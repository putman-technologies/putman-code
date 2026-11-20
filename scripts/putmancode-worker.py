#!/usr/bin/env python3
"""Run PutmanCode project-plan jobs on an explicitly configured Linux Docker host."""
import argparse
import concurrent.futures
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import tempfile
import time


def database(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=rw", uri=True, timeout=15)
    db.row_factory = sqlite3.Row
    return db


def command(*args, cwd=None, env=None):
    return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True,
                          timeout=120, check=True).stdout.strip()


def git(repo, *args):
    env = {"PATH": os.environ["PATH"], "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
           "GIT_TERMINAL_PROMPT": "0", "HOME": str(repo.parent)}
    return command("git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                   "-c", "user.name=PutmanCode Worker", "-c", "user.email=worker@localhost",
                   "-C", str(repo), *args, env=env)


def container_name(row):
    identity = json.dumps([row["project_id"], row["id"]]).encode()
    return "putmancode-" + hashlib.sha256(identity).hexdigest()[:32]


def claim(db, projects):
    with db:
        db.execute("BEGIN IMMEDIATE")
        for p in projects:
            row = db.execute("""
                SELECT j.* FROM coordinator_jobs j
                LEFT JOIN coordinator_team_settings s ON s.project_id=j.project_id
                WHERE j.project_id=? AND j.state='queued'
                AND (SELECT count(*) FROM coordinator_jobs a WHERE a.project_id=j.project_id
                     AND a.state IN ('running','cancelling')) < coalesce(s.agents,2)
                AND (j.kind<>'browser' OR (SELECT count(*) FROM coordinator_jobs b
                     WHERE b.project_id=j.project_id AND b.kind='browser'
                     AND b.state IN ('running','cancelling')) < coalesce(s.browsers,1))
                ORDER BY j.rowid LIMIT 1""", (p,)).fetchone()
            if row:
                db.execute("UPDATE coordinator_jobs SET state='running' WHERE project_id=? AND id=?",
                           (p, row["id"]))
                return row
    return None


def stop_container(name):
    # Confirm daemon availability before treating a missing container as stopped.
    ids = command("docker", "ps", "-aq", "--filter", "name=^/" + name + "$")
    if ids:
        command("docker", "rm", "-f", name)


def project_key(path):
    file = Path(path)
    if not file.is_absolute() or file.stat().st_mode & 0o077:
        raise ValueError("The project API key must be in a private file with mode 0600.")
    key = file.read_text().strip()
    if not key or "\n" in key:
        raise ValueError("Invalid project API key file.")
    return key


def bounded_usage(value, maximum, integer=False):
    if type(value) not in (float, int) or not math.isfinite(value) or value < 0:
        return maximum
    # Charge reported usage even when it exceeds the allowance.
    return math.ceil(value) if integer else value


def sandbox_args(config, row, workspace):
    kind = row["kind"]
    image = config[kind + "_image"]
    if not re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}", image):
        raise ValueError("The project requires a digest-pinned worker image.")
    args = ["docker", "create", "--name", container_name(row), "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=4g",
            "--cpus=2", "--read-only", "--init", "--user", f"{os.getuid()}:{os.getgid()}",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=1024m,mode=1777", "--shm-size=256m",
            "-e", "HOME=/tmp/home", "-e", "CI=true", "--workdir=/work",
            "--mount", f"type=bind,src={workspace},dst=/work"]
    env = dict(os.environ)
    if kind == "browser":
        checks = config["browser_command"]
        if not isinstance(checks, list) or not checks or not all(isinstance(v, str) and v for v in checks):
            raise ValueError("Configure a browser test command in the host project settings.")
        return args + ["--network=none", "--entrypoint", checks[0], image, *checks[1:]], env
    env["ANTHROPIC_API_KEY"] = project_key(config["api_key_file"])
    # Editing tools only. Shells, subagents, MCP, plugins and repository settings cannot
    # start additional provider runs using the project key. Tests use a separate container.
    return args + ["-e", "ANTHROPIC_API_KEY", "--entrypoint", "claude", image, "-p",
                   "--tools", "Read,Edit,Write,Glob,Grep", "--allowedTools", "Read,Edit,Write,Glob,Grep",
                   "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                   "--setting-sources", "user", "--disable-slash-commands",
                   "--permission-mode", "acceptEdits", "--output-format", "json",
                   "--max-turns", str(row["turns"]), "--max-budget-usd", str(row["dollars"]),
                   "--", row["prompt"]], env


def source_revision(repo, ref):
    if ref == "HEAD":
        return git(repo, "rev-parse", "--verify", "HEAD^{commit}")
    git(repo, "check-ref-format", "refs/heads/" + ref)
    return git(repo, "rev-parse", "--verify", "refs/heads/" + ref + "^{commit}")


def return_changes(repo, trusted, work, row, sha):
    for parent, dirs, files in os.walk(work, followlinks=False):
        for entry in [*dirs, *files]:
            mode = (Path(parent) / entry).lstat().st_mode
            if entry.casefold() == ".git" or not any(f(mode) for f in (stat.S_ISREG, stat.S_ISLNK, stat.S_ISDIR)):
                raise ValueError("Workspace contains unsupported repository metadata or special files.")
    git(trusted, "--work-tree=" + str(work), "add", "-A", "--", ".")
    tree = git(trusted, "write-tree")
    if tree == git(trusted, "rev-parse", sha + "^{tree}"):
        return None
    commit = git(trusted, "commit-tree", tree, "-p", sha, "-m", "PutmanCode project task " + row["task"])
    branch = "putmancode-worker/" + container_name(row).removeprefix("putmancode-")
    git(repo, "fetch", "--no-tags", "--no-write-fetch-head", str(trusted), commit + ":refs/heads/" + branch)
    return branch


def execute(dbpath, config, row):
    db = database(dbpath)
    p, job = row["project_id"], row["id"]
    name = container_name(row)
    state, result, branch, turns, dollars = "failed", "Worker setup failed.", None, 0, 0
    started = False
    try:
        repo = Path(config["repository"]).resolve(strict=True)
        sha = source_revision(repo, row["base_ref"])
        with db:
            db.execute("UPDATE coordinator_jobs SET base_sha=? WHERE project_id=? AND id=?", (sha,p,job))
        with tempfile.TemporaryDirectory(prefix="putmancode-job-") as temp:
            root = Path(temp)
            work, trusted = root / "workspace", root / "source"
            work.mkdir()
            # Keep all Git metadata outside the container's only writable host mount.
            git(root, "clone", "--no-local", "--no-checkout", "--", str(repo), str(trusted))
            git(trusted, "--work-tree=" + str(work), "read-tree", "--reset", "-u", sha)
            args, env = sandbox_args(config, row, work)
            command(*args, env=env)
            with (root / "output").open("w+b") as output:
                proc = subprocess.Popen(["docker","start","-a",name], stdout=output, stderr=subprocess.DEVNULL)
                started = True
                turns, dollars = None, None
                deadline = time.monotonic() + min(3600,max(10,int(config.get("timeout_seconds", 900))))
                abort = None
                try:
                    while proc.poll() is None:
                        status = db.execute("SELECT state FROM coordinator_jobs WHERE project_id=? AND id=?",(p,job)).fetchone()[0]
                        if status == "cancelling" or time.monotonic() >= deadline or output.tell() > 8_000_000:
                            abort = "cancelled" if status == "cancelling" else "interrupted"
                            stop_container(name)
                            break
                        time.sleep(0.5)
                    proc.wait(timeout=15)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait()
                if abort:
                    state, result = abort, "Stopped before completion."
                else:
                    code = command("docker","inspect","--format","{{.State.ExitCode}}",name)
                    if row["kind"] == "browser":
                        state = "completed" if code == "0" else "failed"
                        result = "Browser checks exited with code " + code
                        turns, dollars = 0, 0
                    else:
                        output.seek(0)
                        report = json.loads(output.read(8_000_001))
                        turns = bounded_usage(report.get("num_turns"),row["turns"],True)
                        dollars = bounded_usage(report.get("total_cost_usd"),row["dollars"])
                        if report.get("subtype") in ("error_max_turns","error_max_budget_usd"):
                            state, result = "budget_exhausted", "The worker reached its allowance."
                        elif code == "0" and report.get("subtype")=="success" and not report.get("is_error"):
                            state, result = "completed", "Changes are ready for review."
                        else:
                            state, result = "failed", "The model did not complete this task."
                        if state in ("completed","budget_exhausted"):
                            branch = return_changes(repo,trusted,work,row,sha)
                    result += " Base " + sha[:12] + "."
    except (OSError, ValueError, KeyError, sqlite3.Error, subprocess.SubprocessError):
        state, result = "failed", "Worker failed. Check the project image, credentials, source branch and host configuration."
    finally:
        # Never release a slot while its container could still be running.
        try:
            stop_container(name)
            with db:
                db.execute("""UPDATE coordinator_jobs SET state=CASE WHEN state='cancelling' THEN 'cancelled' ELSE ? END,
                              result=?,branch=?,used_turns=?,used_dollars=? WHERE project_id=? AND id=?""",
                           (state,result,branch,turns if started else 0,dollars if started else 0,p,job))
        finally:
            db.close()


def serve(dbpath, config, once):
    if os.getuid() == 0:
        raise ValueError("Run the worker as a dedicated non-root user.")
    with open(str(Path(dbpath).resolve())+".worker.lock","a") as lock, contextlib.closing(database(dbpath)) as db:
        fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
        command("docker","info","--format","{{.ServerVersion}}")
        for row in db.execute("SELECT * FROM coordinator_jobs WHERE state IN ('running','cancelling')").fetchall():
            stop_container(container_name(row))
            with db:
                db.execute("UPDATE coordinator_jobs SET state='interrupted',result='Worker restarted. Review before retrying.' WHERE project_id=? AND id=?",(row["project_id"],row["id"]))
        with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
            active = set()
            while True:
                for future in tuple(active):
                    if future.done():
                        future.result()
                        active.remove(future)
                row = claim(db,config) if len(active)<32 else None
                if row:
                    active.add(pool.submit(execute,dbpath,config[row["project_id"]],row))
                if once:
                    for future in active:
                        future.result()
                    return
                if not row:
                    time.sleep(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--config", required=True, help="Host-owned project mapping JSON")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    serve(args.db,json.loads(Path(args.config).read_text()),args.once)

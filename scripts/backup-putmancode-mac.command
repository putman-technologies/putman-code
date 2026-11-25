#!/usr/bin/python3
"""Make a private, local recovery copy before replacing PutmanCode on this Mac."""
from contextlib import closing
import datetime
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile


def fingerprint(file):
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def copy_verified(source, dest):
    with open(source, "rb") as stream:
        sqlite = stream.read(16) == b"SQLite format 3\0"
    source, dest = Path(source), Path(dest)
    if sqlite:
        # Include committed WAL transactions even if a backend is still running.
        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as old:
            with closing(sqlite3.connect(dest)) as new:
                old.backup(new)
                new.execute("PRAGMA journal_mode=DELETE")
                if new.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise RuntimeError("SQLite could not verify " + source.name)
        shutil.copymode(source, dest)
    else:
        shutil.copy2(source, dest)
        if fingerprint(source) != fingerprint(dest):
            raise RuntimeError("A file changed during the backup: " + source.name)


def snapshot(base, app_support):
    sources = [(base / "userdata", "userdata")]
    sources.extend((app_support / name, name) for name in ("Putman Code", "PutmanCode") if (app_support / name).is_dir())
    if not sources[0][0].is_dir():
        raise RuntimeError("No existing PutmanCode user data found at " + str(sources[0][0]))
    root = base / "backups"
    root.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".preparing-", dir=root) as tmp:
        stage = Path(tmp) / "snapshot"
        stage.mkdir(mode=0o700)
        for folder, label in sources:
            def ignore(directory, names):
                skipped = set()
                if label != "userdata" and Path(directory) == folder:
                    skipped.update({"SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort",
                                    "Cache", "Code Cache", "GPUCache", "Crashpad"})
                for name in names:
                    for suffix in ("-journal", "-wal", "-shm"):
                        if not name.endswith(suffix):
                            continue
                        primary = Path(directory) / name[:-len(suffix)]
                        if primary.is_file() and not primary.is_symlink():
                            with primary.open("rb") as db:
                                if db.read(16) == b"SQLite format 3\0":
                                    skipped.add(name)
                return skipped
            shutil.copytree(folder, stage / label, copy_function=copy_verified, symlinks=True, ignore=ignore)
        now = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        completed = root / ("before-signed-upgrade-" + now)
        stage.rename(completed)
        return completed


if __name__ == "__main__":
    if sys.platform != "darwin":
        raise SystemExit("Run this backup on the Mac where PutmanCode is installed.")
    os.umask(0o077)
    running = subprocess.run(["/usr/bin/pgrep", "-x", "PutmanCode"], stdout=subprocess.DEVNULL)
    if running.returncode == 0:
        raise SystemExit("Quit PutmanCode with Command-Q, then run this backup again.")
    if running.returncode != 1:
        raise SystemExit("Could not check whether PutmanCode is running.")
    home = Path.home()
    base = Path(os.environ.get("PUTMANCODE_HOME") or home / ".putman-code").expanduser()
    saved = snapshot(base, home / "Library/Application Support")
    print("Verified local backup:", saved)
    print("Keep using the same Mac account and login Keychain when installing PutmanCode.")

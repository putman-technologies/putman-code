#!/usr/bin/python3
"""Make a private, local recovery copy before replacing PutmanCode on this Mac."""
from contextlib import closing
import argparse
import datetime
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile


def fingerprint(file):
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def copy_sqlite(source, dest):
    # macOS SQLite can need writable sidecars even to read a WAL-format DB.
    # Recover the copied journals in private storage; SHM is a rebuildable index.
    try:
        with tempfile.TemporaryDirectory(prefix=".sqlite-", dir=dest.parent) as tmp:
            raw = Path(tmp) / "database"
            shutil.copyfile(source, raw)
            for suffix in ("-wal", "-journal"):
                sidecar = source.with_name(source.name + suffix)
                if sidecar.is_file():
                    shutil.copyfile(sidecar, raw.with_name(raw.name + suffix))
            consolidated = Path(tmp) / "verified.sqlite"
            with closing(sqlite3.connect(raw)) as old, closing(sqlite3.connect(consolidated)) as new:
                old.backup(new)
                if new.execute("PRAGMA journal_mode=DELETE").fetchone() != ("delete",):
                    raise RuntimeError("Could not consolidate SQLite journals for " + str(source))
                if new.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise RuntimeError("SQLite integrity check failed for " + str(source))
            consolidated.replace(dest)
        shutil.copymode(source, dest)
    except sqlite3.Error as error:
        raise RuntimeError("Could not back up " + str(source) + ": " + str(error)) from error


def copy_verified(source, dest):
    with open(source, "rb") as stream:
        sqlite = stream.read(16) == b"SQLite format 3\0"
    source, dest = Path(source), Path(dest)
    if sqlite:
        copy_sqlite(source, dest)
    else:
        shutil.copy2(source, dest)
        if fingerprint(source) != fingerprint(dest):
            raise RuntimeError("A file changed during the backup: " + source.name)


PROFILE_TRANSIENTS = {"SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort",
                      "Cache", "Code Cache", "GPUCache", "Crashpad"}


def source_versions(sources):
    # Also catch changes between copying related files, including a WAL appearing
    # or being checkpointed while the main database is being read.
    versions = {}

    def fail(error):
        raise error

    for folder, label in sources:
        for directory, dirs, files in os.walk(folder, onerror=fail):
            if label != "userdata" and Path(directory) == folder:
                dirs[:] = [name for name in dirs if name not in PROFILE_TRANSIENTS]
                files = [name for name in files if name not in PROFILE_TRANSIENTS]
            for name in dirs + files:
                path = Path(directory) / name
                info = path.lstat()
                versions[path] = (info.st_dev, info.st_ino, info.st_mode)
                if not stat.S_ISDIR(info.st_mode):
                    versions[path] += (info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    return versions


def snapshot(base, app_support, output_dir=None):
    sources = [(base / "userdata", "userdata")]
    sources.extend((app_support / name, name) for name in ("Putman Code", "PutmanCode") if (app_support / name).is_dir())
    if not sources[0][0].is_dir():
        raise RuntimeError("No existing PutmanCode user data found at " + str(sources[0][0]))
    root = (output_dir if output_dir is not None else base / "backups").resolve()
    if any(root.is_relative_to(folder.resolve()) for folder, _ in sources):
        raise RuntimeError("Choose a backup destination outside the data being copied.")
    root.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".preparing-", dir=root) as tmp:
        stage = Path(tmp) / "snapshot"
        stage.mkdir(mode=0o700)
        versions = source_versions(sources)
        for folder, label in sources:
            def ignore(directory, names):
                skipped = set()
                if label != "userdata" and Path(directory) == folder:
                    skipped.update(PROFILE_TRANSIENTS)
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
        if source_versions(sources) != versions:
            raise RuntimeError("PutmanCode data changed during the backup. Quit PutmanCode and try again.")
        now = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        completed = root / ("before-signed-upgrade-" + now)
        stage.rename(completed)
        return completed


if __name__ == "__main__":
    if sys.platform != "darwin":
        raise SystemExit("Run this backup on the Mac where PutmanCode is installed.")
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, help="Store the new private snapshot in this folder.")
    args = parser.parse_args()
    running = subprocess.run(["/usr/bin/pgrep", "-x", "PutmanCode"], capture_output=True)
    if running.returncode == 0:
        raise SystemExit("Quit PutmanCode with Command-Q, then run this backup again.")
    home = Path.home()
    support = home / "Library/Application Support"
    if running.returncode != 1:
        if any((support / name / "SingletonLock").is_symlink() for name in ("Putman Code", "PutmanCode")):
            raise SystemExit("Quit PutmanCode with Command-Q, then run this backup again.")
        print("The process list is unavailable. Checking that saved files stay unchanged during the backup.")
    base = Path(os.environ.get("PUTMANCODE_HOME") or home / ".putman-code").expanduser()
    try:
        saved = snapshot(base, support, args.output_dir.expanduser() if args.output_dir else None)
    except (OSError, RuntimeError) as error:
        raise SystemExit("Backup did not complete. " + str(error))
    print("Verified local backup:", saved)
    print("Keep using the same Mac account and login Keychain when installing PutmanCode.")

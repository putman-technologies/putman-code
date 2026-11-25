"""Fail a release build if its executable bundles contain inherited telemetry destinations."""
import os
from pathlib import Path
import sys

MARKERS = (
    b"ingest.t3.codes",
    b"api.axiom.co",
    b"x-axiom-dataset",
    b"app.posthog.com",
    b"us.i.posthog.com",
    b"eu.i.posthog.com",
)


def check(directory):
    count = 0
    for root, folders, names in os.walk(directory):
        if "node_modules" in folders:
            folders.remove("node_modules")
        for name in names:
            path = Path(root, name)
            if path.suffix not in {".js", ".mjs", ".cjs", ".bundle"}:
                continue
            count += 1
            content = path.read_bytes().lower()
            for marker in MARKERS:
                if marker in content:
                    raise SystemExit(f"{path} contains an upstream telemetry marker: {marker.decode()}")
    if not count:
        raise SystemExit(f"No executable bundles to verify in {directory}")
    print(f"Checked {count} executable bundles in {directory}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Pass the directories containing the built application")
    for directory in sys.argv[1:]:
        check(directory)

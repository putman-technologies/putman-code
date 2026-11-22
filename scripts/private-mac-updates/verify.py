"""Run on a disposable GitHub-hosted Mac. Exercises the production updater IPC and ShipIt."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import threading
import time

import preview as p

if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise SystemExit("This test requires a disposable GitHub-hosted Mac.")

# No private production identity or repository secrets are used for this test.
os.umask(0o077)
with tempfile.TemporaryDirectory() as scratch:
    tmp = Path(scratch)
    p.ROOT = tmp
    p.FEED = tmp / "feed"
    p.FEED.mkdir()
    chain = tmp / "test.keychain-db"
    password = os.urandom(16).hex()
    p.run("security", "create-keychain", "-p", password, chain)
    p.run("security", "set-keychain-settings", "-lut", "7200", chain)
    p.run("security", "unlock-keychain", "-p", password, chain)
    p.run("security", "list-keychains", "-d", "user", "-s", chain)
    p.run("security", "default-keychain", "-d", "user", "-s", chain)
    def trust_test_leaf(keychain, cert):
        p.run("sudo", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign",
              "-k", "/Library/Keychains/System.keychain", cert)
    fingerprint = p.initialize_identity(trust_test_leaf)
    p.run("security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s",
          "-k", password, chain)
    server = p.http.server.ThreadingHTTPServer(("127.0.0.1", 0), p.FeedHandler)
    conf = {"port": server.server_address[1], "fingerprint": fingerprint}
    all_releases = p.releases()
    first, second = "1.0.0-beta.1", "1.0.0-beta.3"
    folder = tmp / "Applications"
    folder.mkdir()
    app = p.prepare_app(folder, first, all_releases[first], conf)
    p.publish(second, all_releases[second], conf)
    # Verify an unrelated app fails the same identity check.
    if subprocess.run(["codesign", "--verify", "-R", "=" + p.requirement(fingerprint),
                       "/System/Applications/Calculator.app"]).returncode == 0:
        raise RuntimeError("The private signature requirement accepted an unrelated app.")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {**os.environ, "PUTMANCODE_HOME": str(tmp / "isolated-state"), "T3CODE_TELEMETRY_ENABLED": "false"}
    p.run("codesign", "-dr", "-", app)
    subprocess.run(["node", str(Path(__file__).with_name("verify.cjs")), str(app), first, second],
                   env=env, timeout=360, check=True)
    for _ in range(90):
        try:
            if p.bundle_info(app)["CFBundleShortVersionString"] == second:
                break
        except (FileNotFoundError, plistlib.InvalidFileException):
            pass
        time.sleep(1)
    else:
        raise RuntimeError("ShipIt did not replace the seed with the downloaded beta.")
    p.signature_check(app, p.requirement(fingerprint))
    print(f"Verified the native PutmanCode check, download and install from {first} to {second}.")

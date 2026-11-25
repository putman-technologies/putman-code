"""Exercise one-time setup, its login agent and the native updater on a disposable Mac."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time

import preview as p

if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
    raise SystemExit("This test requires a disposable GitHub-hosted Mac.")
if p.ROOT.exists() or p.APP.exists():
    raise SystemExit("The test requires an empty preview folder and no installed copy.")

os.umask(0o077)
with tempfile.TemporaryDirectory() as scratch:
    tmp = Path(scratch)
    p.ROOT.mkdir(mode=0o700, parents=True)
    chain = tmp / "test.keychain-db"
    password = os.urandom(16).hex()
    p.run("security", "create-keychain", "-p", password, chain)
    p.run("security", "set-keychain-settings", "-lut", "7200", chain)
    p.run("security", "unlock-keychain", "-p", password, chain)
    p.run("security", "list-keychains", "-d", "user", "-s", chain)
    p.run("security", "default-keychain", "-d", "user", "-s", chain)
    # Authorize the disposable test identity without an interactive trust dialog.
    def trust_test_leaf(keychain, cert):
        p.run("sudo", "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign",
              "-k", "/Library/Keychains/System.keychain", cert)
    fp = p.initialize_identity(trust_test_leaf)
    p.run("security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s",
          "-k", password, chain)
    first = "1.0.0-beta.1"
    available = p.releases()
    url, sha = available[first]
    dmg = Path.home() / "Downloads" / p.asset_name(first)
    dmg.parent.mkdir(exist_ok=True)
    p.run("curl", "-fsSL", "--proto", "=https", "--proto-redir", "=https", "-o", dmg, url)
    if p.digest(dmg, "sha256").hexdigest() != sha:
        raise RuntimeError("Seed digest mismatch")
    mount = tmp / "mounted"
    mount.mkdir()
    p.run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg)
    try:
        p.run("ditto", mount / "PutmanCode.app", p.APP)
    finally:
        p.run("hdiutil", "detach", mount)
    p.run(sys.executable, Path(__file__).with_name("preview.py"), "setup")
    # Reproduce the one-time Finder replacement on this otherwise empty test Mac.
    p.APP.rename(tmp / "original.app")
    p.run("ditto", p.ROOT / "Ready" / "PutmanCode.app", p.APP)
    metadata = json.loads((p.FEED / "current.json").read_bytes())
    latest = metadata["version"]
    if p.version_key(latest) <= p.version_key(first):
        raise RuntimeError("The feed does not contain an upgrade")
    unrelated = subprocess.run(["codesign", "--verify", "-R", "=" + p.requirement(fp),
                                tmp / "original.app"])
    if unrelated.returncode == 0:
        raise RuntimeError("The seed accepted the public ad-hoc signer as its private updater.")
    env = {**os.environ, "PUTMANCODE_HOME": str(tmp / "isolated-state"), "T3CODE_TELEMETRY_ENABLED": "false"}
    subprocess.run(["node", str(Path(__file__).with_name("verify.cjs")), str(p.APP), first, latest],
                   env=env, timeout=360, check=True)
    for _ in range(90):
        try:
            if p.bundle_info(p.APP)["CFBundleShortVersionString"] == latest:
                break
        except (FileNotFoundError, plistlib.InvalidFileException):
            pass
        time.sleep(1)
    else:
        raise RuntimeError("ShipIt did not replace the installed app with the downloaded beta.")
    p.signature_check(p.APP, p.requirement(fp))
    print(f"Verified one-time setup, the login agent and native check/download/install from {first} to {latest}.")

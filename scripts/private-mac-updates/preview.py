#!/usr/bin/python3
"""Prepare personal PutmanCode betas for the native Mac updater."""
import argparse
import base64
import contextlib
import datetime
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

REPO = "putman-technologies/putman-code"
BUNDLE_ID = "com.putmantechnologies.putmancode"
ROOT = Path.home() / "Library/Application Support/PutmanCode Private Updates"
AGENT = "com.putmantechnologies.putmancode.private-updates"
PLIST = Path.home() / "Library/LaunchAgents" / (AGENT + ".plist")
APP = Path("/Applications/PutmanCode.app")
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)-beta\.(\d+)")
MANIFESTS = {"stable-mac.yml", "latest-mac.yml", "nightly-mac.yml"}
CONFIG = ROOT / "settings.json"
FEED = ROOT / "feed"


def run(*args):
    subprocess.run([str(a) for a in args], check=True)


def output(*args):
    return subprocess.check_output([str(a) for a in args], text=True).strip()


def atomic(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        out = Path(f.name)
        try:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            out.unlink()
            raise
    os.replace(out, path)


def digest(path, algorithm):
    h = hashlib.new(algorithm)
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h


def version_key(version):
    m = VERSION.fullmatch(version)
    if not m:
        raise ValueError(f"Expected a beta release version, got {version!r}")
    return tuple(map(int, m.groups()))


def asset_name(version):
    version_key(version)
    return f"PutmanCode-{version}-macOS-arm64.dmg"


def releases():
    url = f"https://api.github.com/repos/{REPO}/releases?per_page=100"
    data = json.loads(output("/usr/bin/curl", "-fsSL", "--proto", "=https",
                             "--proto-redir", "=https", "--max-time", "45", "--retry", "2", url))
    found = {}
    for release in data:
        tag = release["tag_name"]
        if release["draft"] or not release["prerelease"] or not tag.startswith("v"):
            continue
        version = tag[1:]
        if not VERSION.fullmatch(version):
            continue
        name = asset_name(version)
        expected = f"https://github.com/{REPO}/releases/download/{tag}/{name}"
        for asset in release["assets"]:
            checksum = asset.get("digest") or ""
            if (asset["name"] == name and asset.get("state") == "uploaded"
                    and asset["browser_download_url"] == expected
                    and re.fullmatch(r"sha256:[0-9a-f]{64}", checksum)):
                found[version] = (expected, checksum[7:])
    if not found:
        raise RuntimeError("GitHub has no published Apple silicon beta with a SHA-256 digest.")
    return found


def bundle_info(app):
    with (app / "Contents/Info.plist").open("rb") as f:
        return plistlib.load(f)


def signature_check(app, requirement=None):
    args = ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--all-architectures"]
    if requirement:
        args.extend(["-R", "=" + requirement])
    run(*args, app)


def initialize_identity(trust_user_identity=None):
    # The leaf is trusted only for code signing in the current user's Keychain.
    # Persistent state stores the public certificate, never the private key.
    cert = ROOT / "preview.cer"
    keychain = output("/usr/bin/security", "default-keychain", "-d", "user").strip('"')
    if not cert.exists():
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            tmp = Path(tmp)
            cfg = tmp / "request.conf"
            cfg.write_text("[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=signing\n"
                           "[dn]\nCN=PutmanCode Private Preview " + secrets.token_hex(8) +
                           "\n[signing]\nbasicConstraints=critical,CA:FALSE\n"
                           "keyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n")
            run("/usr/bin/openssl", "req", "-new", "-newkey", "rsa:3072", "-nodes",
                "-x509", "-sha256", "-days", "90", "-config", cfg, "-keyout", tmp / "key",
                "-out", tmp / "cert.pem")
            run("/usr/bin/openssl", "x509", "-in", tmp / "cert.pem", "-outform", "DER",
                "-out", tmp / "cert.der")
            # The transfer file exists only in this mode-0700 temporary directory.
            transfer_password = secrets.token_hex(24)
            (tmp / "password").write_text(transfer_password)
            run("/usr/bin/openssl", "pkcs12", "-export", "-inkey", tmp / "key",
                "-in", tmp / "cert.pem", "-out", tmp / "identity.p12", "-macalg", "sha1",
                "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES",
                "-passout", f"file:{tmp / 'password'}")
            imported = subprocess.run(["/usr/bin/security", "import", str(tmp / "identity.p12"),
                                       "-k", keychain, "-x", "-P", transfer_password,
                                       "-T", "/usr/bin/codesign"])
            if imported.returncode:
                raise RuntimeError("macOS could not import the private signing identity.")
            atomic(cert, (tmp / "cert.der").read_bytes())
    fp = digest(cert, "sha1").hexdigest().upper()  # Keychain's public identity selector
    def available():
        return fp in output("/usr/bin/security", "find-identity", "-v", "-p", "codesigning", keychain)
    if not available():
        if trust_user_identity is None:
            run("/usr/bin/security", "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign",
                "-k", keychain, cert)
        else:
            trust_user_identity(keychain, cert)
    if not available():
        raise RuntimeError("The preview signing identity is unavailable in your user Keychain.")
    return fp


def requirement(fp):
    if not re.fullmatch("[A-F0-9]{40}", fp):
        raise ValueError("Invalid certificate fingerprint")
    return f'identifier "{BUNDLE_ID}" and certificate leaf = H"{fp}"'


def prepare_app(tmp, version, release, conf):
    url, checksum = release
    name = asset_name(version)
    dmg = Path.home() / "Downloads" / name
    if not dmg.is_file() or digest(dmg, "sha256").hexdigest() != checksum:
        dmg = tmp / name
        run("/usr/bin/curl", "-fLsS", "--proto", "=https", "--proto-redir", "=https",
            "--retry", "3", "--max-time", "1200", "-o", dmg, url)
        if digest(dmg, "sha256").hexdigest() != checksum:
            raise RuntimeError("The downloaded DMG differs from the GitHub release digest.")
    mount = tmp / "mount"
    mount.mkdir()
    run("/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg)
    app = tmp / "PutmanCode.app"
    try:
        source = mount / app.name
        info = bundle_info(source)
        if info["CFBundleIdentifier"] != BUNDLE_ID or info["CFBundleShortVersionString"] != version:
            raise RuntimeError("Disk image app identity/version does not match the GitHub release.")
        signature_check(source)
        run("/usr/bin/ditto", source, app)
    finally:
        run("/usr/bin/hdiutil", "detach", mount)
    feed_url = f"http://127.0.0.1:{conf['port']}/"
    (app / "Contents/Resources/app-update.yml").write_text(
        "provider: generic\nurl: " + feed_url + "\nupdaterCacheDirName: putmancode-private-updater\n")
    req = requirement(conf["fingerprint"])
    run("/usr/bin/codesign", "--force", "--sign", conf["fingerprint"], "--timestamp=none",
        "--preserve-metadata=entitlements,flags,runtime", "--requirements", "=designated => " + req, app)
    signature_check(app, req)
    return app


def publish(version, release, conf):
    print(f"Preparing verified private update {version}…", flush=True)
    with tempfile.TemporaryDirectory(dir=ROOT) as scratch:
        tmp = Path(scratch)
        app = prepare_app(tmp, version, release, conf)
        filename = f"PutmanCode-{version}-arm64.zip"
        archive = tmp / filename
        run("/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive)
        restored = tmp / "restored"
        run("/usr/bin/ditto", "-x", "-k", archive, restored)
        signature_check(restored / app.name, requirement(conf["fingerprint"]))
        sha = base64.b64encode(digest(archive, "sha512").digest()).decode("ascii")
        meta = {"version": version, "path": filename, "sha512": sha,
                "files": [{"url": filename, "sha512": sha, "size": archive.stat().st_size}],
                "releaseDate": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        os.replace(archive, FEED / filename)
        atomic(FEED / "current.json", json.dumps(meta).encode())  # JSON is valid YAML.


@contextlib.contextmanager
def exclusive(path):
    with path.open("a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def refresh(conf, available=None):
    with exclusive(ROOT / "publish.lock"):
        available = available or releases()
        latest = max(available, key=version_key)
        current = FEED / "current.json"
        if current.exists():
            state = json.loads(current.read_bytes())
            if version_key(latest) <= version_key(state["version"]) and (FEED / state["path"]).is_file():
                return
        publish(latest, available[latest], conf)
        # Retain the previous ZIP for a client which already checked before this publish.
        zips = sorted(FEED.glob("PutmanCode-*-arm64.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in zips[2:]:
            old.unlink()


class FeedHandler(http.server.BaseHTTPRequestHandler):
    def handle_file(self, body):
        name = urllib.parse.urlsplit(self.path).path.lstrip("/")
        if name in MANIFESTS:
            path, mime = FEED / "current.json", "application/yaml"
        elif re.fullmatch(r"PutmanCode-\d+\.\d+\.\d+-beta\.\d+-arm64\.zip", name):
            path, mime = FEED / name, "application/zip"
        else:
            self.send_error(404)
            return
        try:
            f = path.open("rb")
        except FileNotFoundError:
            self.send_error(404)
            return
        with f:
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(os.fstat(f.fileno()).st_size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if body:
                shutil.copyfileobj(f, self.wfile)

    def do_GET(self):
        self.handle_file(True)

    def do_HEAD(self):
        self.handle_file(False)

    def log_message(self, *args):
        pass


def serve():
    conf = json.loads(CONFIG.read_bytes())
    server = http.server.ThreadingHTTPServer(("127.0.0.1", conf["port"]), FeedHandler)
    def poll():
        while True:
            try:
                refresh(conf)
            except Exception as exc:
                print("Refresh will retry:", exc, file=sys.stderr, flush=True)
            time.sleep(600)
    threading.Thread(target=poll, daemon=True).start()
    server.serve_forever()


def setup():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("Run setup on the Apple silicon Mac with PutmanCode installed.")
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with exclusive(ROOT / "setup.lock"):
        available = releases()
        installed = bundle_info(APP)
        version = installed["CFBundleShortVersionString"]
        if installed["CFBundleIdentifier"] != BUNDLE_ID or version not in available:
            raise RuntimeError(f"The installed version ({version}) must match a published PutmanCode beta.")
        print("Setting up the personal code-signing identity in your login Keychain.", flush=True)
        fp = initialize_identity()
        if CONFIG.is_file():
            conf = json.loads(CONFIG.read_bytes())
            if conf["fingerprint"] != fp:
                raise RuntimeError("The existing feed uses another identity. Its certificate must be restored.")
        else:
            import socket
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0))
                conf = {"port": s.getsockname()[1], "fingerprint": fp}
            atomic(CONFIG, json.dumps(conf).encode())
        FEED.mkdir(mode=0o700, exist_ok=True)
        ready = ROOT / "Ready"
        ready.mkdir(mode=0o700, exist_ok=True)
        seed = ready / APP.name
        with tempfile.TemporaryDirectory(dir=ROOT) as scratch:
            app = prepare_app(Path(scratch), version, available[version], conf)
            refresh(conf, available)
            if seed.exists():
                shutil.rmtree(seed)
            os.rename(app, seed)
        atomic(ROOT / "preview.py", Path(__file__).read_bytes())
        PLIST.parent.mkdir(parents=True, exist_ok=True)
        plist = {"Label": AGENT, "ProgramArguments": ["/usr/bin/python3", str(ROOT / "preview.py"), "serve"],
                 "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 60,
                 "StandardErrorPath": str(ROOT / "feed.log")}
        atomic(PLIST, plistlib.dumps(plist))
        domain = f"gui/{os.getuid()}"
        if subprocess.run(["/bin/launchctl", "print", domain + "/" + AGENT], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0:
            run("/bin/launchctl", "bootout", domain + "/" + AGENT)
        run("/bin/launchctl", "bootstrap", domain, PLIST)
        # Match the live manifest against the exact verified bytes we published, before presenting the seed.
        import urllib.request
        target = f"http://127.0.0.1:{conf['port']}/stable-mac.yml"
        for attempt in range(15):
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(target, timeout=2) as response:
                    if response.read(32768) != (FEED / "current.json").read_bytes():
                        raise RuntimeError("Another process is responding on the preview port.")
                break
            except OSError:
                if attempt == 14:
                    raise RuntimeError(f"Preview feed did not start. See {ROOT / 'feed.log'}")
                time.sleep(1)
        print(f"Ready: {seed}\nQuit PutmanCode, replace its copy in Applications with this one, then open it.\n"
              "Use Check for Updates, Download, then Install. Your current app has not been replaced.", flush=True)
        run("/usr/bin/open", "-R", seed)


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["setup", "serve"], default="setup", nargs="?")
    try:
        {"setup": setup, "serve": serve}[parser.parse_args().command]()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(f"PutmanCode private updates: {error}")

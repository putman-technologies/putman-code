"""Assemble an unpublished Beta 11 release from the reviewed release and native checks."""
import base64
import hashlib
import json
import os
import pathlib
import subprocess as sp
import tempfile
from concurrent.futures import ThreadPoolExecutor

repo = "putman-technologies/putman-code"
release = os.environ["RELEASE_SHA"]
build = os.environ["RELEASE_BUILD"]
mac_check = os.environ["PROFILE_RUN"]
mac_check_sha = os.environ["PROFILE_SHA"]
preview = "9b081c15962694c092ece6ba74c58fbd87050579"
stage = "staging-mac-beta11-lyd-9b081c1596"
old_sha = "0bf2ab0d4d34dec4b79415b83520f4e860d9c9cd"
archived = "staging-beta11-before-lyd-0bf2ab0d"
version = "1.0.0-beta.11"
tag = "v" + version
mac = f"Putman-Code-{version}-arm64.zip"
win = f"Putman-Code-{version}-x64.exe"
backup = "backup-putmancode-mac.command"
mac_hashes = {
    mac: "sha256:a8f4316d425691d1931e2bfdfb1bb9c98c2e57e876b24416d43b8e38dc4a4a94",
    mac+".blockmap": "sha256:237c7b49e5515d8816515feb327396249e81789028b85394fac3794b63224a53",
    "beta-mac.yml": "sha256:d2bff9ce877b896a44bb770814a18b097f02f881a97491544b8b37f59f6432c5",
}
backup_hash = "sha256:16f1a0f3761583165330a5ae4be9804ff06ed1ebc615a71f6ec076f69db26b46"

def gh(*args):
    return sp.check_output(["gh",*map(str,args)], text=True).strip()

def api(endpoint):
    return json.loads(gh("api", f"repos/{repo}/{endpoint}"))

def check_run(number,sha,name,branch):
    data=api(f"actions/runs/{number}")
    assert (data["status"], data["conclusion"], data["head_sha"], data["name"], data["head_branch"]) == ("completed","success",sha,name,branch)
    jobs=api(f"actions/runs/{number}/jobs?per_page=100")["jobs"]
    assert jobs and all(row["conclusion"]=="success" for row in jobs)

def verify_target():
    assert api("git/ref/heads/release/1.0.0")["object"]["sha"] == release
    assert not any(row["ref"]=="refs/tags/"+tag for row in api("git/matching-refs/tags/"+tag))
    assert not any(r["prerelease"] and not r["draft"] and r["tag_name"]==tag for r in api("releases?per_page=100"))

def hashfile(p,alg):
    with p.open("rb") as stream:
        return hashlib.file_digest(stream,alg)

def filesums(directory):
    return {p.name:"sha256:"+hashfile(p,"sha256").hexdigest() for p in directory.iterdir() if p.is_file()}

def readrelease(release_tag):
    return json.loads(gh("release","view",release_tag,"-R",repo,"--json","isDraft,isPrerelease,targetCommitish,assets"))

def compare_product():
    # Compare the full tracked snapshots. The candidate branch only changed the release workflow trigger.
    for sha in (release,preview):
        sp.run(["git","fetch","--quiet","--no-tags","--depth=1","origin",sha],check=True)
    sp.run(["git","diff","--exit-code","--quiet",preview,release,"--",".",":!.github/workflows/putmancode-desktop-release-build.yml"],check=True)

check_run(build,release,"Build PutmanCode desktop release","release/1.0.0")
check_run(mac_check,mac_check_sha,"Verify signed Mac beta upgrade and saved profile","qa/verify-lyd-mac-signed")
verify_target()
compare_product()
staged=readrelease(stage)
assert staged["isDraft"] and staged["targetCommitish"]==preview
assert {a["name"]:a["digest"] for a in staged["assets"]}==mac_hashes
prior=api("releases/458245270")
assert prior["draft"] and prior["target_commitish"]==old_sha and prior["tag_name"] in (tag,archived)
assert {a["name"]:a["digest"] for a in prior["assets"]}.get(backup)==backup_hash
with tempfile.TemporaryDirectory() as temp:
    root=pathlib.Path(temp)
    out=root/"out"
    out.mkdir()
    gh("release","download",stage,"-R",repo,"-D",out)
    assert filesums(out)==mac_hashes
    gh("release","download",prior["tag_name"],"-R",repo,"-p",backup,"-D",out)
    assert filesums(out)[backup]==backup_hash
    artifacts=[(f"PutmanCode-{version}-Windows-x64",[win,win+".blockmap","beta.yml"])]
    for arch in ("x64","arm64"):
        artifacts.append(("ssh-linux-"+arch,[f"t3-{version}-linux-{arch}.tar.gz"]))
    def fetch_artifact(item):
        artifact,names=item
        directory=root/artifact
        gh("run","download",build,"-R",repo,"--name",artifact,"-D",directory)
        for name in names:
            items=list(directory.rglob(name))
            assert len(items)==1 and items[0].is_file() and items[0].stat().st_size>0
            items[0].rename(out/name)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(fetch_artifact,artifacts))
    for manifest,target in (("beta-mac.yml",mac),("beta.yml",win)):
        data=json.loads(sp.check_output(["ruby","-ryaml","-rjson","-rtime","-e","puts YAML.safe_load(File.read(ARGV[0]), permitted_classes: [Time]).to_json",str(out/manifest)]))
        entry,=data["files"]
        digest=base64.b64encode(hashfile(out/target,"sha512").digest()).decode()
        assert data["version"]==version and data["path"]==entry["url"]==target
        assert data["sha512"]==entry["sha512"]==digest and entry["size"]==(out/target).stat().st_size
    archives=sorted(out.glob("t3-*-linux-*.tar.gz"))
    assert len(archives)==2
    (out/"SHA256SUMS").write_text("".join(hashfile(p,"sha256").hexdigest()+"  "+p.name+"\n" for p in archives))
    sums=filesums(out)
    assert len(sums)==10
    verify_target()
    if prior["tag_name"]==tag:
        gh("api","--method","PATCH",f"repos/{repo}/releases/458245270","-f","tag_name="+archived,"-f","name=Archived Beta 11 candidate before Lyd (draft)")
        assert api("releases/458245270")["draft"] and api("releases/458245270")["tag_name"]==archived
    notes=root/"notes.md"
    notes.write_text("""Open the Lyd bubble for a full-page assistant on Mac and Windows. The Usage button beside Search and Projects opens the detailed breakdown of costs, tokens and limits. Sharing & access includes a QR code for reachable VPS pairing links.

Apple silicon Mac and Windows x64 users on Beta 10 can use **Check for updates**, **Download**, then **Install**. For a new installation, choose the macOS DMG or Windows EXE. The two Linux archives are the SSH server companions.
""")
    release_list=api("releases?per_page=100")
    existing=[r for r in release_list if r["tag_name"]==tag]
    if not existing:
        gh("release","create",tag,"-R",repo,"--draft","--prerelease","--latest=false","--target",release,"--title","PutmanCode 1.0 Beta 11","--notes-file",notes)
    current=readrelease(tag)
    assert current["isDraft"] and current["isPrerelease"] and current["targetCommitish"]==release
    uploaded={a["name"]:a["digest"] for a in current["assets"]}
    assert all(sums.get(name)==digest for name,digest in uploaded.items())
    for name in sorted(sums.keys()-uploaded.keys()):
        gh("release","upload",tag,out/name,"-R",repo)
    current=readrelease(tag)
    assert current["isDraft"] and current["targetCommitish"]==release
    assert {a["name"]:a["digest"] for a in current["assets"]}==sums
    pathlib.Path(os.environ["RUNNER_TEMP"],"verified-beta11-assets.json").write_text(json.dumps(sums,sort_keys=True)+"\n")
    print("Verified ten draft assets. The release is ready for native Mac and Windows upgrade checks.")

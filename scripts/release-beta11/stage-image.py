"""Add the verified disk image and a Keychain note to the unpublished Beta 11 draft."""
from pathlib import Path
import hashlib
import json
import subprocess as sp
import tempfile

repo="putman-technologies/putman-code"
sha="826e07a0c6727b8dc32ece499d416fb621105942"
tag="v1.0.0-beta.11"
def gh(*args):
    return sp.check_output(["gh",*args],text=True).strip()
def api(path):
    return json.loads(gh("api","repos/"+repo+"/"+path))
def checked_draft():
    data=api("releases/458887721")
    assert data["draft"] and data["prerelease"] and data["tag_name"]==tag and data["target_commitish"]==sha
    return data
jobs=api("actions/runs/45745362183/jobs")["jobs"]
run=api("actions/runs/45745362183")
assert run["head_sha"]==sha and run["conclusion"]=="success" and len(jobs)==3 and all(j["conclusion"]=="success" for j in jobs)
stage=api("actions/runs/45745140027")
assert stage["head_sha"]=="aaa25f915b4ac3f312653ad03962668a51c73366" and stage["conclusion"]=="success"
with tempfile.TemporaryDirectory() as t:
    root=Path(t)
    gh("run","download","45745140027","-R",repo,"-n","verified-beta11-assets","-D",t)
    expected=json.loads((root/"verified-beta11-assets.json").read_text())
    assert len(expected)==10
    gh("run","download","45745362183","-R",repo,"-n","verified-beta-dmg","-D",t)
    img=root/"PutmanCode-1.0.0-beta.11-macOS-arm64.dmg"
    assert img.stat().st_size>100_000_000
    with img.open("rb") as f: image_digest="sha256:"+hashlib.file_digest(f,"sha256").hexdigest()
    assets={a["name"]:a["digest"] for a in checked_draft()["assets"]}
    if img.name in assets:
        assert assets.pop(img.name)==image_digest
    assert assets==expected
    if img.name not in {a["name"] for a in checked_draft()["assets"]}:
        gh("release","upload",tag,str(img),"-R",repo)
    expected[img.name]=image_digest
    draft=checked_draft()
    assert {a["name"]:a["digest"] for a in draft["assets"]}==expected
    title="**Mac Keychain on first launch.**"
    if title not in draft["body"]:
        notes=root/"notes.md"
        notes.write_text(draft["body"].rstrip()+"\n\n"+title+" After updating, macOS may ask PutmanCode to access its saved Keychain item. If you recognize PutmanCode and just installed this update, choose **Allow**. The app can wait for this system dialog before showing your chats.\n")
        gh("release","edit",tag,"-R",repo,"--draft","--prerelease","--latest=false","--notes-file",str(notes))
    assert checked_draft()["draft"] and title in checked_draft()["body"]
    print("The draft contains the tested Mac disk image and eleven verified assets. The beta feed is unchanged.")

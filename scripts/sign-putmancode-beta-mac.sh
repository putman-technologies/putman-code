#!/bin/bash
# Sign a staged Apple silicon beta on the release Mac, then package the exact signed bytes for Squirrel.
set -euo pipefail
: "${PUTMANCODE_BETA_SIGNING_ID:?Set the SHA-1 identity of the beta signing certificate in Keychain}"
input=${1:?Pass the GitHub build ZIP}
output=${2:?Pass the release directory}
version=${3:?Pass the expected beta version}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ && "$PUTMANCODE_BETA_SIGNING_ID" =~ ^[[:xdigit:]]{40}$ ]]
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$output"
output=$(cd "$output" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ditto -x -k "$input" "$work"
app="$work/PutmanCode.app"
plist="$app/Contents/Info.plist"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" == "$version" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" == com.putmantechnologies.putmancode ]]
# Preserve the Electron helpers' entitlements. The default designated requirement binds updates to this certificate.
codesign --force --deep --preserve-metadata=entitlements,flags --timestamp=none --sign "$PUTMANCODE_BETA_SIGNING_ID" "$app"
requirement="identifier \"com.putmantechnologies.putmancode\" and certificate leaf = H\"$PUTMANCODE_BETA_SIGNING_ID\""
codesign --verify --strict --deep -R="$requirement" "$app"
codesign -dr- "$app" 2>&1 | grep -Fi "certificate leaf = H\"$PUTMANCODE_BETA_SIGNING_ID\"" >/dev/null
zip="$output/Putman-Code-$version-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
# Use the same block map format as electron-builder's other desktop targets.
node - "$root/apps/desktop/package.json" "$zip" <<'NODE'
const {createRequire} = require('node:module');
const pkg = createRequire(process.argv[2]);
const builder = createRequire(pkg.resolve('electron-builder/package.json'));
const {buildBlockMap} = builder('app-builder-lib/out/targets/blockmap/blockmap.js');
buildBlockMap(process.argv[3], 'gzip', process.argv[3]+'.blockmap').catch(e => { console.error(e); process.exitCode=1; });
NODE
python3 - "$zip" "$version" <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import sys, hashlib, base64, json
archive=Path(sys.argv[1])
with archive.open('rb') as stream:
    checksum=base64.b64encode(hashlib.file_digest(stream,'sha512').digest()).decode()
manifest=dict(version=sys.argv[2],files=[dict(url=archive.name,sha512=checksum,size=archive.stat().st_size)],
              path=archive.name,sha512=checksum,releaseDate=datetime.now(timezone.utc).isoformat())
(archive.parent/'beta-mac.yml').write_text(json.dumps(manifest,indent=2)+'\n')
PY

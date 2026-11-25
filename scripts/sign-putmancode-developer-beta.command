#!/bin/bash
# Run on the signing Mac, using its existing Developer ID and notarytool profile.
set -euo pipefail
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
repo=putman-technologies/putman-code
team=2NZKUVA6F5
identity="Developer ID Application: Putman Technologies, LLC ($team)"
profile=${PUTMANCODE_NOTARY_PROFILE:-PutmanCode}
version=$(jq -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[0-9]+$"))' apps/desktop/package.json)
tag=v$version
draft=$(gh release view "$tag" --repo "$repo" --json isDraft,targetCommitish)
sha=$(jq -er 'select(.isDraft) | .targetCommitish | select(test("^[a-f0-9]{40}$"))' <<<"$draft")
run=$(gh run list --repo "$repo" --workflow putmancode-desktop-release-build.yml --branch release/1.0.0 --commit "$sha" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
[[ -n "$run" ]] || { echo "No build for the draft release commit."; exit 1; }
security find-identity -v -p codesigning | grep -F "\"$identity\"" >/dev/null
if ! xcrun notarytool history --keychain-profile "$profile" --output-format json >/dev/null; then
  echo "Open Terminal in the Mac login session that holds the PutmanCode notarytool profile."
  exit 1
fi
echo "Waiting for all release checks on $version before signing."
gh run watch "$run" --repo "$repo" --exit-status --interval 25 >/dev/null || { echo "Release checks failed."; exit 1; }
dir="$root/dist/developer-id/$sha"
mkdir -p "$dir"
work=$(mktemp -d "$dir/.working.XXXXXX")
trap 'rm -rf "$work"' EXIT
name="Putman-Code-$version-arm64"
dmg="PutmanCode-$version-macOS-arm64.dmg"
account='anchor apple generic and certificate leaf[subject.OU] = "2NZKUVA6F5" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
req="$account and identifier \"com.putmantechnologies.putmancode\""
artifact=$(gh api "repos/$repo/actions/runs/$run/artifacts" --jq '.artifacts[] | select(.name=="mac-signing-candidate" and .expired==false)')
id=$(jq -er .id <<<"$artifact")
digest=$(jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))' <<<"$artifact")
if [[ ! -f "$dir/submission-id" ]]; then
  gh api "repos/$repo/actions/artifacts/$id/zip" > "$work/artifact.zip"
  actual=$(shasum -a 256 "$work/artifact.zip" | cut -d' ' -f1)
  [[ sha256:$actual == "$digest" ]]
  ditto -x -k "$work/artifact.zip" "$work/package"
  mkdir "$work/image"
  ditto -x -k "$work/package/$name.zip" "$work/image"
  app="$work/image/PutmanCode.app"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")" == "$version" ]]
  [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist")" == com.putmantechnologies.putmancode ]]
  (cd scripts && node --input-type=module - "$app" "$identity" <<'NODE'
import { sign } from '@electron/osx-sign';
const [app, identity] = process.argv.slice(2);
await sign({ app, identity, platform: 'darwin', type: 'distribution',
  preAutoEntitlements: false, preEmbedProvisioningProfile: false, batchCodesignCalls: true });
NODE
  )
  codesign --verify --deep --strict -R="$req" "$app"
  detail=$(codesign -dv --verbose=4 "$app" 2>&1)
  grep '^Timestamp=' <<<"$detail" >/dev/null
  grep 'flags=.*(.*runtime' <<<"$detail" >/dev/null
  ln -s /Applications "$work/image/Applications"
  hdiutil create -quiet -format UDZO -volname "PutmanCode $version" -srcfolder "$work/image" "$work/$dmg"
  codesign --timestamp --sign "$identity" "$work/$dmg"
  codesign --verify --strict -R="$account" "$work/$dmg"
  mv "$work/$dmg" "$dir/$dmg"
  xcrun notarytool submit "$dir/$dmg" --keychain-profile "$profile" --output-format json > "$work/submission.json"
  jq -er '.id | select(test("^[0-9a-fA-F-]{36}$"))' "$work/submission.json" > "$work/submission-id"
  mv "$work/submission-id" "$dir/submission-id"
fi
submission=$(cat "$dir/submission-id")
echo "Waiting for Apple notarization of $version. This step can be resumed."
xcrun notarytool wait "$submission" --keychain-profile "$profile" --timeout 90m || true
xcrun notarytool info "$submission" --keychain-profile "$profile" --output-format json > "$work/result.json"
jq -er '.status == "Accepted"' "$work/result.json" >/dev/null || { jq -r '.status' "$work/result.json"; exit 1; }
xcrun stapler staple "$dir/$dmg"
xcrun stapler validate "$dir/$dmg"
codesign --verify --strict -R="$account" "$dir/$dmg"
spctl --assess --type open --context context:primary-signature "$dir/$dmg"
mkdir "$work/mount"
hdiutil attach -nobrowse -readonly -mountpoint "$work/mount" "$dir/$dmg" >/dev/null
trap 'hdiutil detach "$work/mount" -force >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
ditto "$work/mount/PutmanCode.app" "$work/PutmanCode.app"
hdiutil detach "$work/mount" >/dev/null
trap 'rm -rf "$work"' EXIT
app="$work/PutmanCode.app"
xcrun stapler staple "$app"
xcrun stapler validate "$app"
codesign --verify --deep --strict -R="$req" "$app"
spctl --assess --type execute "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$work/$name.zip"
node - "$root/apps/desktop/package.json" "$work/$name.zip" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), {createHash} = require('node:crypto');
const pkg = require('node:module').createRequire(process.argv[2]);
const builder = require('node:module').createRequire(pkg.resolve('electron-builder/package.json'));
const file = process.argv[3], version = pkg('./package.json').version;
(async () => {
  await builder('app-builder-lib/out/targets/blockmap/blockmap.js').buildBlockMap(file,'gzip',file+'.blockmap');
  const hash = createHash('sha512'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const entry = {url:path.basename(file),sha512:hash.digest('base64'),size:fs.statSync(file).size};
  fs.writeFileSync(path.join(path.dirname(file),'beta-mac.yml'),JSON.stringify({version,files:[entry],path:entry.url,sha512:entry.sha512,releaseDate:new Date().toISOString()},null,2)+'\n');
})().catch(e => { console.error(e);process.exitCode=1; });
NODE
mv "$work/$name.zip" "$work/$name.zip.blockmap" "$work/beta-mac.yml" "$dir/"
echo "Verified Apple Developer ID installer and updater files in $dir"

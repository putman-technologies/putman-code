#!/bin/bash
# Run on the signing Mac, using its existing Developer ID and notarytool profile.
set -euo pipefail
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.local/share/vite-plus/bin:$HOME/.cargo/bin:$PATH"
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

dir="$root/dist/developer-id/$sha"
name="Putman-Code-$version-arm64"
dmg="PutmanCode-$version-macOS-arm64.dmg"
assets=("$dmg" "$name.zip" "$name.zip.blockmap" "beta-mac.yml")
manifest="$dir/verified-assets.sha256"

asset_checksums() (
  cd "$dir" && shasum -a 256 "${assets[@]}"
)

stage_assets() {
  local asset want size metadata entry attempt done_upload
  for asset in "${assets[@]}"; do
    want="sha256:$(shasum -a 256 "$dir/$asset" | cut -d' ' -f1)"
    size=$(stat -f %z "$dir/$asset")
    done_upload=false
    for attempt in 1 2 3 4; do
      metadata=$(gh release view "$tag" --repo "$repo" --json isDraft,targetCommitish,assets)
      jq -e --arg sha "$sha" '.isDraft and .targetCommitish==$sha' <<<"$metadata" >/dev/null
      entry=$(jq -c --arg asset "$asset" '.assets[] | select(.name==$asset)' <<<"$metadata")
      if [[ -n "$entry" ]]; then
        if jq -e --arg digest "$want" --argjson size "$size" \
          '.state=="uploaded" and .digest==$digest and .size==$size' <<<"$entry" >/dev/null; then
          done_upload=true
          break
        fi
        echo "Existing draft asset $asset differs from the verified local copy or is incomplete." >&2
        return 1
      fi
      if [[ "$attempt" -lt 4 ]]; then
        # The server can accept the file before returning HTTP 500. Read back before retrying.
        gh release upload "$tag" --repo "$repo" "$dir/$asset" || true
        sleep "$attempt"
      fi
    done
    if [[ "$done_upload" != true ]]; then
      echo "GitHub has not confirmed $asset. Run this command again to resume the upload." >&2
      return 1
    fi
  done
  if [[ "$sha" == 0bf2ab0d4d34dec4b79415b83520f4e860d9c9cd ]]; then
    verification=17aabf549a48734ed2a5bec1071756ebc69dba3f
    branch=qa/beta-11-apple-profile
    existing=$(gh api "repos/$repo/git/matching-refs/heads/$branch" --jq ".[]|select(.ref==\"refs/heads/$branch\")|.object.sha")
    if [[ -z "$existing" ]]; then
      gh api -X POST "repos/$repo/git/refs" -f ref="refs/heads/$branch" -f sha="$verification" --silent
    else
      [[ "$existing" == "$verification" ]]
    fi
  fi
  echo "Signed files are in the GitHub draft for the preview-to-Developer ID upgrade check."
}

if [[ -f "$manifest" ]]; then
  if ! asset_checksums | cmp -s "$manifest" -; then
    echo "The signed files have changed since verification. Check the local release folder." >&2
    exit 1
  fi
  echo "Resuming the upload of the verified signed files for $version."
  stage_assets
  exit 0
fi

run=$(gh run list --repo "$repo" --workflow putmancode-desktop-release-build.yml --branch release/1.0.0 --commit "$sha" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
[[ -n "$run" ]] || { echo "No build for the draft release commit."; exit 1; }
security find-identity -v -p codesigning | grep -F "\"$identity\"" >/dev/null
if ! xcrun notarytool history --keychain-profile "$profile" --output-format json >/dev/null; then
  echo "Open Terminal in the Mac login session that holds the PutmanCode notarytool profile."
  exit 1
fi
echo "Waiting for verified Apple silicon packaging of $version."
primary=$run
ready=false
native=false
for ((attempt=0; attempt<144; attempt++)); do
  primary_metadata=$(gh api "repos/$repo/actions/runs/$primary")
  jq -e --arg sha "$sha" '.head_sha==$sha and .head_branch=="release/1.0.0" and .head_repository.full_name=="putman-technologies/putman-code"' <<<"$primary_metadata" >/dev/null
  result=$(jq -r '.conclusion // empty' <<<"$primary_metadata")
  if [[ "$result" == success ]]; then ready=true; break; fi
  # An alternate hosted runner checks out the same pinned release sources.
  if [[ "$sha" == 0bf2ab0d4d34dec4b79415b83520f4e860d9c9cd ]]; then
    alternate=45639215960
    metadata=$(gh api "repos/$repo/actions/runs/$alternate")
    jq -e '.head_sha=="20f01b3f7c625f2d0da7b991a539080ea5f5af24" and .path==".github/workflows/putmancode-beta11-mac-fallback.yml" and .head_repository.full_name=="putman-technologies/putman-code"' <<<"$metadata" >/dev/null
    if [[ "$(jq -r .conclusion <<<"$metadata")" == success ]]; then
      gh api "repos/$repo/actions/runs/$primary/jobs" | jq -e '[.jobs[] | select(.name!="Package and launch on macOS")] | length==8 and all(.[]; .conclusion=="success")' >/dev/null
      run=$alternate; ready=true; break
    fi
    if [[ "$(jq -r .status <<<"$metadata")" == completed && "$(jq -r .status <<<"$primary_metadata")" == completed ]]; then
      for build in "$primary" "$alternate"; do
        jobs=$(gh api "repos/$repo/actions/runs/$build/jobs?per_page=100")
        if ! jq -e '
          (.jobs|length)==.total_count and
          ([.jobs[] | select(.name=="Package and launch on macOS")] |
            length==1 and all(.[]; .status=="completed" and .conclusion=="cancelled" and .runner_id==0 and .steps==[])) and
          all(.jobs[] | select(.name!="Package and launch on macOS"); .conclusion=="success")' <<<"$jobs" >/dev/null; then
          echo "Build $build has a failed, incomplete, or executed job. Review https://github.com/$repo/actions/runs/$build" >&2
          exit 1
        fi
        if [[ "$build" == "$primary" ]] && ! jq -e '.total_count==9' <<<"$jobs" >/dev/null; then
          echo "Build $primary is missing expected release checks." >&2
          exit 1
        fi
      done
      native=true; ready=true
      break
    fi
  elif [[ -n "$result" ]]; then break
  fi
  sleep 25
done
[[ "$ready" == true ]] || { echo "No verified Mac build is ready. The draft is intact."; exit 1; }
mkdir -p "$dir"
work=$(mktemp -d "$dir/.working.XXXXXX")
trap 'rm -rf "$work"' EXIT
account='anchor apple generic and certificate leaf[subject.OU] = "2NZKUVA6F5" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
req="$account and identifier \"com.putmantechnologies.putmancode\""
if [[ ! -f "$dir/submission-id" ]]; then
  archive="$work/package/$name.zip"
  tested="$root/../release-beta11/mac-candidate/$name.zip"
  if [[ "$native" == true && "$sha" == 0bf2ab0d4d34dec4b79415b83520f4e860d9c9cd && -f "$tested" ]]; then
    mkdir -p "$work/package"
    cp "$tested" "$archive"
    actual=$(shasum -a 256 "$archive" | cut -d' ' -f1)
    [[ "$actual" == 9d26a9e36b60f9ea719dea1267ec2fdcb5a4ed659c50a28b7af30097757c13fa ]] || { echo "The prepared Beta 11 package does not match the tested archive." >&2; exit 1; }
    echo "Using the verified Beta 11 package. Signing with Apple Developer ID."
  elif [[ "$native" == true ]]; then
    checkout="$root/../putmancode-beta11-local-build"
    [[ "$(uname -sm)" == "Darwin arm64" && "$(git -C "$checkout" rev-parse HEAD)" == "$sha" ]]
    [[ -z "$(git -C "$checkout" status --porcelain --untracked-files=normal)" ]]
    echo "Packaging the verified release sources on this Mac."
    (cd "$checkout"
      SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
      CC=$(xcrun --sdk macosx --find clang)
      CXX=$(xcrun --sdk macosx --find clang++)
      export SDKROOT CC CXX
      export LDFLAGS="${LDFLAGS:+$LDFLAGS }-isysroot \"$SDKROOT\""
      APP_VERSION="$version" vp run build:desktop:bundle
      python3 scripts/verify-putmancode-privacy.py apps/desktop/dist-electron apps/server/dist
      vp run dist:desktop:artifact --skip-build --platform mac --target zip --arch arm64 --build-version "$version" --output-dir "$work/package"
    )
  else
    artifact=$(gh api "repos/$repo/actions/runs/$run/artifacts" --jq '.artifacts[] | select(.name=="mac-signing-candidate" and .expired==false)')
    id=$(jq -er .id <<<"$artifact")
    digest=$(jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))' <<<"$artifact")
    gh api "repos/$repo/actions/artifacts/$id/zip" > "$work/artifact.zip"
    actual=$(shasum -a 256 "$work/artifact.zip" | cut -d' ' -f1)
    [[ sha256:$actual == "$digest" ]]
    ditto -x -k "$work/artifact.zip" "$work/package"
  fi
  mkdir "$work/image"
  ditto -x -k "$archive" "$work/image"
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
asset_checksums > "$work/verified-assets.sha256"
mv "$work/verified-assets.sha256" "$manifest"
echo "Verified Apple Developer ID installer and updater files in $dir"
stage_assets

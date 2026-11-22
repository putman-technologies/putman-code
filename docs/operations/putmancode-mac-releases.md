# Distributing PutmanCode for Mac

Friends on Apple silicon install the first signed, notarized PutmanCode build in Applications. The app checks your public GitHub Releases feed and offers **Download** and **Install** when a newer stable release is available. The personal previews through v0.0.3 use an ad-hoc signature and require a manual switch to the first Developer ID build. Older previews labeled 0.1.10 also need that manual switch because 0.0.1 sorts below 0.1.10.

## One-time setup

1. Enroll in the Apple Developer Program. Create a **Developer ID Application** certificate and install it with its private key in the release Mac's keychain. Confirm the identity with `security find-identity -v -p codesigning`.
2. Configure notarization for electron-builder. For an App Store Connect team API key, set `APPLE_API_KEY` to the path to its private key file, plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` in the release environment. Keep the key outside the repository.
3. Use the public repository `putman-technologies/putman-code` for the desktop update feed. Sign in to GitHub CLI on the release Mac with access to publish a release. The installed apps can read the feed anonymously.
4. Keep the bundle identifier `com.putmantechnologies.putmancode` and signing team consistent across releases. Native passkeys are optional and require their own provisioning profile and associated domain when enabled.

## Release from GitHub Actions

1. Merge the reviewed release code and workflow to the repository’s default branch. Set the desktop and server versions together with `node scripts/update-release-package-versions.ts VERSION`. Pick a higher stable version for each published update.
2. In GitHub **Settings → Environments**, create **mac-release** and restrict it to the default branch. Add five environment secrets. `CSC_LINK` contains the base64-encoded password-protected .p12 export of your Developer ID Application identity and private key. `CSC_KEY_PASSWORD` unlocks that export. `APPLE_API_KEY` contains the full .p8 text of the App Store Connect team key for notarization. `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` identify that key. Enter the secrets directly in GitHub.
3. Open **Actions → Draft PutmanCode Mac release → Run workflow** on the default branch. The job builds the DMG and updater ZIP, checks the extracted ZIP’s Developer ID signature and Apple notarization ticket, and verifies the feed owner, version and SHA-512 hash.
4. Open the draft under **Releases** to review its assets. Publishing the stable release makes it available to signed installations on the feed. Friends who have a personal preview install the first signed DMG manually. Trial the next higher signed release through **Check for Updates** on one Mac before wider distribution.

## Publish a stable version

From the commit you intend to ship, set a higher version than the last public build. This example is for 0.0.4 on Apple silicon. Install dependencies with `vp i` first. Commit and push the version change and the features to release before setting the tag target.

```sh
node scripts/update-release-package-versions.ts 0.0.4
```

Build into a fresh, version-specific directory. The DMG target also emits the updater ZIP and metadata. Supply the same Apple signing identity on each build.

```sh
T3CODE_DESKTOP_UPDATE_REPOSITORY=putman-technologies/putman-code \
  vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 \
  --build-version 0.0.4 --signed --output-dir release/friends-0.0.4
```

Mount the DMG. Verify the app with `codesign --verify --deep --strict`, `spctl --assess --type execute --verbose`, and `xcrun stapler validate`, each followed by the path to the app. Check that its Resources/app-update.yml names your GitHub owner and repository. Check that latest-mac.yml lists 0.0.4 and the ZIP filename in the output directory.

Create a draft GitHub Release with the DMG for first installs, the ZIP for updates, the generated blockmaps, and latest-mac.yml. Preserve the generated asset filenames. Verify the draft and publish it as a stable release.

```sh
gh release create v0.0.4 --repo putman-technologies/putman-code \
  --target "$(git rev-parse HEAD)" --draft --title "PutmanCode 0.0.4" \
  --generate-notes release/friends-0.0.4/*.dmg release/friends-0.0.4/*.zip \
  release/friends-0.0.4/*.blockmap release/friends-0.0.4/latest-mac.yml
gh release edit v0.0.4 --repo putman-technologies/putman-code --draft=false --latest
```

On a second Mac with the previous signed build in Applications, check for an update from the app, download, install, and confirm the new version and existing projects. Run this trial before inviting more friends. Intel Macs need an x64 or universal build and a feed containing the matching artifacts.

[Electron macOS signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) · [Electron Builder updates](https://www.electron.build/docs/features/auto-update/) · [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

## Desktop beta updates

Mac and Windows beta installations check GitHub's beta feed. Each release needs the installable DMG and EXE, both beta manifests, the Mac update ZIP, and matching block maps. Electron's Mac updater checks the installed application's designated signing requirement before accepting its replacement. Use the same release identity for every beta. Beta 1 through 6 require a one-time installer download.

1. Push the versioned source to `release/1.0.0` and wait for **Build PutmanCode desktop release**. Keep the exact commit and successful run ID.
2. On the release Mac, download the `mac-signing-candidate` and `mac-upgrade-fixture` artifacts. Set `PUTMANCODE_BETA_SIGNING_ID` to the release certificate's SHA-1 identity in the Mac Keychain. Run `scripts/sign-putmancode-beta-mac.sh INPUT.zip OUTPUT VERSION` on each ZIP with separate output directories. Use the release version for the candidate and `1.0.0-beta.0` for the test fixture. Compare the candidate's designated requirement with the last published beta before changing identities.
3. Create a GitHub draft prerelease at the exact build commit. Attach the candidate's ZIP, ZIP block map and `beta-mac.yml`, plus the verified Windows EXE, EXE block map and `beta.yml`. Attach the signed fixture ZIP as `previous-mac-fixture.zip` for the native tests.
4. Push that same commit to a new branch named `verify/desktop-beta-<version>`. **Verify packaged PutmanCode beta updates** checks the button, download, install and relaunch on both operating systems. Attach its `verified-beta-dmg` artifact to the draft and remove the temporary fixture from the draft. Compare the GitHub release asset digests with the verified local files before publishing the prerelease.

The beta signing key stays on the release Mac. A Developer ID and notarization are still required for the notarized distribution described above.

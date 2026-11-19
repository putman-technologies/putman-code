# Distributing PutmanCode for Mac

Friends on Apple silicon install the first signed, notarized PutmanCode build in Applications. The app checks your public GitHub Releases feed and offers **Download** and **Install** when a newer stable release is available. The personal v0.0.1 preview uses an ad-hoc signature and requires a manual switch to the first Developer ID build. Older previews labeled 0.1.10 also need that manual switch because 0.0.1 sorts below 0.1.10.

## One-time setup

1. Enroll in the Apple Developer Program. Create a **Developer ID Application** certificate and install it with its private key in the release Mac's keychain. Confirm the identity with `security find-identity -v -p codesigning`.
2. Configure notarization for electron-builder. For an App Store Connect team API key, set `APPLE_API_KEY` to the path to its private key file, plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` in the release environment. Keep the key outside the repository.
3. Use the public repository `austin-putmantech/putman-code` for the desktop update feed. Sign in to GitHub CLI on the release Mac with access to publish a release. The installed apps can read the feed anonymously.
4. Keep the bundle identifier `com.putmantechnologies.putmancode` and signing team consistent across releases. Native passkeys are optional and require their own provisioning profile and associated domain when enabled.

## Publish a stable version

From the commit you intend to ship, set a higher version than the last public build. This example is for 0.0.2 on Apple silicon. Install dependencies with `vp i` first. Commit and push the version change and the features to release before setting the tag target.

```sh
node scripts/update-release-package-versions.ts 0.0.2
```

Build into a fresh, version-specific directory. The DMG target also emits the updater ZIP and metadata. Supply the same Apple signing identity on each build.

```sh
T3CODE_DESKTOP_UPDATE_REPOSITORY=austin-putmantech/putman-code \
  vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 \
  --build-version 0.0.2 --signed --output-dir release/friends-0.0.2
```

Mount the DMG. Verify the app with `codesign --verify --deep --strict`, `spctl --assess --type execute --verbose`, and `xcrun stapler validate`, each followed by the path to the app. Check that its Resources/app-update.yml names your GitHub owner and repository. Check that latest-mac.yml lists 0.0.2 and the ZIP filename in the output directory.

Create a draft GitHub Release with the DMG for first installs, the ZIP for updates, the generated blockmaps, and latest-mac.yml. Preserve the generated asset filenames. Verify the draft and publish it as a stable release.

```sh
gh release create v0.0.2 --repo austin-putmantech/putman-code \
  --target "$(git rev-parse HEAD)" --draft --title "PutmanCode 0.0.2" \
  --generate-notes release/friends-0.0.2/*.dmg release/friends-0.0.2/*.zip \
  release/friends-0.0.2/*.blockmap release/friends-0.0.2/latest-mac.yml
gh release edit v0.0.2 --repo austin-putmantech/putman-code --draft=false --latest
```

On a second Mac with the previous signed build in Applications, check for an update from the app, download, install, and confirm the new version and existing projects. Run this trial before inviting more friends. Intel Macs need an x64 or universal build and a feed containing the matching artifacts.

[Electron macOS signing](https://www.electronjs.org/docs/latest/tutorial/code-signing) · [Electron Builder updates](https://www.electron.build/docs/features/auto-update/) · [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

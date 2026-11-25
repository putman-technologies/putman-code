# Personal Mac beta updates

This temporary feed is for an Apple silicon Mac with a published PutmanCode beta in /Applications. Run `/usr/bin/python3 preview.py setup` in Terminal on that Mac. Approve the code-signing certificate for your user account if Keychain asks. Setup can take a few minutes.

Setup stages a signed copy of your installed version and the newest published beta. After Finder reveals the prepared PutmanCode.app in the Ready folder, quit PutmanCode, move the prepared app into Applications and choose Replace. Open it from Applications. Choose Check for Updates, Download and Install. Changing the app’s signer can cause macOS to ask again for access to its existing login Keychain items.

A per-user LaunchAgent listens on 127.0.0.1 and checks the PutmanCode GitHub releases every ten minutes while you are logged in. Only Apple silicon beta DMGs from the project’s release URL with a matching GitHub SHA-256 are staged. The helper checks the original app, verifies the privately signed update after extracting its ZIP, and then replaces the update manifest. Your signing key stays in your Mac’s Keychain. The personal certificate is valid for 90 days.

If a newer beta has yet to appear, the refresh errors are in `~/Library/Application Support/PutmanCode Private Updates/feed.log`. Rerun setup to repair the feed using the same identity.

## Switch to the Apple-signed release

Install the first official Developer ID build manually. After opening it, you can stop the private feed and retire its launch configuration in Terminal.

```bash
launchctl bootout "gui/$(id -u)/com.putmantechnologies.putmancode.private-updates"
rm -f "$HOME/Library/LaunchAgents/com.putmantechnologies.putmancode.private-updates.plist"
```

Use Keychain Access to remove the matching **PutmanCode Private Preview** identity when you’re finished using it. The staging folder is `~/Library/Application Support/PutmanCode Private Updates`. It is separate from the app’s projects and settings.

# PutmanCode

PutmanCode is a desktop workspace for coding agents. Organize work into projects and chats, review pull requests, and run your configured GitHub workflows.

## On a Mac

Open **PutmanCode.app**. The default workspace has a light editor and a navy project sidebar. Choose **Dark** or **System** in **Settings → Appearance** to change the appearance.

Projects and thread history are stored under `~/.putman-code/userdata`. Your repository stays in the folder you chose when adding the project. Fresh installs keep Chromium preferences under `~/Library/Application Support/PutmanCode`. Upgrades from the earlier fork reuse its existing `Putman Code` profile. Set `PUTMANCODE_HOME` to choose another app data directory.

Anonymous product usage reporting is disabled.

The Projects list stays above the thread list. Select a project to filter its chats, or use its pencil button to start a chat there. The badge beside each project follows its latest coordinator handoff and refreshes every minute. **Needs review** covers unlinked work, approvals, and failed checks. **CI running** follows pending GitHub checks. After merge, **Awaiting deploy** changes to **Deployed** when GitHub records a successful deployment for that merge commit in the Production or Prod environment.

## Sharing Mac updates

For distributing signed releases to other Macs, follow the [PutmanCode Mac release guide](./docs/operations/putmancode-mac-releases.md).

## Development

Install dependencies with `vp i`. Use `vp run dev` for a local workspace or `vp run build:desktop:bundle` to compile the desktop client and bundled server.

See the [license](./LICENSE) for the upstream project's attribution and license terms.

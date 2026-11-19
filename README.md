# PutmanCode

PutmanCode is a desktop workspace for coding agents. Each project has a coordinator chat. Open feature chats for individual changes, then use **Send to Coordinator** on a completed run to pass the result back. PutmanCode archives the feature chat after it saves the handoff.

## On a Mac

Open **PutmanCode.app**. The default workspace has a light editor, navy project sidebar, and blue coordinator button. Choose **Dark** or **System** in **Settings → Appearance** to change the appearance.

Projects and thread history are stored under `~/.putman-code/userdata`. Your repository stays in the folder you chose when adding the project. Fresh installs keep Chromium preferences under `~/Library/Application Support/PutmanCode`. Upgrades from the earlier fork reuse its existing `Putman Code` profile. Set `PUTMANCODE_HOME` to choose another app data directory.

## Development

Install dependencies with `vp i`. Use `vp run dev` for a local workspace or `vp run build:desktop:bundle` to compile the desktop client and bundled server.

See the [license](./LICENSE) for the upstream project's attribution and license terms.

# PutmanCode

PutmanCode is a desktop workspace from Putman Technologies for working with coding agents. Each project has a coordinator chat where you can review work from individual feature chats and follow it through GitHub checks, merge, and deployment.

## Working on a change

1. Select your project and open a feature chat for the change.
2. When the agent finishes, choose **Send to Coordinator**. PutmanCode saves the checkout, linked pull requests, and available script results in the project coordinator, then archives the feature chat.
3. Open the coordinator to review the handoff. The project badge shows **Needs review** when a change needs attention and **CI running** while GitHub checks are pending. After a merge, **Awaiting deploy** changes to **Deployed** when GitHub records a successful production deployment for that commit.

## Running PutmanCode from source

The [PutmanCode release branch](https://github.com/putman-technologies/putman-code/tree/release/1.0.0) contains the customized app. With [Vite+](https://viteplus.dev/guide/) installed, use these commands to start the desktop app.

```sh
git clone --branch release/1.0.0 https://github.com/putman-technologies/putman-code.git
cd putman-code
vp i
vp run dev:desktop
```

For Mac distribution, see the [PutmanCode Mac release guide](https://github.com/putman-technologies/putman-code/blob/release/1.0.0/docs/operations/putmancode-mac-releases.md).

## Origins and license

PutmanCode is a fork of [T3 Code](https://github.com/pingdotgg/t3code) and is distributed under the [MIT license](./LICENSE).

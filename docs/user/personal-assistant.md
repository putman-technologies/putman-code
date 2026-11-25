# Personal assistant

On macOS or Windows, click the conversation icon immediately to the right of the navigation arrows. **Personal assistant** keeps a single conversation under your Linux user account. Each computer can use its own SSH alias for the same account. Anyone with access to that Linux account can access the conversation.

## Connect your VPS

1. On the desktop computer, confirm that you can log in with an SSH key or agent. For example, use `ssh devbox` with your own alias. On Windows, use Windows OpenSSH. Verify the host fingerprint the first time you connect.
2. The Linux server needs Python 3, systemd user services and a current Codex CLI signed in under that SSH account. On the server, run `codex login status`. If necessary, run `codex login --device-auth`. The worker checks the user's `~/.local/bin`, `~/.npm-global/bin`, and system PATH for Codex.
3. In **Personal assistant**, enter the alias or `user@hostname` and choose **Connect and install worker**. The app installs a user service over SSH. It uses the existing SSH port.
4. On your other desktop, connect to the same Linux account. The app opens its saved conversation.

Closing PutmanCode leaves the queue on the server. If the app shows the lingering notice, run `loginctl enable-linger` as the SSH user. If the host requires an administrator, ask the administrator to enable lingering for that username. Linux can then keep the service running after the last session ends and start it after a reboot. Check it on the VPS with `systemctl --user status putmancode-assistant.service`.

## Run a task

Enter a question or paste text or CSV rows from your tracker. The assistant uses the server's Codex sign-in for responses and live web research. Ask for current openings, original employer links, salary and location. Give it your criteria and ask a follow-up in the same conversation. Up to eight recent completed exchanges are included as context. Older messages remain in history.

Tasks show **Queued**, **Running**, **Completed**, **Needs your answer**, or **Failed**. A task interrupted by a worker restart is marked failed so you can decide whether to resend it. The pilot can analyze tracker data you paste. Email accounts and desktop tracker files require a future connection.

## Enable Android alerts

1. Install [Pushover for Android](https://pushover.net/clients/android), sign in, and allow notifications.
2. Get your user key from [your Pushover dashboard](https://pushover.net/) and [register a Pushover application](https://pushover.net/apps/build) to obtain an application token.
3. Choose **Android notifications**, enter the two keys, and select **Send test and save**. The VPS sends a test and saves the keys after Pushover accepts it. Confirm arrival on your phone. Pushover has its own trial and pricing.
4. Select **Notify me when done** on each task you want an alert for. The VPS sends a generic status message when it finishes, fails, or needs an answer. View the full result in PutmanCode on either desktop. **Disconnect phone** removes the saved keys and turns off pending alerts.

The service stores conversation history and notification credentials in a user-only directory at `~/.local/share/putmancode-assistant`. To stop it, run `systemctl --user disable --now putmancode-assistant.service`. To reconnect, choose **Change server**, enter the host and install the worker again.

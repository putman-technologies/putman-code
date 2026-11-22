# Use your PutmanCode settings on another device

Start on the Mac or Windows PC that already has your projects and VPS connection. Open **Settings → General → Microsoft 365 → Sign in with Microsoft 365**. Choose your Putman Technologies work account in the browser, allow access to PutmanCode’s own OneDrive folder, then return to the app. **Settings synced** confirms the first save. Your account needs a provisioned OneDrive for Business.

Open the same sign-in option on your other computer. On Android it is under **Settings → Microsoft 365**. If a profile already exists, the new device restores it. While PutmanCode is open, it checks for changes about once a minute. **Sync now** also checks immediately. After going offline, use **Sync now** when you reconnect.

| On the new device          | What to expect                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Appearance and preferences | Desktop restores the supported chat, diff, language, accessibility and confirmation settings. Android applies language, appearance mode and supported themes.                                                |
| VPS                        | On desktop open **Add environment → SSH** and select the saved server details. Set up access with that computer’s own SSH key or agent. Connect the device to your tailnet first if the host uses Tailscale. |
| Android connection         | Open **Add environment**, select a saved HTTPS address and enter a fresh pairing code from the host. You can also scan the host’s pairing QR code.                                                           |
| Assistant and phone alerts | The profile remembers the assistant’s host. Assistant history, jobs and existing Pushover settings stay on that host. Notification permissions and delivery on a new phone are set up on the phone.          |

Microsoft stores the profile in the app folder of your own OneDrive. SSH private keys, pairing codes and provider credentials stay on the device that uses them. **Sign out** disconnects only the current device. Your settings remain in OneDrive for your other devices.

# Privacy Policy — Quick Notes

**Last updated**: April 2026

## Summary

Quick Notes is a local-first Chrome extension. By default, all your data stays on your device. Optional Google Drive sync is opt-in and uses a minimum-privilege scope that cannot access your other Drive files.

## What data the extension handles

Quick Notes handles the following data **only on your local device**, never on a remote server owned by the developer:

- **Notes content** — the text, images, and formatting you type into notes.
- **History** — records of paste / selection / URL-capture operations you trigger (capped at 200 entries).
- **Settings** — your configured themes, URL-pattern rules, per-site default notes, panel opacity, and shape preferences.
- **Pasted page content** — if you click the "Paste clipboard," "Insert URL," or "Insert selection" buttons, the content goes into your active note.

This data is stored in Chrome's built-in `chrome.storage.local` API, which is sandboxed per-extension and local to your browser profile.

## What the extension does NOT do

- It does **not** collect, transmit, or share your notes with the developer, any analytics service, any advertiser, or any third party.
- It does **not** contain tracking code, telemetry, or remote logging.
- It does **not** read page content automatically. Page content is only captured when you explicitly click a capture button.
- It does **not** make any network requests at all, unless you opt into Google Drive sync (see below).

## Optional: Google Drive sync

If you **explicitly** enable Google Drive sync in the options page:

- You grant the extension access to the `https://www.googleapis.com/auth/drive.appdata` scope only. This scope allows the extension to read and write files in a hidden per-app folder (the "appDataFolder") in your Google Drive. This folder is **not visible** in your regular Drive UI and cannot be accessed by any other application.
- The extension **cannot** see, read, or modify any of your other Drive files. The `drive.appdata` scope is specifically restricted to its own sandbox.
- Your notes, history, images, and settings are packaged as a single JSON file and uploaded to this private folder, then re-downloaded when you sync on another device.
- Sync frequency is configurable (manual, or every 5/15/30/60 minutes). You can sign out at any time from the options page.

No other Google APIs or services are contacted.

## Third-party services

Quick Notes uses exactly one optional third-party service:

- **Google Drive** (only when sync is enabled). Its own privacy policy applies: <https://policies.google.com/privacy>.

No other third parties are involved.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save notes and settings locally in `chrome.storage.local`. |
| `scripting` | Inject the floating panel into the active tab on user command. |
| `clipboardRead` | The Paste button reads the clipboard — only when you click it. |
| `contextMenus` | Right-click menu entries for sending selected text / URLs to notes. |
| `identity` | Google sign-in (only if you enable Drive sync). |
| `alarms` | Schedule periodic auto-sync to Drive (only if enabled). |
| `host_permissions: <all_urls>` | So the floating panel can be shown on any page. **No page content is read** unless you click Insert URL / Insert Selection. |

## Data you can export

At any time, you can export **all** your local data as a JSON file via the options page's Backup & Restore section. This file is saved via your browser's normal download flow — the extension does not upload it anywhere.

## Data deletion

To delete all your Quick Notes data:

- **Local**: Options page → Storage → "Reset everything." Or uninstall the extension.
- **Google Drive (if sync was enabled)**: Options → Google Drive sync → Sign out. Then visit <https://myaccount.google.com/permissions>, find Quick Notes, and revoke access. Any files already synced to your Drive appdata folder are deleted automatically when the extension is uninstalled, or you can delete them yourself via the Drive API or reset your Google account permissions.

## Children's privacy

Quick Notes is not directed at children under 13. If you are the parent or guardian of a child under 13 who has installed this extension, you may remove it at any time.

## Changes to this policy

If this policy changes, the new version will be committed to the public repository at
<https://github.com/quicknotes/quick-notes/blob/main/PRIVACY.md> with a new "Last updated" date.

## Contact

Open an issue at <https://github.com/quicknotes/quick-notes/issues>.

---

**Developer**: @mthcht · <https://github.com/mthcht>
**Source code**: <https://github.com/quicknotes/quick-notes>
**License**: MIT

# Codebase Structure: Quick Notes
- `manifest.json`: Extension metadata and permissions.
- `background.js`: Service worker handling context menus, commands, and tab updates.
- `content.js`: Content script injected into pages to provide the floating panel UI.
- `popup.js`: Logic for the editor UI (shared by popup.html and standalone popup).
- `options.js`: Settings page logic.
- `drive-sync.js`: Logic for Google Drive API interaction (imported via `importScripts` in background.js or script tags).
- `icons/`: Extension assets.

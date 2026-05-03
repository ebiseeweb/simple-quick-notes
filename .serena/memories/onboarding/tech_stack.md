# Tech Stack: Quick Notes
- **Languages**: Vanilla JavaScript (ESM where supported), HTML5, CSS3.
- **Extension Platform**: Manifest V3.
- **Persistence**: `chrome.storage.local` (Sync uses `drive.appdata` scope).
- **UI Components**:
  - `content.js`: Floating panel injected into pages using Shadow DOM for CSS isolation.
  - `popup.js`: Main editor logic for both the toolbar popup and standalone view.
  - `options.js`: Settings and configuration.
- **Build System**: None. Files are loaded directly by the browser.

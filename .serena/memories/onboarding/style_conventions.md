# Style and Conventions: Quick Notes
- **Language**: Vanilla JavaScript.
- **Indentation**: 2 spaces.
- **Naming**: camelCase for functions and variables.
- **DOM Access**: Often uses a helper `const $ = (id) => document.getElementById(id)`.
- **State Management**: Uses a central `state` object in `popup.js` and `content.js`.
- **Storage**: Uses `chrome.storage.local`. In `popup.js`, `storageSet` is used to track "self-writing" to avoid feedback loops.
- **UI**: Uses Vanilla CSS with CSS variables for themes.
- **Markdown**: Implements a custom (or semi-custom) Markdown parser and renderer.

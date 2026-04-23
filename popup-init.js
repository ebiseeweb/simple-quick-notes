// Sets a "standalone" class on <html> when popup.html is loaded as a full
// tab (?standalone=1) rather than as the extension popup. This file exists
// because Manifest V3's strict CSP forbids inline <script> in extension
// pages — the same logic can't live in popup.html itself.
if (location.search.includes('standalone=1')) {
  document.documentElement.classList.add('standalone');
}

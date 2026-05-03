// Quick Notes Utilities
const Utils = {
  genId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  
  deriveTitle: (c) => {
    const f = (c.split('\n')[0] || '').trim().slice(0, 40);
    return f || 'Untitled';
  },
  
  hashStr: (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h.toString(36);
  },
  
  matchPattern: (url, pattern) => {
    if (!pattern || !url) return false;
    try {
      const re = pattern
        .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\*/g, '.*');
      return new RegExp('^' + re + '$').test(url);
    } catch { return false; }
  },
  
  escapeHtml: (s) => {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  },
  
  pickDefaultNoteId: (url, siteDefaults, notes) => {
    if (!url || !siteDefaults || !notes) return null;
    for (const [pat, noteId] of Object.entries(siteDefaults)) {
      if (Utils.matchPattern(url, pat) && notes.some(n => n.id === noteId)) {
        return noteId;
      }
    }
    return null;
  },
  
  fmtTime: (ts) => {
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },
  
  normalizeShape: (s) => {
    const VALID_SHAPES = ['rectangle', 'rounded', 'hexagon', 'circle'];
    return VALID_SHAPES.includes(s) ? s : 'rounded';
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Utils;
} else {
  // Expose to global scope in browser
  window.Utils = Utils;
}

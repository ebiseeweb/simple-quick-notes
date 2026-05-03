// Quick Notes v5 · floating panel (content script)
// Full-featured editor rendered into an isolated Shadow DOM on the host page.
// Injected lazily by the background worker; idempotent re-injection.

(function () {
  if (window.__quickNotesInstalled) {
    // Message listener from a prior injection will handle the new command.
    return;
  }
  window.__quickNotesInstalled = true;

  const HOST_ID = '__quicknotes_host__';
  const STATE_KEYS = [
    'notes', 'activeId', 'theme', 'history',
    'settings', 'panel', 'shape', 'opacity',
    'split', 'splitDir', 'pane2Id', 'paneRatio',
    'fontSize', 'zen', 'images', 'customColors', 'lastView'
  ];
  const MAX_HISTORY = 200;

  let host = null;
  let shadow = null;
  let root = null;
  let panel = null;     // the shape frame
  let textarea = null;
  let previewEl = null;
  let noteSelect = null;
  let statusEl = null;
  let counterEl = null;
  let searchInput = null;
  let searchResults = null;
  let searchCount = null;
  let historyListEl = null;
  let historyCountEl = null;
  let visible = false;
  let saveTimer = null;
  let isBootstrapping = false;
  let previewOn = false;

  // View management
  let currentView = 'home'; // 'home' | 'editor' | 'search' | 'history'
  let lastView = 'home';

  let state = {
    notes: [],
    activeId: null,
    theme: 'dark',
    history: [],
    settings: { autoPasteSites: [], floatingPanelSites: [], siteDefaults: {}, lastAutoPastedHash: '' },
    panel: { top: 80, left: null, right: 24, width: 420, height: 540, collapsed: false },
    shape: 'rectangle',
    opacity: 1,
    split: false,            // on/off toggle
    splitDir: 'h',           // 'h' (horizontal) or 'v' (vertical) — remembered between sessions
    pane2Id: null,           // note id shown in pane 2
    paneRatio: 0.5,          // 0..1, size of pane 1 as fraction of body
    fontSize: 13,            // text zoom in px (textarea + preview)
    zen: false,              // distraction-free mode (toolbar + footer hidden)
    images: {},              // { [imageId]: 'data:image/...;base64,...' } — keeps notes clean
    customColors: { dark: {}, light: {} }   // user-customized theme colors
  };

  // Guard against focus-steal echoes from our own writes.
  let selfWriting = 0;
  function isContextValid() {
    return !!chrome.runtime?.id;
  }

  async function storageSet(obj) {
    if (!isContextValid()) {
      console.warn('[QuickNotes] Extension context invalidated. Changes may not be saved. Please refresh the page.');
      if (statusEl) {
        statusEl.textContent = 'context error (refresh page)';
        statusEl.classList.remove('qn-ok');
      }
      return;
    }
    selfWriting++;
    try { await chrome.storage.local.set(obj); }
    catch (e) {
      if (e.message.includes('Extension context invalidated')) {
        console.warn('[QuickNotes] Extension context invalidated during write.');
      } else throw e;
    }
    finally {
      setTimeout(() => { selfWriting = Math.max(0, selfWriting - 1); }, 0);
    }
  }

  // ---------- Helpers ----------
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const activeNote = () => state.notes.find(n => n.id === state.activeId);
  const deriveTitle = (c) => (c.split('\n')[0] || '').trim().slice(0, 40) || 'Untitled';
  const hashStr = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return h.toString(36);
  };
  const matchPattern = (url, pattern) => {
    if (!pattern || !url) return false;
    try {
      const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
      return new RegExp('^' + re + '$').test(url);
    } catch { return false; }
  };
  const matchesAny = (url, pats) => !!pats && pats.some(p => matchPattern(url, p));
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- Storage ----------
  async function loadState() {
    if (!isContextValid()) return;
    const d = await chrome.storage.local.get(STATE_KEYS);
    state.notes = (d.notes && d.notes.length)
      ? d.notes
      : [{ id: genId(), title: 'Untitled', content: '', updatedAt: Date.now(), pinned: false }];
    state.notes.forEach(n => { if (n.pinned == null) n.pinned = false; });

    state.theme = d.theme || 'dark';
    state.history = d.history || [];
    state.settings = Object.assign(
      { autoPasteSites: [], floatingPanelSites: [], siteDefaults: {}, lastAutoPastedHash: '' },
      d.settings || {}
    );
    state.panel = Object.assign(state.panel, d.panel || {});
    const VALID_SHAPES = ['rectangle', 'rounded', 'hexagon', 'circle'];
    const raw = d.shape || 'rounded';
    state.shape = VALID_SHAPES.includes(raw) ? raw : 'rounded';
    const rawOp = typeof d.opacity === 'number' ? d.opacity : 1;
    state.opacity = Math.max(0.3, Math.min(1, rawOp));
    state.split = d.split === true;
    state.splitDir = (d.splitDir === 'v') ? 'v' : 'h';
    state.pane2Id = d.pane2Id || null;
    state.paneRatio = (typeof d.paneRatio === 'number' && d.paneRatio > 0.15 && d.paneRatio < 0.85)
      ? d.paneRatio : 0.5;
    const fs = Number(d.fontSize);
    state.fontSize = (fs >= 10 && fs <= 28) ? fs : 13;
    state.zen = d.zen === true;
    state.images = (d.images && typeof d.images === 'object') ? d.images : {};
    state.customColors = (d.customColors && typeof d.customColors === 'object') ? d.customColors : { dark: {}, light: {} };

    // One-time migration: extract any inline `data:image/...;base64,...` URLs
    // from note content and replace with qn-img:ID refs. Also strip leading
    // zero-width / invisible characters that often sneak in from paste
    // operations and cause the preview to show mysterious empty space at
    // the top of notes.
    let migrated = false;
    const INLINE_IMG_RE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z.+-]+;base64,[A-Za-z0-9+/=]+)\)/g;
    // Matches zero-width chars and soft hyphens that trim() doesn't catch
    const ZWS_RE = /[\u200B-\u200D\uFEFF\u00AD]/g;
    for (const note of state.notes) {
      if (!note.content) continue;
      let content = note.content;
      if (content.includes('data:image/')) {
        content = content.replace(INLINE_IMG_RE, (_, alt, dataUrl) => {
          const imgId = 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
          state.images[imgId] = dataUrl;
          return `![${alt}](qn-img:${imgId})`;
        });
      }
      // Strip zero-width chars and collapse leading blank lines so the
      // note doesn't render with mystery whitespace at the top.
      const cleaned = content.replace(ZWS_RE, '').replace(/^(?:[ \t]*\n)+/, '');
      if (cleaned !== note.content) {
        note.content = cleaned;
        migrated = true;
      }
    }
    if (migrated) {
      await chrome.storage.local.set({ notes: state.notes, images: state.images });
    }

    // Per-site default note
    const perSite = pickDefaultNoteId(location.href);
    const storedActive = d.activeId && state.notes.some(n => n.id === d.activeId)
      ? d.activeId : state.notes[0].id;
    state.activeId = perSite || storedActive;

    if (perSite) {
      currentView = 'editor';
    } else if (d.lastView && (d.lastView === 'home' || d.lastView === 'editor')) {
      currentView = d.lastView;
    } else {
      currentView = 'home';
    }
  }

  function showView(viewId) {
    if (!shadow) return;
    const views = ['homeView', 'editorView', 'searchView', 'historyView'];
    
    views.forEach(v => shadow.getElementById(v).hidden = true);
    shadow.getElementById(viewId).hidden = false;
    currentView = viewId.replace('View', '');

    // Save location
    if (viewId === 'homeView' || viewId === 'editorView') {
      storageSet({ lastView: currentView });
    }
    
    if (viewId === 'homeView') renderHome();
    if (viewId === 'searchView') {
      if (searchInput) {
        searchInput.value = '';
        runSearch();
        setTimeout(() => searchInput.focus(), 30);
      }
    }
    if (viewId === 'historyView') renderHistory();
    if (viewId === 'editorView') {
      if (textarea) textarea.focus();
    }
  }

  function pickDefaultNoteId(url) {
    if (!url) return null;
    const map = state.settings.siteDefaults || {};
    for (const [pat, noteId] of Object.entries(map)) {
      if (matchPattern(url, pat) && state.notes.some(n => n.id === noteId)) return noteId;
    }
    return null;
  }

  // ---------- Build DOM ----------
  function buildPanel() {
    if (document.getElementById(HOST_ID)) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial; position:fixed; top:0; left:0; width:0; height:0; z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });

    root = document.createElement('div');
    root.innerHTML = `
<style>
  :host, * { box-sizing: border-box; }

  /* ===== Theme tokens ===== */
  .qn-wrap {
    --panel-alpha: 1;
  }
  .qn-wrap[data-theme="dark"] {
    --bg-rgb: 31 31 30;           /* #1F1F1E */
    --bg-alt-rgb: 44 44 42;       /* #2C2C2A */
    --bg: rgb(var(--bg-rgb) / var(--panel-alpha));
    --bg-alt: rgb(var(--bg-alt-rgb) / var(--panel-alpha));
    --bg-elev: #26262410;
    --fg: #e8e6e3;
    --fg-dim: #c1beb8;
    --muted: #8a857e;
    --border: #3a3a37;
    --border-strong: #4a4a46;
    --btn: rgb(var(--bg-alt-rgb) / var(--panel-alpha));
    --btn-hover: #373734;
    --btn-active: #42423e;
    --accent: #d4a85f;
    --accent-soft: #d4a85f22;
    --warn: #e57373;
    --row-hover: #2a2a28;
    --highlight: #fde047;
    --highlight-fg: #111;
    --shadow: 0 12px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.3);
  }
  .qn-wrap[data-theme="light"] {
    --bg-rgb: 250 250 248;        /* #fafaf8 */
    --bg-alt-rgb: 243 242 238;    /* #f3f2ee */
    --bg: rgb(var(--bg-rgb) / var(--panel-alpha));
    --bg-alt: rgb(var(--bg-alt-rgb) / var(--panel-alpha));
    --bg-elev: #ffffff;
    --fg: #1a1a1a;
    --fg-dim: #3a3a3a;
    --muted: #6b7280;
    --border: #e5e4de;
    --border-strong: #cfcec8;
    --btn: #ffffff;
    --btn-hover: #ededea;
    --btn-active: #dcdbd5;
    --accent: #8a5a1a;
    --accent-soft: #8a5a1a1a;
    --warn: #dc2626;
    --row-hover: #f3f2ee;
    --highlight: #fde68a;
    --highlight-fg: #111;
    --shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06);
  }

  /* ===== Wrap ===== */
  .qn-wrap {
    position: fixed;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    color: var(--fg);
    display: flex;
    flex-direction: column;
    pointer-events: auto;
  }

  /* The visible "paper" — gets shape clipping */
  .qn-paper {
    position: absolute;
    inset: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 10px;
    transition: clip-path 220ms ease, border-radius 220ms ease;
  }

  /* ===== Shapes (only shapes that keep all buttons reachable) ===== */
  .qn-wrap[data-shape="rectangle"] .qn-paper { border-radius: 4px; }
  .qn-wrap[data-shape="rounded"]   .qn-paper { border-radius: 18px; }
  .qn-wrap[data-shape="circle"]    .qn-paper { border-radius: 50%; }
  .qn-wrap[data-shape="hexagon"]   .qn-paper {
    clip-path: polygon(12% 0%, 88% 0%, 100% 50%, 88% 100%, 12% 100%, 0% 50%);
    border-radius: 0;
  }
  /* Inset content for clipped shapes so the edge curves/cuts don't eat buttons */
  .qn-wrap[data-shape="circle"] .qn-head,
  .qn-wrap[data-shape="circle"] .qn-bar,
  .qn-wrap[data-shape="circle"] .qn-foot {
    padding-left: 14%;
    padding-right: 14%;
    flex-wrap: wrap;
    justify-content: center;
  }
  .qn-wrap[data-shape="circle"] .qn-body,
  .qn-wrap[data-shape="circle"] .qn-preview {
    padding-left: 12%;
    padding-right: 12%;
  }
  .qn-wrap[data-shape="hexagon"] .qn-head,
  .qn-wrap[data-shape="hexagon"] .qn-bar,
  .qn-wrap[data-shape="hexagon"] .qn-foot {
    padding-left: 6%;
    padding-right: 6%;
  }

  /* ===== Header (draggable) ===== */
  .qn-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 7px 10px;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    cursor: grab;
    user-select: none;
    min-height: 38px;
    overflow: hidden;            /* never let buttons overflow horizontally */
  }
  .qn-head.dragging { cursor: grabbing; }
  /* Buttons in the header should never grow but should shrink only as a
     last resort — the select shrinks first because it has flex: 1. Buttons
     stay at their natural icon size unless the panel becomes very narrow. */
  .qn-head .qn-btn { flex: 0 0 auto; }
  .qn-head .qn-bar-sep { flex: 0 0 auto; }
  .qn-head .qn-brand { flex: 0 0 auto; }

  /* Compact mode kicks in for narrow panels (set via JS). Hides brand text,
     tightens padding and gap so all icons stay visible. */
  /* Compact mode: triggered when the header would otherwise overflow
     (measured dynamically in observePanelSize). Progressively tighter so
     all 12 header icons remain visible at any reasonable panel width. */
  .qn-wrap.qn-compact .qn-head { gap: 2px; padding: 5px 5px; }
  .qn-wrap.qn-compact .qn-head .qn-brand {
    /* Hide brand text; keep just the colored dot */
    font-size: 0;
  }
  .qn-wrap.qn-compact .qn-head .qn-brand-dot { margin-right: 0; }
  .qn-wrap.qn-compact .qn-head .qn-btn { padding: 2px 3px; }
  .qn-wrap.qn-compact .qn-head .qn-btn svg { width: 12px; height: 12px; }
  .qn-wrap.qn-compact .qn-head .qn-bar-sep { margin: 0; height: 12px; }
  .qn-wrap.qn-compact .qn-head .qn-select {
    padding: 3px 4px;
    font-size: 10px;
    /* Allow the select to shrink to its dropdown arrow when space is tight */
    min-width: 24px;
  }

  /* Zoom label between A+/A− buttons */
  .qn-zoom-label {
    font-size: 10px;
    color: var(--muted);
    min-width: 32px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    user-select: none;
  }
  .qn-zoom-label:hover { background: var(--btn-hover); color: var(--fg-dim); }

  /* Zen / distraction-free mode: hide header, toolbar, pane heads, footer */
  .qn-wrap.qn-zen .qn-head,
  .qn-wrap.qn-zen .qn-bar,
  .qn-wrap.qn-zen .qn-pane-head,
  .qn-wrap.qn-zen .qn-foot { display: none !important; }

  /* Floating exit-zen button — only visible in zen mode */
  .qn-zen-exit {
    position: absolute;
    top: 8px;
    right: 10px;
    z-index: 25;
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 7px;
    cursor: pointer;
    color: var(--fg-dim);
    opacity: 0.3;
    transition: opacity 180ms ease, background 120ms ease, color 120ms ease;
    display: none;
  }
  .qn-zen-exit:hover { opacity: 1; background: var(--btn-hover); color: var(--fg); }
  .qn-zen-exit svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 1.8; display: block; }
  .qn-wrap.qn-zen .qn-zen-exit { display: block; }

  /* Drag strip for zen mode — thin invisible grab area at the top of the
     panel. Becomes visible (subtle accent line) on hover. */
  .qn-zen-drag {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 10px;
    z-index: 24;
    cursor: grab;
    display: none;
    background: transparent;
    transition: background 150ms ease;
  }
  .qn-zen-drag:hover {
    background: linear-gradient(to bottom, var(--accent-soft), transparent);
  }
  .qn-zen-drag:active { cursor: grabbing; }
  .qn-wrap.qn-zen .qn-zen-drag { display: block; }

  /* When Alt is held, show a move cursor on the whole panel to hint at
     Alt+drag — added/removed by JS in wireEvents. */
  .qn-wrap.qn-alt-held { cursor: move; }
  .qn-wrap.qn-alt-held .qn-text { cursor: move; }

  .qn-brand {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--fg-dim);
    white-space: nowrap;
  }
  .qn-brand-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-soft);
  }

  .qn-select {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
  }
  .qn-select:hover { border-color: var(--border-strong); }
  .qn-select:focus { border-color: var(--accent); }

  /* Inline rename input that temporarily replaces the note selector */
  .qn-rename-input {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  /* ===== Icon buttons ===== */
  .qn-btn {
    background: transparent;
    color: var(--fg-dim);
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px 6px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
    white-space: nowrap;
  }
  .qn-btn:hover {
    background: var(--btn-hover);
    color: var(--fg);
  }
  .qn-btn:active { background: var(--btn-active); }
  .qn-btn.qn-active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }
  .qn-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
    filter: grayscale(0.9);
    pointer-events: none;
  }
  .qn-btn svg {
    width: 14px; height: 14px;
    display: block;
    pointer-events: none;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .qn-btn.qn-text { gap: 4px; font-size: 11px; padding: 4px 8px; }

  /* Text-label buttons in toolbar */
  .qn-bar .qn-btn.qn-text {
    background: var(--bg-elev);
    border-color: var(--border);
  }
  .qn-bar .qn-btn.qn-text:hover {
    background: var(--btn-hover);
    border-color: var(--border-strong);
  }

  /* ===== Toolbar ===== */
  .qn-bar {
    display: flex;
    gap: 3px;
    padding: 4px 8px;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    align-items: center;
  }
  .qn-bar-group {
    display: flex;
    gap: 2px;
    align-items: center;
  }
  .qn-bar-sep {
    width: 1px;
    height: 16px;
    background: var(--border);
    margin: 0 4px;
  }

  /* Responsive toolbar: two progressive compact levels applied by
     observeBarSize() when content would otherwise wrap to > 2 rows. */
  .qn-bar.qn-bar-compact { gap: 2px; padding: 3px 6px; }
  .qn-bar.qn-bar-compact .qn-bar-group { gap: 1px; }
  .qn-bar.qn-bar-compact .qn-btn { padding: 3px 4px; }
  .qn-bar.qn-bar-compact .qn-btn svg { width: 12px; height: 12px; }
  .qn-bar.qn-bar-compact .qn-bar-sep { margin: 0 2px; height: 14px; }
  .qn-bar.qn-bar-compact .qn-range { width: 60px; }
  .qn-bar.qn-bar-compact .qn-zoom-label { font-size: 9px; min-width: 22px; }

  .qn-bar.qn-bar-extra-compact { gap: 1px; padding: 2px 4px; }
  .qn-bar.qn-bar-extra-compact .qn-bar-group { gap: 0; }
  .qn-bar.qn-bar-extra-compact .qn-btn { padding: 2px 3px; }
  .qn-bar.qn-bar-extra-compact .qn-btn svg { width: 11px; height: 11px; }
  .qn-bar.qn-bar-extra-compact .qn-bar-sep { margin: 0 1px; height: 12px; }
  .qn-bar.qn-bar-extra-compact .qn-range { width: 44px; }
  .qn-bar.qn-bar-extra-compact .qn-zoom-label { display: none; }
  .qn-bar.qn-bar-extra-compact .qn-op-label { display: none; }
  .qn-bar.qn-bar-extra-compact .qn-op-icon { display: none; }

  /* Opacity slider in toolbar */
  .qn-opacity-group {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    color: var(--fg-dim);
  }
  .qn-op-icon { display: flex; align-items: center; opacity: 0.7; }
  .qn-op-icon svg { width: 13px; height: 13px; stroke: currentColor; fill: none; stroke-width: 1.8; }
  .qn-range {
    -webkit-appearance: none;
    appearance: none;
    width: 80px;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    cursor: pointer;
    outline: none;
  }
  .qn-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: 0;
    box-shadow: 0 0 0 2px rgba(0,0,0,0.15);
  }
  .qn-range::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: 0;
  }
  .qn-op-label {
    font-size: 10px;
    color: var(--muted);
    min-width: 30px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* Tag color dot in selector */
  .qn-tag-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Color tag picker popup */
  .qn-tag-menu {
    position: absolute;
    top: 44px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    box-shadow: var(--shadow);
    z-index: 30;
    display: flex;
    gap: 6px;
  }
  .qn-tag-swatch {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid transparent;
    transition: transform 120ms ease, border-color 120ms ease;
  }
  .qn-tag-swatch:hover { transform: scale(1.15); }
  .qn-tag-swatch.qn-active { border-color: var(--fg); }
  .qn-tag-swatch.qn-none {
    background: var(--bg-alt);
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
  }
  /* Active note tag-color accent on the brand dot */
  .qn-brand-dot {
    transition: background 200ms ease, box-shadow 200ms ease;
  }

  /* Color picker menu (for text color in notes) */
  .qn-color-menu {
    position: absolute;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    box-shadow: var(--shadow);
    z-index: 30;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 6px;
  }
  .qn-color-swatch {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid transparent;
    transition: transform 120ms ease, border-color 120ms ease;
    padding: 0;
  }
  .qn-color-swatch:hover { transform: scale(1.15); border-color: var(--fg-dim); }
  .qn-color-swatch.qn-none {
    background: var(--bg-alt);
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
  }

  /* Drag-and-drop visual feedback when files are dragged over the textarea */
  .qn-text.qn-drag-over {
    outline: 2px dashed var(--accent);
    outline-offset: -4px;
    background: var(--accent-soft);
  }

  /* ===== View layout ===== */
  .qn-view {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .qn-view[hidden] { display: none !important; }

  /* ===== Body ===== */
  .qn-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    position: relative;
  }
  /* When split is on, body becomes a horizontal or vertical flex container
     of two panes + a splitter. The preview element is pushed out / hidden. */
  .qn-wrap[data-split="on"][data-split-dir="h"] .qn-body { flex-direction: row; }
  .qn-wrap[data-split="on"][data-split-dir="v"] .qn-body { flex-direction: column; }

  .qn-pane {
    flex: 1 1 50%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .qn-pane-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    min-height: 28px;
    flex-shrink: 0;
  }
  /* Hide pane 1's head when split is off to preserve the classic look. */
  .qn-wrap:not([data-split="on"]) #pane1Head { display: none; }
  /* Hide pane 2 entirely when split is off */
  .qn-wrap:not([data-split="on"]) #pane2,
  .qn-wrap:not([data-split="on"]) #splitter { display: none !important; }

  .qn-pane-label {
    flex: 1;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.3px;
    color: var(--fg-dim);
    cursor: text;
    padding: 2px 4px;
    border-radius: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qn-pane-label:hover { background: var(--btn-hover); }
  .qn-pane-label.editing {
    background: var(--bg);
    border: 1px solid var(--accent);
    outline: none;
    padding: 1px 4px;
  }

  .qn-pane-select {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    padding: 3px 6px;
  }
  .qn-pane-btn { padding: 3px 5px; }
  .qn-pane-btn svg { width: 12px; height: 12px; }

  /* Splitter */
  .qn-splitter {
    flex: 0 0 4px;
    background: var(--border);
    transition: background 120ms ease;
  }
  .qn-splitter:hover { background: var(--accent); }
  .qn-wrap[data-split="on"][data-split-dir="h"] .qn-splitter { cursor: col-resize; width: 4px; height: auto; }
  .qn-wrap[data-split="on"][data-split-dir="v"] .qn-splitter { cursor: row-resize; height: 4px; width: auto; }
  .qn-wrap[data-split="on"][data-split-dir="h"] .qn-pane { height: 100%; }
  .qn-wrap[data-split="on"][data-split-dir="v"] .qn-pane { width: 100%; }

  /* Preview still inside body but absolute-style — hide when split is on */
  .qn-wrap[data-split="on"] .qn-preview { display: none !important; }

  /* When preview mode is active, hide the pane containers so the preview
     gets the full body height (otherwise flex-basis: 50% on .qn-pane
     leaves empty space above the preview). */
  .qn-wrap.qn-preview-on .qn-pane,
  .qn-wrap.qn-preview-on .qn-splitter { display: none !important; }

  .qn-text {
    flex: 1;
    min-height: 0;
    border: 0;
    outline: 0;
    resize: none;
    padding: 14px 16px;
    background: transparent;
    color: var(--fg);
    font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.6;
    caret-color: var(--accent);
  }
  .qn-text::placeholder { color: var(--muted); }
  .qn-text::-webkit-scrollbar,
  .qn-preview::-webkit-scrollbar,
  .qn-list::-webkit-scrollbar { width: 10px; height: 10px; }
  .qn-text::-webkit-scrollbar-thumb,
  .qn-preview::-webkit-scrollbar-thumb,
  .qn-list::-webkit-scrollbar-thumb {
    background: var(--border-strong);
    border-radius: 4px;
    cursor: pointer;
  }
  .qn-text::-webkit-scrollbar-thumb:hover,
  .qn-preview::-webkit-scrollbar-thumb:hover,
  .qn-list::-webkit-scrollbar-thumb:hover {
    background: var(--accent);
    cursor: pointer;
  }
  .qn-text::-webkit-scrollbar-track,
  .qn-preview::-webkit-scrollbar-track,
  .qn-list::-webkit-scrollbar-track { background: transparent; cursor: default; }

  .qn-preview {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg);
  }
  .qn-preview h1, .qn-preview h2, .qn-preview h3 {
    margin: 0.9em 0 0.4em;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .qn-preview h1 { font-size: 18px; }
  .qn-preview h2 { font-size: 15px; }
  .qn-preview h3 { font-size: 13px; color: var(--fg-dim); }
  .qn-preview p { margin: 0.45em 0; }
  .qn-preview ul, .qn-preview ol { margin: 0.4em 0; padding-left: 20px; }
  .qn-preview li { margin: 2px 0; }
  .qn-preview code {
    background: var(--bg-alt);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    border: 1px solid var(--border);
  }
  .qn-preview pre {
    background: var(--bg-alt);
    padding: 10px 12px;
    border-radius: 6px;
    overflow-x: auto;
    border: 1px solid var(--border);
    margin: 0.6em 0;
  }
  .qn-preview pre code { background: transparent; border: 0; padding: 0; font-size: 12px; line-height: 1.55; }
  .qn-preview blockquote {
    border-left: 3px solid var(--accent);
    margin: 0.6em 0;
    padding: 2px 12px;
    color: var(--fg-dim);
    font-style: italic;
  }
  .qn-preview a { color: var(--accent); text-decoration: none; border-bottom: 1px dotted var(--accent); }
  .qn-preview a:hover { border-bottom-style: solid; }
  .qn-preview hr {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 1em 0;
  }
  .qn-preview strong { font-weight: 600; color: var(--fg); }
  .qn-preview em { font-style: italic; }
  .qn-preview .qn-img {
    max-width: 100%;
    max-height: 400px;
    height: auto;
    width: auto;
    object-fit: contain;
    display: block;
    margin: 0.6em 0;
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  .qn-preview .qn-img-missing {
    display: inline-block;
    padding: 2px 8px;
    background: var(--bg-alt);
    border: 1px dashed var(--border);
    border-radius: 4px;
    color: var(--muted);
    font-size: 11px;
    font-family: ui-monospace, monospace;
  }

  /* Tables */
  .qn-preview .qn-tbl-wrap {
    overflow-x: auto;
    margin: 0.7em 0;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .qn-preview .qn-tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .qn-preview .qn-tbl th,
  .qn-preview .qn-tbl td {
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
  }
  .qn-preview .qn-tbl th:last-child,
  .qn-preview .qn-tbl td:last-child { border-right: 0; }
  .qn-preview .qn-tbl tbody tr:last-child td { border-bottom: 0; }
  .qn-preview .qn-tbl thead th {
    background: var(--bg-alt);
    font-weight: 600;
    color: var(--fg);
    letter-spacing: 0.2px;
  }
  .qn-preview .qn-tbl tbody tr:nth-child(even) td {
    background: var(--bg-elev);
  }
  .qn-preview .qn-tbl tbody tr:hover td {
    background: var(--row-hover);
  }

  /* Table-size picker (Excel-style click-grid) */
  .qn-tbl-picker {
    position: absolute;
    z-index: 30;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    box-shadow: var(--shadow);
    user-select: none;
  }
  .qn-tbl-picker-label {
    text-align: center;
    font-size: 11px;
    color: var(--fg-dim);
    margin-bottom: 6px;
    font-variant-numeric: tabular-nums;
  }
  .qn-tbl-picker-grid {
    display: grid;
    gap: 2px;
  }
  .qn-tbl-picker-cell {
    width: 16px;
    height: 16px;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: var(--bg-alt);
    cursor: pointer;
    transition: background 80ms ease, border-color 80ms ease;
  }
  .qn-tbl-picker-cell:hover { border-color: var(--border-strong); }
  .qn-tbl-picker-cell.qn-active {
    background: var(--accent-soft);
    border-color: var(--accent);
  }

  .qn-preview .chk-line {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 6px;
    margin: 1px -6px;
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
  }
  .qn-preview .chk-line:hover { background: var(--row-hover); }
  .qn-preview .chk-line input {
    margin-top: 4px;
    cursor: pointer;
    accent-color: var(--accent);
  }
  .qn-preview .chk-line.done .txt {
    text-decoration: line-through;
    color: var(--muted);
  }

  /* ===== Footer ===== */
  .qn-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 12px;
    background: var(--bg-alt);
    border-top: 1px solid var(--border);
    font-size: 10.5px;
    color: var(--muted);
    letter-spacing: 0.2px;
    min-height: 26px;
  }
  .qn-foot .qn-status { color: var(--fg-dim); }
  .qn-foot .qn-status.qn-ok { color: var(--accent); }

  /* ===== Search + History views ===== */
  .qn-search-head {
    padding: 7px 10px;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .qn-input {
    flex: 1;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px;
    font-family: inherit;
    outline: none;
  }
  .qn-input:focus { border-color: var(--accent); }

  .qn-list {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0;
    background: var(--bg);
  }
  .qn-list li {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    align-items: flex-start;
  }
  .qn-list li:hover { background: var(--row-hover); }
  .qn-list .qn-ico {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    margin-top: 1px;
  }
  .qn-list .qn-ico svg { width: 13px; height: 13px; }
  .qn-list .qn-body-cell { flex: 1; min-width: 0; }
  .qn-list .qn-snip {
    font-family: ui-monospace, monospace;
    font-size: 11.5px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 3.6em;
    overflow: hidden;
    color: var(--fg);
  }
  .qn-list .qn-meta {
    font-size: 10px;
    color: var(--muted);
    margin-top: 4px;
    letter-spacing: 0.2px;
  }
  .qn-list .qn-del {
    background: transparent;
    border: 0;
    color: var(--muted);
    padding: 2px 4px;
    cursor: pointer;
    font-size: 13px;
    flex-shrink: 0;
    border-radius: 4px;
  }
  .qn-list .qn-del:hover { color: var(--warn); background: var(--btn-hover); }
  .qn-list .qn-empty {
    text-align: center;
    padding: 50px 20px;
    color: var(--muted);
    font-size: 12px;
    cursor: default;
    display: block;
    font-style: italic;
  }
  .qn-list .qn-empty:hover { background: transparent; }
  .qn-hl { background: var(--highlight); color: var(--highlight-fg); padding: 0 1px; border-radius: 2px; }

  /* ===== Shape menu ===== */
  .qn-shape-menu {
    position: absolute;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px;
    box-shadow: var(--shadow);
    z-index: 10;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    top: 44px;
    right: 12px;
  }
  .qn-shape-menu button {
    background: var(--bg-alt);
    border: 1px solid var(--border);
    color: var(--fg);
    width: 34px;
    height: 34px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
    font-family: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .qn-shape-menu button:hover { background: var(--btn-hover); }
  .qn-shape-menu button.qn-active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }

  /* ===== Resize handles ===== */
  .qn-rz {
    position: absolute;
    z-index: 20;
    background: transparent;
  }
  .qn-rz-n  { top: -3px; left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
  .qn-rz-s  { bottom: -3px; left: 10px; right: 10px; height: 8px; cursor: ns-resize; }
  .qn-rz-e  { top: 10px; bottom: 10px; right: -3px; width: 8px; cursor: ew-resize; }
  .qn-rz-w  { top: 10px; bottom: 10px; left: -3px; width: 8px; cursor: ew-resize; }
  .qn-rz-ne { top: -3px; right: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
  .qn-rz-nw { top: -3px; left: -3px; width: 14px; height: 14px; cursor: nwse-resize; }
  .qn-rz-sw { bottom: -3px; left: -3px; width: 14px; height: 14px; cursor: nesw-resize; }
  .qn-rz-se {
    bottom: -3px; right: -3px; width: 14px; height: 14px; cursor: nwse-resize;
  }
  .qn-rz-se::after {
    content: "";
    position: absolute;
    right: 4px; bottom: 4px;
    width: 8px; height: 8px;
    background:
      linear-gradient(135deg,
        transparent 55%, var(--muted) 55%, var(--muted) 62%,
        transparent 62%, transparent 70%, var(--muted) 70%,
        var(--muted) 77%, transparent 77%);
    opacity: 0.6;
  }

  /* ===== Collapsed ===== */
  /* (Collapse feature removed in v5.4.4 — minimize button hides the panel
     entirely, same as the extension icon click.) */

  /* ===== Homepage / Note List ===== */
  .qn-home-content {
    flex: 1;
    overflow-y: auto;
    background: var(--bg);
  }
  .qn-home-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 120ms ease;
  }
  .qn-home-item:hover { background: var(--row-hover); }
  .qn-home-item .qn-home-ico {
    width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center;
    color: var(--accent); flex-shrink: 0;
  }
  .qn-home-item .qn-home-info { flex: 1; min-width: 0; }
  .qn-home-item .qn-home-title {
    font-weight: 600; font-size: 13px; color: var(--fg);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .qn-home-item .qn-home-meta { font-size: 10px; color: var(--muted); margin-top: 2px; }
  .qn-home-item .qn-home-actions {
    display: flex; gap: 4px; opacity: 0; transition: opacity 120ms ease;
  }
  .qn-home-item:hover .qn-home-actions { opacity: 1; }
  
  .qn-active-label {
    font-size: 12px; font-weight: 600; color: var(--fg);
    padding: 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 140px;
  }
</style>

<div class="qn-wrap" data-theme="${state.theme}" data-shape="${state.shape}" id="wrap">

  <!-- Drag strip for zen mode (shown only when .qn-zen is active).
       Provides a visible handle to move the window when the header is hidden. -->
  <div class="qn-zen-drag" id="zenDragStrip" title="Drag to move (Alt+drag works anywhere)"></div>

  <div class="qn-paper" id="paper">

    <!-- Home (Note List) view -->
    <div class="qn-view" id="homeView" hidden>
      <div class="qn-head" id="homeHead">
        <span class="qn-brand"><span class="qn-brand-dot"></span>QUICK NOTES</span>
        <div style="flex:1"></div>
        <button class="qn-btn" id="homeNewNote" title="New note">${svgIcon('plus')}</button>
        <button class="qn-btn" id="homeSearchBtn" title="Search">${svgIcon('search')}</button>
        <button class="qn-btn" id="homeHistoryBtn" title="History">${svgIcon('clock')}</button>
        <button class="qn-btn" id="homeThemeBtn" title="Toggle theme">${svgIcon('sun')}</button>
        <button class="qn-btn" id="homeOptionsBtn" title="Options">${svgIcon('gear')}</button>
        <div class="qn-bar-sep"></div>
        <button class="qn-btn" id="homeModeToggle" title="Switch to Popup Mode">${svgIcon('layout')}</button>
        <button class="qn-btn" id="homeHideBtn" title="Hide panel">${svgIcon('eyeOff')}</button>
      </div>
      <div class="qn-home-content">
        <ul id="noteList" class="qn-list"></ul>
      </div>
      <div class="qn-foot">
        <span id="noteCount">0 notes</span>
        <span class="qn-status">click to open</span>
      </div>
    </div>

    <!-- Editor view -->
    <div class="qn-view" id="editorView">
      <div class="qn-head" id="head">
        <button class="qn-btn" id="goHome" title="Back to note list">${svgIcon('arrowLeft')}</button>
        <span id="renameBtn" class="qn-active-label">Open Note</span>
        <div style="flex:1"></div>
        <button class="qn-btn" id="newNote" title="New note">${svgIcon('plus')}</button>
        <button class="qn-btn" id="tagBtn" title="Color tag this note">${svgIcon('tag')}</button>
        <div class="qn-bar-sep"></div>
        <button class="qn-btn" id="searchBtn" title="Search (Ctrl+F)">${svgIcon('search')}</button>
        <button class="qn-btn" id="historyBtn" title="History">${svgIcon('clock')}</button>
        <button class="qn-btn" id="splitBtn" title="Split pane (second note side-by-side)">${svgIcon('split')}</button>
        <button class="qn-btn" id="themeBtn" title="Toggle theme">${svgIcon(state.theme === 'dark' ? 'sun' : 'bat')}</button>
        <button class="qn-btn" id="zenBtn" title="Focus mode (hide toolbars for distraction-free writing)">${svgIcon('zen')}</button>
        <button class="qn-btn" id="optionsBtn" title="Options">${svgIcon('gear')}</button>
        <div class="qn-bar-sep"></div>
        <button class="qn-btn" id="modeToggle" title="Switch to Popup Mode">${svgIcon('layout')}</button>
        <button class="qn-btn" id="closeBtn" title="Hide panel">${svgIcon('minimize')}</button>
      </div>

      <div class="qn-bar" id="toolbar">
        <div class="qn-bar-group">
          <button class="qn-btn" id="undoBtn" title="Undo">${svgIcon('undo')}</button>
          <button class="qn-btn" id="redoBtn" title="Redo">${svgIcon('redo')}</button>
        </div>
        <div class="qn-bar-sep"></div>
        <div class="qn-bar-group">
          <button class="qn-btn" id="pasteBtn" title="Paste clipboard">${svgIcon('clipboard')}</button>
          <button class="qn-btn" id="cutBtn" title="Cut selection">${svgIcon('scissors')}</button>
          <button class="qn-btn" id="copyBtn" title="Copy whole note">${svgIcon('copy')}</button>
        </div>
        <div class="qn-bar-sep"></div>
        <div class="qn-bar-group">
          <button class="qn-btn" id="urlBtn" title="Insert page URL">${svgIcon('link')}</button>
          <button class="qn-btn" id="selBtn" title="Insert page selection">${svgIcon('selection')}</button>
          <button class="qn-btn" id="timeBtn" title="Insert timestamp">${svgIcon('clock')}</button>
        </div>
        <div class="qn-bar-sep"></div>
        <div class="qn-bar-group">
          <button class="qn-btn" id="divBtn" title="Insert divider">━</button>
          <button class="qn-btn" id="taskBtn" title="Insert checklist item">${svgIcon('check')}</button>
          <button class="qn-btn" id="tableBtn" title="Insert Markdown table">${svgIcon('table')}</button>
        </div>
        <div class="qn-bar-sep"></div>
        <div class="qn-bar-group">
          <button class="qn-btn" id="boldBtn" title="Bold (wrap **selection**)">${svgIcon('bold')}</button>
          <button class="qn-btn" id="codeBtn" title="Code (inline or fenced block)">${svgIcon('code')}</button>
          <button class="qn-btn" id="colorBtn" title="Text color">${svgIcon('colorText')}</button>
          <button class="qn-btn" id="previewBtn" title="Toggle Markdown preview">${svgIcon('eye')}</button>
        </div>
        <div class="qn-bar-sep"></div>
        <div class="qn-bar-group">
          <button class="qn-btn" id="zoomOutBtn" title="Decrease text size">${svgIcon('zoomOut')}</button>
          <span id="zoomLabel" class="qn-zoom-label" title="Reset to default (click)">13px</span>
          <button class="qn-btn" id="zoomInBtn" title="Increase text size">${svgIcon('zoomIn')}</button>
        </div>
        <div class="qn-bar-sep"></div>
        <div class="qn-bar-group">
          <button class="qn-btn" id="defaultBtn" title="Set as default note for this site">${svgIcon('target')}</button>
          <button class="qn-btn" id="dlBtn" title="Download note as .txt">${svgIcon('download')}</button>
        </div>
        <div class="qn-bar-sep"></div>
        <div class="qn-opacity-group" title="Panel opacity">
          <span class="qn-op-icon">${svgIcon('eye')}</span>
          <input type="range" id="opacitySlider" class="qn-range" min="30" max="100" step="5" value="100">
          <span id="opacityLabel" class="qn-op-label">100%</span>
        </div>
      </div>

      <div class="qn-body" id="body">
        <!-- Pane 1 (primary, always visible) -->
        <div class="qn-pane" id="pane1">
          <div class="qn-pane-head" id="pane1Head">
            <select class="qn-select qn-pane-select" id="pane1Select" title="Pane 1 note"></select>
          </div>
          <textarea class="qn-text" id="text" spellcheck="true" placeholder="Start typing…   Auto-saved."></textarea>
        </div>

        <!-- Splitter (hidden when split off) -->
        <div class="qn-splitter" id="splitter" hidden></div>

        <!-- Pane 2 (shown only when split is on) -->
        <div class="qn-pane" id="pane2" hidden>
          <div class="qn-pane-head">
            <select class="qn-select qn-pane-select" id="pane2Select" title="Pane 2 note"></select>
            <button class="qn-btn qn-pane-btn" id="splitSwapBtn" title="Swap pane 1 ↔ pane 2">${svgIcon('swap')}</button>
            <button class="qn-btn qn-pane-btn" id="splitDirBtn" title="Flip split direction">${svgIcon('splitFlip')}</button>
          </div>
          <textarea class="qn-text" id="text2" spellcheck="true" placeholder="Second note…"></textarea>
        </div>

        <div class="qn-preview" id="preview" hidden></div>

        <!-- Floating exit-zen button, only visible when .qn-wrap.qn-zen -->
        <button class="qn-zen-exit" id="zenExitBtn" title="Exit distraction-free mode (Esc)">${svgIcon('zenExit')}</button>
      </div>

      <div class="qn-foot">
        <span id="counter">0 words · 0 chars</span>
        <span id="status" class="qn-status qn-ok">ready</span>
      </div>
    </div>

    <!-- Search view -->
    <div class="qn-view" id="searchView" hidden>
      <div class="qn-search-head">
        <button class="qn-btn" id="backFromSearch" title="Back">${svgIcon('arrowLeft')}</button>
        <input class="qn-input" id="searchInput" type="text" placeholder="Search notes and history…">
        <select class="qn-select" id="searchScope" style="flex:0 0 80px;">
          <option value="all">All</option>
          <option value="notes">Notes</option>
          <option value="history">History</option>
        </select>
      </div>
      <ul class="qn-list" id="searchResults"></ul>
      <div class="qn-foot">
        <span id="searchCount">type to search</span>
        <span class="qn-status">esc to close</span>
      </div>
    </div>

    <!-- History view -->
    <div class="qn-view" id="historyView" hidden>
      <div class="qn-search-head">
        <button class="qn-btn" id="backFromHistory" title="Back">${svgIcon('arrowLeft')}</button>
        <span style="flex:1;font-weight:600;font-size:12px;letter-spacing:0.4px;text-transform:uppercase;color:var(--fg-dim);">History</span>
        <button class="qn-btn qn-text" id="clearHistoryBtn" title="Clear all">Clear</button>
      </div>
      <ul class="qn-list" id="historyList"></ul>
      <div class="qn-foot">
        <span id="historyCount">0 entries</span>
        <span class="qn-status">click to insert</span>
      </div>
    </div>

  </div>

  <!-- Resize handles -->
  <div class="qn-rz qn-rz-n"  data-dir="n"></div>
  <div class="qn-rz qn-rz-s"  data-dir="s"></div>
  <div class="qn-rz qn-rz-e"  data-dir="e"></div>
  <div class="qn-rz qn-rz-w"  data-dir="w"></div>
  <div class="qn-rz qn-rz-ne" data-dir="ne"></div>
  <div class="qn-rz qn-rz-nw" data-dir="nw"></div>
  <div class="qn-rz qn-rz-se" data-dir="se"></div>
  <div class="qn-rz qn-rz-sw" data-dir="sw"></div>

</div>
    `;
    shadow.appendChild(root);
    document.documentElement.appendChild(host);

    panel = shadow.getElementById('paper');
    const wrap = shadow.getElementById('wrap');
    textarea = shadow.getElementById('text');
    previewEl = shadow.getElementById('preview');
    statusEl = shadow.getElementById('status');
    counterEl = shadow.getElementById('counter');
    noteSelect = shadow.getElementById('renameBtn');
    searchInput = shadow.getElementById('searchInput');
    searchResults = shadow.getElementById('searchResults');
    searchCount = shadow.getElementById('searchCount');
    historyListEl = shadow.getElementById('historyList');
    historyCountEl = shadow.getElementById('historyCount');
    
    // Homepage elements
    const homeNewNote = shadow.getElementById('homeNewNote');
    const noteList = shadow.getElementById('noteList');
    const noteCount = shadow.getElementById('noteCount');
    const goHome = shadow.getElementById('goHome');

    applyGeometry(wrap);
    applyOpacity(wrap);
    applyCustomColors();
    applySplit(wrap);
    applyFontSize(wrap);
    applyZen(wrap);
    wireEvents(wrap);
    loadActiveIntoEditor();
    updateDefaultButton();
    updateTagUI();
    observePanelSize(wrap);

    showView(currentView + 'View');
  }

  // Apply text zoom: sets font-size on both textareas and the preview.
  // The zoom label in the toolbar mirrors the value.
  function applyFontSize(wrap) {
    const px = Math.max(10, Math.min(28, state.fontSize || 13));
    state.fontSize = px;
    if (!shadow) return;
    const t1 = shadow.getElementById('text');
    const t2 = shadow.getElementById('text2');
    const pv = shadow.getElementById('preview');
    if (t1) t1.style.fontSize = px + 'px';
    if (t2) t2.style.fontSize = px + 'px';
    if (pv) pv.style.fontSize = px + 'px';
    const lbl = shadow.getElementById('zoomLabel');
    if (lbl) lbl.textContent = px + 'px';
  }

  // Apply zen mode: hide toolbars + footer, show floating exit button.
  function applyZen(wrap) {
    wrap.classList.toggle('qn-zen', !!state.zen);
    const zb = shadow && shadow.getElementById('zenBtn');
    if (zb) zb.classList.toggle('qn-active', !!state.zen);
  }

  // Toggle .qn-compact on the wrap when the panel is narrow enough that
  // the header would otherwise overflow. Threshold chosen empirically based
  // on the natural width of the brand text + all the icon buttons.
  // Toggle .qn-compact on the wrap whenever the header can't fit all its
  // icons at the current panel width. Uses scrollWidth vs clientWidth
  // instead of a fixed pixel breakpoint, so it stays correct as buttons
  // are added/removed and across different system font metrics.
  function observePanelSize(wrap) {
    const head = shadow.getElementById('head');
    const bar = shadow.getElementById('toolbar');
    if (!head) return;
    let updating = false;
    const update = () => {
      if (updating) return;
      updating = true;

      // ----- Header compact detection -----
      wrap.classList.remove('qn-compact');
      const headOverflow = head.scrollWidth > head.clientWidth + 1;
      if (headOverflow) wrap.classList.add('qn-compact');

      // ----- Toolbar compact detection (cap at 2 rows) -----
      if (bar) {
        // Reset to natural and measure progressively.
        bar.classList.remove('qn-bar-compact', 'qn-bar-extra-compact');
        const btn = bar.querySelector('.qn-btn');
        const barPad = 8; // approx vertical padding + gap budget
        const rowH = () => (btn ? btn.offsetHeight : 24);
        // Bar natural height > 2 rows? → compact
        if (bar.offsetHeight > rowH() * 2 + barPad) {
          bar.classList.add('qn-bar-compact');
          // Still > 2 rows? → extra compact
          if (bar.offsetHeight > rowH() * 2 + barPad) {
            bar.classList.add('qn-bar-extra-compact');
          }
        }
      }

      updating = false;
    };
    update();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update);
      ro.observe(wrap);
      ro.observe(head);
      if (bar) ro.observe(bar);
    } else {
      window.addEventListener('resize', update);
    }
  }

  // Apply split attribute and sizing
  function applySplit(wrap) {
    const pane2 = shadow.getElementById('pane2');
    const splitter = shadow.getElementById('splitter');
    if (!pane2 || !splitter) return;
    if (state.split) {
      wrap.dataset.split = 'on';
      wrap.dataset.splitDir = state.splitDir === 'v' ? 'v' : 'h';
      pane2.hidden = false;
      splitter.hidden = false;
      const p1 = shadow.getElementById('pane1');
      const r = Math.max(0.15, Math.min(0.85, state.paneRatio || 0.5));
      p1.style.flex = `${r} 1 0`;
      pane2.style.flex = `${1 - r} 1 0`;
      shadow.getElementById('splitBtn').classList.add('qn-active');
    } else {
      wrap.removeAttribute('data-split');
      wrap.removeAttribute('data-split-dir');
      pane2.hidden = true;
      splitter.hidden = true;
      const p1 = shadow.getElementById('pane1');
      p1.style.flex = '1 1 0';
      shadow.getElementById('splitBtn').classList.remove('qn-active');
    }

    // Disable preview button if split mode is on
    const previewBtn = shadow.getElementById('previewBtn');
    if (previewBtn) previewBtn.disabled = state.split;
  }

  // Populate pane 1's own note selector (visible only when split is on).
  function renderPane1Selector() {
    const sel = shadow && shadow.getElementById('pane1Select');
    if (!sel) return;
    const pinned = state.notes.filter(n => n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    const rest = state.notes.filter(n => !n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    const all = [...pinned, ...rest];

    // In-place update to avoid focus-steal (same pattern as main selector).
    const orderSig = all.map(n => `${n.id}:${n.pinned ? 1 : 0}`).join(',');
    if (sel._qnOrderSig === orderSig && sel.options.length === all.length) {
      for (let i = 0; i < all.length; i++) {
        const n = all[i];
        const opt = sel.options[i];
        const newText = (n.pinned ? '◆ ' : '') + (n.title || 'Untitled');
        if (opt.textContent !== newText) opt.textContent = newText;
        if (opt.value !== n.id) opt.value = n.id;
        const shouldBeSelected = n.id === state.activeId;
        if (opt.selected !== shouldBeSelected) opt.selected = shouldBeSelected;
      }
      return;
    }
    sel._qnOrderSig = orderSig;
    sel.innerHTML = '';
    all.forEach(n => {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = (n.pinned ? '◆ ' : '') + (n.title || 'Untitled');
      if (n.id === state.activeId) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  // Populate pane 2's own note selector
  function renderPane2Selector() {
    const sel = shadow && shadow.getElementById('pane2Select');
    if (!sel) return;
    const pinned = state.notes.filter(n => n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    const rest = state.notes.filter(n => !n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    const all = [...pinned, ...rest];
    sel.innerHTML = '';
    // Default pane 2 id: first non-active note, or any note
    if (!state.pane2Id || !state.notes.some(n => n.id === state.pane2Id)) {
      const candidate = all.find(n => n.id !== state.activeId) || all[0];
      state.pane2Id = candidate ? candidate.id : null;
    }
    all.forEach(n => {
      const opt = document.createElement('option');
      opt.value = n.id;
      opt.textContent = (n.pinned ? '◆ ' : '') + (n.title || 'Untitled');
      if (n.id === state.pane2Id) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function pane2Note() { return state.notes.find(n => n.id === state.pane2Id); }
  function loadPane2IntoEditor() {
    const t2 = shadow && shadow.getElementById('text2');
    if (!t2) return;
    const n = pane2Note();
    if (n && document.activeElement !== t2) t2.value = n.content;
  }

  function applyOpacity(wrap) {
    wrap.style.setProperty('--panel-alpha', String(state.opacity));
    const sl = shadow && shadow.getElementById('opacitySlider');
    if (sl) sl.value = String(Math.round(state.opacity * 100));
    const lbl = shadow && shadow.getElementById('opacityLabel');
    if (lbl) lbl.textContent = `${Math.round(state.opacity * 100)}%`;
  }

  // Convert '#RRGGBB' to 'R G B' (space-separated triplet) for use in
  // rgb(var(--bg-rgb) / alpha) expressions.
  function hexToRgbTriplet(hex) {
    if (!hex || hex[0] !== '#') return '';
    const h = hex.slice(1);
    if (h.length === 3) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      return `${r} ${g} ${b}`;
    }
    if (h.length === 6) {
      return `${parseInt(h.slice(0, 2), 16)} ${parseInt(h.slice(2, 4), 16)} ${parseInt(h.slice(4, 6), 16)}`;
    }
    return '';
  }

  // Generate an override <style> for customized theme colors. Returns the
  // CSS text (empty string if no customizations).
  function generateCustomColorsCss() {
    const cc = state.customColors || { dark: {}, light: {} };
    let css = '';
    ['dark', 'light'].forEach(theme => {
      const c = cc[theme];
      if (!c || Object.keys(c).length === 0) return;
      const rules = [];
      if (c.bg) {
        const rgb = hexToRgbTriplet(c.bg);
        if (rgb) rules.push(`--bg-rgb: ${rgb};`);
      }
      if (c.bgAlt) {
        const rgb = hexToRgbTriplet(c.bgAlt);
        if (rgb) rules.push(`--bg-alt-rgb: ${rgb};`);
      }
      if (c.fg) rules.push(`--fg: ${c.fg};`);
      if (c.accent) {
        rules.push(`--accent: ${c.accent};`);
        // Derive --accent-soft as the same hex + 22 alpha (≈ 0.13)
        rules.push(`--accent-soft: ${c.accent}22;`);
      }
      if (c.border) rules.push(`--border: ${c.border};`);
      if (rules.length) {
        css += `.qn-wrap[data-theme="${theme}"] { ${rules.join(' ')} }\n`;
      }
    });
    return css;
  }

  // Apply custom colors by injecting a <style> element inside the shadow
  // root. Re-called whenever customColors changes.
  function applyCustomColors() {
    if (!shadow) return;
    let styleEl = shadow.getElementById('qn-custom-colors');
    const css = generateCustomColorsCss();
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'qn-custom-colors';
      shadow.appendChild(styleEl);
    }
    styleEl.textContent = css;
  }

  // ---------- SVG icons ----------
  function svgIcon(name) {
    const paths = {
      plus: '<path d="M12 5v14M5 12h14"/>',
      minus: '<path d="M5 12h14"/>',
      x: '<path d="M6 6l12 12M18 6L6 18"/>',
      trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
      pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"/>',
      clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
      copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
      link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
      scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9"/><path d="M14.5 14.5L20 20"/><path d="M8.1 8.1L12 12"/>',
      check: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 12l2 2 4-4"/>',
      eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
      target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
      shape: '<polygon points="12,3 21,20 3,20" />',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
      bat: '<path d="M12 7c-2 0-3 1-3 1s-2-3-5-3c0 2 1 3 1 3s-2 1-2 3c2 0 4-1 4-1l2 3 3 1 3-1 2-3s2 1 4 1c0-2-2-3-2-3s1-1 1-3c-3 0-5 3-5 3s-1-1-3-1z"/>',
      arrowLeft: '<path d="M15 18l-6-6 6-6"/>',
      tag: '<path d="M20 12V4a1 1 0 0 0-1-1h-8L3 11l9 9 8-8z"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/>',
      pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
      monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
      layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
      eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
      split: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
      splitFlip: '<path d="M3 8h18M3 16h18"/><path d="M7 5l-4 3 4 3"/><path d="M17 13l4 3-4 3"/>',
      swap: '<path d="M8 3L4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/>',
      minimize: '<rect x="3" y="3" width="18" height="18" rx="2" opacity="0.4"/><path d="M6 18h12" stroke-width="2.5"/>',
      table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
      cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9"/><path d="M14.5 14.5L20 20"/><path d="M8.1 8.1L12 12"/>',
      zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M11 8v6M8 11h6"/>',
      zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/><path d="M8 11h6"/>',
      zen: '<circle cx="12" cy="6" r="2.5"/><path d="M12 10c-3 0-5 2-5 5v1h10v-1c0-3-2-5-5-5z"/><path d="M7 16c-1.5 0.5-3 1.5-3 3h16c0-1.5-1.5-2.5-3-3"/>',
      zenExit: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h6v6h-6z"/>',
      bold: '<path d="M7 4h7a4 4 0 0 1 0 8H7z"/><path d="M7 12h8a4 4 0 0 1 0 8H7z"/>',
      code: '<path d="M9 8l-5 4 5 4M15 8l5 4-5 4"/>',
      colorText: '<path d="M6 20l6-14 6 14M8.5 16h7"/><rect x="4" y="20" width="16" height="2" fill="currentColor" stroke="none"/>',
      undo: '<path d="M9 14L4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
      redo: '<path d="M15 14l5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
      selection: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 4"/><path d="M9 9h6v6H9z" fill="currentColor" fill-opacity="0.3"/>'
    };
    return `<svg viewBox="0 0 24 24">${paths[name] || ''}</svg>`;
  }

  // ---------- Geometry ----------
  function applyGeometry(wrap) {
    const p = state.panel;
    const KEEP = 80;
    // Clamp width/height to viewport
    const w = Math.max(240, Math.min(window.innerWidth, p.width || 420));
    const h = Math.max(120, Math.min(window.innerHeight, p.height || 540));
    wrap.style.width = w + 'px';
    wrap.style.height = h + 'px';

    if (p.left != null) {
      // Clamp left so at least KEEP pixels of the panel remain visible
      const minLeft = KEEP - w;
      const maxLeft = window.innerWidth - KEEP;
      const nl = Math.max(minLeft, Math.min(maxLeft, p.left));
      wrap.style.left = nl + 'px';
      wrap.style.right = 'auto';
      if (nl !== p.left) { state.panel.left = nl; }
    } else {
      const r = Math.max(KEEP - w, p.right ?? 24);
      wrap.style.right = r + 'px';
      wrap.style.left = 'auto';
    }

    // Clamp top so header stays reachable
    const minTop = 0;
    const maxTop = window.innerHeight - KEEP;
    const nt = Math.max(minTop, Math.min(maxTop, p.top || 80));
    wrap.style.top = nt + 'px';
    if (nt !== p.top) { state.panel.top = nt; }
  }
  function savePanelGeometry() { storageSet({ panel: state.panel }); }

  // Snap panel to a known-safe position and size. Callable from any context
  // (double-click, keyboard shortcut, message from background).
  function recenterPanel() {
    if (!host || !shadow) return;
    const wrap = shadow.getElementById('wrap');
    if (!wrap) return;
    const w = Math.min(480, Math.max(320, window.innerWidth - 40));
    const h = Math.min(560, Math.max(260, window.innerHeight - 80));
    state.panel.width = w;
    state.panel.height = h;
    state.panel.left = Math.max(20, (window.innerWidth - w) / 2);
    state.panel.top = Math.max(20, (window.innerHeight - h) / 3);
    state.panel.right = null;
    applyGeometry(wrap);
    savePanelGeometry();
    if (typeof flash === 'function') flash('recentered ✓');
  }

  // ---------- Rendering ----------
  function renderHome() {
    if (!shadow) return;
    const list = shadow.getElementById('noteList');
    const count = shadow.getElementById('noteCount');
    if (!list || !count) return;

    const pinned = state.notes.filter(n => n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    const rest = state.notes.filter(n => !n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
    const all = [...pinned, ...rest];

    count.textContent = `${all.length} note${all.length === 1 ? '' : 's'}`;
    list.innerHTML = '';

    all.forEach(n => {
      const li = document.createElement('li');
      li.className = 'qn-home-item';
      
      const icon = document.createElement('div');
      icon.className = 'qn-home-ico';
      icon.innerHTML = svgIcon('pencil');

      const info = document.createElement('div');
      info.className = 'qn-home-info';
      
      const title = document.createElement('div');
      title.className = 'qn-home-title';
      title.textContent = (n.pinned ? '📌 ' : '') + (n.title || 'Untitled');
      
      const meta = document.createElement('div');
      meta.className = 'qn-home-meta';
      meta.textContent = new Date(n.updatedAt).toLocaleString();

      info.appendChild(title);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'qn-home-actions';

      const pinBtn = document.createElement('button');
      pinBtn.className = 'qn-btn' + (n.pinned ? ' qn-active' : '');
      pinBtn.title = n.pinned ? 'Unpin' : 'Pin';
      pinBtn.innerHTML = svgIcon('pin');
      pinBtn.onclick = (e) => { e.stopPropagation(); togglePin(n.id); };

      const renBtn = document.createElement('button');
      renBtn.className = 'qn-btn';
      renBtn.title = 'Rename';
      renBtn.innerHTML = svgIcon('pencil');
      renBtn.onclick = (e) => { e.stopPropagation(); startRenameFromHome(n.id, title); };

      const delBtn = document.createElement('button');
      delBtn.className = 'qn-btn';
      delBtn.title = 'Delete';
      delBtn.innerHTML = svgIcon('trash');
      delBtn.onclick = (e) => { e.stopPropagation(); deleteNoteFromHome(n.id); };

      actions.appendChild(pinBtn);
      actions.appendChild(renBtn);
      actions.appendChild(delBtn);

      li.appendChild(icon);
      li.appendChild(info);
      li.appendChild(actions);

      li.onclick = () => {
        state.activeId = n.id;
        storageSet({ activeId: n.id });
        loadActiveIntoEditor();
        showView('editorView');
        textarea.focus();
      };

      list.appendChild(li);
    });
  }

  async function togglePin(id) {
    const n = state.notes.find(note => note.id === id);
    if (!n) return;
    n.pinned = !n.pinned;
    n.updatedAt = Date.now();
    await storageSet({ notes: state.notes });
    renderHome();
  }

  async function deleteNoteFromHome(id) {
    const n = state.notes.find(note => note.id === id);
    if (!n) return;
    if (!confirm(`Delete "${n.title || 'Untitled'}"?`)) return;
    
    state.notes = state.notes.filter(note => note.id !== id);
    if (state.notes.length === 0) {
      state.notes = [{ id: genId(), title: 'Untitled', content: '', updatedAt: Date.now(), pinned: false }];
    }
    if (state.activeId === id) state.activeId = state.notes[0].id;
    
    await storageSet({ notes: state.notes, activeId: state.activeId });
    renderHome();
  }

  function startRenameFromHome(id, titleEl) {
    const n = state.notes.find(note => note.id === id);
    if (!n) return;
    const current = n.title || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'qn-input';
    input.style.padding = '2px 4px';
    input.style.height = 'auto';
    input.value = current;
    input.onclick = (e) => e.stopPropagation();
    
    const originalDisplay = titleEl.style.display;
    titleEl.style.display = 'none';
    titleEl.parentNode.insertBefore(input, titleEl);
    
    let committed = false;
    async function commit(save) {
      if (committed) return;
      committed = true;
      input.remove();
      titleEl.style.display = originalDisplay;
      if (!save) return;
      const t = input.value.trim().slice(0, 80);
      if (t === current) return;
      if (t) {
        n.title = t;
        n.titleLocked = true;
      } else {
        n.titleLocked = false;
        n.title = deriveTitle(n.content);
      }
      n.updatedAt = Date.now();
      await storageSet({ notes: state.notes });
      renderHome();
    }
    
    input.onkeydown = (e) => {
      if (e.key === 'Enter') commit(true);
      if (e.key === 'Escape') commit(false);
    };
    input.onblur = () => commit(true);
    input.focus();
    input.select();
  }

  function renderSelector() {
    if (currentView === 'home') renderHome();
    renderPane1Selector();
    renderPane2Selector();
  }
  function loadActiveIntoEditor() {
    const n = activeNote();
    if (!n) return;
    if (document.activeElement !== textarea) textarea.value = n.content;
    if (shadow) {
      const lbl = shadow.getElementById('renameBtn');
      if (lbl) lbl.textContent = n.title || 'Untitled';
    }
    updateCounter();
    if (previewOn) renderPreview();
  }
  function updateCounter() {
    const t = textarea.value;
    const chars = t.length;
    const words = t.trim() ? t.trim().split(/\s+/).length : 0;
    counterEl.textContent = `${words} words · ${chars} chars`;
  }
  function flash(msg) {
    statusEl.textContent = msg;
    statusEl.classList.add('qn-ok');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => statusEl.textContent = 'saved ✓', 1400);
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    statusEl.textContent = 'saving…';
    statusEl.classList.remove('qn-ok');
    saveTimer = setTimeout(save, 200);
  }
  async function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      await save();
    }
  }
  async function save() {
    const n = activeNote();
    if (!n) return;
    n.content = textarea.value;
    n.updatedAt = Date.now();
    if (!n.titleLocked) {
      n.title = deriveTitle(textarea.value);
    }
    if (shadow) {
      const lbl = shadow.getElementById('renameBtn');
      if (lbl) lbl.textContent = n.title || 'Untitled';
    }
    await storageSet({ notes: state.notes, activeId: state.activeId });
    updatePaneLabel();
    statusEl.textContent = 'saved ✓';
    statusEl.classList.add('qn-ok');
  }
  function updatePaneLabel() {
    // Update the pane 1 select to reflect the active note's (possibly
    // renamed) title. Options list regeneration is handled by renderPane1Selector.
    renderPane1Selector();
  }
  function insertAtCursor(text) {
    textarea.focus();
    try {
      if (!document.execCommand('insertText', false, text)) {
        throw new Error('execCommand failed');
      }
    } catch (err) {
      const s = textarea.selectionStart, e = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, s) + text + textarea.value.slice(e);
      textarea.selectionStart = textarea.selectionEnd = s + text.length;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ===== Markdown table insertion =====
  function buildMarkdownTable(rows, cols) {
    const cell = '   ';
    const header = '| ' + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ') + ' |';
    const sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
    const body = Array.from({ length: rows }, () =>
      '| ' + Array.from({ length: cols }, () => cell).join(' | ') + ' |'
    ).join('\n');
    return `${header}\n${sep}\n${body}`;
  }

  function insertTable(rows, cols) {
    const md = buildMarkdownTable(rows, cols);
    const s = textarea.selectionStart;
    const before = textarea.value[s - 1];
    const prefix = (s === 0 || before === '\n') ? '' : '\n';
    // Add a trailing newline so the next thing the user types doesn't run
    // into the table.
    insertAtCursor(prefix + md + '\n');
    flash(`table ${rows}×${cols}`);
  }

  // Visual size picker: click-and-drag a grid to choose dimensions.
  function openTablePicker(anchorBtn) {
    const MAX_R = 8, MAX_C = 8;
    const picker = document.createElement('div');
    picker.className = 'qn-tbl-picker';
    const label = document.createElement('div');
    label.className = 'qn-tbl-picker-label';
    label.textContent = '0 × 0';
    const grid = document.createElement('div');
    grid.className = 'qn-tbl-picker-grid';
    grid.style.gridTemplateColumns = `repeat(${MAX_C}, 1fr)`;
    let hoverR = 0, hoverC = 0;
    const cells = [];
    for (let r = 0; r < MAX_R; r++) {
      for (let c = 0; c < MAX_C; c++) {
        const cell = document.createElement('div');
        cell.className = 'qn-tbl-picker-cell';
        cell.dataset.r = r;
        cell.dataset.c = c;
        cell.addEventListener('mouseenter', () => {
          hoverR = r + 1; hoverC = c + 1;
          updateHighlight();
        });
        cell.addEventListener('click', () => {
          picker.remove();
          insertTable(hoverR, hoverC);
        });
        grid.appendChild(cell);
        cells.push(cell);
      }
    }
    function updateHighlight() {
      label.textContent = `${hoverR} × ${hoverC}`;
      cells.forEach(c => {
        const rr = +c.dataset.r, cc = +c.dataset.c;
        c.classList.toggle('qn-active', rr < hoverR && cc < hoverC);
      });
    }
    picker.appendChild(label);
    picker.appendChild(grid);

    // Position picker near the toolbar button
    const rect = anchorBtn.getBoundingClientRect();
    const wrapRect = shadow.getElementById('wrap').getBoundingClientRect();
    picker.style.position = 'absolute';
    picker.style.top = (rect.bottom - wrapRect.top + 4) + 'px';
    picker.style.left = (rect.left - wrapRect.left) + 'px';
    shadow.getElementById('paper').appendChild(picker);

    // Dismiss on outside click
    setTimeout(() => {
      const dismiss = (ev) => {
        if (!ev.composedPath().includes(picker)) {
          picker.remove();
          document.removeEventListener('click', dismiss);
        }
      };
      document.addEventListener('click', dismiss);
    }, 0);
  }

  async function logHistory({ source, content }) {
    if (!content) return;
    const entry = {
      id: genId(), ts: Date.now(), source,
      preview: content.slice(0, 300), full: content,
      noteId: state.activeId, url: location.href, title: document.title
    };
    state.history.unshift(entry);
    if (state.history.length > MAX_HISTORY) state.history = state.history.slice(0, MAX_HISTORY);
    await storageSet({ history: state.history });
  }

  // ---------- Views ----------
  // switchView replaced by showView

  // ---------- Search ----------
  function runSearch() {
    const q = searchInput.value.trim();
    const scope = shadow.getElementById('searchScope').value;
    searchResults.innerHTML = '';
    if (!q) { searchCount.textContent = 'type to search'; return; }
    const lower = q.toLowerCase();
    const results = [];

    if (scope === 'all' || scope === 'notes') {
      state.notes.forEach(n => {
        const inTitle = n.title.toLowerCase().includes(lower);
        const inContent = n.content.toLowerCase().includes(lower);
        if (inTitle || inContent) {
          let snippet = n.title;
          if (inContent) {
            const idx = n.content.toLowerCase().indexOf(lower);
            const start = Math.max(0, idx - 30);
            const end = Math.min(n.content.length, idx + q.length + 70);
            snippet = (start > 0 ? '…' : '') + n.content.slice(start, end) + (end < n.content.length ? '…' : '');
          }
          results.push({ type: 'note', id: n.id, title: n.title, snippet, pinned: n.pinned, ts: n.updatedAt });
        }
      });
    }
    if (scope === 'all' || scope === 'history') {
      state.history.forEach(h => {
        if (h.full.toLowerCase().includes(lower)) {
          results.push({ type: 'history', id: h.id, source: h.source, preview: h.preview, full: h.full, title: h.title, ts: h.ts });
        }
      });
    }
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'note' ? -1 : 1;
      return b.ts - a.ts;
    });
    searchCount.textContent = `${results.length} match${results.length === 1 ? '' : 'es'}`;

    results.forEach(r => {
      const li = document.createElement('li');
      const ico = document.createElement('div'); ico.className = 'qn-ico';
      ico.innerHTML = r.type === 'note' ? svgIcon(r.pinned ? 'pin' : 'check') : svgIcon(historyIcon(r.source));
      const body = document.createElement('div'); body.className = 'qn-body-cell';
      const snip = document.createElement('div'); snip.className = 'qn-snip';
      snip.innerHTML = highlightMatch(r.type === 'note' ? r.snippet : r.preview, q);
      const meta = document.createElement('div'); meta.className = 'qn-meta';
      meta.textContent = r.type === 'note'
        ? `note · ${r.title} · ${fmtTime(r.ts)}`
        : `${(r.source || '').replace(/-/g, ' ')} · ${fmtTime(r.ts)}${r.title ? ' · ' + r.title.slice(0, 30) : ''}`;
      body.appendChild(snip); body.appendChild(meta);
      li.appendChild(ico); li.appendChild(body);
      li.addEventListener('click', async () => {
        if (r.type === 'note') {
          showView('editorView');
          state.activeId = r.id;
          await storageSet({ activeId: state.activeId });
          renderSelector(); loadActiveIntoEditor();
          updatePinButton(); updateDefaultButton(); updateTagUI();
        } else {
          showView('editorView');
          insertAtCursor(r.full);
          flash('inserted from history');
        }
      });
      searchResults.appendChild(li);
    });
  }
  function highlightMatch(text, q) {
    const safe = escapeHtml(text || '');
    if (!q) return safe;
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(esc, 'gi'), m => `<span class="qn-hl">${m}</span>`);
  }

  // ---------- History ----------
  function historyIcon(source) {
    const m = { 'clipboard': 'clipboard', 'auto-paste': 'clipboard', 'page': 'link',
                'selection': 'scissors', 'ctx-selection': 'scissors',
                'ctx-page': 'link', 'ctx-link': 'link' };
    return m[source] || 'check';
  }
  function fmtTime(ts) {
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function renderHistory() {
    historyCountEl.textContent = `${state.history.length} entries`;
    if (state.history.length === 0) {
      historyListEl.innerHTML = '<li class="qn-empty">No history yet. Your captures will appear here.</li>';
      return;
    }
    historyListEl.innerHTML = '';
    state.history.forEach(entry => {
      const li = document.createElement('li');
      const ico = document.createElement('div'); ico.className = 'qn-ico';
      ico.innerHTML = svgIcon(historyIcon(entry.source));
      const body = document.createElement('div'); body.className = 'qn-body-cell';
      const snip = document.createElement('div'); snip.className = 'qn-snip';
      snip.textContent = entry.preview;
      const meta = document.createElement('div'); meta.className = 'qn-meta';
      const src = (entry.source || '').replace(/-/g, ' ');
      const titleBit = entry.title ? ` · ${entry.title.slice(0, 30)}` : '';
      meta.textContent = `${src} · ${fmtTime(entry.ts)}${titleBit}`;
      body.appendChild(snip); body.appendChild(meta);
      const del = document.createElement('button'); del.className = 'qn-del'; del.textContent = '✕';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        state.history = state.history.filter(h => h.id !== entry.id);
        await storageSet({ history: state.history });
        renderHistory();
      });
      li.appendChild(ico); li.appendChild(body); li.appendChild(del);
      li.addEventListener('click', () => {
        showView('editorView');
        insertAtCursor(entry.full);
        flash('inserted from history');
      });
      historyListEl.appendChild(li);
    });
  }

  // ---------- Preview (markdown + checklist) ----------
  function renderPreview() {
    const text = textarea.value;
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, inOList = false;
    const closeList = () => {
      if (inList) { html += '</ul>'; inList = false; }
      if (inOList) { html += '</ol>'; inOList = false; }
    };
    const inline = (s) => {
      // Extract Markdown images first. Support three URL forms:
      //   - qn-img:ID (our internal reference scheme, resolved from state.images)
      //   - data:image/...;base64,... (legacy inline data URLs from older notes)
      //   - http(s):// URLs
      const imgs = [];
      const withoutImgs = s.replace(/!\[([^\]]*)\]\((qn-img:[A-Za-z0-9_]+|data:image\/[a-zA-Z.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^)]+)\)/g, (_, alt, url) => {
        const idx = imgs.length;
        imgs.push({ alt, url });
        return `\u0000QNIMG${idx}\u0000`;
      });
      // Extract <span style="color: X">text</span> patterns too, so the
      // color style passes through without being HTML-escaped. Only allow
      // hex-color and single-word color names to keep this safe from XSS.
      const colorSpans = [];
      const withoutSpans = withoutImgs.replace(
        /<span\s+style="color:\s*(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s*">([\s\S]*?)<\/span>/g,
        (_, color, content) => {
          const idx = colorSpans.length;
          colorSpans.push({ color, content });
          return `\u0000QNCOLOR${idx}\u0000`;
        }
      );
      let out = escapeHtml(withoutSpans)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
      // Restore color spans. Content is inline-parsed recursively so markdown
      // inside the span (bold, italics, links) still works.
      out = out.replace(/\u0000QNCOLOR(\d+)\u0000/g, (_, n) => {
        const { color, content } = colorSpans[+n];
        // Re-run inline on the inner content (without the already-extracted
        // images, which are still placeholdered). escapeHtml first.
        const inner = escapeHtml(content)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\*([^*]+)\*/g, '<em>$1</em>');
        return `<span style="color: ${color}">${inner}</span>`;
      });
      // Restore images as <img> elements, resolving qn-img: refs from the store
      out = out.replace(/\u0000QNIMG(\d+)\u0000/g, (_, n) => {
        const { alt, url } = imgs[+n];
        const altEsc = escapeHtml(alt || 'image');
        let src = url;
        if (url.startsWith('qn-img:')) {
          const id = url.slice(7);
          src = state.images[id] || '';
          if (!src) return `<span class="qn-img-missing">[missing image: ${escapeHtml(id)}]</span>`;
        }
        return `<img class="qn-img" alt="${altEsc}" src="${src}">`;
      });
      return out;
    };

    // Helper: detect a Markdown table starting at index `i`. Returns
    // { html, consumed } if a valid table was found, or null otherwise.
    // A valid table has: header row (pipes), separator row (---|---|---),
    // and zero or more body rows.
    const splitCells = (line) => {
      // Strip optional leading/trailing pipes, then split on unescaped |.
      let s = line.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map(c => c.trim());
    };
    const isSepRow = (line) => {
      const s = line.trim();
      if (!s.includes('|') && !/^[\s:|-]+$/.test(s)) return false;
      // Each cell must match optional :, dashes, optional :
      const cells = splitCells(s);
      if (cells.length === 0) return false;
      return cells.every(c => /^:?-{3,}:?$/.test(c));
    };
    const tryTable = (start) => {
      const header = lines[start];
      const sep = lines[start + 1];
      if (!header || !sep) return null;
      if (!header.includes('|')) return null;
      if (!isSepRow(sep)) return null;
      const headers = splitCells(header);
      const aligns = splitCells(sep).map(c => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return null;
      });
      const bodyRows = [];
      let i = start + 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        bodyRows.push(splitCells(lines[i]));
        i++;
      }
      let h = '<div class="qn-tbl-wrap"><table class="qn-tbl"><thead><tr>';
      headers.forEach((c, idx) => {
        const a = aligns[idx];
        h += `<th${a ? ` style="text-align:${a}"` : ''}>${inline(c)}</th>`;
      });
      h += '</tr></thead><tbody>';
      bodyRows.forEach(row => {
        h += '<tr>';
        for (let idx = 0; idx < headers.length; idx++) {
          const cell = row[idx] || '';
          const a = aligns[idx];
          h += `<td${a ? ` style="text-align:${a}"` : ''}>${inline(cell)}</td>`;
        }
        h += '</tr>';
      });
      h += '</tbody></table></div>';
      return { html: h, consumed: i - start };
    };

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (/^```/.test(line)) {
        if (!inCode) { closeList(); html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += escapeHtml(line) + '\n'; continue; }
      // Try table first (must check before checking for plain pipes elsewhere)
      if (line.includes('|')) {
        const t = tryTable(idx);
        if (t) {
          closeList();
          html += t.html;
          idx += t.consumed - 1; // for-loop will increment
          continue;
        }
      }
      const chk = line.match(/^(\s*)[-*] \[( |x|X)\] (.*)$/);
      if (chk) {
        closeList();
        const checked = chk[2].toLowerCase() === 'x';
        html += `<label class="chk-line ${checked ? 'done' : ''}" data-line="${idx}">
          <input type="checkbox" ${checked ? 'checked' : ''} data-line="${idx}">
          <span class="txt">${inline(chk[3])}</span>
        </label>`;
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.+)$/);
      if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
      if (/^---+\s*$/.test(line)) { closeList(); html += '<hr>'; continue; }
      if (/^>\s?/.test(line)) { closeList(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
      const uli = line.match(/^[-*]\s+(.+)$/);
      if (uli) {
        if (inOList) { html += '</ol>'; inOList = false; }
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inline(uli[1])}</li>`; continue;
      }
      const oli = line.match(/^\d+\.\s+(.+)$/);
      if (oli) {
        if (inList) { html += '</ul>'; inList = false; }
        if (!inOList) { html += '<ol>'; inOList = true; }
        html += `<li>${inline(oli[1])}</li>`; continue;
      }
      // Treat lines containing only whitespace or invisible/zero-width
      // chars as empty. Plain .trim() does NOT strip U+200B/C/D or U+FEFF,
      // so lines with just those would otherwise render as empty <p> blocks
      // that still occupy vertical space.
      if (!line.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '').trim()) { closeList(); continue; }
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
    closeList();
    if (inCode) html += '</code></pre>';
    previewEl.innerHTML = html;
  }

  // ---------- Pin / default buttons ----------
  function updatePinButton() {
    const n = activeNote();
    const btn = shadow.getElementById('pinNote');
    if (!n || !btn) return;
    btn.classList.toggle('qn-active', !!n.pinned);
    btn.title = n.pinned ? 'Unpin note' : 'Pin note to top';
  }

  // Color tag plumbing
  const TAG_CSS = {
    red: '#e57373', orange: '#f0a35e', yellow: '#e7c862', green: '#7bb87a',
    blue: '#6da4d4', purple: '#a880c4', pink: '#d486a8'
  };
  function updateTagUI() {
    const n = activeNote();
    const btn = shadow.getElementById('tagBtn');
    const dot = shadow.querySelector('.qn-brand-dot');
    const color = (n && n.tag && TAG_CSS[n.tag]) || null;
    if (btn) {
      if (color) {
        btn.style.color = color;
        btn.classList.add('qn-active');
      } else {
        btn.style.color = '';
        btn.classList.remove('qn-active');
      }
    }
    if (dot) {
      dot.style.background = color || 'var(--accent)';
      dot.style.boxShadow = color ? `0 0 8px ${color}55` : '0 0 8px var(--accent-soft)';
    }
  }
  function currentSitePattern() {
    try { const u = new URL(location.href); return `${u.protocol}//${u.host}/*`; }
    catch { return null; }
  }
  function currentSiteIsDefault() {
    const pat = currentSitePattern();
    return pat && state.settings.siteDefaults?.[pat] === state.activeId;
  }
  function updateDefaultButton() {
    const btn = shadow.getElementById('defaultBtn');
    if (!btn) return;
    const pat = currentSitePattern();
    btn.classList.toggle('qn-active', pat && currentSiteIsDefault());
    btn.title = pat ? (currentSiteIsDefault()
      ? 'This note is default for this site (click to remove)'
      : 'Set as default for this site')
      : 'Not available here';
  }

  // ---------- Auto-paste ----------
  async function maybeAutoPaste() {
    try {
      if (!matchesAny(location.href, state.settings.autoPasteSites)) return;
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const hash = hashStr(text);
      if (hash === state.settings.lastAutoPastedHash) return;
      const sep = textarea.value && !textarea.value.endsWith('\n') ? '\n' : '';
      textarea.value = textarea.value + sep + text + '\n';
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      updateCounter();
      state.settings.lastAutoPastedHash = hash;
      await storageSet({ settings: state.settings });
      await logHistory({ source: 'auto-paste', content: text });
      scheduleSave();
      flash('auto-pasted ✓');
    } catch { /* silently */ }
  }

  // ---------- Events ----------
  function wireEvents(wrap) {
    const head = shadow.getElementById('head');
    const homeHead = shadow.getElementById('homeHead');
    const heads = [head, homeHead].filter(Boolean);

    // Double-click anywhere on the header (except buttons/select) recenters.
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, select, .qn-select')) return;
      recenterPanel();
    });

    // Keyboard rescue: Alt+Shift+R recenters the panel, even if it's off-screen.
    // Listen at the document level (capture phase) so we catch it regardless
    // of focus location, and stopImmediatePropagation to avoid site conflicts.
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        // Only if our panel exists and is visible
        if (host && host.style.display !== 'none') {
          e.preventDefault();
          e.stopPropagation();
          recenterPanel();
        }
      }
      // Alt+Shift+S toggles split view
      if (e.altKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        if (host && host.style.display !== 'none') {
          e.preventDefault();
          e.stopPropagation();
          state.split = !state.split;
          applySplit(wrap);
          storageSet({ split: state.split });
          if (state.split) {
            renderPane1Selector();
            renderPane2Selector();
            loadPane2IntoEditor();
          }
          flash(state.split ? 'split on' : 'split off');
        }
      }
    }, true);

    // Show a "move" cursor on the panel while Alt is held, to hint that
    // Alt+drag repositions the window. Cleared on keyup or blur.
    function syncAltCursor(held) {
      wrap.classList.toggle('qn-alt-held', !!held);
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Alt') syncAltCursor(true);
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') syncAltCursor(false);
    });
    window.addEventListener('blur', () => syncAltCursor(false));

    // Window resize: re-clamp so panel stays reachable if the viewport shrinks.
    window.addEventListener('resize', () => {
      applyGeometry(wrap);
      savePanelGeometry();
    });

    (function dragSetup() {
      let sx, sy, st, sl, dragging = false;

      // Shared drag-move logic — starts a drag from a given pointer position.
      function beginDrag(e) {
        const r = wrap.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; st = r.top; sl = r.left;
        dragging = true;
        head.classList.add('dragging');
        e.preventDefault();
      }

      heads.forEach(h => {
        h.addEventListener('mousedown', (e) => {
          if (e.target.closest('button, select')) return;
          beginDrag(e);
        });
      });

      // Alt + drag anywhere on the panel moves the window. This is the
      // primary way to reposition in zen mode (no visible header). Also
      // works in normal mode as a power-user shortcut.
      wrap.addEventListener('mousedown', (e) => {
        if (!e.altKey) return;
        if (e.target.closest('button, select, input, textarea')) return;
        beginDrag(e);
      });

      // Dedicated thin drag strip at the top edge — visible only in zen
      // mode. Gives users a discoverable handle without needing to know
      // about the Alt modifier.
      const zenDrag = shadow.getElementById('zenDragStrip');
      if (zenDrag) {
        zenDrag.addEventListener('mousedown', (e) => {
          if (e.target.closest('button')) return;
          beginDrag(e);
        });
      }

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const pr = wrap.getBoundingClientRect();
        // Keep at least KEEP_VISIBLE pixels of the header reachable from
        // every side so the panel can always be grabbed and moved back.
        const KEEP = 80;
        const maxLeft = window.innerWidth - KEEP;
        const minLeft = KEEP - pr.width;
        const maxTop = window.innerHeight - KEEP;
        const minTop = 0;
        const nt = Math.max(minTop, Math.min(maxTop, st + (e.clientY - sy)));
        const nl = Math.max(minLeft, Math.min(maxLeft, sl + (e.clientX - sx)));
        wrap.style.top = nt + 'px';
        wrap.style.left = nl + 'px';
        wrap.style.right = 'auto';
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        head.classList.remove('dragging');
        const r = wrap.getBoundingClientRect();
        state.panel.top = r.top; state.panel.left = r.left; state.panel.right = null;
        savePanelGeometry();
      });
    })();

    // Resize (8-way)
    (function resizeSetup() {
      let dir = null, sx, sy, sw, sh, sl, st;
      const onMove = (e) => {
        if (!dir) return;
        let w = sw, h = sh, l = sl, t = st;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (dir.includes('e')) w = sw + dx;
        if (dir.includes('w')) { w = sw - dx; l = sl + dx; }
        if (dir.includes('s')) h = sh + dy;
        if (dir.includes('n')) { h = sh - dy; t = st + dy; }
        w = Math.max(320, Math.min(900, w));
        h = Math.max(260, Math.min(800, h));
        wrap.style.width = w + 'px';
        wrap.style.height = h + 'px';
        wrap.style.left = l + 'px';
        wrap.style.top = t + 'px';
        wrap.style.right = 'auto';
        state.panel = { ...state.panel, width: w, height: h, left: l, top: t, right: null };
      };
      const onUp = () => {
        if (!dir) return;
        dir = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        savePanelGeometry();
      };
      shadow.querySelectorAll('.qn-rz').forEach(h => {
        h.addEventListener('mousedown', (e) => {
          dir = h.dataset.dir;
          const r = wrap.getBoundingClientRect();
          sx = e.clientX; sy = e.clientY;
          sw = r.width; sh = r.height; sl = r.left; st = r.top;
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
          e.preventDefault();
        });
      });
    })();

    // Close / hide
    shadow.getElementById('closeBtn').addEventListener('click', hide);

    // Navigation listeners
    shadow.getElementById('goHome').addEventListener('click', async () => {
      await save();
      showView('homeView');
    });

    shadow.getElementById('homeNewNote').addEventListener('click', async () => {
      if (previewOn) togglePreview(false); // Disable preview
      const note = { id: genId(), title: 'Untitled', content: '', updatedAt: Date.now(), pinned: false };
      state.notes.push(note);
      state.activeId = note.id;
      await storageSet({ notes: state.notes, activeId: state.activeId });
      loadActiveIntoEditor();
      showView('editorView');
      textarea.focus();
    });

    shadow.getElementById('homeSearchBtn').addEventListener('click', () => showView('searchView'));
    shadow.getElementById('homeHistoryBtn').addEventListener('click', () => showView('historyView'));
    shadow.getElementById('homeThemeBtn').addEventListener('click', () => {
      state.theme = (state.theme === 'dark' ? 'light' : 'dark');
      wrap.dataset.theme = state.theme;
      storageSet({ theme: state.theme });
      // Update icon in editor too
      const themeBtn = shadow.getElementById('themeBtn');
      if (themeBtn) themeBtn.innerHTML = svgIcon(state.theme === 'dark' ? 'sun' : 'bat');
      // Update home theme button icon
      const homeThemeBtn = shadow.getElementById('homeThemeBtn');
      if (homeThemeBtn) homeThemeBtn.innerHTML = svgIcon(state.theme === 'dark' ? 'sun' : 'bat');
    });

    shadow.getElementById('homeOptionsBtn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'open-options' });
    });

    shadow.getElementById('homeModeToggle').addEventListener('click', async () => {
      await save();
      state.settings.defaultView = 'popup';
      await storageSet({ settings: state.settings });
      chrome.runtime.sendMessage({ type: 'refresh-action-state' });
      hide();
    });

    shadow.getElementById('modeToggle').addEventListener('click', async () => {
      await save();
      state.settings.defaultView = 'popup';
      await storageSet({ settings: state.settings });
      chrome.runtime.sendMessage({ type: 'refresh-action-state' });
      hide();
    });

    shadow.getElementById('homeHideBtn').addEventListener('click', () => {
      hide();
    });

    shadow.getElementById('newNote').addEventListener('click', async () => {
      await save();
      if (previewOn) togglePreview(false); // Disable preview
      const note = { id: genId(), title: 'Untitled', content: '', updatedAt: Date.now(), pinned: false };
      state.notes.push(note);
      state.activeId = note.id;
      await storageSet({ notes: state.notes, activeId: state.activeId });
      loadActiveIntoEditor();
      updateDefaultButton(); updateTagUI();
      textarea.focus();
    });
    shadow.getElementById('backFromSearch').addEventListener('click', () => {
      showView((lastView || 'home') + 'View');
    });
    shadow.getElementById('backFromHistory').addEventListener('click', () => {
      showView((lastView || 'home') + 'View');
    });

    // Textarea
    textarea.addEventListener('input', () => { updateCounter(); scheduleSave(); });
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); flash('saved ✓'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); showView('searchView'); }
    });

    // Image paste: if the clipboard has an image, store it in state.images
    // and insert a short Markdown reference `![image](qn-img:ID)`. Keeps the
    // note text readable; the full data URL is only stored once and looked
    // up at render or copy time.
    // Shared helper: given a File (image), store it in state.images and
    // insert a Markdown reference at the cursor in `targetTextarea`.
    async function insertImageFile(file, targetTextarea) {
      if (!file || !file.type || !file.type.startsWith('image/')) return false;
      const MAX_BYTES = 3 * 1024 * 1024;
      if (file.size > MAX_BYTES) {
        flash(`image too big (${Math.round(file.size / 1024 / 1024)}MB, max 3MB)`);
        return true;
      }
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const imgId = 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        state.images[imgId] = dataUrl;
        await storageSet({ images: state.images });
        const altText = file.type === 'image/gif' ? 'gif' : 'image';
        const md = `![${altText}](qn-img:${imgId})`;
        const s = targetTextarea.selectionStart;
        const e2 = targetTextarea.selectionEnd;
        const before = targetTextarea.value[s - 1];
        const prefix = (s === 0 || before === '\n') ? '' : '\n';
        targetTextarea.value = targetTextarea.value.slice(0, s) + prefix + md + '\n' + targetTextarea.value.slice(e2);
        const newPos = s + prefix.length + md.length + 1;
        targetTextarea.selectionStart = targetTextarea.selectionEnd = newPos;
        targetTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        flash(file.type === 'image/gif' ? 'gif added' : 'image added');
      } catch (err) {
        flash('image paste failed');
      }
      return true;
    }

    async function handleImagePaste(ev, targetTextarea) {
      const items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return false;
      for (const item of items) {
        if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          ev.preventDefault();
          await insertImageFile(file, targetTextarea);
          return true;
        }
      }
      return false;
    }
    textarea.addEventListener('paste', (ev) => handleImagePaste(ev, textarea));

    // Drag-and-drop image files directly onto the textarea. Works for any
    // image type the browser accepts — PNG, JPEG, GIF (with animation
    // preserved), WebP, SVG, etc. A dashed amber outline appears while a
    // valid image is hovering over the drop target.
    function wireDropHandlers(targetTextarea) {
      let dragDepth = 0;
      targetTextarea.addEventListener('dragenter', (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file')) {
          dragDepth++;
          targetTextarea.classList.add('qn-drag-over');
        }
      });
      targetTextarea.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) targetTextarea.classList.remove('qn-drag-over');
      });
      targetTextarea.addEventListener('dragover', (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      targetTextarea.addEventListener('drop', async (e) => {
        dragDepth = 0;
        targetTextarea.classList.remove('qn-drag-over');
        if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault();
        for (const file of e.dataTransfer.files) {
          if (file.type && file.type.startsWith('image/')) {
            await insertImageFile(file, targetTextarea);
          }
        }
      });
    }
    wireDropHandlers(textarea);

    // Prevent host-page keyboard shortcuts from hijacking keys typed inside
    // the panel. Without this, sites like Gmail / GitHub see retargeted
    // events (target = shadow host, not textarea) and treat single letters
    // as page shortcuts, stealing focus mid-keystroke.
    const stopKeyEvent = (e) => e.stopPropagation();
    const wrapEl = shadow.getElementById('wrap');
    ['keydown', 'keyup', 'keypress'].forEach(ev => {
      wrapEl.addEventListener(ev, stopKeyEvent, true);
      wrapEl.addEventListener(ev, stopKeyEvent, false);
    });

    // Toolbar buttons
    shadow.getElementById('undoBtn').addEventListener('click', () => {
      textarea.focus();
      document.execCommand('undo');
    });
    shadow.getElementById('redoBtn').addEventListener('click', () => {
      textarea.focus();
      document.execCommand('redo');
    });
    shadow.getElementById('pasteBtn').addEventListener('click', async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (t) { insertAtCursor(t); await logHistory({ source: 'clipboard', content: t }); flash('pasted ✓'); }
        else flash('clipboard empty');
      } catch { flash('clipboard blocked'); }
    });
    // Replace qn-img:ID refs in text with the full data: URL, so copied or
    // downloaded notes contain the real image and work outside the extension.
    function expandImageRefs(text) {
      return text.replace(/!\[([^\]]*)\]\(qn-img:([A-Za-z0-9_]+)\)/g, (full, alt, id) => {
        const dataUrl = state.images[id];
        if (!dataUrl) return full; // leave the ref if image went missing
        return `![${alt}](${dataUrl})`;
      });
    }

    shadow.getElementById('copyBtn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(expandImageRefs(textarea.value)); flash('copied ✓'); }
      catch { flash('copy failed'); }
    });
    shadow.getElementById('cutBtn').addEventListener('click', async () => {
      const s = textarea.selectionStart, e = textarea.selectionEnd;
      const sel = textarea.value.slice(s, e);
      if (sel) {
        try {
          await navigator.clipboard.writeText(sel);
          textarea.value = textarea.value.slice(0, s) + textarea.value.slice(e);
          updateCounter(); scheduleSave();
          flash('cut ✓');
          textarea.focus();
        } catch { flash('cut failed'); }
      } else flash('nothing selected');
    });
    shadow.getElementById('urlBtn').addEventListener('click', async () => {
      const text = `${document.title}\n${location.href}\n`;
      insertAtCursor(text);
      await logHistory({ source: 'page', content: text });
      flash('link added ✓');
    });
    shadow.getElementById('selBtn').addEventListener('click', async () => {
      const sel = window.getSelection().toString().trim();
      if (sel) {
        const formatted = `"${sel}"\n~ ${document.title} (${location.href})\n\n`;
        insertAtCursor(formatted);
        await logHistory({ source: 'selection', content: formatted });
        flash('selection added ✓');
      } else flash('no selection on page');
    });
    shadow.getElementById('timeBtn').addEventListener('click', () => {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      const offMin = -now.getTimezoneOffset();
      const sign = offMin >= 0 ? '+' : '-';
      const abs = Math.abs(offMin);
      const offH = String(Math.floor(abs / 60)).padStart(2, '0');
      const offM = String(abs % 60).padStart(2, '0');
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `[${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} GMT${sign}${offH}:${offM} (${tz})] `;
      insertAtCursor(stamp);
      flash('time added');
    });
    shadow.getElementById('divBtn').addEventListener('click', () => {
      insertAtCursor('\n━━━━━━━━━━\n');
      flash('divider');
    });
    shadow.getElementById('taskBtn').addEventListener('click', () => {
      const s = textarea.selectionStart;
      const before = textarea.value[s - 1];
      const prefix = (s === 0 || before === '\n') ? '' : '\n';
      insertAtCursor(prefix + '- [ ] ');
      flash('task added');
    });
    shadow.getElementById('tableBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = shadow.querySelector('.qn-tbl-picker');
      if (existing) { existing.remove(); return; }
      openTablePicker(e.currentTarget);
    });

    // ===== Bold =====
    function wrapSelection(before, after) {
      const s = textarea.selectionStart, e = textarea.selectionEnd;
      const selected = textarea.value.slice(s, e);
      const inserted = before + selected + after;
      textarea.value = textarea.value.slice(0, s) + inserted + textarea.value.slice(e);
      if (selected) {
        // Keep the wrapped text selected so you can re-toggle
        textarea.selectionStart = s;
        textarea.selectionEnd = s + inserted.length;
      } else {
        // Place cursor between the markers
        const pos = s + before.length;
        textarea.selectionStart = textarea.selectionEnd = pos;
      }
      textarea.focus();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    shadow.getElementById('boldBtn').addEventListener('click', () => {
      wrapSelection('**', '**');
      flash('bold');
    });

    // ===== Code =====
    // Inline `backticks` for single-line; fenced ``` block for multi-line.
    shadow.getElementById('codeBtn').addEventListener('click', () => {
      const s = textarea.selectionStart, e = textarea.selectionEnd;
      const selected = textarea.value.slice(s, e);
      if (selected.includes('\n')) {
        // Fenced block — ensure leading/trailing newline boundaries
        const before = textarea.value[s - 1];
        const leadNl = (s === 0 || before === '\n') ? '' : '\n';
        const inserted = `${leadNl}\`\`\`\n${selected}\n\`\`\`\n`;
        textarea.value = textarea.value.slice(0, s) + inserted + textarea.value.slice(e);
        textarea.selectionStart = textarea.selectionEnd = s + inserted.length;
      } else if (selected) {
        wrapSelection('`', '`');
      } else {
        // Empty: insert fenced skeleton and drop cursor inside
        const before = textarea.value[s - 1];
        const leadNl = (s === 0 || before === '\n') ? '' : '\n';
        const skeleton = `${leadNl}\`\`\`\n\n\`\`\`\n`;
        textarea.value = textarea.value.slice(0, s) + skeleton + textarea.value.slice(e);
        const pos = s + leadNl.length + 4; // after "```\n"
        textarea.selectionStart = textarea.selectionEnd = pos;
      }
      textarea.focus();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      flash('code');
    });

    // ===== Color picker =====
    shadow.getElementById('colorBtn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const existing = shadow.querySelector('.qn-color-menu');
      if (existing) { existing.remove(); return; }
      const menu = document.createElement('div');
      menu.className = 'qn-color-menu';
      const colors = [
        { name: 'red',     css: '#e57373' },
        { name: 'orange',  css: '#f0a35e' },
        { name: 'yellow',  css: '#e7c862' },
        { name: 'green',   css: '#7bb87a' },
        { name: 'cyan',    css: '#6ec1d4' },
        { name: 'blue',    css: '#6da4d4' },
        { name: 'purple',  css: '#a880c4' },
        { name: 'pink',    css: '#d486a8' },
        { name: 'clear',   css: null }
      ];
      colors.forEach(c => {
        const sw = document.createElement('button');
        sw.className = 'qn-color-swatch' + (c.css === null ? ' qn-none' : '');
        if (c.css) sw.style.background = c.css;
        else sw.textContent = '∅';
        sw.title = c.name;
        sw.addEventListener('click', (e2) => {
          e2.stopPropagation();
          menu.remove();
          const s = textarea.selectionStart, e = textarea.selectionEnd;
          const selected = textarea.value.slice(s, e);
          if (c.css) {
            // Wrap in <span style="color: ..."> — valid inline HTML in Markdown
            wrapSelection(`<span style="color: ${c.css}">`, `</span>`);
            flash(`color: ${c.name}`);
          } else {
            // Strip any <span style="color: ..."> wrapping the selection
            if (selected) {
              const stripped = selected
                .replace(/^<span\s+style="color:\s*[^"]*">/, '')
                .replace(/<\/span>$/, '');
              textarea.value = textarea.value.slice(0, s) + stripped + textarea.value.slice(e);
              textarea.selectionStart = s;
              textarea.selectionEnd = s + stripped.length;
              textarea.dispatchEvent(new Event('input', { bubbles: true }));
              flash('color cleared');
            }
          }
        });
        menu.appendChild(sw);
      });
      // Position near the color button
      const rect = ev.currentTarget.getBoundingClientRect();
      const wrapRect = shadow.getElementById('wrap').getBoundingClientRect();
      menu.style.top = (rect.bottom - wrapRect.top + 4) + 'px';
      menu.style.left = (rect.left - wrapRect.left) + 'px';
      shadow.getElementById('paper').appendChild(menu);
      setTimeout(() => {
        const dismiss = (e2) => {
          if (!e2.composedPath().includes(menu)) {
            menu.remove();
            document.removeEventListener('click', dismiss);
          }
        };
        document.addEventListener('click', dismiss);
      }, 0);
    });

    function togglePreview(force) {
      previewOn = (force !== undefined) ? force : !previewOn;
      const btn = shadow.getElementById('previewBtn');
      btn.classList.toggle('qn-active', previewOn);
      wrap.classList.toggle('qn-preview-on', previewOn);
      textarea.hidden = previewOn;
      previewEl.hidden = !previewOn;
      
      // Disable toolbar buttons when preview is active
      const toolbarButtons = shadow.querySelectorAll('#toolbar .qn-btn:not(#previewBtn)');
      toolbarButtons.forEach(b => b.disabled = previewOn);

      // Disable split button in header too
      const splitBtn = shadow.getElementById('splitBtn');
      if (splitBtn) splitBtn.disabled = previewOn;
      
      if (previewOn) renderPreview();
    }

    shadow.getElementById('previewBtn').addEventListener('click', () => togglePreview());

    // ===== Zoom controls =====
    const ZOOM_STEP = 1;
    const ZOOM_MIN = 10;
    const ZOOM_MAX = 28;
    let zoomSaveTimer = null;
    function persistZoom() {
      clearTimeout(zoomSaveTimer);
      zoomSaveTimer = setTimeout(() => storageSet({ fontSize: state.fontSize }), 50);
    }
    shadow.getElementById('zoomInBtn').addEventListener('click', () => {
      const next = Math.min(ZOOM_MAX, (state.fontSize || 13) + ZOOM_STEP);
      if (next === state.fontSize) return;
      state.fontSize = next;
      applyFontSize(wrap);
      persistZoom();
    });
    shadow.getElementById('zoomOutBtn').addEventListener('click', () => {
      const next = Math.max(ZOOM_MIN, (state.fontSize || 13) - ZOOM_STEP);
      if (next === state.fontSize) return;
      state.fontSize = next;
      applyFontSize(wrap);
      persistZoom();
    });
    // Click the "13px" label to reset to default
    shadow.getElementById('zoomLabel').addEventListener('click', () => {
      state.fontSize = 13;
      applyFontSize(wrap);
      persistZoom();
      flash('zoom reset');
    });

    // ===== Zen mode =====
    async function toggleZen() {
      state.zen = !state.zen;
      applyZen(wrap);
      await storageSet({ zen: state.zen });
      flash(state.zen ? 'zen mode' : 'back to normal');
      // Refocus the textarea (which shifts when toolbars hide/show)
      if (textarea) textarea.focus();
    }
    shadow.getElementById('zenBtn').addEventListener('click', toggleZen);
    shadow.getElementById('zenExitBtn').addEventListener('click', async () => {
      if (!state.zen) return;
      await toggleZen();
    });
    // Esc exits zen mode when the panel has focus. Attached on the shadow
    // wrap so we don't mess with page-level Esc behavior.
    shadow.getElementById('wrap').addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.zen) {
        e.preventDefault();
        toggleZen();
      }
    });
    previewEl.addEventListener('click', async (e) => {
      const cb = e.target.closest('input[type="checkbox"][data-line]');
      if (!cb) return;
      const idx = parseInt(cb.dataset.line, 10);
      const lines = textarea.value.split('\n');
      if (idx < 0 || idx >= lines.length) return;
      const m = lines[idx].match(/^(\s*[-*] \[)( |x|X)(\].*)$/);
      if (!m) return;
      lines[idx] = m[1] + (m[2].toLowerCase() === 'x' ? ' ' : 'x') + m[3];
      textarea.value = lines.join('\n');
      updateCounter(); await save(); renderPreview();
    });
    shadow.getElementById('defaultBtn').addEventListener('click', async () => {
      const pat = currentSitePattern();
      if (!pat) return flash('no site');
      state.settings.siteDefaults = state.settings.siteDefaults || {};
      if (state.settings.siteDefaults[pat] === state.activeId) {
        delete state.settings.siteDefaults[pat];
        flash('default removed');
      } else {
        state.settings.siteDefaults[pat] = state.activeId;
        try { flash(`default set: ${new URL(location.href).host}`); }
        catch { flash('default set'); }
      }
      await storageSet({ settings: state.settings });
      updateDefaultButton();
    });
    shadow.getElementById('dlBtn').addEventListener('click', () => {
      const n = activeNote(); if (!n) return;
      const fullContent = expandImageRefs(n.content);
      const blob = new Blob([fullContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safe = (n.title || 'note').replace(/[^a-z0-9_\- ]/gi, '_').trim() || 'note';
      a.href = url; a.download = `${safe}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash('downloading…');
    });

    // ===== Split view =====
    shadow.getElementById('splitBtn').addEventListener('click', async () => {
      // Toggle on/off. Direction is remembered separately in state.splitDir.
      state.split = !state.split;
      applySplit(wrap);
      await storageSet({ split: state.split });
      if (state.split) {
        renderPane1Selector();
        renderPane1Selector(); renderPane2Selector();
        loadPane2IntoEditor();
      }
    });

    // Flip between horizontal and vertical split
    shadow.getElementById('splitDirBtn').addEventListener('click', async () => {
      state.splitDir = state.splitDir === 'h' ? 'v' : 'h';
      applySplit(wrap);
      await storageSet({ splitDir: state.splitDir });
      flash(`split: ${state.splitDir === 'h' ? 'horizontal' : 'vertical'}`);
    });

    // Swap pane 1 and pane 2 notes
    shadow.getElementById('splitSwapBtn').addEventListener('click', async () => {
      if (!state.split) return;
      // Save any pending edits first so nothing is lost
      await save();
      await savePane2();
      const prevActive = state.activeId;
      const prevPane2 = state.pane2Id;
      if (prevActive === prevPane2) return; // nothing to swap
      state.activeId = prevPane2;
      state.pane2Id = prevActive;
      await storageSet({ activeId: state.activeId, pane2Id: state.pane2Id });
      renderSelector();
      renderPane1Selector();
      renderPane2Selector();
      loadActiveIntoEditor();
      loadPane2IntoEditor();
      updatePinButton();
      updateDefaultButton();
      updateTagUI();
      flash('swapped');
    });

    // Pane 1 selector (only visible when split is on)
    shadow.getElementById('pane1Select').addEventListener('change', async (e) => {
      const targetId = e.target.value;
      await save();
      state.activeId = targetId;
      await storageSet({ activeId: state.activeId });
      renderSelector();
      renderPane1Selector();
      loadActiveIntoEditor();
      updatePinButton(); updateDefaultButton(); updateTagUI();
    });

    // Pane 2 note selector
    shadow.getElementById('pane2Select').addEventListener('change', async (e) => {
      const targetId = e.target.value;
      await savePane2();
      state.pane2Id = targetId;
      await storageSet({ pane2Id: state.pane2Id });
      renderPane2Selector();
      loadPane2IntoEditor();
    });

    // Pane 2 textarea: own save pipeline (doesn't go through pane 1's `save`)
    const text2 = shadow.getElementById('text2');
    let p2SaveTimer = null;
    text2.addEventListener('input', () => {
      clearTimeout(p2SaveTimer);
      p2SaveTimer = setTimeout(savePane2, 200);
    });
    async function savePane2() {
      const n = pane2Note();
      if (!n) return;
      n.content = text2.value;
      n.updatedAt = Date.now();
      if (!n.titleLocked) {
        n.title = deriveTitle(text2.value);
      }
      await storageSet({ notes: state.notes });
      renderSelector();
      renderPane1Selector(); renderPane2Selector();
    }
    // Stop key events leaking out of pane 2 textarea too
    text2.addEventListener('keydown', (e) => e.stopPropagation());
    text2.addEventListener('keyup', (e) => e.stopPropagation());
    text2.addEventListener('keypress', (e) => e.stopPropagation());
    text2.addEventListener('paste', (ev) => handleImagePaste(ev, text2));
    wireDropHandlers(text2);

    // Splitter drag
    (function splitterDrag() {
      const splitter = shadow.getElementById('splitter');
      const body = shadow.getElementById('body');
      let dragging = false;
      splitter.addEventListener('mousedown', (e) => {
        dragging = true;
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        if (!state.split) return;
        const rect = body.getBoundingClientRect();
        let ratio;
        if (state.splitDir === 'h') {
          ratio = (e.clientX - rect.left) / rect.width;
        } else {
          ratio = (e.clientY - rect.top) / rect.height;
        }
        ratio = Math.max(0.15, Math.min(0.85, ratio));
        state.paneRatio = ratio;
        const p1 = shadow.getElementById('pane1');
        const p2 = shadow.getElementById('pane2');
        p1.style.flex = `${ratio} 1 0`;
        p2.style.flex = `${1 - ratio} 1 0`;
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        storageSet({ paneRatio: state.paneRatio });
      });
    })();

    // ===== Rename current note (main header button) =====
    shadow.getElementById('renameBtn').addEventListener('click', () => {
      startInlineRename();
    });

    // Inline rename: swap the noteSelect for an <input>, commit on Enter,
    // cancel on Esc, restore the select when done.
    function startInlineRename() {
      const n = activeNote();
      if (!n) return;
      // If an inline rename is already active, focus its input instead
      const existing = shadow.getElementById('renameInput');
      if (existing) { existing.focus(); existing.select(); return; }

      const current = n.title || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'renameInput';
      input.className = 'qn-rename-input';
      input.value = current;
      input.maxLength = 80;
      input.title = 'Enter to save · Esc to cancel · empty = auto-derive';

      // Insert input where noteSelect is, hide noteSelect during edit
      noteSelect.style.display = 'none';
      noteSelect.parentNode.insertBefore(input, noteSelect);

      let committed = false;
      async function commit(save) {
        if (committed) return;
        committed = true;
        input.remove();
        noteSelect.style.display = '';
        if (!save) return;
        const t = (input.value || '').trim().slice(0, 80);
        if (t === current) return; // no change
        if (t) {
          n.title = t;
          n.titleLocked = true;
        } else {
          n.titleLocked = false;
          n.title = deriveTitle(n.content);
        }
        n.updatedAt = Date.now();
        await storageSet({ notes: state.notes });
        renderSelector();
        renderPane1Selector();
        renderPane2Selector();
        flash(t ? 'renamed ✓' : 'title unlocked');
      }

      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
      input.addEventListener('blur', () => commit(true));
      // Focus + select all for quick replace
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    // Theme
    shadow.getElementById('themeBtn').addEventListener('click', async () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      wrap.dataset.theme = state.theme;
      shadow.getElementById('themeBtn').innerHTML = svgIcon(state.theme === 'dark' ? 'sun' : 'bat');
      const homeThemeBtn = shadow.getElementById('homeThemeBtn');
      if (homeThemeBtn) homeThemeBtn.innerHTML = svgIcon(state.theme === 'dark' ? 'sun' : 'bat');
      await storageSet({ theme: state.theme });
    });

    // Opacity slider (live as you drag, persisted on release)
    const slider = shadow.getElementById('opacitySlider');
    slider.value = String(Math.round(state.opacity * 100));
    shadow.getElementById('opacityLabel').textContent = `${slider.value}%`;
    slider.addEventListener('input', () => {
      const v = Math.max(30, Math.min(100, +slider.value || 100));
      state.opacity = v / 100;
      wrap.style.setProperty('--panel-alpha', String(state.opacity));
      shadow.getElementById('opacityLabel').textContent = `${v}%`;
    });
    let opTimer = null;
    slider.addEventListener('change', () => {
      clearTimeout(opTimer);
      opTimer = setTimeout(() => storageSet({ opacity: state.opacity }), 50);
    });

    // Tag picker
    shadow.getElementById('tagBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = shadow.querySelector('.qn-tag-menu');
      if (existing) { existing.remove(); return; }
      const n = activeNote();
      if (!n) return;
      const menu = document.createElement('div');
      menu.className = 'qn-tag-menu';
      const colors = [
        { key: null,        css: null,        label: 'No tag' },
        { key: 'red',       css: '#e57373' },
        { key: 'orange',    css: '#f0a35e' },
        { key: 'yellow',    css: '#e7c862' },
        { key: 'green',     css: '#7bb87a' },
        { key: 'blue',      css: '#6da4d4' },
        { key: 'purple',    css: '#a880c4' },
        { key: 'pink',      css: '#d486a8' }
      ];
      colors.forEach(c => {
        const sw = document.createElement('button');
        sw.className = 'qn-tag-swatch' + (c.key === null ? ' qn-none' : '');
        if (c.css) sw.style.background = c.css;
        if (c.key === null) sw.textContent = '∅';
        sw.title = c.label || c.key;
        if ((n.tag || null) === c.key) sw.classList.add('qn-active');
        sw.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          n.tag = c.key;
          n.updatedAt = Date.now();
          await storageSet({ notes: state.notes });
          renderSelector();
          updateTagUI();
          menu.remove();
          flash(c.key ? `tagged ${c.key}` : 'tag cleared');
        });
        menu.appendChild(sw);
      });
      shadow.getElementById('paper').appendChild(menu);
      // Dismiss on outside click
      setTimeout(() => {
        const dismiss = (ev) => {
          if (!ev.composedPath().includes(menu)) {
            menu.remove();
            document.removeEventListener('click', dismiss);
          }
        };
        document.addEventListener('click', dismiss);
      }, 0);
    });

    // Search / history / options
    shadow.getElementById('searchBtn').addEventListener('click', () => showView('searchView'));
    shadow.getElementById('historyBtn').addEventListener('click', () => showView('historyView'));
    shadow.getElementById('backFromSearch').addEventListener('click', () => showView(lastView + 'View'));
    shadow.getElementById('backFromHistory').addEventListener('click', () => showView(lastView + 'View'));
    shadow.getElementById('clearHistoryBtn').addEventListener('click', async () => {
      if (!confirm('Clear all history?')) return;
      state.history = [];
      await storageSet({ history: [] });
      renderHistory();
    });
    shadow.getElementById('optionsBtn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'open-options' });
    });
    searchInput.addEventListener('input', () => {
      clearTimeout(runSearch._t);
      runSearch._t = setTimeout(runSearch, 80);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') showView('editorView');
    });
    shadow.getElementById('searchScope').addEventListener('change', runSearch);
  }

  // ---------- Storage changes ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !host) return;
    // Ignore echoes of our own writes to prevent focus-steal re-renders.
    if (selfWriting > 0) return;
    if (changes.notes) {
      state.notes = changes.notes.newValue || [];
      state.notes.forEach(n => { if (n.pinned == null) n.pinned = false; });
      if (!state.notes.find(n => n.id === state.activeId) && state.notes.length) {
        state.activeId = state.notes[0].id;
      }
      renderSelector();
      renderPane1Selector(); renderPane2Selector();
      const n = activeNote();
      if (n && document.activeElement !== textarea && textarea.value !== n.content) {
        loadActiveIntoEditor();
      }
      // Sync pane 2 if not focused
      const t2 = shadow && shadow.getElementById('text2');
      const p2 = pane2Note();
      if (t2 && p2 && document.activeElement !== t2 && t2.value !== p2.content) {
        loadPane2IntoEditor();
      }
      updatePaneLabel();
      updatePinButton();
    }
    if (changes.history) {
      state.history = changes.history.newValue || [];
      if (currentView === 'history') renderHistory();
    }
    if (changes.settings) {
      state.settings = Object.assign(state.settings, changes.settings.newValue || {});
      updateDefaultButton();
    }
    if (changes.theme && shadow) {
      state.theme = changes.theme.newValue || state.theme;
      shadow.getElementById('wrap').dataset.theme = state.theme;
      const tb = shadow.getElementById('themeBtn');
      if (tb) tb.innerHTML = svgIcon(state.theme === 'dark' ? 'sun' : 'bat');
    }
    if (changes.shape && shadow) {
      state.shape = changes.shape.newValue || state.shape;
      shadow.getElementById('wrap').dataset.shape = state.shape;
    }
    if (changes.opacity && shadow) {
      const v = typeof changes.opacity.newValue === 'number' ? changes.opacity.newValue : 1;
      state.opacity = Math.max(0.3, Math.min(1, v));
      const wrap = shadow.getElementById('wrap');
      if (wrap) wrap.style.setProperty('--panel-alpha', String(state.opacity));
      const slider = shadow.getElementById('opacitySlider');
      if (slider) slider.value = String(Math.round(state.opacity * 100));
      const lbl = shadow.getElementById('opacityLabel');
      if (lbl) lbl.textContent = `${Math.round(state.opacity * 100)}%`;
    }
    if ((changes.split || changes.splitDir || changes.pane2Id || changes.paneRatio) && shadow) {
      if (changes.split) state.split = changes.split.newValue === true;
      if (changes.splitDir) state.splitDir = changes.splitDir.newValue === 'v' ? 'v' : 'h';
      if (changes.pane2Id) state.pane2Id = changes.pane2Id.newValue || null;
      if (changes.paneRatio && typeof changes.paneRatio.newValue === 'number') {
        state.paneRatio = changes.paneRatio.newValue;
      }
      const wrap = shadow.getElementById('wrap');
      if (wrap) applySplit(wrap);
      renderPane1Selector(); renderPane2Selector();
      loadPane2IntoEditor();
    }
    if (changes.fontSize && shadow) {
      const v = Number(changes.fontSize.newValue);
      state.fontSize = (v >= 10 && v <= 28) ? v : 13;
      const wrap = shadow.getElementById('wrap');
      if (wrap) applyFontSize(wrap);
    }
    if (changes.zen && shadow) {
      state.zen = changes.zen.newValue === true;
      const wrap = shadow.getElementById('wrap');
      if (wrap) applyZen(wrap);
    }
    if (changes.images) {
      state.images = changes.images.newValue || {};
      if (previewOn) renderPreview();
    }
    if (changes.customColors) {
      state.customColors = changes.customColors.newValue || { dark: {}, light: {} };
      applyCustomColors();
    }
  });

  // ---------- Show / hide ----------
  function show(focus = false) {
    if (!host) return;
    host.style.display = '';
    visible = true;

    // Use the view determined during loadState or previous session
    showView(currentView + 'View');

    if (shadow) {
      const wrap = shadow.getElementById('wrap');
      if (wrap) applyGeometry(wrap);
    }
    loadActiveIntoEditor();
    maybeAutoPaste();

    if (focus && currentView === 'editor' && textarea) {
      setTimeout(() => {
        textarea.focus();
      }, 150);
    }
  }
  async function hide() {
    await flushSave();
    if (!host) return;
    host.style.display = 'none';
    visible = false;
  }

  async function bootstrap() {
    if (isBootstrapping || host) return;
    isBootstrapping = true;
    try {
      await loadState();
      buildPanel();
      visible = true;
      if (textarea) textarea.focus();
      maybeAutoPaste();
    } finally {
      isBootstrapping = false;
    }
  }

  // ---------- Message router ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'toggle') {
      if (!host) bootstrap(msg.focus);
      else if (visible) hide();
      else show(msg.focus);
    } else if (msg.type === 'show') {
      if (!host) bootstrap(msg.focus);
      else show(msg.focus);
    } else if (msg.type === 'hide') {
      hide();
    } else if (msg.type === 'recenter') {
      if (!host) {
        bootstrap(msg.focus).then(() => recenterPanel());
      } else {
        show(msg.focus);
        recenterPanel();
      }
    }
    sendResponse && sendResponse({ ok: true });
  });

  window.addEventListener('pagehide', () => {
    flushSave();
  });
})();

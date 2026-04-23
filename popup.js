// Quick Notes v3 · popup logic
const $ = (id) => document.getElementById(id);

const editor = $('editor');
const preview = $('preview');
const noteSelect = $('noteSelect');
const statusEl = $('status');
const counter = $('counter');

const editorView = $('editorView');
const historyView = $('historyView');
const searchView = $('searchView');

const historyList = $('historyList');
const historyCount = $('historyCount');

const searchInput = $('searchInput');
const searchScope = $('searchScope');
const searchResults = $('searchResults');
const searchCount = $('searchCount');

const MAX_HISTORY = 200;

const state = {
  notes: [],
  activeId: null,
  theme: 'dark',
  history: [],
  settings: {
    autoPasteSites: [],
    floatingPanelSites: [],
    siteDefaults: {},      // { "https://foo.com/*": noteId }
    lastAutoPastedHash: ''
  },
  currentTab: null,
  previewOn: false,
  shape: 'rectangle',
  size: { w: 460, h: 560 },
  opacity: 1,
  images: {},
  customColors: { dark: {}, light: {} }
};

let saveTimer = null;
// True while we're writing to storage from within this popup — used to
// ignore the onChanged echo and prevent focus-stealing re-renders.
let selfWriting = 0;

async function storageSet(obj) {
  selfWriting++;
  try { await chrome.storage.local.set(obj); }
  finally {
    // Decrement on next tick so the onChanged handler (which fires async)
    // still sees the flag.
    setTimeout(() => { selfWriting = Math.max(0, selfWriting - 1); }, 0);
  }
}

// ============ Helpers ============
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function activeNote() { return state.notes.find(n => n.id === state.activeId); }
function deriveTitle(c) {
  const f = (c.split('\n')[0] || '').trim().slice(0, 40);
  return f || 'Untitled';
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h.toString(36);
}
function matchPattern(url, pattern) {
  if (!pattern || !url) return false;
  try {
    const re = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*');
    return new RegExp('^' + re + '$').test(url);
  } catch { return false; }
}
const matchesAny = (url, pats) => !!pats && pats.some(p => matchPattern(url, p));
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const VALID_SHAPES = ['rectangle', 'rounded', 'hexagon', 'circle'];
function normalizeShape(s) {
  return VALID_SHAPES.includes(s) ? s : 'rounded';
}

// ============ Load / save ============
async function load() {
  const data = await chrome.storage.local.get([
    'notes', 'activeId', 'theme', 'history', 'settings', 'shape', 'size', 'opacity', 'images', 'customColors'
  ]);
  state.notes = (data.notes && data.notes.length)
    ? data.notes
    : [{ id: genId(), title: 'Untitled', content: '', updatedAt: Date.now(), pinned: false }];
  state.notes.forEach(n => { if (n.pinned == null) n.pinned = false; });

  state.theme = data.theme || 'dark';
  state.history = data.history || [];
  state.settings = Object.assign(
    { autoPasteSites: [], floatingPanelSites: [], siteDefaults: {}, lastAutoPastedHash: '' },
    data.settings || {}
  );
  state.shape = normalizeShape(data.shape);
  state.size = (data.size && typeof data.size.w === 'number') ? data.size : { w: 460, h: 560 };
  const rawOp = typeof data.opacity === 'number' ? data.opacity : 1;
  state.opacity = Math.max(0.3, Math.min(1, rawOp));
  state.images = (data.images && typeof data.images === 'object') ? data.images : {};
  state.customColors = (data.customColors && typeof data.customColors === 'object') ? data.customColors : { dark: {}, light: {} };

  // One-time migration: extract inline data:image URLs to qn-img refs,
  // and strip zero-width / invisible whitespace from note starts.
  let migrated = false;
  const INLINE_IMG_RE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z.+-]+;base64,[A-Za-z0-9+/=]+)\)/g;
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
    const cleaned = content.replace(ZWS_RE, '').replace(/^(?:[ \t]*\n)+/, '');
    if (cleaned !== note.content) {
      note.content = cleaned;
      migrated = true;
    }
  }
  if (migrated) {
    await chrome.storage.local.set({ notes: state.notes, images: state.images });
  }

  // Get current tab early so we can use it for per-site default
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.currentTab = tab || null;
  } catch { state.currentTab = null; }

  // Per-site default: if active site matches a default, switch to that note
  const perSite = pickDefaultNoteId(state.currentTab?.url);
  const storedActive = data.activeId && state.notes.some(n => n.id === data.activeId)
    ? data.activeId : state.notes[0].id;
  state.activeId = perSite || storedActive;

  document.documentElement.dataset.theme = state.theme;
  applyThemeIcon();
  applyShape();
  applySize();
  applyOpacity();
  renderSelector();
  loadActive();
  updateDefaultButton();
  updatePinButton();
  updateTagUI();
  editor.focus();

  await maybeAutoPaste();
}

function applyOpacity() {
  document.documentElement.style.setProperty('--panel-alpha', String(state.opacity));
  const sl = document.getElementById('opacitySlider');
  if (sl) sl.value = String(Math.round(state.opacity * 100));
  const lbl = document.getElementById('opacityLabel');
  if (lbl) lbl.textContent = `${Math.round(state.opacity * 100)}%`;
}

// Color tag plumbing
const TAG_CSS = {
  red: '#e57373', orange: '#f0a35e', yellow: '#e7c862', green: '#7bb87a',
  blue: '#6da4d4', purple: '#a880c4', pink: '#d486a8'
};
function updateTagUI() {
  const n = activeNote();
  const btn = document.getElementById('tagBtn');
  const dot = document.querySelector('.brand-dot');
  const color = (n && n.tag && TAG_CSS[n.tag]) || null;
  if (btn) {
    if (color) { btn.style.color = color; btn.classList.add('active'); }
    else { btn.style.color = ''; btn.classList.remove('active'); }
  }
  if (dot) {
    dot.style.background = color || 'var(--accent)';
    dot.style.boxShadow = color ? `0 0 8px ${color}55` : '0 0 8px var(--accent-soft)';
  }
}

function pickDefaultNoteId(url) {
  if (!url) return null;
  const map = state.settings.siteDefaults || {};
  // Find the first matching pattern whose noteId still exists
  for (const [pat, noteId] of Object.entries(map)) {
    if (matchPattern(url, pat) && state.notes.some(n => n.id === noteId)) {
      return noteId;
    }
  }
  return null;
}

async function maybeAutoPaste() {
  try {
    if (!state.currentTab?.url) return;
    if (!matchesAny(state.currentTab.url, state.settings.autoPasteSites)) return;
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const hash = hashStr(text);
    if (hash === state.settings.lastAutoPastedHash) return;
    const sep = editor.value && !editor.value.endsWith('\n') ? '\n' : '';
    editor.value = editor.value + sep + text + '\n';
    editor.selectionStart = editor.selectionEnd = editor.value.length;
    updateCounter();
    state.settings.lastAutoPastedHash = hash;
    await storageSet({ settings: state.settings });
    await logHistory({ source: 'auto-paste', content: text, tab: state.currentTab });
    scheduleSave();
    flash('auto-pasted ✓');
  } catch { /* clipboard denied or unavailable */ }
}

function renderSelector() {
  // Pinned first (sorted by updatedAt desc), then unpinned (updatedAt desc)
  const pinned = state.notes.filter(n => n.pinned)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const rest = state.notes.filter(n => !n.pinned)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const all = [...pinned, ...rest];

  // Order signature — which note IDs in which order, with pin state.
  // If this matches what's already in the DOM, we only need to update
  // option text content and the selected flag. No innerHTML rebuild.
  const orderSig = all.map(n => `${n.id}:${n.pinned ? 1 : 0}`).join(',');

  if (noteSelect._qnOrderSig === orderSig && noteSelect.options.length === all.length) {
    // In-place update: no DOM structure changes, so focus is preserved.
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      const opt = noteSelect.options[i];
      const newText = (n.pinned ? '📌 ' : '') + (n.title || 'Untitled');
      if (opt.textContent !== newText) opt.textContent = newText;
      if (opt.value !== n.id) opt.value = n.id;
      const shouldBeSelected = n.id === state.activeId;
      if (opt.selected !== shouldBeSelected) opt.selected = shouldBeSelected;
    }
    return;
  }

  // Structure changed — rebuild from scratch.
  noteSelect._qnOrderSig = orderSig;
  noteSelect.innerHTML = '';
  all.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n.id;
    opt.textContent = (n.pinned ? '📌 ' : '') + (n.title || 'Untitled');
    if (n.id === state.activeId) opt.selected = true;
    noteSelect.appendChild(opt);
  });
}

function loadActive() {
  const n = activeNote();
  editor.value = n ? n.content : '';
  updateCounter();
  if (state.previewOn) renderPreview();
}

function updateCounter() {
  const text = editor.value;
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  counter.textContent = `${words} words · ${chars} chars`;
}

function flash(msg) {
  statusEl.textContent = msg;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { statusEl.textContent = 'saved ✓'; }, 1400);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  statusEl.textContent = 'saving…';
  saveTimer = setTimeout(save, 200);
}

async function save() {
  const n = activeNote();
  if (!n) return;
  n.content = editor.value;
  n.updatedAt = Date.now();
  if (!n.titleLocked) {
    n.title = deriveTitle(editor.value);
  }
  await storageSet({ notes: state.notes, activeId: state.activeId });
  renderSelector();
  statusEl.textContent = 'saved ✓';
}

function insertAtCursor(text) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
  editor.selectionStart = editor.selectionEnd = start + text.length;
  editor.focus();
  updateCounter();
  scheduleSave();
}

async function logHistory({ source, content, tab }) {
  if (!content) return;
  const entry = {
    id: genId(),
    ts: Date.now(),
    source,
    preview: content.slice(0, 300),
    full: content,
    noteId: state.activeId,
    url: tab?.url || '',
    title: tab?.title || ''
  };
  state.history.unshift(entry);
  if (state.history.length > MAX_HISTORY) state.history = state.history.slice(0, MAX_HISTORY);
  await storageSet({ history: state.history });
}

// ============ Editor events ============
editor.addEventListener('input', () => {
  updateCounter();
  scheduleSave();
});
editor.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault(); save(); flash('saved ✓');
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault(); openSearch();
  }
});
editor.addEventListener('paste', async (ev) => {
  const items = ev.clipboardData && ev.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind !== 'file' || !item.type || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    const MAX_BYTES = 3 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      flash(`image too big (${Math.round(file.size / 1024 / 1024)}MB, max 3MB)`);
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
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
      const md = `![image](qn-img:${imgId})`;
      const s = editor.selectionStart;
      const e2 = editor.selectionEnd;
      const before = editor.value[s - 1];
      const prefix = (s === 0 || before === '\n') ? '' : '\n';
      editor.value = editor.value.slice(0, s) + prefix + md + '\n' + editor.value.slice(e2);
      const newPos = s + prefix.length + md.length + 1;
      editor.selectionStart = editor.selectionEnd = newPos;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      flash('image pasted');
    } catch (err) {
      flash('image paste failed');
    }
    return;
  }
});

noteSelect.addEventListener('change', async () => {
  // Capture target before save() — save calls renderSelector which would
  // otherwise reset the dropdown to the old active note.
  const targetId = noteSelect.value;
  await save();
  state.activeId = targetId;
  await storageSet({ activeId: state.activeId });
  renderSelector();
  loadActive();
  updatePinButton();
  updateDefaultButton();
  updateTagUI();
  editor.focus();
});

$('newNote').addEventListener('click', async () => {
  await save();
  const note = { id: genId(), title: 'Untitled', content: '', updatedAt: Date.now(), pinned: false };
  state.notes.push(note);
  state.activeId = note.id;
  await storageSet({ notes: state.notes, activeId: state.activeId });
  renderSelector(); loadActive();
  updatePinButton(); updateDefaultButton(); updateTagUI();
  editor.focus();
});

$('deleteNote').addEventListener('click', async () => {
  if (state.notes.length === 1) {
    if (!confirm('Clear this note?')) return;
    const n = activeNote();
    n.content = ''; n.title = 'Untitled'; n.updatedAt = Date.now();
    await storageSet({ notes: state.notes });
    loadActive(); renderSelector(); flash('cleared');
    return;
  }
  if (!confirm(`Delete "${activeNote().title}"?`)) return;
  // Also clear any siteDefaults pointing to this note
  const deletedId = state.activeId;
  const newDefaults = {};
  for (const [pat, id] of Object.entries(state.settings.siteDefaults || {})) {
    if (id !== deletedId) newDefaults[pat] = id;
  }
  state.settings.siteDefaults = newDefaults;
  state.notes = state.notes.filter(n => n.id !== deletedId);
  state.activeId = state.notes[0].id;
  await storageSet({
    notes: state.notes, activeId: state.activeId, settings: state.settings
  });
  renderSelector(); loadActive();
  updatePinButton(); updateDefaultButton(); updateTagUI();
  flash('deleted');
});

// ============ Pinned notes ============
function updatePinButton() {
  const n = activeNote();
  const btn = $('pinNote');
  if (!n) return;
  btn.classList.toggle('active', !!n.pinned);
  btn.title = n.pinned ? 'Unpin this note' : 'Pin this note to top';
}

$('pinNote').addEventListener('click', async () => {
  const n = activeNote();
  if (!n) return;
  n.pinned = !n.pinned;
  n.updatedAt = Date.now();
  await storageSet({ notes: state.notes });
  renderSelector();
  updatePinButton();
  flash(n.pinned ? 'pinned' : 'unpinned');
});

$('renameNote').addEventListener('click', () => startInlineRename());

function startInlineRename() {
  const n = activeNote();
  if (!n) return;
  const existing = document.getElementById('renameInput');
  if (existing) { existing.focus(); existing.select(); return; }

  const current = n.title || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'renameInput';
  input.className = 'rename-input';
  input.value = current;
  input.maxLength = 80;
  input.title = 'Enter to save · Esc to cancel · empty = auto-derive';

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
    renderSelector();
    flash(t ? 'renamed ✓' : 'title unlocked');
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// ============ Clipboard / capture buttons ============
$('pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      insertAtCursor(text);
      await logHistory({ source: 'clipboard', content: text, tab: state.currentTab });
      flash('pasted ✓');
    } else flash('clipboard empty');
  } catch { flash('clipboard blocked'); }
});

function expandImageRefs(text) {
  return text.replace(/!\[([^\]]*)\]\(qn-img:([A-Za-z0-9_]+)\)/g, (full, alt, id) => {
    const dataUrl = state.images[id];
    if (!dataUrl) return full;
    return `![${alt}](${dataUrl})`;
  });
}

$('copyBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(expandImageRefs(editor.value)); flash('copied ✓'); }
  catch { flash('copy failed'); }
});

$('urlBtn').addEventListener('click', async () => {
  if (!state.currentTab) return flash('no tab');
  const text = `${state.currentTab.title}\n${state.currentTab.url}\n`;
  insertAtCursor(text);
  await logHistory({ source: 'page', content: text, tab: state.currentTab });
  flash('link added ✓');
});

$('selectionBtn').addEventListener('click', async () => {
  try {
    if (!state.currentTab) return flash('no tab');
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: state.currentTab.id },
      func: () => window.getSelection().toString()
    });
    const sel = (result && result.result || '').trim();
    if (sel) {
      const formatted = `"${sel}"\n~ ${state.currentTab.title} (${state.currentTab.url})\n\n`;
      insertAtCursor(formatted);
      await logHistory({ source: 'selection', content: formatted, tab: state.currentTab });
      flash('selection added ✓');
    } else flash('no selection on page');
  } catch { flash('not available here'); }
});

$('timeBtn').addEventListener('click', () => {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  const offMin = -now.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const offH = String(Math.floor(abs / 60)).padStart(2, '0');
  const offM = String(abs % 60).padStart(2, '0');
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const stamp = `[${y}-${mo}-${d} ${h}:${mi}:${s} GMT${sign}${offH}:${offM} (${tz})] `;
  insertAtCursor(stamp);
  flash('time added');
});

$('divBtn').addEventListener('click', () => {
  insertAtCursor('\n---\n');
  flash('divider');
});

$('checkBtn').addEventListener('click', () => {
  const sel = editor.selectionStart;
  const before = editor.value[sel - 1];
  const prefix = (sel === 0 || before === '\n') ? '' : '\n';
  insertAtCursor(prefix + '- [ ] ');
  flash('task added');
});

function wrapEditorSelection(before, after) {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const selected = editor.value.slice(s, e);
  const inserted = before + selected + after;
  editor.value = editor.value.slice(0, s) + inserted + editor.value.slice(e);
  if (selected) {
    editor.selectionStart = s;
    editor.selectionEnd = s + inserted.length;
  } else {
    const pos = s + before.length;
    editor.selectionStart = editor.selectionEnd = pos;
  }
  editor.focus();
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

$('boldBtn').addEventListener('click', () => {
  wrapEditorSelection('**', '**');
  flash('bold');
});

$('codeBtn').addEventListener('click', () => {
  const s = editor.selectionStart, e = editor.selectionEnd;
  const selected = editor.value.slice(s, e);
  if (selected.includes('\n')) {
    const before = editor.value[s - 1];
    const leadNl = (s === 0 || before === '\n') ? '' : '\n';
    const inserted = `${leadNl}\`\`\`\n${selected}\n\`\`\`\n`;
    editor.value = editor.value.slice(0, s) + inserted + editor.value.slice(e);
    editor.selectionStart = editor.selectionEnd = s + inserted.length;
  } else if (selected) {
    wrapEditorSelection('`', '`');
  } else {
    const before = editor.value[s - 1];
    const leadNl = (s === 0 || before === '\n') ? '' : '\n';
    const skeleton = `${leadNl}\`\`\`\n\n\`\`\`\n`;
    editor.value = editor.value.slice(0, s) + skeleton + editor.value.slice(e);
    const pos = s + leadNl.length + 4;
    editor.selectionStart = editor.selectionEnd = pos;
  }
  editor.focus();
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  flash('code');
});

$('colorBtn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const existing = document.querySelector('.colorMenu');
  if (existing) { existing.remove(); return; }
  const menu = document.createElement('div');
  menu.className = 'colorMenu';
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
    sw.className = 'color-swatch' + (c.css === null ? ' none' : '');
    if (c.css) sw.style.background = c.css;
    else sw.textContent = '∅';
    sw.title = c.name;
    sw.addEventListener('click', (e2) => {
      e2.stopPropagation();
      menu.remove();
      if (c.css) {
        wrapEditorSelection(`<span style="color: ${c.css}">`, `</span>`);
        flash(`color: ${c.name}`);
      } else {
        const s = editor.selectionStart, e = editor.selectionEnd;
        const selected = editor.value.slice(s, e);
        if (selected) {
          const stripped = selected
            .replace(/^<span\s+style="color:\s*[^"]*">/, '')
            .replace(/<\/span>$/, '');
          editor.value = editor.value.slice(0, s) + stripped + editor.value.slice(e);
          editor.selectionStart = s;
          editor.selectionEnd = s + stripped.length;
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          flash('color cleared');
        }
      }
    });
    menu.appendChild(sw);
  });
  const rect = ev.currentTarget.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  document.body.appendChild(menu);
  setTimeout(() => {
    const dismiss = (e2) => {
      if (!menu.contains(e2.target)) {
        menu.remove();
        document.removeEventListener('click', dismiss);
      }
    };
    document.addEventListener('click', dismiss);
  }, 0);
});

// Drag-and-drop image files onto the editor
(function wireEditorDrop() {
  let dragDepth = 0;
  async function insertImageFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const MAX_BYTES = 3 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      flash(`image too big (${Math.round(file.size / 1024 / 1024)}MB, max 3MB)`);
      return;
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
      const s = editor.selectionStart, e2 = editor.selectionEnd;
      const before = editor.value[s - 1];
      const prefix = (s === 0 || before === '\n') ? '' : '\n';
      editor.value = editor.value.slice(0, s) + prefix + md + '\n' + editor.value.slice(e2);
      const newPos = s + prefix.length + md.length + 1;
      editor.selectionStart = editor.selectionEnd = newPos;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      flash(file.type === 'image/gif' ? 'gif added' : 'image added');
    } catch (err) {
      flash('image drop failed');
    }
  }
  editor.addEventListener('dragenter', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file')) {
      dragDepth++;
      editor.classList.add('drag-over');
    }
  });
  editor.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) editor.classList.remove('drag-over');
  });
  editor.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  editor.addEventListener('drop', async (e) => {
    dragDepth = 0;
    editor.classList.remove('drag-over');
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    for (const file of e.dataTransfer.files) {
      if (file.type && file.type.startsWith('image/')) {
        await insertImageFile(file);
      }
    }
  });
})();

$('downloadBtn').addEventListener('click', () => {
  const n = activeNote();
  if (!n) return;
  const fullContent = expandImageRefs(n.content);
  const blob = new Blob([fullContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const safe = (n.title || 'note').replace(/[^a-z0-9_\- ]/gi, '_').trim() || 'note';
  // Anchor-tag download — works without the 'downloads' permission.
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash('downloaded ✓');
});

// ============ Theme & options ============
function applyThemeIcon() {
  // Icon shows the *destination* of the toggle:
  // - Currently dark → show ☀ (click to go light)
  // - Currently light → show 🦇 (click to go dark)
  const btn = $('themeBtn');
  const use = btn.querySelector('use');
  if (use) {
    use.setAttribute('href', state.theme === 'dark' ? '#i-sun' : '#i-bat');
  }
  btn.title = state.theme === 'dark'
    ? 'Switch to light theme'
    : 'Switch to dark theme';
}

$('themeBtn').addEventListener('click', async () => {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  applyThemeIcon();
  await storageSet({ theme: state.theme });
});

$('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ============ Opacity slider ============
const opacitySlider = $('opacitySlider');
if (opacitySlider) {
  opacitySlider.value = String(Math.round(state.opacity * 100));
  opacitySlider.addEventListener('input', () => {
    const v = Math.max(30, Math.min(100, +opacitySlider.value || 100));
    state.opacity = v / 100;
    document.documentElement.style.setProperty('--panel-alpha', String(state.opacity));
    const lbl = $('opacityLabel');
    if (lbl) lbl.textContent = `${v}%`;
  });
  let opSaveTimer = null;
  opacitySlider.addEventListener('change', () => {
    clearTimeout(opSaveTimer);
    opSaveTimer = setTimeout(() => storageSet({ opacity: state.opacity }), 50);
  });
}

// ============ Color tag picker ============
$('tagBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const existing = document.querySelector('.tagMenu');
  if (existing) { existing.remove(); return; }
  const n = activeNote();
  if (!n) return;
  const menu = document.createElement('div');
  menu.className = 'tagMenu';
  const colors = [
    { key: null,     css: null,        label: 'No tag' },
    { key: 'red',    css: '#e57373' },
    { key: 'orange', css: '#f0a35e' },
    { key: 'yellow', css: '#e7c862' },
    { key: 'green',  css: '#7bb87a' },
    { key: 'blue',   css: '#6da4d4' },
    { key: 'purple', css: '#a880c4' },
    { key: 'pink',   css: '#d486a8' }
  ];
  colors.forEach(c => {
    const sw = document.createElement('button');
    sw.className = 'tag-swatch' + (c.key === null ? ' none' : '');
    if (c.css) sw.style.background = c.css;
    if (c.key === null) sw.textContent = '∅';
    sw.title = c.label || c.key;
    if ((n.tag || null) === c.key) sw.classList.add('active');
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
  // Attach inside the shape frame so position is relative to the popup
  const frame = document.getElementById('shapeFrame');
  (frame || document.body).appendChild(menu);
  setTimeout(() => {
    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('click', dismiss);
      }
    };
    document.addEventListener('click', dismiss);
  }, 0);
});

// ============ Floating panel ============
// In standalone mode (opened as a full tab via fallback), hide the Float
// button since we are on a chrome-extension:// page where injection can't run.
if (document.documentElement.classList.contains('standalone')) {
  const fb = $('floatBtn');
  if (fb) fb.style.display = 'none';
}
$('floatBtn').addEventListener('click', async () => {
  if (!state.currentTab) return flash('no tab');
  try {
    await chrome.runtime.sendMessage({ type: 'toggle-floating', tabId: state.currentTab.id });
    flash('toggled panel');
    window.close();
  } catch { flash('not available here'); }
});

// ============ Per-site default note ============
function currentSitePattern() {
  if (!state.currentTab?.url) return null;
  try {
    const u = new URL(state.currentTab.url);
    return `${u.protocol}//${u.host}/*`;
  } catch { return null; }
}

function currentSiteIsDefault() {
  const pat = currentSitePattern();
  if (!pat) return false;
  return state.settings.siteDefaults?.[pat] === state.activeId;
}

function updateDefaultButton() {
  const btn = $('defaultBtn');
  const applicable = !!currentSitePattern();
  btn.disabled = !applicable;
  btn.style.opacity = applicable ? '1' : '0.5';
  btn.classList.toggle('active', applicable && currentSiteIsDefault());
  btn.title = applicable
    ? (currentSiteIsDefault()
      ? 'This note is the default for this site (click to remove)'
      : 'Set this note as default for this site')
    : 'Not available on this page';
}

$('defaultBtn').addEventListener('click', async () => {
  const pat = currentSitePattern();
  if (!pat) return flash('no site');
  state.settings.siteDefaults = state.settings.siteDefaults || {};
  if (state.settings.siteDefaults[pat] === state.activeId) {
    delete state.settings.siteDefaults[pat];
    flash('default removed');
  } else {
    state.settings.siteDefaults[pat] = state.activeId;
    flash(`default set for ${new URL(state.currentTab.url).host}`);
  }
  await storageSet({ settings: state.settings });
  updateDefaultButton();
});

// ============ Markdown / checklist preview ============
// Minimal markdown · headings, bold, italic, code, links, lists, blockquotes, hr.
// Checklists are special: rendered as real checkboxes that round-trip to text.
function renderPreview() {
  const text = editor.value;
  const lines = text.split('\n');
  let html = '';
  let inCode = false;
  let inList = false;
  let inOList = false;
  let codeLang = '';
  let listBuffer = [];

  const closeList = () => {
    if (inList) { html += '</ul>'; inList = false; }
    if (inOList) { html += '</ol>'; inOList = false; }
  };

  const inline = (s) => {
    const imgs = [];
    const withoutImgs = s.replace(/!\[([^\]]*)\]\((qn-img:[A-Za-z0-9_]+|data:image\/[a-zA-Z.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^)]+)\)/g, (_, alt, url) => {
      const idx = imgs.length;
      imgs.push({ alt, url });
      return `\u0000QNIMG${idx}\u0000`;
    });
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
    out = out.replace(/\u0000QNCOLOR(\d+)\u0000/g, (_, n) => {
      const { color, content } = colorSpans[+n];
      const inner = escapeHtml(content)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
      return `<span style="color: ${color}">${inner}</span>`;
    });
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

  lines.forEach((line, idx) => {
    if (/^```/.test(line)) {
      if (!inCode) {
        closeList();
        codeLang = line.slice(3).trim();
        html += `<pre><code>`;
        inCode = true;
      } else {
        html += `</code></pre>`;
        inCode = false;
      }
      return;
    }
    if (inCode) {
      html += escapeHtml(line) + '\n';
      return;
    }
    // Checklist item: "- [ ] foo" or "- [x] foo"
    const chkMatch = line.match(/^(\s*)[-*] \[( |x|X)\] (.*)$/);
    if (chkMatch) {
      closeList();
      const checked = chkMatch[2].toLowerCase() === 'x';
      const content = inline(chkMatch[3]);
      html += `<label class="chk-line ${checked ? 'done' : ''}" data-line="${idx}">
        <input type="checkbox" ${checked ? 'checked' : ''} data-line="${idx}">
        <span class="txt">${content}</span>
      </label>`;
      return;
    }
    // Heading
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html += `<h${level}>${inline(h[2])}</h${level}>`;
      return;
    }
    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      closeList();
      html += '<hr>';
      return;
    }
    // Blockquote
    if (/^>\s?/.test(line)) {
      closeList();
      html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`;
      return;
    }
    // Unordered list
    const uli = line.match(/^[-*]\s+(.+)$/);
    if (uli) {
      if (inOList) { html += '</ol>'; inOList = false; }
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(uli[1])}</li>`;
      return;
    }
    // Ordered list
    const oli = line.match(/^\d+\.\s+(.+)$/);
    if (oli) {
      if (inList) { html += '</ul>'; inList = false; }
      if (!inOList) { html += '<ol>'; inOList = true; }
      html += `<li>${inline(oli[1])}</li>`;
      return;
    }
    // Blank line — strip zero-width chars so they don't render as empty <p>
    if (!line.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '').trim()) {
      closeList();
      return;
    }
    // Paragraph
    closeList();
    html += `<p>${inline(line)}</p>`;
  });
  closeList();
  if (inCode) html += '</code></pre>';
  preview.innerHTML = html;
}

// Checkbox click → toggle in source text
preview.addEventListener('click', async (e) => {
  const cb = e.target.closest('input[type="checkbox"][data-line]');
  if (!cb) return;
  const lineIdx = parseInt(cb.dataset.line, 10);
  const lines = editor.value.split('\n');
  if (lineIdx < 0 || lineIdx >= lines.length) return;
  const m = lines[lineIdx].match(/^(\s*[-*] \[)( |x|X)(\].*)$/);
  if (!m) return;
  const newState = m[2].toLowerCase() === 'x' ? ' ' : 'x';
  lines[lineIdx] = m[1] + newState + m[3];
  editor.value = lines.join('\n');
  updateCounter();
  await save();
  renderPreview();
});

$('previewBtn').addEventListener('click', () => {
  state.previewOn = !state.previewOn;
  $('previewBtn').classList.toggle('active', state.previewOn);
  editor.hidden = state.previewOn;
  preview.hidden = !state.previewOn;
  if (state.previewOn) renderPreview();
});

// ============ History view ============
$('historyBtn').addEventListener('click', () => {
  renderHistory();
  editorView.hidden = true;
  searchView.hidden = true;
  historyView.hidden = false;
});

$('backFromHistory').addEventListener('click', () => {
  historyView.hidden = true;
  editorView.hidden = false;
  editor.focus();
});

$('clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('Clear all history?')) return;
  state.history = [];
  await storageSet({ history: [] });
  renderHistory();
  flash('history cleared');
});

const ICONS = {
  clipboard: '📋',
  'auto-paste': '⚡',
  page: '🔗',
  selection: '✂',
  'ctx-selection': '✂',
  'ctx-page': '🔗',
  'ctx-link': '🔗'
};

function fmtTime(ts) {
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderHistory() {
  historyCount.textContent = `${state.history.length} entries`;
  if (state.history.length === 0) {
    historyList.innerHTML = '<li class="empty">No history yet. Your captures will appear here.</li>';
    return;
  }
  historyList.innerHTML = '';
  state.history.forEach(entry => {
    const li = buildEntryRow(entry);
    li.addEventListener('click', (e) => {
      if (e.target.closest('.del')) return;
      historyView.hidden = true;
      editorView.hidden = false;
      insertAtCursor(entry.full);
      flash('inserted from history');
    });
    historyList.appendChild(li);
  });
}

function buildEntryRow(entry, highlight) {
  const li = document.createElement('li');
  li.dataset.id = entry.id;

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = ICONS[entry.source] || '•';

  const body = document.createElement('div');
  body.className = 'body';

  const prev = document.createElement('div');
  prev.className = 'preview';
  prev.innerHTML = highlightMatch(entry.preview, highlight);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const src = (entry.source || '').replace(/-/g, ' ');
  const titleBit = entry.title ? ` · ${entry.title.slice(0, 30)}` : '';
  meta.textContent = `${src} · ${fmtTime(entry.ts)}${titleBit}`;

  body.appendChild(prev);
  body.appendChild(meta);

  const del = document.createElement('button');
  del.className = 'del';
  del.textContent = '✕';
  del.title = 'Delete entry';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    state.history = state.history.filter(h => h.id !== entry.id);
    await storageSet({ history: state.history });
    renderHistory();
  });

  li.appendChild(icon);
  li.appendChild(body);
  li.appendChild(del);
  return li;
}

function highlightMatch(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(esc, 'gi'), m => `<span class="hl">${m}</span>`);
}

// ============ Search view ============
function openSearch() {
  historyView.hidden = true;
  editorView.hidden = true;
  searchView.hidden = false;
  searchInput.value = '';
  searchResults.innerHTML = '';
  searchCount.textContent = 'type to search';
  setTimeout(() => searchInput.focus(), 30);
}

$('searchBtn').addEventListener('click', openSearch);
$('backFromSearch').addEventListener('click', () => {
  searchView.hidden = true;
  editorView.hidden = false;
  editor.focus();
});

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 80);
});
searchScope.addEventListener('change', runSearch);

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchView.hidden = true;
    editorView.hidden = false;
    editor.focus();
  }
});

function runSearch() {
  const q = searchInput.value.trim();
  const scope = searchScope.value;
  searchResults.innerHTML = '';
  if (!q) {
    searchCount.textContent = 'type to search';
    return;
  }
  const lower = q.toLowerCase();
  const results = [];

  if (scope === 'all' || scope === 'notes') {
    state.notes.forEach(n => {
      const inTitle = n.title.toLowerCase().includes(lower);
      const inContent = n.content.toLowerCase().includes(lower);
      if (inTitle || inContent) {
        // Build a snippet around the first content match
        let snippet = n.title;
        if (inContent) {
          const idx = n.content.toLowerCase().indexOf(lower);
          const start = Math.max(0, idx - 30);
          const end = Math.min(n.content.length, idx + q.length + 70);
          snippet = (start > 0 ? '…' : '') + n.content.slice(start, end) + (end < n.content.length ? '…' : '');
        }
        results.push({
          type: 'note',
          id: n.id,
          title: n.title,
          snippet,
          pinned: n.pinned,
          ts: n.updatedAt
        });
      }
    });
  }

  if (scope === 'all' || scope === 'history') {
    state.history.forEach(h => {
      if (h.full.toLowerCase().includes(lower)) {
        results.push({
          type: 'history',
          id: h.id,
          source: h.source,
          preview: h.preview,
          full: h.full,
          title: h.title,
          ts: h.ts
        });
      }
    });
  }

  // Sort: notes first, then history, each by most recent
  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'note' ? -1 : 1;
    return b.ts - a.ts;
  });

  searchCount.textContent = `${results.length} match${results.length === 1 ? '' : 'es'}`;

  results.forEach(r => {
    const li = document.createElement('li');

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = r.type === 'note' ? (r.pinned ? '📌' : '📝') : (ICONS[r.source] || '•');

    const body = document.createElement('div');
    body.className = 'body';
    const prev = document.createElement('div');
    prev.className = 'preview';
    prev.innerHTML = highlightMatch(r.type === 'note' ? r.snippet : r.preview, q);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = r.type === 'note'
      ? `note · ${highlightMatchText(r.title, q)} · ${fmtTime(r.ts)}`
      : `${(r.source || '').replace(/-/g, ' ')} · ${fmtTime(r.ts)}${r.title ? ' · ' + r.title.slice(0, 30) : ''}`;
    body.appendChild(prev);
    body.appendChild(meta);

    li.appendChild(icon);
    li.appendChild(body);

    li.addEventListener('click', async () => {
      if (r.type === 'note') {
        await save();
        state.activeId = r.id;
        await storageSet({ activeId: state.activeId });
        renderSelector();
        loadActive();
        updatePinButton();
        updateDefaultButton();
        updateTagUI();
        searchView.hidden = true;
        editorView.hidden = false;
        editor.focus();
      } else {
        searchView.hidden = true;
        editorView.hidden = false;
        insertAtCursor(r.full);
        flash('inserted from history');
      }
    });
    searchResults.appendChild(li);
  });
}

function highlightMatchText(text, q) {
  // For the meta line · plain string with match markers stripped of HTML safety
  if (!q) return text;
  return text; // meta line is textContent anyway, so we skip the markup
}

// ============ Storage sync ============
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Ignore echoes of our own writes — they'd trigger re-renders that steal
  // focus from the textarea while typing.
  if (selfWriting > 0) return;
  if (changes.notes) {
    state.notes = changes.notes.newValue || [];
    state.notes.forEach(n => { if (n.pinned == null) n.pinned = false; });
    if (!state.notes.find(n => n.id === state.activeId) && state.notes.length) {
      state.activeId = state.notes[0].id;
    }
    renderSelector();
    const n = activeNote();
    if (n && editor.value !== n.content && document.activeElement !== editor) {
      loadActive();
    }
    updatePinButton();
    updateTagUI();
  }
  if (changes.history) {
    state.history = changes.history.newValue || [];
    if (!historyView.hidden) renderHistory();
  }
  if (changes.settings) {
    state.settings = Object.assign(state.settings, changes.settings.newValue || {});
    updateDefaultButton();
  }
  if (changes.shape) {
    state.shape = changes.shape.newValue || 'rectangle';
    applyShape();
  }
  if (changes.size) {
    state.size = changes.size.newValue || state.size;
    applySize();
  }
  if (changes.opacity) {
    const v = typeof changes.opacity.newValue === 'number' ? changes.opacity.newValue : 1;
    state.opacity = Math.max(0.3, Math.min(1, v));
    applyOpacity();
  }
  if (changes.images) {
    state.images = changes.images.newValue || {};
    if (state.previewOn) renderPreview();
  }
});

// ============ Shape picker ============
function applyShape() {
  document.body.dataset.shape = state.shape;
  // Update active button in the menu
  document.querySelectorAll('#shapeMenu button').forEach(b => {
    b.classList.toggle('active', b.dataset.shape === state.shape);
  });
}

$('shapeBtn').addEventListener('click', () => {
  const m = $('shapeMenu');
  m.hidden = !m.hidden;
});
document.querySelectorAll('#shapeMenu button').forEach(b => {
  b.addEventListener('click', async () => {
    state.shape = b.dataset.shape;
    applyShape();
    $('shapeMenu').hidden = true;
    await storageSet({ shape: state.shape });
    flash(`shape: ${state.shape}`);
  });
});
// Close shape menu if user clicks elsewhere
document.addEventListener('click', (e) => {
  const m = $('shapeMenu');
  if (m.hidden) return;
  if (e.target.closest('#shapeMenu') || e.target.closest('#shapeBtn')) return;
  m.hidden = true;
});

// ============ 8-directional resize ============
function applySize() {
  const w = Math.max(320, Math.min(800, state.size.w | 0));
  const h = Math.max(260, Math.min(720, state.size.h | 0));
  document.documentElement.style.setProperty('--w', w + 'px');
  document.documentElement.style.setProperty('--h', h + 'px');
}

(function wireResize() {
  let startX, startY, startW, startH, dir = null;
  let saveSizeT = null;

  const onMove = (e) => {
    if (!dir) return;
    let w = startW, h = startH;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dir.includes('e')) w = startW + dx;
    if (dir.includes('w')) w = startW - dx;
    if (dir.includes('s')) h = startH + dy;
    if (dir.includes('n')) h = startH - dy;
    state.size = {
      w: Math.max(320, Math.min(800, w)),
      h: Math.max(260, Math.min(720, h))
    };
    applySize();
    clearTimeout(saveSizeT);
    saveSizeT = setTimeout(() => {
      storageSet({ size: state.size });
    }, 120);
  };
  const onUp = () => {
    if (!dir) return;
    dir = null;
    document.body.classList.remove('resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  document.querySelectorAll('.rz').forEach(h => {
    h.addEventListener('mousedown', (e) => {
      dir = h.dataset.dir;
      startX = e.clientX;
      startY = e.clientY;
      startW = state.size.w;
      startH = state.size.h;
      document.body.classList.add('resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  });
})();

load();

// ============ Custom theme colors ============
// Convert '#RRGGBB' to 'R G B' for use in rgb(var(--bg-rgb) / alpha).
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
      rules.push(`--accent-soft: ${c.accent}22;`);
    }
    if (c.border) rules.push(`--border: ${c.border};`);
    if (rules.length) {
      // In popup, the theme is applied via :root[data-theme]. Default (no
      // attribute) falls back to dark. We generate rules for both selectors
      // so the dark overrides also apply when no theme attr is set.
      if (theme === 'dark') {
        css += `:root, :root[data-theme="dark"] { ${rules.join(' ')} }\n`;
      } else {
        css += `:root[data-theme="${theme}"] { ${rules.join(' ')} }\n`;
      }
    }
  });
  return css;
}

function applyCustomColors() {
  let styleEl = document.getElementById('qn-custom-colors');
  const css = generateCustomColorsCss();
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'qn-custom-colors';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css;
}

// Apply once on load (state is already populated by this point — the
// IIFE runs after load() has completed for async-safe ordering).
(function initCustomColors() {
  // Wait a tick so state is populated from async load
  setTimeout(applyCustomColors, 0);
})();

// Re-apply whenever customColors changes (e.g. user tweaks in options)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.customColors) {
    state.customColors = changes.customColors.newValue || { dark: {}, light: {} };
    applyCustomColors();
  }
});

// Quick Notes v2 · options page
const $ = (id) => document.getElementById(id);

const autoPasteInput = $('autoPasteInput');
const autoPasteList  = $('autoPasteList');
const floatInput     = $('floatInput');
const floatList      = $('floatList');
const defaultsList   = $('defaultsList');
const importFile     = $('importFile');
const importStatus   = $('importStatus');

let settings = { autoPasteSites: [], floatingPanelSites: [], siteDefaults: {} };
let notesCache = [];

async function loadAll() {
  const d = await chrome.storage.local.get(['settings', 'notes', 'history']);
  settings = Object.assign(
    { autoPasteSites: [], floatingPanelSites: [], siteDefaults: {} },
    d.settings || {}
  );
  notesCache = d.notes || [];
  renderList(autoPasteList, settings.autoPasteSites, 'auto-paste');
  renderList(floatList, settings.floatingPanelSites, 'floating');
  renderDefaults();
  renderStats(d);
}

function renderDefaults() {
  defaultsList.innerHTML = '';
  const entries = Object.entries(settings.siteDefaults || {});
  if (entries.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No per-site defaults yet. Set one with the 🎯 Default button in the popup.';
    defaultsList.appendChild(li);
    return;
  }
  entries.forEach(([pat, noteId]) => {
    const note = notesCache.find(n => n.id === noteId);
    const label = note ? (note.title || 'Untitled') : '⚠ deleted note';
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'pat';
    span.innerHTML = `<code>${escapeHtml(pat)}</code> → <strong>${escapeHtml(label)}</strong>`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Remove';
    del.addEventListener('click', async () => {
      delete settings.siteDefaults[pat];
      await chrome.storage.local.set({ settings });
      renderDefaults();
    });
    li.appendChild(span);
    li.appendChild(del);
    defaultsList.appendChild(li);
  });
}

function escapeHtml(s) { return Utils.escapeHtml(s); }

function renderList(ul, arr, kind) {
  ul.innerHTML = '';
  if (!arr.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No patterns yet.';
    ul.appendChild(li);
    return;
  }
  arr.forEach((p, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'pat';
    span.textContent = p;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Remove';
    del.addEventListener('click', async () => {
      arr.splice(i, 1);
      if (kind === 'auto-paste') settings.autoPasteSites = arr;
      else settings.floatingPanelSites = arr;
      await chrome.storage.local.set({ settings });
      renderList(ul, arr, kind);
    });
    li.appendChild(span);
    li.appendChild(del);
    ul.appendChild(li);
  });
}

function normalize(pat) {
  pat = pat.trim();
  if (!pat) return null;
  // If user enters plain "github.com" → turn into *://*.github.com/*
  if (!/:\/\//.test(pat) && !pat.includes('*')) {
    return `*://*.${pat}/*`;
  }
  return pat;
}

async function addPattern(input, arr, kind) {
  const v = normalize(input.value);
  if (!v) return;
  if (arr.includes(v)) { input.value = ''; return; }
  arr.push(v);
  if (kind === 'auto-paste') settings.autoPasteSites = arr;
  else settings.floatingPanelSites = arr;
  await chrome.storage.local.set({ settings });
  input.value = '';
  renderList(kind === 'auto-paste' ? autoPasteList : floatList, arr, kind);
}

$('autoPasteAdd').addEventListener('click', () =>
  addPattern(autoPasteInput, settings.autoPasteSites, 'auto-paste'));
autoPasteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addPattern(autoPasteInput, settings.autoPasteSites, 'auto-paste');
});
$('floatAdd').addEventListener('click', () =>
  addPattern(floatInput, settings.floatingPanelSites, 'floating'));
floatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addPattern(floatInput, settings.floatingPanelSites, 'floating');
});

// === Stats ===
function renderStats(d) {
  $('statNotes').textContent = (d.notes || []).length;
  $('statHistory').textContent = (d.history || []).length;
  const size = new Blob([JSON.stringify(d)]).size;
  $('statBytes').textContent = formatBytes(size);
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// === Export ===
$('exportBtn').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const payload = {
    kind: 'quick-notes-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    data: all
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Anchor-tag download — works without the 'downloads' permission.
  const a = document.createElement('a');
  a.href = url;
  a.download = `quick-notes-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// === Import ===
function pickFile() { importFile.click(); }

$('importBtn').addEventListener('click', () => { importMode = 'merge'; pickFile(); });
$('importReplaceBtn').addEventListener('click', () => {
  if (!confirm('Replace ALL current data with the imported file?\nYour existing notes & history will be overwritten.')) return;
  importMode = 'replace'; pickFile();
});

let importMode = 'merge';

importFile.addEventListener('change', async () => {
  const f = importFile.files && importFile.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const json = JSON.parse(text);
    if (json.kind !== 'quick-notes-backup' || !json.data) {
      importStatus.textContent = '❌ Not a Quick Notes backup file.';
      return;
    }
    if (importMode === 'replace') {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(json.data);
      importStatus.textContent = '✓ Replaced all data from backup.';
    } else {
      // Merge: keep all existing, append imported notes with new IDs, dedupe history
      const cur = await chrome.storage.local.get(null);
      const newNotes = [...(cur.notes || [])];
      const genId = () => Utils.genId();
      (json.data.notes || []).forEach(n => {
        newNotes.push({ ...n, id: genId() });
      });
      const mergedHistory = [
        ...(json.data.history || []),
        ...(cur.history || [])
      ].slice(0, 200);
      const mergedSettings = Object.assign(
        { autoPasteSites: [], floatingPanelSites: [] },
        json.data.settings || {},
        cur.settings || {}
      );
      // Union pattern arrays
      mergedSettings.autoPasteSites = [...new Set([
        ...(json.data.settings?.autoPasteSites || []),
        ...(cur.settings?.autoPasteSites || [])
      ])];
      mergedSettings.floatingPanelSites = [...new Set([
        ...(json.data.settings?.floatingPanelSites || []),
        ...(cur.settings?.floatingPanelSites || [])
      ])];
      await chrome.storage.local.set({
        notes: newNotes,
        history: mergedHistory,
        settings: mergedSettings,
        theme: cur.theme || json.data.theme || 'light'
      });
      importStatus.textContent = `✓ Merged ${json.data.notes?.length || 0} notes and ${json.data.history?.length || 0} history entries.`;
    }
    await loadAll();
  } catch (e) {
    importStatus.textContent = '❌ Could not read file: ' + e.message;
  } finally {
    importFile.value = '';
  }
});

// === Clear ===
$('clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('Clear all history?')) return;
  await chrome.storage.local.set({ history: [] });
  await loadAll();
});

$('clearAllBtn').addEventListener('click', async () => {
  if (!confirm('RESET everything?\nThis deletes all notes, history, and settings.')) return;
  if (!confirm('Are you absolutely sure? This cannot be undone.')) return;
  await chrome.storage.local.clear();
  await loadAll();
});

// ===== Shape picker =====
const VALID_SHAPES = ['rectangle', 'rounded', 'hexagon', 'circle'];
async function renderShape() {
  const d = await chrome.storage.local.get('shape');
  const current = Utils.normalizeShape(d.shape);
  document.querySelectorAll('.shapeChip').forEach(b => {
    b.classList.toggle('active', b.dataset.shape === current);
  });
}
document.querySelectorAll('.shapeChip').forEach(b => {
  b.addEventListener('click', async () => {
    const shape = b.dataset.shape;
    if (!VALID_SHAPES.includes(shape)) return;
    await chrome.storage.local.set({ shape });
    renderShape();
  });
});
renderShape();

// ===== Opacity slider =====
const optOpacity = document.getElementById('optOpacity');
const optOpacityLabel = document.getElementById('optOpacityLabel');
const optOpacityReset = document.getElementById('optOpacityReset');

async function renderOpacity() {
  const d = await chrome.storage.local.get('opacity');
  const raw = typeof d.opacity === 'number' ? d.opacity : 1;
  const pct = Math.round(Math.max(0.3, Math.min(1, raw)) * 100);
  optOpacity.value = String(pct);
  optOpacityLabel.textContent = `${pct}%`;
}
optOpacity.addEventListener('input', () => {
  optOpacityLabel.textContent = `${optOpacity.value}%`;
});
let optOpTimer = null;
optOpacity.addEventListener('change', () => {
  clearTimeout(optOpTimer);
  const v = Math.max(30, Math.min(100, +optOpacity.value || 100));
  optOpTimer = setTimeout(() => {
    chrome.storage.local.set({ opacity: v / 100 });
  }, 50);
});
optOpacityReset.addEventListener('click', async () => {
  await chrome.storage.local.set({ opacity: 1 });
  renderOpacity();
});
renderOpacity();

// Live refresh when storage changes elsewhere
chrome.storage.onChanged.addListener((changes) => {
  loadAll();
  if (changes.shape) renderShape();
  if (changes.opacity) renderOpacity();
});

loadAll();

// ============ Custom theme colors ============
// Default color palette. Must match the CSS `--bg`/`--fg`/... values used
// in content.js and popup.css. When the user customizes colors, these are
// used as the reset target.
const DEFAULT_COLORS = {
  dark: {
    bg:     '#1F1F1E',
    bgAlt:  '#2C2C2A',
    fg:     '#e8e6e3',
    accent: '#d4a85f',
    border: '#3a3a37'
  },
  light: {
    bg:     '#fafaf8',
    bgAlt:  '#f3f2ee',
    fg:     '#1a1a1a',
    accent: '#8a5a1a',
    border: '#e5e4de'
  }
};

let customColors = { dark: {}, light: {} };

async function loadCustomColors() {
  const d = await chrome.storage.local.get(['customColors']);
  customColors = Object.assign({ dark: {}, light: {} }, d.customColors || {});
  renderColorInputs();
}

function effectiveColor(theme, key) {
  return (customColors[theme] && customColors[theme][key]) || DEFAULT_COLORS[theme][key];
}

function renderColorInputs() {
  document.querySelectorAll('input[type="color"][data-theme]').forEach(input => {
    const theme = input.dataset.theme;
    const key = input.dataset.key;
    const value = effectiveColor(theme, key);
    input.value = value;
    // Update the sibling hex text input
    const hexEl = document.getElementById(input.id + 'Hex');
    if (hexEl && document.activeElement !== hexEl) {
      hexEl.value = value.toLowerCase();
      const isCustom = customColors[theme] && customColors[theme][key];
      hexEl.placeholder = isCustom ? '#RRGGBB' : `${value.toLowerCase()} (default)`;
    }
  });
}

// Debounced save — color pickers fire 'input' very rapidly while dragging
let colorSaveTimer = null;
function queueCustomColorSave() {
  clearTimeout(colorSaveTimer);
  colorSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ customColors });
  }, 120);
}

// Parse a possibly-incomplete hex input into a valid #RRGGBB or null.
// Accepts '#abc' (short form → expands) and '#rrggbb'. Leading '#' optional.
function parseHexColor(raw) {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (s.startsWith('#')) s = s.slice(1);
  if (!/^[0-9a-f]+$/.test(s)) return null;
  if (s.length === 3) {
    return '#' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  if (s.length === 6) return '#' + s;
  return null;
}

// Color picker (visual) drag/change
document.querySelectorAll('input[type="color"][data-theme]').forEach(input => {
  input.addEventListener('input', (e) => {
    const theme = e.target.dataset.theme;
    const key = e.target.dataset.key;
    if (!customColors[theme]) customColors[theme] = {};
    customColors[theme][key] = e.target.value;
    // Sync the sibling hex text input
    const hexEl = document.getElementById(e.target.id + 'Hex');
    if (hexEl) hexEl.value = e.target.value.toLowerCase();
    queueCustomColorSave();
  });
});

// Hex text input — accept pasted/typed hex codes
document.querySelectorAll('input.hexInput').forEach(input => {
  input.addEventListener('input', (e) => {
    const theme = e.target.dataset.theme;
    const key = e.target.dataset.key;
    const parsed = parseHexColor(e.target.value);
    // Show red border on invalid, remove otherwise
    e.target.classList.toggle('invalid', e.target.value.trim() !== '' && !parsed);
    if (!parsed) return;
    if (!customColors[theme]) customColors[theme] = {};
    customColors[theme][key] = parsed;
    // Sync the color picker
    const colorInput = document.getElementById(e.target.id.replace(/Hex$/, ''));
    if (colorInput) colorInput.value = parsed;
    queueCustomColorSave();
  });
  // On blur, normalize the displayed value (add #, lowercase, expand short-form)
  input.addEventListener('blur', (e) => {
    const parsed = parseHexColor(e.target.value);
    if (parsed) {
      e.target.value = parsed;
      e.target.classList.remove('invalid');
    } else if (e.target.value.trim() === '') {
      // Empty — revert display to current effective color
      const theme = e.target.dataset.theme;
      const key = e.target.dataset.key;
      e.target.value = effectiveColor(theme, key).toLowerCase();
      e.target.classList.remove('invalid');
    }
  });
});

// Per-theme reset buttons
['darkReset', 'lightReset'].forEach(id => {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const theme = btn.dataset.theme;
    customColors[theme] = {};
    await chrome.storage.local.set({ customColors });
    renderColorInputs();
  });
});

// Listen for customColors changes from other contexts and re-render inputs
chrome.storage.onChanged.addListener((changes) => {
  if (changes.customColors) {
    customColors = Object.assign({ dark: {}, light: {} }, changes.customColors.newValue || {});
    renderColorInputs();
  }
});

loadCustomColors();

// ============ Google Drive sync UI ============
const driveSignInBtn  = document.getElementById('driveSignInBtn');
const driveSignOutBtn = document.getElementById('driveSignOutBtn');
const driveAccountLbl = document.getElementById('driveAccountLabel');
const driveBody       = document.getElementById('driveBody');
const driveSyncNowBtn = document.getElementById('driveSyncNowBtn');
const drivePushBtn    = document.getElementById('drivePushBtn');
const drivePullBtn    = document.getElementById('drivePullBtn');
const driveAutoSync   = document.getElementById('driveAutoSync');
const driveInterval   = document.getElementById('driveInterval');
const driveStatus     = document.getElementById('driveStatus');

function sendDrive(op, extras = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type: 'drive', op }, extras), (resp) => {
      resolve(resp || { ok: false, error: 'no response' });
    });
  });
}

function fmtTime(iso) {
  if (!iso) return 'never';
  return Utils.fmtTime(new Date(iso).getTime());
}

async function refreshDriveUI() {
  const resp = await sendDrive('status');
  if (!resp.ok) {
    driveStatus.textContent = 'Status error: ' + (resp.error || 'unknown');
    return;
  }
  const cfg = resp.driveSync || {};
  const enabled = !!cfg.enabled;
  driveSignInBtn.hidden  = enabled;
  driveSignOutBtn.hidden = !enabled;
  driveBody.hidden       = !enabled;
  driveAccountLbl.textContent = enabled
    ? `Signed in as ${cfg.email || '(unknown account)'}`
    : '';
  driveAutoSync.checked = !!cfg.autoSync;
  driveInterval.value   = String(cfg.intervalMinutes || 15);

  let bits = [];
  if (resp.driveLastSync) {
    bits.push(`Last sync: ${fmtTime(resp.driveLastSync)} (${resp.driveLastSyncDirection || '?'})`);
  } else if (enabled) {
    bits.push('Not yet synced');
  }
  if (resp.remote) {
    if (resp.remote.error) {
      bits.push('Remote check failed: ' + resp.remote.error);
    } else {
      bits.push(`Drive copy: ${fmtTime(resp.remote.modifiedTime)} · ${resp.remote.size || '?'} bytes`);
    }
  }
  if (resp.driveLastSyncError) {
    bits.push('⚠ ' + resp.driveLastSyncError);
  }
  driveStatus.textContent = bits.join(' · ');
}

// Friendly translation of low-level OAuth errors into user-facing messages.
function friendlyError(raw) {
  if (!raw) return 'Sign-in failed';
  const s = String(raw);
  if (s.includes('OAuth2 not granted or revoked') || s.includes('The user did not approve')) {
    return 'Sign-in was cancelled.';
  }
  if (s.includes('bad client id') || s.includes('invalid_client') || s.includes('OAuth2 request failed')) {
    return 'Google Drive sync is temporarily unavailable in this build. Please try again later or contact support.';
  }
  if (s.includes('Network')) {
    return 'Network error. Check your connection and try again.';
  }
  return s;
}

driveSignInBtn.addEventListener('click', async () => {
  driveSignInBtn.disabled = true;
  driveStatus.textContent = 'Signing in…';
  const resp = await sendDrive('signIn');
  driveSignInBtn.disabled = false;
  if (resp.ok) {
    driveStatus.textContent = 'Signed in. Performing first sync…';
    await sendDrive('sync');
  } else {
    driveStatus.textContent = friendlyError(resp.error);
  }
  refreshDriveUI();
});

driveSignOutBtn.addEventListener('click', async () => {
  if (!confirm('Sign out of Google Drive sync? Your local notes will not be deleted.')) return;
  await sendDrive('signOut');
  refreshDriveUI();
});

driveSyncNowBtn.addEventListener('click', async () => {
  driveStatus.textContent = 'Syncing…';
  const resp = await sendDrive('sync');
  if (!resp.ok) {
    driveStatus.textContent = 'Sync failed: ' + (resp.error || 'unknown');
  }
  refreshDriveUI();
});
drivePushBtn.addEventListener('click', async () => {
  if (!confirm('Push local data to Drive? This overwrites the cloud copy.')) return;
  driveStatus.textContent = 'Pushing…';
  await sendDrive('push');
  refreshDriveUI();
});
drivePullBtn.addEventListener('click', async () => {
  if (!confirm('Pull from Drive? This OVERWRITES your local notes with the cloud copy.')) return;
  driveStatus.textContent = 'Pulling…';
  await sendDrive('pull');
  refreshDriveUI();
});

driveAutoSync.addEventListener('change', async () => {
  await sendDrive('configure', { config: { autoSync: driveAutoSync.checked } });
  refreshDriveUI();
});
driveInterval.addEventListener('change', async () => {
  await sendDrive('configure', { config: { intervalMinutes: parseInt(driveInterval.value, 10) || 15 } });
  refreshDriveUI();
});

refreshDriveUI();

// Live update About version from manifest
try {
  const v = chrome.runtime.getManifest().version;
  const aboutVer = document.getElementById('aboutVersion');
  if (aboutVer) aboutVer.textContent = v;
} catch {}

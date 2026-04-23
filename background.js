// Quick Notes v2 · background service worker
// Responsibilities:
//  - Context menus (add selection/page/link to notes; log history)
//  - Tab watcher: auto-show floating panel on configured URL patterns
//  - Toggle floating panel via command or message from popup
//  - Command: Alt+Shift+N toggles floating panel
//  - Google Drive sync (delegated to drive-sync.js)

importScripts('drive-sync.js');

const MAX_HISTORY = 200;

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function matchPattern(url, pattern) {
  if (!pattern) return false;
  try {
    const re = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*');
    return new RegExp('^' + re + '$').test(url);
  } catch { return false; }
}
const matchesAny = (url, pats) => !!pats && pats.some(p => matchPattern(url, p));

// === Install: create context menus ===
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'add-selection-to-notes',
    title: 'Add selection to Quick Notes',
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: 'add-page-to-notes',
    title: 'Add page link to Quick Notes',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'add-link-to-notes',
    title: 'Add this link to Quick Notes',
    contexts: ['link']
  });
  chrome.contextMenus.create({
    id: 'toggle-float-here',
    title: 'Toggle floating Quick Notes on this page',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'recenter-float-here',
    title: 'Recenter floating Quick Notes panel',
    contexts: ['page']
  });
});

// === Context menu handler ===
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'toggle-float-here') {
    toggleFloating(tab.id);
    return;
  }
  if (info.menuItemId === 'recenter-float-here') {
    await recenterFloating(tab.id);
    return;
  }

  const data = await chrome.storage.local.get(['notes', 'activeId', 'history']);
  let notes = data.notes || [];
  let history = data.history || [];
  if (notes.length === 0) {
    notes = [{ id: genId(), title: 'Untitled', content: '', updatedAt: Date.now() }];
  }
  const activeId = data.activeId && notes.find(n => n.id === data.activeId)
    ? data.activeId
    : notes[0].id;
  const active = notes.find(n => n.id === activeId);

  let toAdd = '', source = '';
  if (info.menuItemId === 'add-selection-to-notes' && info.selectionText) {
    toAdd = `"${info.selectionText}"\n~ ${tab.title} (${tab.url})\n\n`;
    source = 'ctx-selection';
  } else if (info.menuItemId === 'add-page-to-notes') {
    toAdd = `${tab.title}\n${tab.url}\n\n`;
    source = 'ctx-page';
  } else if (info.menuItemId === 'add-link-to-notes' && info.linkUrl) {
    toAdd = `${info.linkUrl}\n`;
    source = 'ctx-link';
  }

  if (!toAdd) return;

  const sep = active.content && !active.content.endsWith('\n') ? '\n' : '';
  active.content = (active.content || '') + sep + toAdd;
  active.updatedAt = Date.now();
  if (!active.title || active.title === 'Untitled') {
    const first = (active.content.split('\n')[0] || '').trim().slice(0, 40);
    active.title = first || 'Untitled';
  }

  history.unshift({
    id: genId(), ts: Date.now(), source,
    preview: toAdd.slice(0, 300), full: toAdd,
    noteId: active.id, url: tab.url, title: tab.title
  });
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);

  await chrome.storage.local.set({ notes, activeId, history });

  chrome.action.setBadgeText({ text: '+' });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
});

// === Tab watcher: auto-show floating panel on configured URL patterns ===
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (!/^https?:/.test(tab.url)) return;
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings?.floatingPanelSites?.length) return;
  if (!matchesAny(tab.url, settings.floatingPanelSites)) return;
  try {
    await injectFloating(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'show' });
  } catch {/* some pages reject injection */}
});

// === Commands: Alt+Shift+N toggles floating panel ===
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-floating') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) toggleFloating(tab.id);
});

// === Messages from popup ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'toggle-floating' && msg.tabId) {
    toggleFloating(msg.tabId);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }
  // Not our message — let other listeners handle it (e.g. Drive listener).
  return false;
});

// === Icon click: open floating panel on current tab ===
chrome.action.onClicked.addListener(async (tab) => {
  await openOnTab(tab);
});

async function openOnTab(tab) {
  if (!tab || !tab.id) return;
  // Chrome-internal pages can't be injected. Fall back to opening the
  // standalone popup.html in a new tab window.
  if (!tab.url || /^(chrome|chrome-extension|edge|brave|about|file):/.test(tab.url)
      || /^https:\/\/chrome\.google\.com\/webstore/.test(tab.url)
      || /^https:\/\/chromewebstore\.google\.com/.test(tab.url)) {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?standalone=1') });
    return;
  }
  try {
    await injectFloating(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch (e) {
    // Fallback to standalone if injection somehow failed
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?standalone=1') });
  }
}

// === Inject + toggle helpers ===
async function injectFloating(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

async function toggleFloating(tabId) {
  try {
    await injectFloating(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
  } catch (e) {
    // likely a restricted page (chrome://, web store, etc.)
    console.warn('[QuickNotes] Cannot toggle on this page:', e);
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?standalone=1') });
  }
}

async function recenterFloating(tabId) {
  // Ask the content script to recenter using current viewport dimensions.
  // If the panel isn't open, open it first (which loads fresh geometry).
  try {
    await injectFloating(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'recenter' });
  } catch (e) {
    // Fallback: reset saved geometry to safe defaults and show.
    const defaultPanel = {
      top: 80, left: null, right: 24,
      width: 420, height: 540, collapsed: false
    };
    await chrome.storage.local.set({ panel: defaultPanel });
    try {
      await injectFloating(tabId);
      await chrome.tabs.sendMessage(tabId, { type: 'show' });
    } catch (e2) {
      console.warn('[QuickNotes] Cannot recenter on this page:', e2);
    }
  }
}

// === Drive sync wiring ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'drive' && self.QN_Drive) {
    self.QN_Drive.handleDriveMessage(msg)
      .then((resp) => {
        if (!resp || resp.ok === false) {
          console.warn('[QuickNotes Drive]', msg.op, 'failed:', resp && resp.error);
        }
        sendResponse(resp);
      })
      .catch((e) => {
        console.error('[QuickNotes Drive] exception:', e);
        sendResponse({ ok: false, error: String(e && e.message || e) });
      });
    return true; // async response
  }
  return false;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (self.QN_Drive) self.QN_Drive.onAlarm(alarm);
});
// Re-arm the alarm whenever the service worker starts up.
chrome.runtime.onStartup.addListener(() => {
  if (self.QN_Drive) self.QN_Drive.setupAutoSync();
});
chrome.runtime.onInstalled.addListener(() => {
  if (self.QN_Drive) self.QN_Drive.setupAutoSync();
});

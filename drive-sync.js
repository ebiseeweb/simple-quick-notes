// drive-sync.js · Google Drive sync for Quick Notes
// Uses chrome.identity + Drive REST API. Stores everything in the appDataFolder
// (invisible to the user, per-app, requires only drive.appdata scope).
// The whole app state is serialized as a single JSON file named "quick-notes.json".

const DRIVE_API   = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3';
const FILE_NAME   = 'quick-notes.json';
const SYNC_ALARM  = 'qn-auto-sync';
const DRIVE_KEYS  = [
  'notes', 'activeId', 'settings', 'history',
  'shape', 'opacity', 'split', 'splitDir', 'pane2Id', 'paneRatio',
  'fontSize', 'zen', 'images', 'customColors', 'theme'
  // deliberately NOT synced: 'panel' (geometry is per-device)
];

// ----- Auth -----

// Web Application OAuth client ID for launchWebAuthFlow fallback.
// Required on browsers where chrome.identity.getAuthToken is unavailable
// (Edge, Brave, Opera, Vivaldi, Arc — all Chromium but no Chrome account).
// This is a PUBLIC identifier; no client_secret is used (implicit flow).
const WEB_APP_CLIENT_ID = '872447937251-3sfejbbko37mis39mld134jit2uko8as.apps.googleusercontent.com';

async function getAuthTokenNative(interactive) {
  return new Promise((resolve, reject) => {
    if (!chrome.identity || typeof chrome.identity.getAuthToken !== 'function') {
      reject(new Error('getAuthToken not available'));
      return;
    }
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const err = chrome.runtime.lastError;
        if (err || !token) {
          reject(new Error((err && err.message) || 'no token returned'));
        } else {
          resolve(token);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function getAuthTokenWebFlow(interactive) {
  if (!WEB_APP_CLIENT_ID || WEB_APP_CLIENT_ID.startsWith('YOUR_')) {
    throw new Error('Sign-in in this browser requires a Web Application OAuth client. Please use Chrome, or ask the developer to configure one.');
  }
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', WEB_APP_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.appdata');
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive },
      (redirectUrl) => {
        const err = chrome.runtime.lastError;
        if (err || !redirectUrl) {
          reject(new Error((err && err.message) || 'sign-in cancelled'));
          return;
        }
        try {
          const u = new URL(redirectUrl);
          const params = new URLSearchParams(u.hash.slice(1));
          const token = params.get('access_token');
          if (!token) reject(new Error('no access_token in response'));
          else resolve(token);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function getAuthToken(interactive = true) {
  // Try the native Chrome path first (best UX, no popup needed in Chrome).
  try {
    return await getAuthTokenNative(interactive);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Edge (and other Chromium browsers without Chrome account) responds with
    // "This API is not supported on Microsoft Edge" or similar. Fall back to
    // the standard OAuth2 web flow, which works everywhere.
    const isUnsupported = /not supported|not available|Unsupported|Not implemented/i.test(msg);
    if (!isUnsupported) {
      console.warn('[QuickNotes Drive] getAuthToken failed:', msg);
      throw e;
    }
    console.info('[QuickNotes Drive] Native auth unavailable, using web-flow fallback');
    return await getAuthTokenWebFlow(interactive);
  }
}

async function revokeAuthToken() {
  try {
    const token = await getAuthToken(false);
    // removeCachedAuthToken only exists when native path is used
    if (chrome.identity && typeof chrome.identity.removeCachedAuthToken === 'function') {
      await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
    }
    // Revoke on Google's side — works for both flows
    try {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
    } catch {}
  } catch {}
}

// ----- Drive REST helpers -----

async function driveFetch(url, options = {}) {
  const token = await getAuthToken(false);
  const headers = Object.assign(
    { Authorization: `Bearer ${token}` },
    options.headers || {}
  );
  const resp = await fetch(url, Object.assign({}, options, { headers }));
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Drive API ${resp.status}: ${text}`);
  }
  return resp;
}

// Find our backup file in appDataFolder. Returns { id, modifiedTime } or null.
async function findBackupFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const url = `${DRIVE_API}/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime,size)`;
  const resp = await driveFetch(url);
  const data = await resp.json();
  if (data.files && data.files.length > 0) {
    return data.files[0];
  }
  return null;
}

// Upload the given payload. If `existingId` is provided, update that file;
// otherwise create a new file in appDataFolder.
async function uploadBackup(payload, existingId) {
  const metadata = { name: FILE_NAME };
  if (!existingId) metadata.parents = ['appDataFolder'];

  const boundary = '---------------314159265358979323846';
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(payload) +
    `\r\n--${boundary}--`;

  const url = existingId
    ? `${UPLOAD_API}/files/${existingId}?uploadType=multipart&fields=id,modifiedTime`
    : `${UPLOAD_API}/files?uploadType=multipart&fields=id,modifiedTime`;

  const resp = await driveFetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  return resp.json();
}

async function downloadBackup(fileId) {
  const url = `${DRIVE_API}/files/${fileId}?alt=media`;
  const resp = await driveFetch(url);
  return resp.json();
}

// ----- High-level sync operations -----

async function collectLocalPayload() {
  const data = await chrome.storage.local.get(DRIVE_KEYS);
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    data
  };
}

async function applyRemotePayload(payload) {
  if (!payload || !payload.data) throw new Error('invalid payload');
  const toWrite = {};
  for (const k of DRIVE_KEYS) {
    if (k in payload.data) toWrite[k] = payload.data[k];
  }
  await chrome.storage.local.set(toWrite);
}

// Push: upload local state. Overwrites remote.
async function pushToDrive() {
  const payload = await collectLocalPayload();
  const existing = await findBackupFile();
  const result = await uploadBackup(payload, existing && existing.id);
  const stamp = new Date().toISOString();
  await chrome.storage.local.set({
    driveLastSync: stamp,
    driveLastSyncDirection: 'push',
    driveFileId: result.id,
    driveLastSyncError: null
  });
  return { ok: true, direction: 'push', at: stamp, fileId: result.id };
}

// Pull: download remote state. Overwrites local.
async function pullFromDrive() {
  const existing = await findBackupFile();
  if (!existing) throw new Error('no backup file on Drive');
  const payload = await downloadBackup(existing.id);
  await applyRemotePayload(payload);
  const stamp = new Date().toISOString();
  await chrome.storage.local.set({
    driveLastSync: stamp,
    driveLastSyncDirection: 'pull',
    driveFileId: existing.id,
    driveLastSyncError: null
  });
  return { ok: true, direction: 'pull', at: stamp };
}

// Smart sync: choose push or pull based on timestamps.
// If remote is newer than our last known sync, pull. Otherwise push.
async function smartSync() {
  const existing = await findBackupFile();
  if (!existing) {
    return pushToDrive();
  }
  const { driveLastSync } = await chrome.storage.local.get(['driveLastSync']);
  const remoteTime = new Date(existing.modifiedTime).getTime();
  const lastLocalSync = driveLastSync ? new Date(driveLastSync).getTime() : 0;
  if (remoteTime > lastLocalSync + 2000) {
    // Remote has changed since our last sync — pull.
    return pullFromDrive();
  }
  return pushToDrive();
}

// ----- Auto-sync scheduling -----

async function setupAutoSync() {
  const { driveSync } = await chrome.storage.local.get(['driveSync']);
  const cfg = driveSync || {};
  chrome.alarms.clear(SYNC_ALARM);
  if (cfg.enabled && cfg.autoSync && cfg.intervalMinutes) {
    chrome.alarms.create(SYNC_ALARM, {
      delayInMinutes: cfg.intervalMinutes,
      periodInMinutes: cfg.intervalMinutes
    });
  }
}

async function onAlarm(alarm) {
  if (alarm.name !== SYNC_ALARM) return;
  try {
    await smartSync();
  } catch (e) {
    await chrome.storage.local.set({ driveLastSyncError: String(e.message || e) });
  }
}

// ----- Exported message handler -----
// The background service worker and options page call this via
// chrome.runtime.sendMessage({ type: 'drive', op: '...' }).

async function handleDriveMessage(msg) {
  try {
    switch (msg.op) {
      case 'signIn': {
        const token = await getAuthToken(true);
        // Fetch user info (best effort)
        let email = null;
        try {
          const r = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (r.ok) { const info = await r.json(); email = info.email; }
        } catch {}
        const cur = (await chrome.storage.local.get(['driveSync'])).driveSync || {};
        await chrome.storage.local.set({
          driveSync: Object.assign(
            { autoSync: true, intervalMinutes: 15 },
            cur,
            { enabled: true, email }
          )
        });
        await setupAutoSync();
        return { ok: true, email };
      }
      case 'signOut': {
        await revokeAuthToken();
        const cur = (await chrome.storage.local.get(['driveSync'])).driveSync || {};
        await chrome.storage.local.set({
          driveSync: Object.assign({}, cur, { enabled: false, email: null })
        });
        chrome.alarms.clear(SYNC_ALARM);
        return { ok: true };
      }
      case 'push':     return await pushToDrive();
      case 'pull':     return await pullFromDrive();
      case 'sync':     return await smartSync();
      case 'status': {
        const d = await chrome.storage.local.get([
          'driveSync', 'driveLastSync', 'driveLastSyncDirection', 'driveLastSyncError'
        ]);
        let remoteInfo = null;
        if (d.driveSync && d.driveSync.enabled) {
          try {
            const f = await findBackupFile();
            if (f) remoteInfo = { modifiedTime: f.modifiedTime, size: f.size };
          } catch (e) {
            // Token could be stale
            remoteInfo = { error: String(e.message || e) };
          }
        }
        return { ok: true, ...d, remote: remoteInfo };
      }
      case 'configure': {
        const cur = (await chrome.storage.local.get(['driveSync'])).driveSync || {};
        const next = Object.assign({}, cur, msg.config || {});
        await chrome.storage.local.set({ driveSync: next });
        await setupAutoSync();
        return { ok: true, driveSync: next };
      }
    }
    return { ok: false, error: 'unknown op' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ----- Export for service worker -----

if (typeof self !== 'undefined') {
  self.QN_Drive = { handleDriveMessage, onAlarm, setupAutoSync };
}

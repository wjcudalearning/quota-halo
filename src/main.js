'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const credentials = require('./credentials');
const activity = require('./activity');
const settingsStore = require('./settingsStore');
const providers = require('./providers');

// ---------------------------------------------------------------- geometry --
// The window holds the whole card; win.setShape narrows the OS hit region to
// the collapsed pill, so the transparent surround never blocks the desktop.
const PILL_H = 34;
const CARD_H = 240;
const CELL_W = 88;   // per-provider cell width in the expanded card
const EDGE_GAP = 6;

function cardWidthFor(count) {
  return Math.max(236, 20 + count * CELL_W + 14);
}

let settingsFile = null;
let settings = settingsStore.defaults();
let win = null;
let tray = null;
let settingsWin = null;
let lastPayload = null;
let pollTimer = null;
let activityTimer = null;
let pointerTimer = null;
let currentMode = 'pill';
let pollInFlight = null;
let consecutiveTransient = 0;
let notchPos = null;
let windowPlacing = false;
let isQuitting = false;
let everBroadcast = false;

const userData = () => app.getPath('userData');
const settingsPath = () => path.join(userData(), 'settings.json');

function reloadSettings() {
  settings = settingsStore.load(settingsFile || settingsPath());
}
function saveSettings(patch) {
  settings = { ...settings, ...patch };
  settingsStore.save(settingsFile || settingsPath(), settings);
}

function enabledCount() {
  return providers.enabledProviders(settings).length;
}

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function placeWindow() {
  if (!win || win.isDestroyed()) return;
  const w = cardWidthFor(enabledCount());
  const wa = workArea();
  const cx = wa.x + Math.round(wa.width / 2);
  let x = cx - Math.round(w / 2);
  let y;
  if (settings.edge === 'bottom') {
    y = wa.y + wa.height - EDGE_GAP - CARD_H;
  } else {
    y = wa.y + EDGE_GAP;
  }
  // Respect a position the user dragged the notch to (and its display still
  // exists); otherwise fall back to the centred default above.
  let target = { x, y, width: w, height: CARD_H };
  if (notchPos && typeof notchPos.x === 'number' && typeof notchPos.y === 'number') {
    const d = screen.getDisplayNearestPoint({ x: notchPos.x, y: notchPos.y });
    if (d && screen.getAllDisplays().some((dd) => dd.id === (notchPos.displayId ?? d.id))) {
      target = { x: notchPos.x, y: notchPos.y, width: w, height: CARD_H };
    } else {
      notchPos = null;
      saveSettings({ notchPos: null });
    }
  }
  windowPlacing = true;
  try {
    win.setBounds(target);
  } finally {
    windowPlacing = false;
  }
}

let moveSaveTimer = null;
function rememberPosition() {
  if (windowPlacing || !win || win.isDestroyed()) return;
  clearTimeout(moveSaveTimer);
  moveSaveTimer = setTimeout(() => {
    const b = win.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    notchPos = { x: b.x, y: b.y, displayId: d ? d.id : null };
    saveSettings({ notchPos });
  }, 600);
}

function rehomeOnDisplayChange() {
  if (!win || win.isDestroyed()) return;
  if (!notchPos || notchPos.displayId == null) {
    placeWindow();
    return;
  }
  const stillThere = screen.getAllDisplays().some((dd) => dd.id === notchPos.displayId);
  if (!stillThere) {
    notchPos = null;
    saveSettings({ notchPos: null });
  }
  placeWindow();
}

function pillRect() {
  const w = cardWidthFor(enabledCount());
  const pw = Math.min(220, w - 24);
  const y = settings.edge === 'bottom' ? CARD_H - PILL_H : 0;
  return { x: Math.round((w - pw) / 2), y, width: pw, height: PILL_H };
}
function cardRect() {
  return { x: 0, y: 0, width: cardWidthFor(enabledCount()), height: CARD_H };
}

function setMode(mode) {
  currentMode = mode;
  if (!win || win.isDestroyed()) return;
  try {
    if (mode === 'card') win.setShape([cardRect()]);
    else win.setShape([pillRect()]);
  } catch {
    /* setShape unsupported */
  }
  try {
    win.webContents.send('mode', mode);
  } catch {
    /* renderer gone */
  }
}

// ---------------------------------------------------------------- snapshot --

/** Keep a provider's last good reading so a transient failure shows it stale. */
const providerCache = new Map();

const lastStateFile = () => path.join(userData(), 'last-state.json');
function loadLastState() {
  try {
    return JSON.parse(fs.readFileSync(lastStateFile(), 'utf8'));
  } catch {
    return {};
  }
}
let lastStateWrite = null;
function scheduleStatePersist() {
  if (lastStateWrite) return;
  lastStateWrite = setTimeout(() => {
    lastStateWrite = null;
    try {
      const obj = {};
      for (const [id, snap] of providerCache) obj[id] = snap;
      fs.mkdirSync(path.dirname(lastStateFile()), { recursive: true });
      fs.writeFileSync(lastStateFile(), JSON.stringify(obj));
    } catch {
      /* non-fatal */
    }
  }, 1500);
}

function buildPayload(results, act) {
  const out = [];
  for (const r of results) {
    let item = { ...r };
    if (item.state === 'ok') {
      providerCache.set(item.id, { ...item });
      scheduleStatePersist();
    } else {
      // Expired / needsAuth / error: if we ever had a good reading, keep the
      // last numbers visible and mark them stale rather than blanking out.
      const last = providerCache.get(item.id);
      if (last) {
        item = { ...item, staleOf: last, stale: true };
      }
    }
    out.push(item);
  }
  return {
    providers: out,
    activity: act,
    pinned: !!settings.pinned,
    edge: settings.edge,
    locale: settings.locale,
    refreshSeconds: settings.refreshSeconds,
    fetchedAt: new Date().toISOString(),
  };
}

async function runPoll() {
  // Single-flight: a manual Refresh while a poll is in flight just waits on the
  // same promise instead of firing a second set of API calls.
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    try {
      dbg('runPoll start');
      const results = await providers.fetchAll(settings);
      dbg(`runPoll fetched ${results.length}`);
      const act = activity.sampleActivity();
      lastPayload = buildPayload(results, act);
      broadcast();
      updateTray();
      // Track transient API failures so the scheduler can back off rather than
      // hammering a temporarily-unreachable endpoint at a fixed cadence.
      const hasTransient = results.some(
        (r) => r.state === 'error' || r.badge === 'RATE' || r.badge === 'TIMEOUT' || r.state === 'rateLimited'
      );
      consecutiveTransient = hasTransient ? consecutiveTransient + 1 : 0;
      dbg('runPoll done transient=' + consecutiveTransient);
    } finally {
      pollInFlight = null;
    }
  })();
  return pollInFlight;
}

function dbg(msg) {
  if (!process.env.CODENOTCH_DEBUG) return;
  try {
    const dir = path.join(__dirname, '..', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'main.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function broadcast() {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('snapshot', lastPayload);
    } catch {
      /* renderer not ready */
    }
  }
  everBroadcast = true;
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const activeNow = !!(lastPayload && lastPayload.activity && lastPayload.activity.active);
  const base = activeNow ? 10000 : Math.max(10, (settings.refreshSeconds || 60) * 1000);
  let delay = base;
  // On repeated transient failures back off exponentially (15s→30s→60s→120s),
  // capped at the normal cadence, resuming immediately once a poll succeeds.
  if (consecutiveTransient > 0 && !activeNow) {
    delay = Math.min(base, 15000 * Math.pow(2, Math.min(consecutiveTransient - 1, 3)));
  }
  pollTimer = setTimeout(() => runPoll().finally(schedulePoll), delay);
}

function startTimers() {
  stopTimers();
  runPoll().finally(schedulePoll);
  activityTimer = setInterval(() => {
    const act = activity.sampleActivity();
    if (lastPayload) {
      lastPayload = { ...lastPayload, activity: act };
      broadcast();
    }
  }, 10000);
  pointerTimer = setInterval(watchPointer, 300);
}

/** Robust hover expand / leave collapse, driven by the real cursor position
    rather than DOM mouse events (which are unreliable on a transparent,
    shaped, always-on-top window). While the cursor is moving (dragging the
    window) we never auto-expand, so grabbing the pill to move it between
    screens stays a clean drag. */
let watchLastPt = null;
function watchPointer() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (settings.pinned) return;
  let p, b, pr;
  try {
    p = screen.getCursorScreenPoint();
    b = win.getBounds();
    pr = pillRect();
  } catch {
    return;
  }
  const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
  const pillLeft = b.x + pr.x;
  const pillTop = b.y + pr.y;
  const inPill = p.x >= pillLeft && p.x <= pillLeft + pr.width && p.y >= pillTop && p.y <= pillTop + pr.height;

  let moving = false;
  if (watchLastPt) {
    const dx = p.x - watchLastPt.x;
    const dy = p.y - watchLastPt.y;
    moving = Math.hypot(dx, dy) > 24; // moved >24px in the last 300ms tick
  }
  watchLastPt = { x: p.x, y: p.y };

  if (!inside && currentMode === 'card') {
    setMode('pill');
  } else if (inPill && currentMode === 'pill' && !moving) {
    setMode('card');
  }
}

function stopTimers() {
  if (pollTimer) clearTimeout(pollTimer);
  if (activityTimer) clearInterval(activityTimer);
  if (pointerTimer) clearInterval(pointerTimer);
  pollTimer = null;
  activityTimer = null;
  pointerTimer = null;
}

// ---------------------------------------------------------------- tray ----
let trayIcon = null;
function ensureTrayIcon() {
  if (trayIcon) return trayIcon;
  try {
    const p = path.join(__dirname, '..', 'assets', 'tray.png');
    if (fs.existsSync(p)) {
      trayIcon = nativeImage.createFromPath(p);
      if (process.platform === 'win32') trayIcon = trayIcon.resize({ width: 16, height: 16 });
    }
  } catch {
    trayIcon = null;
  }
  return trayIcon;
}

function updateTray() {
  if (!tray) return;
  const p = lastPayload ? lastPayload.providers : [];
  const parts = p.map((x) => (x.state === 'ok' ? `${x.name} ${x.headline}` : x.state === 'needsAuth' ? `${x.name} needs sign-in` : `${x.name} unavailable`));
  tray.setToolTip(`Codenotch · ${parts.join(' · ') || 'no providers'}`);
  tray.setContextMenu(buildMenu());
}
function rebuildMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

function buildMenu() {
  const visible = win && !win.isDestroyed() && win.isVisible();
  const items = [];
  if (lastPayload) {
    for (const p of lastPayload.providers) {
      const status = p.state === 'ok' ? p.headline : p.state === 'expired' ? 'token expired' : p.state === 'needsAuth' ? 'sign in needed' : p.state;
      items.push({ label: `${p.name}: ${status}`, enabled: false });
    }
  }
  items.push({ type: 'separator' });
  items.push(
    {
      label: visible ? 'Hide notch' : 'Show notch',
      click: () => toggleNotch(),
    },
    {
      label: settings.pinned ? 'Unpin (hover to expand)' : 'Pin open',
      click: () => {
        saveSettings({ pinned: !settings.pinned });
        if (win) {
          if (settings.pinned) setMode('card');
          broadcast();
          rebuildMenu();
        }
      },
    },
    { label: 'Refresh now', click: () => refreshNow() },
    { type: 'separator' },
    { label: 'Settings\u2026', click: () => openSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit Codenotch', click: () => quitApp() }
  );
  return Menu.buildFromTemplate(items);
}

function toggleNotch() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else win.show();
  rebuildMenu();
}
async function refreshNow() {
  await runPoll();
  rebuildMenu();
}

// ---------------------------------------------------------------- windows --
function createNotchWindow() {
  if (win && !win.isDestroyed()) return;
  win = new BrowserWindow({
    width: cardWidthFor(enabledCount()),
    height: CARD_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, settings.overlayLevel === 'normal' ? 'normal' : 'screen-saver');
  try {
    win.setShape([pillRect()]);
  } catch {
    /* older electron */
  }
  win.setSkipTaskbar(true);
  win.on('move', rememberPosition);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Right-click on the notch opens the same actions as the tray menu.
  win.webContents.on('context-menu', () => {
    try {
      buildMenu().popup({ window: win });
    } catch {
      /* ignore */
    }
  });
  win.webContents.on('did-finish-load', () => {
    // Renderer is live; make sure it holds the current snapshot (the very
    // first poll often lands before the page finished loading).
    if (lastPayload) broadcast();
    else refreshNow();
  });
  win.once('ready-to-show', () => {
    placeWindow();
    win.showInactive();
    setMode(settings.pinned ? 'card' : 'pill');
  });
  win.on('closed', () => {
    win = null;
  });
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 640,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// ---------------------------------------------------------------- IPC -----
ipcMain.on('ui:action', (event, action) => {
  switch (action) {
    case 'expand':
      if (!settings.pinned) setMode('card');
      break;
    case 'collapse':
      if (!settings.pinned) setMode('pill');
      break;
    case 'pin':
      saveSettings({ pinned: true });
      setMode('card');
      rebuildMenu();
      break;
    case 'unpin':
      saveSettings({ pinned: false });
      setMode('pill');
      rebuildMenu();
      break;
    case 'refresh':
      refreshNow();
      break;
    case 'settings':
      openSettingsWindow();
      break;
    case 'close-settings':
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
      break;
    case 'quit':
      quitApp();
      break;
    default:
      break;
  }
});

ipcMain.handle('settings:get', () => ({ ...settings, _width: cardWidthFor(enabledCount()), _cardH: CARD_H }));

const SETTABLE = new Set([
  'refreshSeconds',
  'keyName',
  'credentialsPath',
  'pinned',
  'edge',
  'launchAtLogin',
  'providers',
  'openrouterApiKey',
  'refreshOnActivity',
  'notchPos',
  'locale',
  'overlayLevel',
]);

ipcMain.handle('settings:set', (_e, patch) => {
  const clean = {};
  for (const k of SETTABLE) {
    if (k in patch) clean[k] = patch[k];
  }
  if ('refreshSeconds' in clean) {
    clean.refreshSeconds = Math.max(10, Math.min(3600, Number(clean.refreshSeconds) || 60));
  }
  if ('providers' in clean) {
    const flags = { ...(settings.providers || {}) };
    for (const [id, on] of Object.entries(clean.providers)) {
      if (typeof on === 'boolean') flags[id] = on;
    }
    clean.providers = flags;
  }
  // Only persist an OpenRouter value that is actually a key (or empty).
  if ('openrouterApiKey' in clean) {
    const v = String(clean.openrouterApiKey || '').trim();
    if (v && !v.startsWith('sk-or-')) {
      delete clean.openrouterApiKey;
    } else {
      clean.openrouterApiKey = v;
    }
  }
  if ('launchAtLogin' in clean) {
    app.setLoginItemSettings({ openAtLogin: !!clean.launchAtLogin });
  }
  if ('edge' in clean) {
    clean.notchPos = null; // switching screen edge re-centres; user re-drags
  }
  saveSettings(clean);
  if ('notchPos' in clean) notchPos = clean.notchPos || null;
  if ('overlayLevel' in clean && win && !win.isDestroyed()) {
    win.setAlwaysOnTop(true, settings.overlayLevel === 'normal' ? 'normal' : 'screen-saver');
  }
  if ('edge' in clean || 'providers' in clean) {
    notchPos = settings.notchPos || null;
    placeWindow();
    try {
      win.setShape(settings.pinned ? [cardRect()] : [pillRect()]);
    } catch {
      /* ignore */
    }
  }
  if (win && !win.isDestroyed()) {
    if (settings.pinned) setMode('card');
    broadcast();
  }
  if ('refreshSeconds' in clean || 'providers' in clean) {
    // Re-arm the poll cadence.
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(() => runPoll().finally(schedulePoll), 400);
    }
  }
  if (tray) rebuildMenu();
  return { ...settings };
});
ipcMain.handle('settings:probe', () => {
  const out = {};
  const deep = credentials.readApiKey(settings);
  out.deepseek = { found: deep.present, file: deep.file || '', name: deep.name };
  const { resolveKey } = require('./providers/openrouter');
  out.openrouter = { found: !!resolveKey(settings), source: resolveKey(settings) ? 'configured' : 'none' };
  out.claude = { found: fs.existsSync(path.join(process.env.USERPROFILE || os.homedir(), '.claude', '.credentials.json')) };
  out.codex = { found: fs.existsSync(path.join(process.env.USERPROFILE || os.homedir(), '.codex', 'auth.json')) };
  out.antigravity = { found: null, via: 'Windows Credential Manager (gemini:antigravity) — read at each poll' };
  return out;
});
ipcMain.handle('settings:pickCredentials', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose credentials file',
    defaultPath: credentials.effectiveCredentialsPath(settings),
    properties: ['openFile'],
    filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});
ipcMain.handle('dialog:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------------------------------------------------------------- app -----
function quitApp() {
  isQuitting = true;
  stopTimers();
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.showInactive();
      setMode(settings.pinned ? 'card' : 'pill');
    }
  });

  app.whenReady().then(() => {
    settingsFile = settingsPath();
    reloadSettings();
    app.setName('Codenotch');
    notchPos = settings.notchPos || null;
    dbg('ready: creating window');

    // Seed the last-ok cache so a cold start (e.g. no network yet) still shows
    // the most recent reading instead of a blank notch.
    for (const [id, snap] of Object.entries(loadLastState())) providerCache.set(id, snap);

    createNotchWindow();
    ensureTrayIcon();
    tray = new Tray(ensureTrayIcon());
    tray.setToolTip('Codenotch');
    tray.setContextMenu(buildMenu());
    if (process.platform === 'win32') {
      tray.on('double-click', () => toggleNotch());
    }
    dbg('tray created');

    const storedLogin = app.getLoginItemSettings && app.getLoginItemSettings().openAtLogin;
    if (storedLogin) settings.launchAtLogin = true;

    // Re-home the notch if a display that held it was added/removed/resized.
    screen.on('display-added', rehomeOnDisplayChange);
    screen.on('display-removed', rehomeOnDisplayChange);
    screen.on('display-metrics-changed', rehomeOnDisplayChange);

    startTimers();
    dbg('timers started');

    if (process.env.CODENOTCH_DEBUG) runDebugChecks();
  });

  app.on('activate', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });
  app.on('before-quit', () => {
    isQuitting = true;
    stopTimers();
  });
  app.on('window-all-closed', () => {
    if (isQuitting) app.quit();
  });
}

// ---------------------------------------------------------------- debug ----
async function runDebugChecks() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const outDir = path.join(__dirname, '..', 'debug');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await sleep(2000);
    // Wait until cells actually rendered (first polls can be slow on cold start).
    for (let i = 0; i < 15; i++) {
      const n = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.cell').length`
      );
      if (n > 0) break;
      await sleep(1500);
    }
    const info = await win.webContents.executeJavaScript(`(() => {
      const cells = [...document.querySelectorAll('.cell')].map(c => ({
        name: c.dataset.name,
        headline: c.querySelector('.cell-headline')?.textContent.trim(),
        badge: c.querySelector('.cell-badge')?.textContent.trim(),
        arc: c.querySelector('.ring-arc')?.style.strokeDasharray,
      }));
      return {
        mode: document.getElementById('notch')?.className,
        pillText: document.getElementById('miniText')?.textContent,
        cells,
        dpName: document.getElementById('dpName')?.textContent.trim(),
        dpFid: document.getElementById('dpFid')?.textContent.trim(),
        dpUpd: document.getElementById('dpUpd')?.textContent.trim(),
        dpRows: [...document.querySelectorAll('.dp-window')].map(r => ({
          label: r.querySelector('.w-label')?.textContent.trim(),
          val: r.querySelector('.w-val')?.textContent.trim(),
          reset: r.querySelector('.w-reset')?.textContent.trim(),
          fill: r.querySelector('.w-fill')?.style.width,
        })),
        body: { w: document.body.offsetWidth, h: document.body.offsetHeight },
      };
    })()`);
    info.bounds = win.getBounds();
    await win.webContents.executeJavaScript(
      `document.getElementById('mini').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))`
    );
    await sleep(500);
    info.expanded = await win.webContents.executeJavaScript(`(() => ({
      className: document.getElementById('notch').className,
      fullOpacity: getComputedStyle(document.getElementById('full')).opacity,
    }))()`);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'notch.png'), img.toPNG());
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(info, null, 2));
    console.log('[debug] report written');
    setTimeout(() => quitApp(), 400);
  } catch (err) {
    console.error('[debug] failed', err);
    setTimeout(() => quitApp(), 400);
  }
}

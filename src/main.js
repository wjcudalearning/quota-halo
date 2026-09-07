'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, shell, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const credentials = require('./credentials');
const activity = require('./activity');
const settingsStore = require('./settingsStore');
const providers = require('./providers');
const claudeProvider = require('./providers/claude');

const APP_NAME = 'Quota Halo';

// ---------------------------------------------------------------- geometry --
// The window holds the whole card; win.setShape narrows the OS hit region to
// the collapsed pill, so the transparent surround never blocks the desktop.
const PILL_H = 34;
let PILL_W = 220;     // renderer 回報實際膠囊寬度後即時修正
const PILL_W_MIN = 96;
const PILL_W_MAX = 220;
let CARD_H = 276;    // renderer 回報實際內容高度後即時修正
const CARD_H_MIN = 180;
const CARD_H_MAX = 460;
const CELL_W = 92;   // per-provider cell width in the expanded card
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
let prevProviderStates = new Map();
let isQuitting = false;
let everBroadcast = false;

const userData = () => app.getPath('userData');
const settingsPath = () => path.join(userData(), 'settings.json');

/** Preserve settings across the product-name change without deleting or
    modifying the legacy folders. DPAPI-protected values remain valid for the
    same Windows user. */
function migrateLegacyUserData() {
  const destination = userData();
  const parent = path.dirname(destination);
  const candidates = ['Codenotch', 'Codenotch for Windows', 'codenotch-win']
    .map((name) => path.join(parent, name))
    .filter((dir) => path.resolve(dir) !== path.resolve(destination))
    .filter((dir) => fs.existsSync(path.join(dir, 'settings.json')))
    .sort((a, b) => {
      try { return fs.statSync(path.join(b, 'settings.json')).mtimeMs - fs.statSync(path.join(a, 'settings.json')).mtimeMs; }
      catch { return 0; }
    });
  if (!candidates.length) return;
  fs.mkdirSync(destination, { recursive: true });
  let copied = 0;
  for (const file of ['settings.json', 'last-state.json']) {
    const target = path.join(destination, file);
    if (fs.existsSync(target)) continue;
    const source = candidates.map((dir) => path.join(dir, file)).find((p) => fs.existsSync(p));
    if (!source) continue;
    try {
      fs.copyFileSync(source, target);
      copied += 1;
    } catch (err) {
      console.warn('[migration] could not copy', file, err && err.message);
    }
  }
  if (copied) console.log(`[migration] imported ${copied} file(s) from ${candidates[0]}`);
}

function reloadSettings() {
  settings = settingsStore.load(settingsFile || settingsPath());
}
function saveSettings(patch) {
  settings = { ...settings, ...patch };
  settingsStore.save(settingsFile || settingsPath(), settings);
}

/** Resolve the OpenRouter key for polling: prefer the DPAPI-encrypted value,
    fall back to a legacy plaintext value, then the env var. */
function decryptOpenRouterKey() {
  if (settings.openrouterApiKeyEnc) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(settings.openrouterApiKeyEnc, 'base64'));
      }
    } catch (err) {
      console.warn('[openrouter] decrypt failed:', err && err.message);
    }
  }
  if (settings.openrouterApiKey && String(settings.openrouterApiKey).startsWith('sk-or-')) {
    return settings.openrouterApiKey;
  }
  return process.env.OPENROUTER_API_KEY || null;
}

/** Encrypt & store an OpenRouter key; never writes the plaintext to disk. */
function encryptStoreOpenRouterKey(value) {
  let enc = null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      enc = safeStorage.encryptString(value).toString('base64');
    }
  } catch (err) {
    console.warn('[openrouter] encrypt failed:', err && err.message);
  }
  return {
    openrouterApiKeyEnc: enc,
    openrouterApiKey: enc ? undefined : value, // fall back to plaintext only if DPAPI unusable
    openrouterApiKeyHint: '…' + value.slice(-4),
  };
}

function enabledCount() {
  return providers.enabledProviders(settings).length;
}

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function shortPath(p) {
  if (!p) return '';
  const home = (process.env.USERPROFILE || os.homedir()).replace(/\\/g, '/');
  return p.replace(/\\/g, '/').replace(home, '~');
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

/** Throttle dynamic resize so the window doesn't jump on every poll. */
let lastResizeAt = 0;
function resizeOk() {
  const now = Date.now();
  if (now - lastResizeAt < 700) return false;
  lastResizeAt = now;
  return true;
}

/** Windows 11 glass is optional: acrylic on a transparent shaped window is the
    main source of compositing jank, so it defaults off (solid card = smooth). */
function applyGlass() {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.setBackgroundMaterial) win.setBackgroundMaterial(settings.useAcrylic ? 'acrylic' : 'none');
  } catch {
    /* runtime */
  }
  try {
    win.webContents.executeJavaScript(
      `document.documentElement.classList.toggle('no-acrylic', ${!settings.useAcrylic})`
    ).catch(() => {});
  } catch {
    /* not loaded yet */
  }
}

function pillRect() {
  const w = cardWidthFor(enabledCount());
  const pw = Math.max(PILL_W_MIN, Math.min(PILL_W_MAX, Math.min(PILL_W, w - 24)));
  const y = settings.edge === 'bottom' ? CARD_H - PILL_H : 0;
  return { x: Math.round((w - pw) / 2), y, width: pw, height: PILL_H };
}
function cardRect() {
  return { x: 0, y: 0, width: cardWidthFor(enabledCount()), height: CARD_H };
}

function setMode(mode) {
  currentMode = mode;
  if (!win || win.isDestroyed()) return;
  // While the notch is collapsed, the renderer may already have measured a
  // taller detail card and updated CARD_H. The window itself deliberately
  // stays put in pill mode, so apply that pending size *before* exposing the
  // card; otherwise the old, shorter transparent window clips the detail
  // panel and makes the bottom rounded corners appear to disappear.
  if (mode === 'card') placeWindow();
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
  const out = providers.applyStale(results, providerCache);
  // Never persist fixture/screenshot test values into the real last-state.json.
  if (!process.env.CODENOTCH_FIXTURE && results.some((r) => r.state === 'ok')) scheduleStatePersist();
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
      // Re-read settings from disk each poll so a key/option saved externally
      // (or while the app was already running) takes effect immediately.
      reloadSettings();
      const fetchSettings = { ...settings, openrouterApiKey: decryptOpenRouterKey() };
      const results = process.env.CODENOTCH_FIXTURE
        ? fixtureProviders()
        : await providers.fetchAll(fetchSettings);
      dbg(`runPoll fetched ${results.length}`);
      maybeNotify(results);
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

/** Notify only when a provider actually *changes* state (never every poll). */
function maybeNotify(results) {
  if (settings.notifyOnStateChange === false) return;
  for (const r of results) {
    const prev = prevProviderStates.get(r.id);
    const cur = r.state;
    if (prev && prev !== cur && Notification.isSupported()) {
      const bad = cur !== 'ok';
      const title = bad ? `${r.name} 狀態變更` : `${r.name} 已恢復`;
      const body = bad ? (r.message || r.state) : `讀取已恢復：${r.headline || ''}`;
      try {
        new Notification({ title, body, silent: true }).show();
      } catch {
        /* suppress */
      }
    }
    prevProviderStates.set(r.id, cur);
  }
}

/** Renderer fixture mode (CODENOTCH_FIXTURE=ok|stale|auth|empty) for design /
    screenshot work without touching the providers. */
function fixtureProviders() {
  const mode = (process.env.CODENOTCH_FIXTURE || 'ok').toLowerCase();
  const base = [
    { id: 'deepseek', name: 'DeepSeek', glyph: 'D', kind: 'money' },
    { id: 'openrouter', name: 'OpenRouter', glyph: 'OR', kind: 'money' },
    { id: 'claude', name: 'Claude', glyph: 'Cl', kind: 'usage' },
    { id: 'codex', name: 'Codex', glyph: 'Cx', kind: 'usage' },
    { id: 'antigravity', name: 'Antigravity', glyph: 'Ag', kind: 'usage' },
  ];
  const ok = (p) => ({
    ...p,
    state: 'ok',
    fidelity: 'official',
    headline: p.kind === 'money' ? '$30.00' : '12%',
    headlineRaw: null,
    fraction: p.kind === 'money' ? null : 0.12,
    level: 'ok',
    badge: 'OK',
    caption: p.kind === 'money' ? 'USD' : 'USED',
    rows: [{ k: 'reading', v: '100%' }],
    windows: [],
    updatedAt: new Date().toISOString(),
  });
  let out = base.map(ok);
  if (mode === 'auth') out = out.map((p) => ({ ...p, state: 'needsAuth', headline: '\u2014', badge: 'AUTH', rows: [{ k: 'SIGN IN', v: '' }] }));
  else if (mode === 'empty') out = [];
  else if (mode === 'stale') out = out.map((p) => ({ ...p, state: 'error', headline: '\u2014', badge: 'ERR', stale: true, staleOf: ok(p) }));
  return out;
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
let debugHoldCard = false;
function watchPointer() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (settings.pinned || debugHoldCard) return;
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
  tray.setToolTip(`${APP_NAME} · ${parts.join(' · ') || 'no providers'}`);
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
    { label: `Quit ${APP_NAME}`, click: () => quitApp() }
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
    backgroundColor: '#00000000',
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
  applyGlass();
  // Right-click on the notch opens the same actions as the tray menu.
  win.webContents.on('context-menu', () => {
    try {
      buildMenu().popup({ window: win });
    } catch {
      /* ignore */
    }
  });
  win.webContents.on('did-finish-load', () => {
    // Acrylic only renders a real desktop blur on Windows 10/11; elsewhere (and
    // when the user prefers smoothness over glass) fall back to the solid card.
    if (!settings.useAcrylic) {
      win.webContents.executeJavaScript(
        "document.documentElement.classList.add('no-acrylic')",
      ).catch(() => {});
    }
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
ipcMain.on('ui:action', (event, action, arg) => {
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
    case 'height': {
      const requested = Number(arg);
      if (!Number.isFinite(requested)) break;
      // Dampen: snap to 24px steps and require a cooldown so the window does
      // not micro-resize on every poll (that is what made it "pump").
      const snap = Math.max(CARD_H_MIN, Math.min(CARD_H_MAX, Math.round(requested / 24) * 24 + 24));
      if (snap === CARD_H || !resizeOk()) break;
      CARD_H = snap;
      if (currentMode === 'card') placeWindow();
      break;
    }
    case 'pill-width': {
      const requested = Number(arg);
      if (!Number.isFinite(requested)) break;
      const width = Math.max(PILL_W_MIN, Math.min(PILL_W_MAX, Math.round(requested / 8) * 8));
      if (width === PILL_W || !resizeOk()) break;
      PILL_W = width;
      if (currentMode === 'pill' && win && !win.isDestroyed()) {
        try { win.setShape([pillRect()]); } catch { /* older electron */ }
      }
      break;
    }
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

ipcMain.handle('settings:get', () => {
  const { openrouterApiKey, openrouterApiKeyEnc, ...rest } = settings;
  return { ...rest, _width: cardWidthFor(enabledCount()), _cardH: CARD_H };
});

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
  'notifyOnStateChange',
]);

ipcMain.handle('settings:set', (_e, patch) => {
  const clean = {};
  for (const k of SETTABLE) {
    if (k in patch) clean[k] = patch[k];
  }
  // Validate every settable value (never trust the renderer blindly).
  if ('refreshSeconds' in clean) {
    clean.refreshSeconds = Math.max(10, Math.min(3600, Number(clean.refreshSeconds) || 60));
  }
  if ('edge' in clean && !['top', 'bottom'].includes(clean.edge)) delete clean.edge;
  if ('locale' in clean && !['zh-TW', 'en'].includes(clean.locale)) delete clean.locale;
  if ('overlayLevel' in clean && !['screen-saver', 'normal'].includes(clean.overlayLevel)) delete clean.overlayLevel;
  if ('keyName' in clean) clean.keyName = String(clean.keyName || 'DEEPSEEK_API_KEY').slice(0, 80);
  if ('credentialsPath' in clean) clean.credentialsPath = String(clean.credentialsPath || '').slice(0, 1024);
  for (const k of ['pinned', 'launchAtLogin', 'refreshOnActivity', 'notifyOnStateChange']) {
    if (k in clean) clean[k] = !!clean[k];
  }
  if ('notchPos' in clean) {
    if (clean.notchPos && typeof clean.notchPos === 'object' && Number.isFinite(clean.notchPos.x) && Number.isFinite(clean.notchPos.y)) {
      clean.notchPos = {
        x: Math.round(clean.notchPos.x),
        y: Math.round(clean.notchPos.y),
        displayId: clean.notchPos.displayId || null,
      };
    } else {
      clean.notchPos = null;
    }
  }
  if ('providers' in clean) {
    const flags = { ...(settings.providers || {}) };
    for (const [id, on] of Object.entries(clean.providers)) {
      if (typeof on === 'boolean') flags[id] = on;
    }
    clean.providers = flags;
  }
  // Only persist an OpenRouter value that is actually a key (or empty), and
  // store it encrypted via Electron safeStorage (DPAPI on Windows).
  if ('openrouterApiKey' in clean) {
    const v = String(clean.openrouterApiKey || '').trim();
    if (v && v.startsWith('sk-or-')) {
      const stored = encryptStoreOpenRouterKey(v);
      clean.openrouterApiKey = stored.openrouterApiKey;
      clean.openrouterApiKeyEnc = stored.openrouterApiKeyEnc;
      clean.openrouterApiKeyHint = stored.openrouterApiKeyHint;
    } else {
      clean.openrouterApiKey = undefined;
      clean.openrouterApiKeyEnc = null;
      clean.openrouterApiKeyHint = null;
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
  if ('useAcrylic' in clean) applyGlass();
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
  const { jwtClaims } = require('./providers/helpers');
  const { resolveKey } = require('./providers/openrouter');
  const home = process.env.USERPROFILE || os.homedir();

  const deep = credentials.readApiKey(settings);
  const creds = {};
  creds.deepseek = deep.present
    ? { ok: true, status: 'ok', detail: `key found @ ${shortPath(deep.file) || '~/.dsh/.credentials.yaml'}`, next: '' }
    : { ok: false, status: 'missing', detail: `no ${deep.name || 'DEEPSEEK_API_KEY'} @ ${shortPath(deep.file) || '~/.dsh/.credentials.yaml'}`, next: 'Open DSH so it writes the key' };

  // Match the provider's lookup order, including OPENROUTER_API_KEY in the
  // DSH credentials file; otherwise Settings can incorrectly say that no key
  // exists while the OpenRouter card is already using one.
  const orKey = resolveKey({ ...settings, openrouterApiKey: decryptOpenRouterKey() });
  creds.openrouter = orKey
    ? { ok: true, status: 'ok', detail: 'sk-or-' + orKey.slice(-4), next: '' }
    : { ok: false, status: 'missing', detail: 'no sk-or- key', next: 'Create one at openrouter.ai/keys, paste above' };

  const desktopClaude = claudeProvider.readDesktopUsage();
  const cf = path.join(home, '.claude', '.credentials.json');
  if (desktopClaude) {
    creds.claude = { ok: true, status: 'ok', detail: `Claude Desktop cache · ${shortPath(desktopClaude.file)}`, next: '' };
  } else if (!fs.existsSync(cf)) {
    creds.claude = { ok: false, status: 'missing', detail: 'no Claude Desktop usage or Claude Code login', next: 'Open Claude Desktop or sign in with Claude Code' };
  } else {
    let expired = null;
    try {
      const j = JSON.parse(fs.readFileSync(cf, 'utf8'));
      const ms = Number(j.claudeAiOauth && j.claudeAiOauth.expiresAt);
      if (ms) expired = ms <= Date.now();
    } catch { /* ignore */ }
    creds.claude = expired
      ? { ok: false, status: 'expired', detail: 'token expired', next: 'Run "claude" once to refresh login' }
      : { ok: true, status: 'ok', detail: `token present @ ${shortPath(cf)}`, next: '' };
  }

  const cx = path.join(home, '.codex', 'auth.json');
  if (!fs.existsSync(cx)) {
    creds.codex = { ok: false, status: 'missing', detail: 'no ~/.codex/auth.json', next: 'Run "codex login" once' };
  } else {
    let expired = false;
    try {
      const j = JSON.parse(fs.readFileSync(cx, 'utf8'));
      const claims = jwtClaims(j.tokens && j.tokens.access_token);
      expired = !!(claims && claims.exp && claims.exp <= Date.now() / 1000);
    } catch { /* ignore */ }
    creds.codex = expired
      ? { ok: false, status: 'expired', detail: 'token expired', next: 'Run "codex login" once' }
      : { ok: true, status: 'ok', detail: `token present @ ${shortPath(cx)}`, next: '' };
  }

  creds.antigravity = { ok: null, status: 'unknown', detail: 'Windows Credential Manager (gemini:antigravity)', next: 'Open Antigravity once if the ring is empty' };

  // Live provider status that the settings provider-rows surface.
  const liveProviders = lastPayload && lastPayload.providers
    ? lastPayload.providers.map((p) => ({ id: p.id, name: p.name, glyph: p.glyph, state: p.state, headline: p.headline, badge: p.badge, level: p.level }))
    : [];

  // Reflect the *actual* Windows login-item state (may be blocked by policy).
  let login = { requested: !!settings.launchAtLogin };
  try {
    const li = app.getLoginItemSettings({ path: process.execPath });
    login.actual = !!(li && li.openAtLogin);
    login.blocked = login.requested && !login.actual;
  } catch {
    login.actual = null;
    login.blocked = false;
  }

  return { creds, providers: liveProviders, login };
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
  // Allowlist: only https to hosts this app actually links to.
  const ALLOWED = ['openrouter.ai', 'github.com', 'githubusercontent.com'];
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) return;
  try {
    const host = new URL(url).hostname;
    if (ALLOWED.some((h) => host === h || host.endsWith('.' + h))) shell.openExternal(url);
  } catch {
    /* malformed URL */
  }
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
    migrateLegacyUserData();
    settingsFile = settingsPath();
    reloadSettings();
    app.setName(APP_NAME);
    notchPos = settings.notchPos || null;
    dbg('ready: creating window');

    // Seed the last-ok cache so a cold start (e.g. no network yet) still shows
    // the most recent reading instead of a blank notch.
    for (const [id, snap] of Object.entries(loadLastState())) providerCache.set(id, snap);

    createNotchWindow();
    ensureTrayIcon();
    tray = new Tray(ensureTrayIcon());
    tray.setToolTip(APP_NAME);
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

    // Screenshot regression route: CODENOTCH_SHOT=1 saves collapsed pill and
    // expanded card under screenshots/ (pill.png, card.png).
    const shotDir = path.join(__dirname, '..', 'screenshots');
    if (process.env.CODENOTCH_SHOT) {
      const pillImg = await win.webContents.capturePage();
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(path.join(shotDir, 'pill.png'), pillImg.toPNG());
    }

    debugHoldCard = true;
    setMode('card');
    await sleep(500);
    info.expanded = await win.webContents.executeJavaScript(`(() => ({
      className: document.getElementById('notch').className,
      fullOpacity: getComputedStyle(document.getElementById('full')).opacity,
    }))()`);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'notch.png'), img.toPNG());
    if (process.env.CODENOTCH_SHOT) {
      fs.writeFileSync(path.join(shotDir, 'card.png'), img.toPNG());
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(info, null, 2));
    console.log('[debug] report written');
    setTimeout(() => quitApp(), 400);
  } catch (err) {
    console.error('[debug] failed', err);
    setTimeout(() => quitApp(), 400);
  }
}

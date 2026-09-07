'use strict';

/**
 * Claude (Claude Code). Reads the OAuth token Claude Code keeps in
 * ~/.claude/.credentials.json and calls the same usage endpoint Claude Code's
 * own /usage uses. Claude Code refreshes the token when it runs; this app only
 * borrows it (mirrors the macOS original, which read the keychain).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpJson, parseIso, levelForFraction } = require('./helpers');

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CRED_FILE = () => path.join(os.homedir(), '.claude', '.credentials.json');

const KIND_LABELS = {
  session: 'Current session',
  weekly_all: 'All models',
  weekly_opus: 'Opus',
  weekly_sonnet: 'Sonnet',
};

function fmtReset(resetsAtMs) {
  if (!resetsAtMs) return '';
  const d = new Date(resetsAtMs);
  const now = Date.now();
  const days = Math.floor((resetsAtMs - now) / 86400000);
  return d.toLocaleString([], {
    weekday: days >= 1 ? 'short' : undefined,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function readCredentials() {
  const file = CRED_FILE();
  if (!fs.existsSync(file)) return { present: false, reason: `No ~/.claude/.credentials.json — run \`claude\` to sign in` };
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { present: false, reason: '~/.claude/.credentials.json is not readable JSON' };
  }
  const oauth = payload && payload.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    return { present: false, reason: 'No claudeAiOauth.accessToken in ~/.claude/.credentials.json' };
  }
  return {
    present: true,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken || null,
    expiresAt: Number(oauth.expiresAt) || 0,
    plan: oauth.subscriptionType || null,
    file,
  };
}

// Best-effort Claude Code OAuth refresh (the app is allowed to refresh the
// user's *own* token here, per explicit request). If it fails we fall back to
// the expired/needsAuth state — never breaking the read.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

let credMtime = 0;
let refreshDead = false; // set after invalid_grant; reset when the credential file changes

function shouldTryRefresh() {
  let m = 0;
  try {
    m = fs.statSync(CRED_FILE()).mtimeMs;
  } catch {
    /* no file */
  }
  if (m !== credMtime) {
    credMtime = m;
    refreshDead = false; // user re-logged in → new refresh token expected
  }
  return !refreshDead;
}
function markRefreshDead() {
  refreshDead = true;
}

function writeRefreshedToken(t) {
  const file = CRED_FILE();
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!p.claudeAiOauth) return;
    p.claudeAiOauth.accessToken = t.accessToken;
    p.claudeAiOauth.expiresAt = t.expiresAt;
    if (t.refreshToken) p.claudeAiOauth.refreshToken = t.refreshToken;
    fs.writeFileSync(file, JSON.stringify(p, null, 2));
  } catch (err) {
    console.warn('[claude] write refreshed token failed:', err && err.message);
  }
}

async function tryRefresh(cred, signal) {
  if (!cred.refreshToken) return null;
  try {
    const res = await httpJson(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: cred.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal,
    });
    const d = res.json;
    if (res.status === 200 && d && d.access_token) {
      const expiresAt = Date.now() + (Number(d.expires_in) || 8 * 3600) * 1000;
      const next = {
        accessToken: d.access_token,
        refreshToken: d.refresh_token || cred.refreshToken,
        expiresAt,
        plan: cred.plan || null,
      };
      writeRefreshedToken({ ...next, refreshToken: next.refreshToken });
      console.log('[claude] OAuth token refreshed for', next.expiresAt);
      return next;
    }
    console.warn('[claude] refresh failed status', res.status);
    if (res.status === 400) markRefreshDead();
  } catch (err) {
    console.warn('[claude] refresh error:', err && err.message);
  }
  return null;
}

function base(plan) {
  return {
    id: 'claude',
    name: 'Claude',
    glyph: 'Cl',
    kind: 'usage',
    fidelity: 'official',
    fraction: null,
    plan,
  };
}

function levelFor(frac) {
  return levelForFraction(frac);
}

function labelForKind(kind) {
  return KIND_LABELS[kind] || (kind || '').replace(/weekly_/g, '').replace(/_/g, ' ') || kind;
}

async function fetchSnapshot(_settings, signal) {
  const cred = readCredentials();
  const b = base(cred.plan);
  if (!cred.present) {
    return {
      ...b,
      state: 'needsAuth',
      headline: '\u2014',
      badge: 'AUTH',
      rows: [{ k: 'Fix', v: 'Run \u201cclaude\u201d once to sign in & refresh the token' }],
      message: cred.reason,
      hint: 'Run \u201cclaude\u201d once \u2014 it refreshes the token this reads',
    };
  }
  let activeCred = cred;
  if (cred.expiresAt && cred.expiresAt <= Date.now()) {
    // Best-effort refresh before declaring expired; only show expired if it
    // actually fails. Skip after an invalid_grant until the file changes.
    const refreshed = shouldTryRefresh() ? await tryRefresh(cred, signal) : null;
    if (refreshed) {
      activeCred = refreshed;
      b.plan = refreshed.plan || b.plan;
    } else {
      const d = new Date(cred.expiresAt);
      return {
        ...b,
        state: 'expired',
        headline: '\u2014',
        badge: 'EXPIRED',
        rows: [
          { k: 'Token expired', v: d.toLocaleDateString([], { month: 'short', day: 'numeric' }) },
          { k: 'Fix', v: 'Run \u201cclaude\u201d once to refresh login' },
        ],
        message: `Claude token expired ${d.toLocaleDateString()} \u2014 refresh failed`,
        hint: 'Run \u201cclaude\u201d once',
      };
    }
  }

  let res;
  try {
    res = await httpJson(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${activeCred.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal,
    });
  } catch (err) {
    return { ...b, state: 'error', headline: '\u2014', badge: 'ERR', rows: [{ k: 'Fetch failed', v: String((err && err.message) || err) }], message: `Couldn\u2019t read Claude usage \u2014 ${String((err && err.message) || err)}` };
  }
  if (res.status === 401 || res.status === 403) {
    // Token rejected mid-flight: try one refresh, then give up honestly.
    const refreshed = shouldTryRefresh() ? await tryRefresh(activeCred, signal) : null;
    if (refreshed) return fetchSnapshot(_settings, signal);
    return { ...b, state: 'needsAuth', headline: '\u2014', badge: 'AUTH', rows: [{ k: 'Sign in', v: 'Run \u201cclaude\u201d to refresh login' }], message: 'Claude rejected the token \u2014 run \u201cclaude\u201d to refresh login', hint: 'Run \u201cclaude\u201d once' };
  }
  if (res.status === 429) {
    return { ...b, state: 'error', headline: '\u2014', badge: 'RATE', rows: [{ k: 'Rate limited', v: 'HTTP 429' }], message: 'Claude rate limited (HTTP 429)' };
  }
  if (!res.ok && res.status !== 200) {
    return { ...b, state: 'error', headline: '\u2014', badge: 'ERR', rows: [{ k: 'Fetch failed', v: `HTTP ${res.status}` }], message: `Claude usage endpoint failed (HTTP ${res.status})` };
  }
  const body = res.json || {};
  const windows = [];

  const push = (id, label, usedFraction, resetsAtMs) => {
    if (windows.some((w) => w.id === id)) return;
    windows.push({ id, label, usedFraction, resetsAtMs });
  };
  for (const limit of body.limits || []) {
    const resets = parseIso(limit.resets_at);
    if (resets == null) continue;
    push(limit.kind, labelForKind(limit.kind), Number(limit.percent) / 100, resets);
  }
  const mergeNamed = (win, id, label) => {
    if (!win) return;
    const resets = parseIso(win.resets_at);
    if (resets == null) return;
    push(id, label, Number(win.utilization) / 100, resets);
  };
  mergeNamed(body.five_hour, 'session', 'Current session');
  mergeNamed(body.seven_day, 'weekly_all', 'All models');

  if (!windows.length) {
    return { ...b, state: 'error', headline: '\u2014', badge: 'EMPTY', rows: [{ k: 'No windows', v: 'response had no usage limits' }], message: 'Claude returned no usage windows' };
  }
  windows.sort((x, y) => {
    const rk = (w) => (w.id === 'session' ? 0 : w.id === 'weekly_all' ? 1 : 2);
    return rk(x) - rk(y) || x.id.localeCompare(y.id);
  });
  const headline = windows.reduce((a, b) => (b.usedFraction > a.usedFraction ? b : a), windows[0]);
  const frac = headline.usedFraction;
  const level = levelFor(frac);
  const rows = windows.map((w) => {
    const when = w.resetsAtMs ? ` \u00b7 resets ${fmtReset(w.resetsAtMs)}` : '';
    return { k: w.label, v: `${Math.round(w.usedFraction * 100)}% used${when}` };
  });
  return {
    ...b,
    state: 'ok',
    headline: `${Math.round(frac * 100)}%`,
    headlineRaw: frac,
    fraction: frac,
    level,
    badge: level === 'crit' ? 'CRIT' : level === 'low' ? 'LOW' : 'OK',
    caption: 'USED',
    rows,
    windows: windows.map((w) => ({
      label: w.label,
      usedFraction: w.usedFraction,
      kind: 'used',
      resetsAtMs: w.resetsAtMs || null,
    })),
    plan: cred.plan || undefined,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { fetchSnapshot, id: 'claude', name: 'Claude', glyph: 'Cl', fmtReset };

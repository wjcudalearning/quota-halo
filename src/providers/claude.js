'use strict';

/**
 * Claude usage. Prefer Claude Code's OAuth usage endpoint and fall back to the
 * official Claude Desktop usage cache when the CLI credential is absent or
 * expired. The Desktop fallback avoids reaching into its encrypted session.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpJson, parseIso, levelForFraction } = require('./helpers');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const usageBaseUrl = () => String(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const ENDPOINT = () => `${usageBaseUrl()}/api/oauth/usage`;
const CRED_FILE = () => process.env.CLAUDE_CREDENTIALS_PATH || process.env.CLAUDE_CREDENTIALS || path.join(os.homedir(), '.claude', '.credentials.json');
const CLI_USER_AGENT = 'claude-cli (Quota Halo for Windows)';
const DESKTOP_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

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

function epochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Claude Code currently writes milliseconds, but accepting seconds keeps
  // this reader compatible with older credentials and test fixtures.
  return n < 100000000000 ? n * 1000 : n;
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
    expiresAt: epochMs(oauth.expiresAt),
    refreshTokenExpiresAt: epochMs(oauth.refreshTokenExpiresAt),
    plan: oauth.subscriptionType || null,
    file,
  };
}

// Best-effort Claude Code OAuth refresh (the app is allowed to refresh the
// user's *own* token here, per explicit request). If it fails we fall back to
// the expired/needsAuth state — never breaking the read.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

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
    // Anthropic does not consistently return a refresh-token lifetime. Never
    // retain an old, already-expired lifetime after a successful exchange.
    if (t.refreshTokenExpiresAt) p.claudeAiOauth.refreshTokenExpiresAt = t.refreshTokenExpiresAt;
    else delete p.claudeAiOauth.refreshTokenExpiresAt;
    fs.writeFileSync(file, JSON.stringify(p, null, 2));
  } catch (err) {
    console.warn('[claude] write refreshed token failed:', err && err.message);
  }
}

async function tryRefresh(cred, signal) {
  if (!cred.refreshToken) return null;
  if (cred.refreshTokenExpiresAt && cred.refreshTokenExpiresAt <= Date.now()) {
    markRefreshDead();
    return null;
  }
  try {
    const res = await httpJson(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': CLI_USER_AGENT,
      },
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
        refreshTokenExpiresAt: Number(d.refresh_token_expires_in) > 0
          ? Date.now() + Number(d.refresh_token_expires_in) * 1000
          : 0,
        plan: cred.plan || null,
      };
      writeRefreshedToken({ ...next, refreshToken: next.refreshToken });
      console.log('[claude] OAuth token refreshed for', next.expiresAt);
      return next;
    }
    console.warn('[claude] refresh failed status', res.status);
    if (res.status === 400 || res.status === 401) markRefreshDead();
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

function desktopUsagePaths() {
  if (process.env.CLAUDE_DESKTOP_USAGE_PATH) return [process.env.CLAUDE_DESKTOP_USAGE_PATH];
  const out = [];
  const roaming = process.env.APPDATA;
  const local = process.env.LOCALAPPDATA;
  if (roaming) out.push(path.join(roaming, 'Claude', 'plan-usage-history.json'));
  if (local) {
    out.push(path.join(local, 'Claude', 'plan-usage-history.json'));
    const packages = path.join(local, 'Packages');
    try {
      for (const name of fs.readdirSync(packages)) {
        if (/^Claude_/i.test(name)) {
          out.push(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'plan-usage-history.json'));
        }
      }
    } catch {
      /* Microsoft Store packages folder may not be readable */
    }
  }
  return [...new Set(out)];
}

function parseDesktopUsageHistory(payload, now = Date.now(), maxAgeMs = DESKTOP_CACHE_MAX_AGE_MS) {
  const samples = payload && Array.isArray(payload.samples) ? payload.samples : [];
  const latest = samples
    .filter((sample) => Number.isFinite(Number(sample && sample.t)) && sample && sample.u)
    .sort((a, b) => Number(b.t) - Number(a.t))[0];
  if (!latest) return null;
  const updatedAtMs = Number(latest.t);
  const ageMs = Math.max(0, now - updatedAtMs);
  if (updatedAtMs > now + 5 * 60 * 1000 || ageMs > maxAgeMs) return null;
  const windows = [];
  const add = (id, label, value) => {
    const percent = Number(value);
    if (!Number.isFinite(percent)) return;
    windows.push({ id, label, usedFraction: Math.max(0, Math.min(1, percent / 100)), resetsAtMs: null });
  };
  add('session', 'Current session', latest.u.fh);
  add('weekly_all', 'All models', latest.u.sd);
  if (!windows.length) return null;
  return { updatedAtMs, ageMs, plan: latest.plan || null, windows };
}

function readDesktopUsage(now = Date.now()) {
  let newest = null;
  for (const file of desktopUsagePaths()) {
    try {
      const parsed = parseDesktopUsageHistory(JSON.parse(fs.readFileSync(file, 'utf8')), now);
      if (parsed && (!newest || parsed.updatedAtMs > newest.updatedAtMs)) newest = { ...parsed, file };
    } catch {
      /* missing, locked, or incomplete cache; try the next known location */
    }
  }
  return newest;
}

function currentSessionRemaining(windows) {
  const session = windows.find((w) => w.id === 'session') || windows[0];
  const used = Number(session && session.usedFraction);
  return Number.isFinite(used) ? Math.max(0, Math.min(1, 1 - used)) : null;
}

function finishSnapshot(b, windows, options = {}) {
  windows.sort((x, y) => {
    const rk = (w) => (w.id === 'session' ? 0 : w.id === 'weekly_all' ? 1 : 2);
    return rk(x) - rk(y) || x.id.localeCompare(y.id);
  });
  const headline = windows.reduce((a, w) => (w.usedFraction > a.usedFraction ? w : a), windows[0]);
  const frac = headline.usedFraction;
  const remaining = currentSessionRemaining(windows);
  const level = levelFor(frac);
  const rows = windows.map((w) => {
    const when = w.resetsAtMs ? ` \u00b7 resets ${fmtReset(w.resetsAtMs)}` : '';
    return { k: w.label, v: `${Math.round(w.usedFraction * 100)}% used${when}` };
  });
  if (options.source) rows.push({ k: 'Source', v: options.source });
  return {
    ...b,
    fidelity: options.fidelity || b.fidelity,
    state: 'ok',
    // The compact Claude ring answers the most useful question at a glance:
    // how much of the current session is left. The arc, level and detail bars
    // remain usage-based so a depleted session still renders as critical.
    headline: remaining == null ? '\u2014' : `${Math.round(remaining * 100)}%`,
    headlineRaw: remaining,
    fraction: frac,
    level,
    badge: level === 'crit' ? 'CRIT' : level === 'low' ? 'LOW' : 'OK',
    caption: 'LEFT',
    rows,
    windows: windows.map((w) => ({
      label: w.label,
      usedFraction: w.usedFraction,
      kind: 'used',
      resetsAtMs: w.resetsAtMs || null,
    })),
    updatedAt: new Date(options.updatedAtMs || Date.now()).toISOString(),
  };
}

function desktopFallback(plan, otherwise) {
  const usage = readDesktopUsage();
  if (!usage) return otherwise;
  return finishSnapshot(base(plan || usage.plan), usage.windows, {
    fidelity: 'cached',
    source: 'Claude Desktop cache',
    updatedAtMs: usage.updatedAtMs,
  });
}

async function fetchSnapshot(_settings, signal) {
  const cred = readCredentials();
  const b = base(cred.plan);
  if (!cred.present) {
    return desktopFallback(cred.plan, {
      ...b,
      state: 'needsAuth',
      headline: '\u2014',
      badge: 'AUTH',
      rows: [{ k: 'Fix', v: 'Run \u201cclaude\u201d once to sign in & refresh the token' }],
      message: cred.reason,
      hint: 'Run \u201cclaude\u201d once \u2014 it refreshes the token this reads',
    });
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
      return desktopFallback(cred.plan, {
        ...b,
        state: 'expired',
        headline: '\u2014',
        badge: 'EXPIRED',
        rows: [
          { k: 'Token expired', v: d.toLocaleDateString([], { month: 'short', day: 'numeric' }) },
          { k: 'Fix', v: cred.refreshTokenExpiresAt && cred.refreshTokenExpiresAt <= Date.now() ? 'Sign in to Claude Code again (claude login)' : 'Run \u201cclaude\u201d once to refresh login' },
        ],
        message: cred.refreshTokenExpiresAt && cred.refreshTokenExpiresAt <= Date.now()
          ? `Claude login expired ${d.toLocaleDateString()} \u2014 sign in to Claude Code again`
          : `Claude token expired ${d.toLocaleDateString()} \u2014 refresh failed`,
        hint: cred.refreshTokenExpiresAt && cred.refreshTokenExpiresAt <= Date.now() ? 'Sign in to Claude Code again' : 'Run \u201cclaude\u201d once',
      });
    }
  }

  let res;
  try {
    res = await httpJson(ENDPOINT(), {
      headers: {
        Authorization: `Bearer ${activeCred.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': CLI_USER_AGENT,
      },
      signal,
    });
  } catch (err) {
    return desktopFallback(cred.plan, { ...b, state: 'error', headline: '\u2014', badge: 'ERR', rows: [{ k: 'Fetch failed', v: String((err && err.message) || err) }], message: `Couldn\u2019t read Claude usage \u2014 ${String((err && err.message) || err)}` });
  }
  if (res.status === 401 || res.status === 403) {
    // Token rejected mid-flight: try one refresh, then give up honestly.
    const refreshed = shouldTryRefresh() ? await tryRefresh(activeCred, signal) : null;
    if (refreshed) return fetchSnapshot(_settings, signal);
    return desktopFallback(cred.plan, { ...b, state: 'needsAuth', headline: '\u2014', badge: 'AUTH', rows: [{ k: 'Sign in', v: 'Run \u201cclaude\u201d to refresh login' }], message: 'Claude rejected the token \u2014 run \u201cclaude\u201d to refresh login', hint: 'Run \u201cclaude\u201d once' });
  }
  if (res.status === 429) {
    return desktopFallback(cred.plan, { ...b, state: 'error', headline: '\u2014', badge: 'RATE', rows: [{ k: 'Rate limited', v: 'HTTP 429' }], message: 'Claude rate limited (HTTP 429)' });
  }
  if (!res.ok && res.status !== 200) {
    return desktopFallback(cred.plan, { ...b, state: 'error', headline: '\u2014', badge: 'ERR', rows: [{ k: 'Fetch failed', v: `HTTP ${res.status}` }], message: `Claude usage endpoint failed (HTTP ${res.status})` });
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
    return desktopFallback(cred.plan, { ...b, state: 'error', headline: '\u2014', badge: 'EMPTY', rows: [{ k: 'No windows', v: 'response had no usage limits' }], message: 'Claude returned no usage windows' });
  }
  return finishSnapshot({ ...b, plan: cred.plan || undefined }, windows);
}

module.exports = {
  fetchSnapshot,
  id: 'claude',
  name: 'Claude',
  glyph: 'Cl',
  fmtReset,
  epochMs,
  parseDesktopUsageHistory,
  readDesktopUsage,
  desktopUsagePaths,
  currentSessionRemaining,
  usageEndpoint: ENDPOINT,
  OAUTH_TOKEN_URL,
};

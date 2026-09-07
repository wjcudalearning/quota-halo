'use strict';

/**
 * Codex (ChatGPT / OpenAI). Borrows the Codex CLI session in
 * ~/.codex/auth.json and reads the same wham/usage endpoint Codex uses.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpJson, jwtClaims } = require('./helpers');

const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const AUTH_FILE = () => path.join(os.homedir(), '.codex', 'auth.json');

function windowLabel(windowSeconds, fallback) {
  if (!windowSeconds || windowSeconds <= 0) return fallback === 'primary' ? 'Current session' : 'Longer window';
  const minutes = windowSeconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m limit`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h limit`;
  const days = Math.round(minutes / (60 * 24));
  if (days === 7) return 'Weekly limit';
  if (days === 30) return 'Monthly limit';
  return `${days}d limit`;
}

function readCredentials() {
  const file = AUTH_FILE();
  if (!fs.existsSync(file)) return { present: false, reason: '~/.codex/auth.json not found — sign in to Codex once' };
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { present: false, reason: '~/.codex/auth.json unreadable' };
  }
  const tokens = auth && auth.tokens;
  if (!tokens || !tokens.access_token || !tokens.account_id) {
    return { present: false, reason: 'No tokens.access_token/account_id in ~/.codex/auth.json' };
  }
  return { present: true, accessToken: tokens.access_token, accountId: tokens.account_id, file };
}

function levelFor(frac) {
  if (frac == null) return 'ok';
  if (frac >= 0.95) return 'crit';
  if (frac >= 0.8) return 'low';
  return 'ok';
}

function fmtReset(resetAtSeconds, now) {
  if (!resetAtSeconds) return '';
  const d = new Date(resetAtSeconds * 1000);
  const days = Math.floor(((resetAtSeconds * 1000) - now) / 86400000);
  return d.toLocaleString([], { weekday: days >= 1 ? 'short' : undefined, hour: '2-digit', minute: '2-digit' });
}

async function fetchSnapshot(_settings, signal) {
  const cred = readCredentials();
  const b = { id: 'codex', name: 'Codex', glyph: 'Cx', kind: 'usage', fidelity: 'official', fraction: null };
  if (!cred.present) {
    return { ...b, state: 'needsAuth', headline: '\u2014', badge: 'AUTH', rows: [{ k: 'Fix', v: 'Sign in to Codex once (~/.codex/auth.json)' }], message: cred.reason, hint: 'Sign in to Codex (codex login) once' };
  }
  // Local expiry hint from the JWT; server validates anyway.
  const claims = jwtClaims(cred.accessToken);
  if (claims && claims.exp && claims.exp <= Date.now() / 1000) {
    return { ...b, state: 'expired', headline: '\u2014', badge: 'EXPIRED', rows: [{ k: 'Fix', v: 'Run \u201ccodex login\u201d to refresh' }], message: 'Codex token expired — run \u201ccodex login\u201d to refresh (app only borrows it)' };
  }

  let res;
  try {
    res = await httpJson(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'ChatGPT-Account-Id': cred.accountId,
        'Cache-Control': 'no-cache, no-store',
      },
      signal,
    });
  } catch (err) {
    return { ...b, state: 'error', headline: '\u2014', badge: 'ERR', rows: [{ k: 'Fetch failed', v: String((err && err.message) || err) }], message: `Couldn\u2019t read Codex usage \u2014 ${String((err && err.message) || err)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...b, state: 'needsAuth', headline: '\u2014', badge: 'AUTH', rows: [{ k: 'Sign in', v: 'Run \u201ccodex login\u201d' }], message: 'Codex rejected the token — run \u201ccodex login\u201d', hint: 'Run \u201ccodex login\u201d once' };
  }
  if (res.status === 429) {
    return { ...b, state: 'error', headline: '\u2014', badge: 'RATE', rows: [{ k: 'Rate limited', v: 'HTTP 429' }], message: 'Codex rate limited (HTTP 429)' };
  }
  if (!res.ok && res.status !== 200) {
    return { ...b, state: 'error', headline: '\u2014', badge: 'ERR', rows: [{ k: 'Fetch failed', v: `HTTP ${res.status}` }], message: `Codex usage endpoint failed (HTTP ${res.status})` };
  }
  const body = res.json || {};
  const rl = body.rate_limit || {};
  const now = Date.now();
  const windows = [];
  for (const [id, win] of [['primary', rl.primary_window], ['secondary', rl.secondary_window]]) {
    if (!win || win.used_percent == null) continue;
    const resets = win.reset_at != null
      ? Number(win.reset_at) * 1000
      : win.reset_after_seconds != null ? now + Number(win.reset_after_seconds) * 1000 : null;
    // Codex's wham `used_percent` is the *remaining* percent on these accounts
    // (a 100%-used 5h window reports 0). The notch shows used, so invert.
    const remaining = Number(win.used_percent);
    const usedFraction = Math.max(0, Math.min(1, (100 - remaining) / 100));
    windows.push({
      id,
      label: windowLabel(win.limit_window_seconds, id),
      usedFraction,
      resetsAtMs: resets,
    });
  }
  if (!windows.length) {
    return { ...b, state: 'error', headline: '\u2014', badge: 'EMPTY', rows: [{ k: 'No windows', v: 'no usage reported' }], message: 'Codex reported no usage windows' };
  }
  // Headline = the most-constrained window (highest used), not a fixed index.
  const headline = windows.reduce((a, b) => (b.usedFraction > a.usedFraction ? b : a), windows[0]);
  const frac = headline.usedFraction;
  const level = levelFor(frac);
  const rows = windows.map((w) => ({
    k: w.label,
    v: `${Math.round(w.usedFraction * 100)}% used${w.resetsAtMs ? ` \u00b7 resets ${fmtReset(w.resetsAtMs / 1000, now)}` : ''}`,
  }));
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
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { fetchSnapshot, id: 'codex', name: 'Codex', glyph: 'Cx' };

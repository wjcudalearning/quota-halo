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
const { httpJson, parseIso } = require('./helpers');

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
    expiresAt: Number(oauth.expiresAt) || 0,
    plan: oauth.subscriptionType || null,
    file,
  };
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
  if (frac == null) return 'ok';
  if (frac >= 0.95) return 'crit';
  if (frac >= 0.8) return 'low';
  return 'ok';
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
  if (cred.expiresAt && cred.expiresAt <= Date.now()) {
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
      message: `Claude token expired ${d.toLocaleDateString()} \u2014 run \u201cclaude\u201d to refresh (the app never mints tokens)`,
      hint: 'Run \u201cclaude\u201d once',
    };
  }

  let res;
  try {
    res = await httpJson(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal,
    });
  } catch (err) {
    return { ...b, state: 'error', headline: '\u2014', badge: 'ERR', rows: [{ k: 'Fetch failed', v: String((err && err.message) || err) }], message: `Couldn\u2019t read Claude usage \u2014 ${String((err && err.message) || err)}` };
  }
  if (res.status === 401 || res.status === 403) {
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
  const headline = windows.find((w) => w.id === 'session') || windows[0];
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
    plan: cred.plan || undefined,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { fetchSnapshot, id: 'claude', name: 'Claude', glyph: 'Cl' };

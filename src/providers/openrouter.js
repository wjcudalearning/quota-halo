'use strict';

/**
 * OpenRouter — prepaid credit account. Two endpoints, both read:
 *   GET https://openrouter.ai/api/v1/auth/key   (account + free-tier + per-key limit)
 *   GET https://openrouter.ai/api/v1/credits     (total_credits vs total_usage)
 *
 * The live responses differ from the documented shape, so parsing is defensive:
 *   - credits → { "data": { "total_credits": 40, "total_usage": 20.63 } }
 *     or the legacy { "credits": { total, used, limit } }.
 *   - auth/key → { "data": { label, is_free_tier, limit, usage, limit_remaining } }.
 *
 * Key sources (first match wins): pasted in Settings → env OPENROUTER_API_KEY →
 * OPENROUTER_API_KEY inside the DSH credentials file.
 */

const { httpJson } = require('./helpers');
const credentials = require('../credentials');

const AUTH_KEY_URL = 'https://openrouter.ai/api/v1/auth/key';
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(n) {
  const v = num(n);
  if (v == null) return '$0.00';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function resolveKey(settings) {
  if (settings && settings.openrouterApiKey && String(settings.openrouterApiKey).startsWith('sk-or-')) {
    return settings.openrouterApiKey;
  }
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const cred = credentials.readApiKey({ ...settings, keyName: 'OPENROUTER_API_KEY' });
  if (cred.present) return cred.key;
  return null;
}

function base() {
  return { id: 'openrouter', name: 'OpenRouter', glyph: 'OR', kind: 'money', fidelity: 'official', fraction: null, caption: 'USD' };
}

function levelFor(remaining) {
  if (remaining == null) return 'ok';
  if (remaining <= 1) return 'crit';
  if (remaining < 5) return 'low';
  return 'ok';
}

function moneyResult(b, { total, used, limit, remaining, free, label }) {
  if (free) {
    return {
      ...b,
      state: 'ok',
      headline: 'free',
      headlineRaw: null,
      level: 'ok',
      badge: 'FREE',
      rows: [
        { k: 'Free tier', v: 'no credit limit' },
        ...(label ? [{ k: 'Account', v: label }] : []),
      ],
      message: 'Free tier — no purchased credits are metered',
      updatedAt: new Date().toISOString(),
    };
  }
  const rem = num(remaining);
  if (rem == null) {
    return errResult('no remaining figure in the response');
  }
  const level = levelFor(rem);
  const rows = [];
  if (label) rows.push({ k: 'Account', v: label });
  if (num(total) != null) rows.push({ k: 'Budget', v: money(total) });
  if (num(used) != null) rows.push({ k: 'Used', v: money(used) });
  rows.push({ k: 'Remaining', v: money(rem) });
  return {
    ...b,
    state: 'ok',
    headline: money(rem),
    headlineRaw: rem,
    level,
    badge: level === 'crit' ? 'CRIT' : level === 'low' ? 'LOW' : 'OK',
    rows,
    updatedAt: new Date().toISOString(),
  };
}

function parseCredits(json) {
  const c = json && (json.credits || json.data);
  if (!c) return null;
  const total = num(c.total_credits != null ? c.total_credits : c.total);
  const used = num(c.total_usage != null ? c.total_usage : c.used);
  const limit = num(c.limit);
  const free = c.is_free_tier === true;
  let remaining = null;
  if (limit != null && used != null) {
    remaining = Math.max(0, limit - used);
  } else if (total != null && used != null) {
    remaining = Math.max(0, total - used);
  }
  return { total, used, limit, free, remaining };
}

function parseAuthKey(json) {
  const d = json && json.data;
  if (!d) return null;
  const remaining = num(d.limit_remaining != null ? d.limit_remaining : null);
  const limit = num(d.limit);
  const usage = num(d.usage);
  const free = d.is_free_tier === true;
  return {
    label: d.label || null,
    free,
    limit,
    usage,
    remaining: remaining != null ? remaining : limit != null && usage != null ? Math.max(0, limit - usage) : null,
  };
}

function errResult(detail) {
  return { ...base(), state: 'error', headline: '\u2014', badge: 'ERR', rows: [{ k: 'Fetch failed', v: detail }], message: `Couldn\u2019t read OpenRouter credits \u2014 ${detail}` };
}

async function fetchSnapshot(settings) {
  const b = base();
  const key = resolveKey(settings);
  if (!key) {
    return {
      ...b,
      state: 'needsAuth',
      headline: '\u2014',
      badge: 'AUTH',
      rows: [
        { k: 'No OpenRouter key yet', v: '' },
        { k: 'Fix', v: 'Create one at openrouter.ai/keys, paste in Settings' },
      ],
      message: 'No OpenRouter API key found — create one at openrouter.ai/keys and paste it in Settings (or set OPENROUTER_API_KEY)',
      hint: 'Settings → OpenRouter key',
    };
  }

  // 1) account info (label, free tier, per-key limit) — informational.
  let account = null;
  try {
    const a = await httpJson(AUTH_KEY_URL, { headers: { Authorization: `Bearer ${key}` } });
    if (a.status === 401 || a.status === 403) {
      return { ...b, state: 'needsAuth', headline: '\u2014', badge: 'AUTH', rows: [{ k: 'Key rejected', v: `HTTP ${a.status}` }], message: `OpenRouter rejected the key (HTTP ${a.status})`, hint: 'Check the key in Settings' };
    }
    if (a.status === 200) account = parseAuthKey(a.json);
  } catch {
    /* fall through to credits */
  }
  if (account && account.free) {
    return moneyResult(b, { free: true, label: account.label });
  }

  // 2) credits — the money figure.
  try {
    const c = await httpJson(CREDITS_URL, { headers: { Authorization: `Bearer ${key}` } });
    if (c.status === 401 || c.status === 403) {
      return { ...b, state: 'needsAuth', headline: '\u2014', badge: 'AUTH', rows: [{ k: 'Key rejected', v: `HTTP ${c.status}` }], message: `OpenRouter rejected the key (HTTP ${c.status})`, hint: 'Check the key in Settings' };
    }
    if (c.status === 200) {
      const credits = parseCredits(c.json);
      if (credits) return moneyResult(b, { ...credits, label: account ? account.label : null });
    }
  } catch (err) {
    return errResult(String((err && err.message) || err));
  }

  // 3) no shape we understand.
  return errResult('unrecognized response');
}

module.exports = { fetchSnapshot, id: 'openrouter', name: 'OpenRouter', glyph: 'OR', resolveKey };

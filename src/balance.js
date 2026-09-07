'use strict';

/**
 * Reads the DeepSeek account balance behind DSH.
 *
 * The harness routes agent traffic to DeepSeek's official API
 * (provider `deepseek-official`, key DEEPSEEK_API_KEY), so the same key is
 * good for GET https://api.deepseek.com/user/balance — the same account the
 * harness is actually spending from.
 */

const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';
const TIMEOUT_MS = 15000;

const CURRENCY_SYMBOLS = { USD: '$', CNY: '\u00a5', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5' };

function symbolFor(currency) {
  return CURRENCY_SYMBOLS[(currency || '').toUpperCase()] || (currency ? `${currency} ` : '');
}

function formatMoney(value, currency) {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${symbolFor(currency)}—`;
  return `${symbolFor(currency)}${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function normalizeBalanceInfo(info) {
  return {
    currency: info.currency || 'USD',
    total: Number(info.total_balance || 0),
    granted: Number(info.granted_balance || 0),
    toppedUp: Number(info.topped_up_balance || 0),
  };
}

/**
 * Pick the entry the notch headlines: USD when present (the user funds in USD
 * and asks about USD), otherwise the first currency, otherwise null.
 */
function pickHeadline(balances) {
  if (!balances.length) return null;
  return balances.find((b) => b.currency === 'USD') || balances[0];
}

async function fetchBalance(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BALANCE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'Codenotch-Windows/0.1 (DSH balance notch)',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { kind: 'needsAuth', detail: `HTTP ${res.status} — key rejected` };
    }
    if (res.status === 429) {
      return { kind: 'rateLimited', detail: 'HTTP 429 — slow down' };
    }
    if (!res.ok) {
      return { kind: 'error', detail: `HTTP ${res.status}` };
    }
    const body = await res.json();
    if (!body || !Array.isArray(body.balance_infos)) {
      return { kind: 'error', detail: 'Unrecognized response' };
    }
    const balances = body.balance_infos.map(normalizeBalanceInfo);
    return { kind: 'ok', isAvailable: body.is_available !== false, balances };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    return {
      kind: 'error',
      detail: aborted ? 'timed out' : String(err && err.message ? err.message : err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Compose the snapshot the renderer draws. */
async function snapshot(key, state) {
  const at = new Date();
  const result = await fetchBalance(key);
  if (result.kind === 'needsAuth') {
    return { state: 'needsAuth', fetchedAt: at.toISOString() };
  }
  if (result.kind === 'error' || result.kind === 'rateLimited') {
    // Keep the last good reading visible; mark it stale.
    return {
      state: 'stale',
      detail: result.detail,
      fetchedAt: at.toISOString(),
      ...(state && state.balance ? { balance: state.balance, balances: state.balances } : {}),
    };
  }
  const headline = pickHeadline(result.balances);
  return {
    state: 'ok',
    isAvailable: result.isAvailable,
    balances: result.balances,
    balance: headline,
    headlineText: headline ? formatMoney(headline.total, headline.currency) : '—',
    fetchedAt: at.toISOString(),
  };
}

module.exports = { snapshot, formatMoney, symbolFor, BALANCE_ENDPOINT };

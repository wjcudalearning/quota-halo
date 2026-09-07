'use strict';

/**
 * DeepSeek — the DSH harness backend. Balance in USD from the official API,
 * reading the key DSH itself holds in ~/.dsh/.credentials.yaml.
 */

const { httpJson, levelForMoney } = require('./helpers');
const credentials = require('../credentials');

const ENDPOINT = 'https://api.deepseek.com/user/balance';
const SYMBOLS = { USD: '$', CNY: '\u00a5', EUR: '\u20ac', GBP: '\u00a3' };

function money(n, currency) {
  const v = Number(n);
  if (!Number.isFinite(v)) return `${SYMBOLS[currency] || ''}\u2014`;
  const sym = SYMBOLS[currency] || (currency ? `${currency} ` : '');
  return `${sym}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function levelFor(total) {
  return levelForMoney(total);
}

async function fetchSnapshot(settings, signal) {
  const cred = credentials.readApiKey(settings);
  if (!cred.present) {
    const reason =
      cred.reason === 'no-credentials-file'
        ? `Credentials file not found: ${cred.file || ''}`
        : `Key "${cred.name}" not present in ${cred.file || 'credentials file'}`;
    return {
      id: 'deepseek',
      name: 'DeepSeek',
      glyph: 'D',
      kind: 'money',
      state: 'needsAuth',
      fidelity: 'official',
      headline: '\u2014',
      fraction: null,
      badge: 'AUTH',
      caption: 'USD',
      rows: [
        { k: 'Harness backend', v: 'DeepSeek official API' },
        { k: 'Fix', v: reason },
      ],
      message: reason,
      hint: 'Open DSH once so ~/.dsh/.credentials.yaml has DEEPSEEK_API_KEY',
    };
  }

  let res;
  try {
    res = await httpJson(ENDPOINT, {
      headers: { Authorization: `Bearer ${cred.key}` },
      signal,
    });
  } catch (err) {
    return errResult(String((err && err.message) || err));
  }

  if (res.status === 401 || res.status === 403) {
    return {
      id: 'deepseek', name: 'DeepSeek', glyph: 'D', kind: 'money',
      state: 'needsAuth', fidelity: 'official', headline: '\u2014', fraction: null,
      badge: 'AUTH', caption: 'USD',
      rows: [{ k: 'Key rejected', v: `HTTP ${res.status}` }, { k: 'Fix', v: 'Renew DEEPSEEK_API_KEY in ~/.dsh/.credentials.yaml' }],
      message: `DeepSeek rejected the key (HTTP ${res.status})`,
    };
  }
  if (res.status === 429) {
    return errResult('rate limited (HTTP 429)');
  }
  if (!res.ok && res.status !== 200) return errResult(`HTTP ${res.status}`);
  const body = res.json;
  if (!body || !Array.isArray(body.balance_infos) || !body.balance_infos.length) {
    return errResult('unrecognized response');
  }

  const infos = body.balance_infos.map((b) => ({
    currency: b.currency || 'USD',
    total: Number(b.total_balance || 0),
    granted: Number(b.granted_balance || 0),
    toppedUp: Number(b.topped_up_balance || 0),
  }));
  const headline = infos.find((b) => b.currency === 'USD') || infos[0];
  const level = body.is_available === false ? 'crit' : levelFor(headline.total);
  const rows = [
    { k: 'Available now', v: body.is_available === false ? 'No' : 'Yes' },
    { k: 'Topped up', v: money(headline.toppedUp, headline.currency) },
    { k: 'Granted (free)', v: money(headline.granted, headline.currency) },
  ];
  for (const b of infos) {
    if (b.currency !== headline.currency) {
      rows.push({ k: `Total (${b.currency})`, v: money(b.total, b.currency) });
    }
  }
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    glyph: 'D',
    kind: 'money',
    state: 'ok',
    fidelity: 'official',
    headline: money(headline.total, headline.currency),
    headlineRaw: headline.total,
    fraction: null,
    level,
    badge: body.is_available === false ? 'UNAVAIL' : level === 'crit' ? 'CRIT' : level === 'low' ? 'LOW' : 'OK',
    caption: headline.currency,
    rows,
    updatedAt: new Date().toISOString(),
  };
}

function errResult(detail) {
  return {
    id: 'deepseek', name: 'DeepSeek', glyph: 'D', kind: 'money',
    state: 'error', fidelity: 'official', headline: '\u2014', fraction: null,
    badge: 'ERR', caption: 'USD',
    rows: [{ k: 'Fetch failed', v: detail }],
    message: `Couldn\u2019t read balance \u2014 ${detail}`,
  };
}

module.exports = { fetchSnapshot, id: 'deepseek', name: 'DeepSeek', glyph: 'D', money, levelFor };

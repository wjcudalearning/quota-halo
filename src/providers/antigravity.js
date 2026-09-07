'use strict';

/**
 * Antigravity (Google). Three honest answers, in the macOS original's order:
 *   1. Google's own quota endpoint — licensed accounts only (personal
 *      "consumer" accounts get 403, so this is usually skipped).
 *   2. Otherwise a local, derived count of model requests today from
 *      Antigravity's own transcripts (~/.gemini/antigravity/brain).
 *
 * Credential: Windows Credential Manager generic credential
 * `gemini:antigravity` (Go keyring), raw JSON {token:{access_token,expiry},…}.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpJson, parseIso, readCredentialManager, httpsJsonSelfSigned, runPowerShell, levelForRemaining, levelForFraction } = require('./helpers');

const LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const CRED_TARGET = 'gemini:antigravity';
const TRANSCRIPT_ROOT = () => path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

const QUOTA_SERVICE = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const CSRF_HEADER = 'x-codeium-csrf-token';

let cachedToken = null; // { accessToken, expiresAtMs }
let cachedBridge = null; // { ports: [..], csrfToken }

async function readToken() {
  if (cachedToken && cachedToken.expiresAtMs && cachedToken.expiresAtMs > Date.now() + 60 * 1000) {
    return cachedToken;
  }
  const raw = await readCredentialManager(CRED_TARGET);
  if (!raw) return null;
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Windows wincred stores the raw payload; mac stored a base64 marker.
    if (raw.startsWith('go-keyring-base64:')) {
      try {
        payload = JSON.parse(Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8'));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  const token = payload && payload.token;
  if (!token || !token.access_token) return null;
  const expiryMs = parseIso(token.expiry) || 0;
  cachedToken = { accessToken: token.access_token, expiresAtMs: expiryMs, authMethod: payload.auth_method };
  return cachedToken;
}

/** Find the Antigravity language server: its csrf token is on the command
    line and its ports are chosen at runtime (--https_server_port 0). */
async function discoverBridge() {
  if (cachedBridge) return cachedBridge;
  const out = await runPowerShell(
    `$p = Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" | Where-Object { $_.CommandLine -match '--csrf_token' } | Select-Object -First 1; if ($p) { $t=[regex]::Match($p.CommandLine,'--csrf_token ([^ ]+)').Groups[1].Value; $ports=(Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue).LocalPort; $s = "$($p.ProcessId)|$t|$($ports -join ',')"; Write-Output $s }`
  );
  if (!out) return null;
  const parts = out.split('|');
  if (parts.length < 3 || !parts[2]) return null;
  const ports = parts[2].split(',').map(Number).filter(Boolean);
  if (!ports.length) return null;
  const csrfToken = parts[1];
  if (!csrfToken) return null;
  cachedBridge = { ports, csrfToken };
  return cachedBridge;
}

function clearBridge() {
  cachedBridge = null;
}

/** The server reports what is *left*, not spent — invert to used, like the
    macOS original did in the view's place. */
function bridgeWindows(bridge) {
  return (async () => {
    let lastError = null;
    for (const port of bridge.ports) {
      const res = await httpsJsonSelfSigned(`https://127.0.0.1:${port}${QUOTA_SERVICE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: bridge.csrfToken },
        body: '{}',
        timeoutMs: 8000,
      });
      if (res.status === 200 && res.json && res.json.response && Array.isArray(res.json.response.groups)) {
        const groups = res.json.response.groups;
        const out = [];
        for (const g of groups) {
          for (const b of g.buckets || []) {
            const remaining = Number(b.remainingFraction);
            if (!(remaining >= 0 && remaining <= 1)) continue;
            out.push({
              id: b.bucketId || g.displayName || 'quota',
              group: g.displayName || '',
              label: (g.displayName ? `${g.displayName} · ` : '') + (b.displayName || 'Usage'),
              usedFraction: 1 - remaining,
              remainingFraction: remaining,
              resetsAtMs: parseIso(b.resetTime) || null,
            });
          }
        }
        if (out.length) {
          // The user cares about Gemini models (the "Gemini Models" group):
          // prefer those windows; only fall back to other groups when the
          // Gemini group is absent.
          const gemini = out.filter((w) => /gemini/i.test(w.group) || /gemini/i.test(w.id));
          return gemini.length ? gemini : out;
        }
      } else {
        lastError = res.status || (res.error && 'connect') || 0;
      }
    }
    throw new Error(`language server RPC failed (${lastError || 'no ports answered'})`);
  })();
}

function fmtExpiry(expiresAtMs) {
  if (!expiresAtMs) return '';
  return new Date(expiresAtMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Count MODEL steps in each trajectory transcript (same layout as macOS).
    Per-file mtime cache so unchanged transcripts aren't re-read every poll. */
const transcriptCache = new Map();
function countRequestsToday() {
  const root = TRANSCRIPT_ROOT();
  let today = 0;
  let last = null;
  const startOfLocalDay = new Date();
  startOfLocalDay.setHours(0, 0, 0, 0);
  const dayStarts = startOfLocalDay.getTime();
  if (!fs.existsSync(root)) return { today, last };
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { today, last };
  }
  for (const d of dirs) {
    const file = path.join(root, d.name, '.system_generated', 'logs', 'transcript.jsonl');
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      transcriptCache.delete(file);
      continue;
    }
    const cached = transcriptCache.get(file);
    if (cached && cached.mtime === mtime && cached.dayStarts === dayStarts) {
      today += cached.today;
      if (cached.last != null && (last == null || cached.last > last)) last = cached.last;
      continue;
    }
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let t = 0;
    let l = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }
      if (step.source !== 'MODEL') continue;
      const at = parseIso(step.created_at);
      if (at == null) continue;
      if (l == null || at > l) l = at;
      if (at >= dayStarts) t += 1;
    }
    transcriptCache.set(file, { mtime, today: t, last: l, dayStarts });
    today += t;
    if (l != null && (last == null || l > last)) last = l;
  }
  return { today, last };
}

async function fetchSnapshot(_settings, signal) {
  const b = { id: 'antigravity', name: 'Antigravity', glyph: 'Ag', kind: 'usage', fidelity: 'derived', fraction: null };

  // 1. Antigravity's own language server first: it holds the client identity
  //    Google insists on, and answers with the exact figures the app's own
  //    Models & Usage panel shows (weekly + 5h remaining; we invert to used).
  try {
    const bridge = await discoverBridge();
    if (bridge) {
      const windows = await bridgeWindows(bridge);
      // bridgeWindows returned after first answer; if it threw, catch below.
      if (windows.length) {
        // The notch shows what the app's own Models & Usage panel leads with:
        // REMAINING, not spent. Headline = the most-constrained window (the
        // one with the least remaining), not a fixed index.
        const headline = windows.reduce((a, b) => (
          (typeof b.remainingFraction === 'number' ? b.remainingFraction : 1 - b.usedFraction) <
          (typeof a.remainingFraction === 'number' ? a.remainingFraction : 1 - a.usedFraction) ? b : a
        ), windows[0]);
        const rem = typeof headline.remainingFraction === 'number' ? headline.remainingFraction : 1 - headline.usedFraction;
        return {
          ...b,
          state: 'ok',
          fidelity: 'official',
          headline: `${Math.round(rem * 100)}%`,
          headlineRaw: rem,
          fraction: rem,
          level: levelForRemaining(rem),
          badge: rem <= 0.05 ? 'LOW' : rem <= 0.2 ? 'WATCH' : 'OK',
          caption: 'LEFT',
          rows: windows.map((w) => {
            const r = typeof w.remainingFraction === 'number' ? w.remainingFraction : 1 - w.usedFraction;
            return {
              k: w.label,
              v: `${Math.round(r * 100)}% left${w.resetsAtMs ? ` \u00b7 resets ${new Date(w.resetsAtMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}`,
            };
          }),
          windows: windows.map((w) => ({
            label: w.label,
            usedFraction: typeof w.remainingFraction === 'number' ? w.remainingFraction : 1 - w.usedFraction,
            kind: 'left',
            resetsAtMs: w.resetsAtMs || null,
          })),
          updatedAt: new Date().toISOString(),
        };
      }
    }
  } catch {
    clearBridge();
    /* fall through to cloudcode / count */
  }

  const token = await readToken();
  if (!token) {
    return { ...b, state: 'needsAuth', headline: '\u2014', badge: 'AUTH', rows: [{ k: 'Fix', v: 'Sign in to Antigravity (Windows Credential Manager: gemini:antigravity)' }], message: 'No Antigravity credential in Windows Credential Manager — sign in to Antigravity once', hint: 'Sign in to Antigravity' };
  }
  if (token.expiresAtMs && token.expiresAtMs <= Date.now()) {
    return { ...b, state: 'expired', headline: '\u2014', badge: 'EXPIRED', rows: [{ k: 'Token expired', v: fmtExpiry(token.expiresAtMs) }, { k: 'Fix', v: 'Open Antigravity to refresh login' }], message: `Antigravity token expired ${fmtExpiry(token.expiresAtMs)} — open Antigravity to refresh it` };
  }
  if (token.authMethod) b.plan = token.authMethod === 'consumer' ? 'Personal' : token.authMethod;

  // 2. Tier (tells us which plan; harmless for personal accounts).
  let tier = null;
  try {
    const t = await httpJson(LOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}` },
      body: JSON.stringify({ metadata: { pluginType: 'GEMINI' } }),
      signal,
    });
    if (t.status === 200 && t.json) {
      tier = (t.json.currentTier && t.json.currentTier.name) ||
        (t.json.allowedTiers && t.json.allowedTiers.find((x) => x.isDefault) && t.json.allowedTiers.find((x) => x.isDefault).name) ||
        (t.json.allowedTiers && t.json.allowedTiers[0] && t.json.allowedTiers[0].name) || null;
    }
  } catch {
    /* tier unknown is fine */
  }

  // 3. Google's quota — usually 403 for personal accounts.
  let windows = [];
  try {
    const q = await httpJson(QUOTA_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}` },
      body: '{}',
      signal,
    });
    if (q.status === 200 && q.json) {
      const groups = (q.json.quotaGroups || []).concat(q.json.groups || []);
      const buckets = (q.json.buckets || []).concat(groups.flatMap((g) => g.buckets || []));
      for (const bucket of buckets) {
        const limit = Number(bucket.limit);
        const used = Number(bucket.used);
        if (!(limit > 0) || !(used >= 0) || used > limit * 1.5) continue;
        windows.push({
          id: bucket.name || bucket.bucketId || bucket.displayName || 'quota',
          label: bucket.displayName || bucket.name || 'Usage',
          usedFraction: used / limit,
          resetsAtMs: parseIso(bucket.resetTime) || parseIso(bucket.reset_time) || null,
        });
      }
    }
  } catch {
    /* fall through to count */
  }

  if (windows.length) {
    const frac = windows[0].usedFraction;
    return {
      ...b,
      state: 'ok',
      fidelity: 'official',
      headline: `${Math.round(frac * 100)}%`,
      headlineRaw: frac,
      fraction: frac,
      level: levelForFraction(frac),
      badge: 'OK',
      caption: 'USED',
      rows: windows.map((w) => ({ k: w.label, v: `${Math.round(w.usedFraction * 100)}% used` })),
      windows: windows.map((w) => ({ label: w.label, usedFraction: w.usedFraction, kind: 'used', resetsAtMs: w.resetsAtMs || null })),
      tier,
      updatedAt: new Date().toISOString(),
    };
  }

  // 4. Derived local count — no published limit, so a count, never a percent.
  const { today, last } = countRequestsToday();
  return {
    ...b,
    state: 'ok',
    headline: today === 0 ? '0' : `~${today}`,
    headlineRaw: today,
    fraction: null,
    level: today > 0 ? 'ok' : 'ok',
    badge: today > 0 ? 'TODAY' : 'IDLE',
    caption: today === 1 ? 'request today' : 'requests today',
    rows: [
      { k: 'Requests today', v: String(today) },
      { k: 'No limit published', v: 'Google won\u2019t say for this account' },
    ],
    tier,
    derived: true,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { fetchSnapshot, id: 'antigravity', name: 'Antigravity', glyph: 'Ag', discoverBridge, bridgeWindows };

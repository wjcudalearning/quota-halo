'use strict';

/** Shared helpers for provider modules. */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const home = () => os.homedir();

function expand(p) {
  if (!p) return p;
  if (p === '~') return home();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home(), p.slice(2));
  return p;
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

/** Try JSON.parse on a utf8 string; return null on failure. */
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** ISO8601 with optional fractional seconds and offset -> epoch ms, or null. */
function parseIso(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Decode a JWT payload (base64url) to an object, or null. */
function jwtClaims(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (payload.length % 4) payload += '=';
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Timeout-aware fetch returning { status, body(text), headers } or throwing {kind}.
    Accepts an external AbortSignal so a caller can cancel an in-flight request. */
async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 15000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signals = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body,
      signal: signals,
    });
    const text = await res.text();
    return { status: res.status, body: text, headers: res.headers };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    throw new Error(aborted ? 'cancelled' : String((err && err.message) || err));
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: GET or POST json, returns {status, json|null, raw}. */
async function httpJson(url, opts = {}) {
  const res = await http(url, opts);
  const json = tryParse(res.body);
  return { status: res.status, json, raw: res.body };
}
/** Retry-After header: seconds or http-date -> seconds, or null. */
function retryAfterSeconds(headers) {
  const value = headers && headers.get ? headers.get('retry-after') : null;
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.max(0, (ms - Date.now()) / 1000) : null;
}

/** Read a Windows Credential Manager generic credential blob as UTF-8. */
async function readCredentialManager(target) {
  // Loaded lazily so provider modules stay small.
  const { readCredentialManager: impl } = require('./wincred');
  return impl(target);
}

/** RFC3339 with fractional seconds and offset -> epoch ms (strict enough). */
function parseRfc3339(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** HTTPS JSON to a self-signed (loopback) endpoint with TLS verification off. */
function httpsJsonSelfSigned(url, { method = 'POST', headers = {}, body, timeoutMs = 10000 } = {}) {
  const https = require('https');
  return new Promise((resolve) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const req = https.request(
      url,
      {
        method,
        rejectUnauthorized: false,
        headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* non-json */
          }
          resolve({ status: res.statusCode || 0, json, raw: data });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ status: 0, json: null, raw: '', error: String((err && err.message) || err) }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Run a PowerShell command and return stdout (trimmed), or null on failure. */
async function runPowerShell(command, timeoutMs = 15000) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.replace(/^\uFEFF/, '').trim() : null));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      resolve(null);
    }, timeoutMs);
  });
}

/** Unify the usage-window warning thresholds across providers. */
function levelForFraction(frac) {
  if (frac == null) return 'ok';
  if (frac >= 0.95) return 'crit';
  if (frac >= 0.8) return 'low';
  return 'ok';
}

/** Unify the money-balance thresholds (DeepSeek / OpenRouter). */
function levelForMoney(remaining) {
  if (remaining == null) return 'ok';
  if (remaining <= 1) return 'crit';
  if (remaining < 5) return 'low';
  return 'ok';
}

/** Unify the *remaining* thresholds used when a provider shows LEFT. */
function levelForRemaining(remaining) {
  if (remaining == null) return 'ok';
  if (remaining <= 0.05) return 'crit';
  if (remaining <= 0.2) return 'low';
  return 'ok';
}

module.exports = {
  home,
  expand,
  readJson,
  tryParse,
  parseIso,
  parseRfc3339,
  jwtClaims,
  http,
  httpJson,
  retryAfterSeconds,
  readCredentialManager,
  httpsJsonSelfSigned,
  runPowerShell,
  levelForFraction,
  levelForMoney,
  levelForRemaining,
};

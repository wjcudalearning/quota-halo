'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Credential borrowing, Codenotch style: this app never stores the API key.
 * It reads the key that DSH (the harness) already holds in its credentials
 * file, so there is only ever one account — the one actually being used.
 *
 * Default location mirrors the harness: ${DSH_HOME:-~/.dsh}/.credentials.yaml
 * The key name is configurable; DEEPSEEK_API_KEY is the harness default.
 */

const DEFAULTS = {
  credentialsPath: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml'),
  keyName: 'DEEPSEEK_API_KEY',
};

// Strip an inline YAML comment (` # …`) but respect quoted strings, so a
// value like `sk-abc # note` keeps `sk-abc` while `'a # b'` stays intact.
function stripInlineComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function parseCredentialsYaml(text) {
  const out = {};
  // Very small YAML subset: `key: value` pairs at any indent, plain or quoted,
  // with comment / quoted-value handling. Matches DSH's own .credentials.yaml.
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = stripInlineComment(m[2]).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val && val !== 'null') out[key] = val;
  }
  return out;
}

/** Resolve the configured credentials file path (settings may override). */
function effectiveCredentialsPath(settings) {
  return settings.credentialsPath || DEFAULTS.credentialsPath;
}

function effectiveKeyName(settings) {
  return settings.keyName || DEFAULTS.keyName;
}

/**
 * @returns {{ present: boolean, name: string, file: string }}
 *   present=false → nothing usable was found (needsAuth state).
 */
function readApiKey(settings) {
  const file = effectiveCredentialsPath(settings);
  const name = effectiveKeyName(settings);
  try {
    if (!fs.existsSync(file)) {
      return { present: false, reason: 'no-credentials-file', name, file };
    }
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseCredentialsYaml(text);
    const key = (parsed[name] || '').trim();
    if (!key) {
      return { present: false, reason: 'key-missing', name, file };
    }
    return { present: true, key, name, file };
  } catch (err) {
    return { present: false, reason: 'read-error', detail: String(err && err.message || err), name, file };
  }
}

module.exports = { readApiKey, parseCredentialsYaml, DEFAULTS, effectiveCredentialsPath };

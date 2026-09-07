'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * "Is the harness still working?"
 *
 * DSH appends each completed turn to
 *   ~/.dsh/sessions/<workspace>/<session-id>/session.jsonl.zstd
 * so a session file whose mtime is recent means a model turn is being written
 * right now (generation in flight) or just landed. We watch the newest session
 * file's age — no decompression, just stat.
 */

const SESSION_GLOB = /^session\.jsonl(\.zstd)?$/;
/** A file this fresh means the harness wrote to it in the last moments. */
const ACTIVE_WINDOW_MS = 60 * 1000;
/** Hard cap on how deep to walk (sessions/<ws>/<id>/file). */
const MAX_DEPTH = 4;

function sessionsHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function walkSessions(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) walkSessions(full, depth + 1, out);
    } else if (e.isFile() && SESSION_GLOB.test(e.name)) {
      try {
        out.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
      } catch {
        /* file vanished between readdir and stat — skip */
      }
    }
  }
  return out;
}

/** Newest session file under the sessions tree. */
function newestSession(home) {
  const sessionsDir = path.join(home || sessionsHome(), 'sessions');
  const found = walkSessions(sessionsDir, 0, []);
  if (!found.length) return null;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0];
}

// mtime cache so the 10s poll doesn't recurse the whole sessions tree every
// time. Files are re-stat'ed (cheap) between walks; a full walk only happens
// every WALK_INTERVAL_MS or when the cache is empty / all files vanished.
const WALK_INTERVAL_MS = 30 * 1000;
let fileCache = new Map();
let lastWalk = 0;

function toActivity(top) {
  if (!top) return null;
  const ageMs = Date.now() - top.mtimeMs;
  return {
    active: ageMs <= ACTIVE_WINDOW_MS,
    file: top.file,
    lastActiveSecondsAgo: Math.max(0, Math.round(ageMs / 1000)),
  };
}

/**
 * @returns { null | { active: boolean, file: string|null, lastActiveSecondsAgo: number|null } }
 *   null when there is no sessions tree at all (harness never ran / different home).
 */
function sampleActivity(home) {
  const now = Date.now();
  if (fileCache.size && now - lastWalk < WALK_INTERVAL_MS) {
    // Fast path: re-stat known files (no directory recursion).
    let newest = null;
    for (const [file, mtime] of fileCache) {
      try {
        const m = fs.statSync(file).mtimeMs;
        if (m !== mtime) fileCache.set(file, m);
        if (!newest || m > newest.mtimeMs) newest = { file, mtimeMs: m };
      } catch {
        fileCache.delete(file);
      }
    }
    if (newest) return toActivity(newest);
    // otherwise all cached files vanished → fall through to a full walk
  }
  const found = walkSessions(path.join(home || sessionsHome(), 'sessions'), 0, []);
  fileCache = new Map(found.map((f) => [f.file, f.mtimeMs]));
  lastWalk = now;
  if (!found.length) return null;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return toActivity(found[0]);
}

module.exports = { sampleActivity, sessionsHome };

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

/**
 * @returns { null | { active: boolean, file: string|null, lastActiveSecondsAgo: number|null } }
 *   null when there is no sessions tree at all (harness never ran / different home).
 */
function sampleActivity(home) {
  const top = newestSession(home);
  if (!top) return null;
  const ageMs = Date.now() - top.mtimeMs;
  return {
    active: ageMs <= ACTIVE_WINDOW_MS,
    file: top.file,
    lastActiveSecondsAgo: Math.max(0, Math.round(ageMs / 1000)),
  };
}

module.exports = { sampleActivity, sessionsHome };

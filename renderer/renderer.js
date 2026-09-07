'use strict';

/* Codenotch for Windows — renderer. Renders one ring-cell per provider from
   snapshots pushed by the main process. */

const $ = (id) => document.getElementById(id);

const notch = $('notch');
const mini = $('mini');
const titleName = $('titleName');
const miniArc = $('miniArc');
const miniText = $('miniText');
const miniDots = $('miniDots');
const miniWarn = $('miniWarn');
const dpBanner = $('dpBanner');
const titleSub = $('titleSub');
const cellsEl = $('cells');
const activityDot = $('actDot');
const activityText = $('activityText');
const dpGlyph = $('dpGlyph');
const dpName = $('dpName');
const dpPlan = $('dpPlan');
const dpFid = $('dpFid');
const dpUpd = $('dpUpd');
const dpRows = $('dpRows');
const btnPin = $('btnPin');

const R = { cell: 30, mini: 8.5 };
const CIRC = { cell: 2 * Math.PI * R.cell, mini: 2 * Math.PI * R.mini };

const COLORS = {
  ok: '#00ff88',
  low: '#f2ff00',
  crit: '#ff3f00',
  idle: '#7a828c',
};

const state = {
  payload: null,
  mode: 'pill',
  pinned: false,
  busyReasons: new Set(),
  collapseTimer: null,
  hovered: null,
  cellEls: new Map(), // provider id -> element
};

function pushBusy(r) { state.busyReasons.add(r); syncBusy(); }
function popBusy(r) { state.busyReasons.delete(r); syncBusy(); }
function syncBusy() {
  const busy = state.busyReasons.size > 0;
  notch.classList.toggle('busy', busy);
  mini.classList.toggle('busy', busy);
}

function stateColor(p) {
  if (p.state !== 'ok') {
    if (p.state === 'needsAuth' || p.state === 'expired') return COLORS.crit;
    return COLORS.idle;
  }
  return COLORS[p.level] || COLORS.ok;
}

const BADGE_KEY = {
  OK: 'bOk',
  LOW: 'bLow',
  CRIT: 'bCrit',
  FREE: 'bFree',
  IDLE: 'bIdle',
  TODAY: 'bToday',
  UNAVAIL: 'bUnavail',
  RATE: 'bRate',
  TIMEOUT: 'bTimeout',
};

function badgeLabel(p) {
  const t = (k, vars) => window.I18N.t(k, vars);
  if (p.state !== 'ok') {
    if (p.state === 'expired') return t('bExpired');
    if (p.state === 'needsAuth') return t('bSignIn');
    if (p.state === 'rateLimited') return t('bRate');
    if (p.state === 'error') return p.stale ? t('bStale') : t('bError');
    return p.state.toUpperCase();
  }
  const key = BADGE_KEY[p.badge];
  return key ? t(key) : (p.badge || 'OK');
}

/** Ring arc fraction for this provider; null → no arc (full-dim or none). */
function arcFraction(p) {
  if (p.state !== 'ok') return 0;
  if (p.fraction != null) return Math.max(0, Math.min(1, p.fraction));
  return 1; // money / count: full colored status ring
}

function setArc(circle, c, frac) {
  circle.style.strokeDasharray = frac > 0 ? `${c * frac} ${c}` : `0 ${c}`;
}

function cellText(cell, sel) {
  const n = cell.querySelector(sel);
  return n ? n.textContent.trim() : '';
}

function isOkish(p) {
  return p.state === 'ok';
}

function heroOf(providers) {
  return providers.find(isOkish) || providers[0];
}

/* ------------------------------------------------------------ rendering -- */

function currentPick() {
  const providers = state.payload ? state.payload.providers : [];
  if (state.hovered) {
    const found = providers.find((x) => x.id === state.hovered);
    if (found) return found;
  }
  return heroOf(providers);
}

function ensureCell(p) {
  let cell = state.cellEls.get(p.id);
  if (cell) return cell;
  cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.name = p.name;
  cell.dataset.id = p.id;
  cell.innerHTML = `
    <div class="cell-top">
      <svg class="ring cell-ring" width="64" height="64" viewBox="0 0 64 64">
        <circle class="ring-track" cx="32" cy="32" r="${R.cell}" />
        <circle class="ring-arc" cx="32" cy="32" r="${R.cell}" />
      </svg>
      <span class="cell-glyph"></span>
    </div>
    <div class="cell-headline"></div>
    <div class="cell-badge"></div>
    <div class="cell-name"></div>
    <div class="cell-caption"></div>
  `;
  cell.addEventListener('mouseenter', () => {
    clearTimeout(state.collapseTimer);
    state.hovered = p.id;
    cellsEl.classList.add('has-hover');
    showDetail(currentPick());
  });
  cell.addEventListener('mouseleave', () => {
    state.hovered = null;
    cellsEl.classList.remove('has-hover');
    showDetail(currentPick());
  });
  cell.addEventListener('click', () => {
    const cur = state.payload && state.payload.providers.find((x) => x.id === p.id);
    if (cur && cur.state !== 'ok') window.codenotch.action('settings');
  });
  cellsEl.appendChild(cell);
  state.cellEls.set(p.id, cell);
  return cell;
}

function renderCell(p) {
  const cell = ensureCell(p);
  cell.dataset.state = p.state !== 'ok' ? p.state : (p.level || 'ok');
  const arc = cell.querySelector('.ring-arc');
  const color = stateColor(p);
  const disp = p.stale && p.staleOf ? p.staleOf : p;

  notch.style.setProperty('--ring-color', color);
  setArc(arc, CIRC.cell, arcFraction(disp));

  const glyph = cell.querySelector('.cell-glyph');
  glyph.textContent = disp.glyph || p.id.slice(0, 2);
  glyph.style.color = p.state === 'ok' ? color : '#5a5f66';

  const headline = cell.querySelector('.cell-headline');
  headline.textContent = p.state === 'ok' || p.stale ? disp.headline : '\u2014';
  headline.style.color = p.state === 'ok' || p.stale ? 'var(--text)' : '#5a5f66';
  headline.style.color = p.state !== 'ok' && !p.stale ? '#5a5f66' : headline.style.color;

  const badge = cell.querySelector('.cell-badge');
  badge.textContent = badgeLabel(p);
  badge.style.setProperty('--badge-color', p.state === 'ok' ? color : p.state === 'expired' ? '#ff8a6b' : p.state === 'needsAuth' ? '#ffb29e' : '#8a929c');

  cell.querySelector('.cell-name').textContent = p.name;
  cell.querySelector('.cell-caption').textContent = p.state === 'ok' ? (disp.caption || '') : '';
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtReset(resetsAtMs) {
  if (!resetsAtMs) return '';
  const delta = resetsAtMs - Date.now();
  const d = new Date(resetsAtMs);
  if (delta < 3600000) {
    if (delta <= 0) return window.I18N.t('resettingNow');
    return window.I18N.t('resetsIn', { ago: `${Math.ceil(delta / 60000)}m` });
  }
  return window.I18N.t('resetsAt', { date: d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) });
}

function barColor(p, kind) {
  const frac = p.fraction != null ? p.fraction : null;
  if (kind === 'left') {
    // remaining: low remaining is bad
    const r = p.headlineRaw != null ? p.headlineRaw : null;
    if (r != null && r <= 0.2) return 'var(--orange)';
    if (r != null && r <= 0.5) return 'var(--yellow)';
    return 'var(--green)';
  }
  if (frac == null) return 'var(--green)';
  if (frac >= 0.95) return 'var(--orange)';
  if (frac >= 0.8) return 'var(--yellow)';
  return 'var(--green)';
}

function showDetail(pick) {
  if (!pick) {
    dpRows.textContent = '';
    return;
  }
  const disp = pick.stale && pick.staleOf ? pick.staleOf : pick;
  dpGlyph.textContent = disp.glyph || pick.id.slice(0, 2);
  dpName.textContent = pick.name;
  dpPlan.textContent = (disp.plan && disp.plan !== 'Personal' ? disp.plan : '') || '';
  dpFid.textContent = pick.state !== 'ok'
    ? (pick.stale ? window.I18N.t('bStale') : pick.badge ? window.I18N.t(BADGE_KEY[pick.badge] || 'bError') : pick.state)
    : (disp.fidelity === 'official' ? window.I18N.t('official') : disp.fidelity === 'derived' ? window.I18N.t('derived') : disp.fidelity || '');
  dpUpd.textContent = pick.state !== 'ok'
    ? (pick.stale && pick.staleOf && pick.staleOf.updatedAt ? window.I18N.t('lastGood', { ago: timeAgo(pick.staleOf.updatedAt) }) : pick.message || pick.state)
    : (disp.updatedAt ? window.I18N.t('updatedAgo', { ago: timeAgo(disp.updatedAt) }) : '');
  dpPlan.style.display = dpPlan.textContent ? '' : 'none';
  dpFid.style.setProperty('--ring-color', stateColor(pick));

  dpRows.textContent = '';
  const windows = Array.isArray(disp.windows) ? disp.windows : [];
  if (pick.state === 'ok' && windows.length) {
    for (const w of windows) {
      const f = Math.max(0, Math.min(1, Number(w.usedFraction) || 0));
      const row = document.createElement('div');
      row.className = 'dp-window';
      const label = document.createElement('span');
      label.className = 'w-label';
      label.textContent = w.label;
      const bar = document.createElement('div');
      bar.className = 'w-bar';
      const fill = document.createElement('div');
      fill.className = 'w-fill';
      fill.style.width = `${Math.round(f * 100)}%`;
      fill.style.background = barColor(pick, w.kind);
      bar.appendChild(fill);
      const val = document.createElement('span');
      val.className = 'w-val';
      val.textContent = `${Math.round(f * 100)}%`;
      const reset = document.createElement('span');
      reset.className = 'w-reset';
      reset.textContent = fmtReset(w.resetsAtMs);
      row.append(label, bar, val, reset);
      dpRows.appendChild(row);
    }
  } else {
    // money providers (no notion of windows) or empty/error/needsAuth
    for (const r of (disp.rows || [])) {
      const line = document.createElement('div');
      line.className = 'dp-msg';
      const k = document.createElement('span');
      k.textContent = r.k;
      const v = document.createElement('span');
      v.textContent = r.v ? (r.k ? '：' + r.v : r.v) : '';
      line.append(k, v);
      if (r.cta) {
        line.classList.add('cta');
        line.title = 'Open settings';
        line.addEventListener('click', () => window.codenotch.action('settings'));
      }
      dpRows.appendChild(line);
    }
    if (!(disp.rows || []).length) {
      const msg = document.createElement('div');
      msg.className = 'dp-msg';
      msg.textContent = pick.state !== 'ok' ? (pick.message || pick.state) : window.I18N.t('noReading');
      dpRows.appendChild(msg);
    }
  }
}

function renderTitle(payload) {
  const providers = payload.providers;
  const okN = providers.filter(isOkish).length;
  titleName.textContent = window.I18N.t('titleName');
  const time = new Date(payload.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  titleSub.textContent = providers.length ? window.I18N.t('titleSub', { ok: okN, total: providers.length, time }) : '';
}

function renderMini(providers) {
  const hero = heroOf(providers);
  if (!hero) {
    miniText.textContent = '\u2014';
    return;
  }
  const disp = hero.stale && hero.staleOf ? hero.staleOf : hero;
  const color = stateColor(hero);
  miniText.textContent = hero.state === 'ok' || hero.stale ? `${disp.headline}` : (hero.state === 'needsAuth' ? 'sign in' : 'unavailable');
  notch.style.setProperty('--ring-color', color);
  const frac = hero.state === 'ok' && hero.fraction != null ? hero.fraction : hero.state === 'ok' ? 1 : 0;
  setArc(miniArc, CIRC.mini, frac);

  // dots for the remaining providers
  miniDots.textContent = '';
  const rest = providers.filter((p) => p.id !== hero.id);
  const shown = rest.slice(0, 4);
  for (const p of shown) {
    const d = document.createElement('span');
    d.className = 'dot';
    const c = p.state === 'ok' ? COLORS[p.level] || COLORS.ok : p.state === 'expired' || p.state === 'needsAuth' ? COLORS.crit : '#5a5f66';
    d.style.background = c;
    d.title = `${p.name}: ${p.state === 'ok' ? p.headline : p.state}`;
    miniDots.appendChild(d);
  }
  // Problem summary for the collapsed pill: count of non-ok providers and the
  // most-constraining one's name, plus how long ago the readings updated.
  const problems = providers.filter((p) => p.state !== 'ok');
  if (problems.length) {
    miniWarn.classList.remove('hidden');
    miniWarn.textContent = `\u26a0${problems.length}`;
    miniWarn.title = problems.map((p) => `${p.name}: ${p.state}`).join('\n');
  } else {
    miniWarn.classList.add('hidden');
    miniWarn.textContent = '';
  }
  if (state.payload && state.payload.fetchedAt) {
    mini.title = window.I18N.t('pillUpd', { ago: timeAgo(state.payload.fetchedAt) });
  }
}

function renderActivity(act) {
  const t = (k, v) => window.I18N.t(k, v);
  if (!act) {
    activityText.textContent = t('dshNone');
    activityDot.className = 'dot idle';
    popBusy('activity');
    return;
  }
  if (act.active) {
    activityText.textContent = t('dshWriting');
    activityDot.className = 'dot ok pulse';
    pushBusy('activity');
  } else {
    const ago = act.lastActiveSecondsAgo;
    const agoText = ago < 90 ? `${ago}s` : `${Math.round(ago / 60)}m`;
    activityText.textContent = t('dshLast', { ago: agoText });
    activityDot.className = 'dot ok';
    popBusy('activity');
  }
}

function render(payload) {
  state.payload = payload;
  window.I18N.setLocale(payload.locale || 'zh-TW');
  document.documentElement.dataset.edge = payload.edge || 'top';
  state.pinned = !!payload.pinned;
  btnPin.classList.toggle('on', state.pinned);

  // remove cells no longer present
  const ids = new Set(payload.providers.map((p) => p.id));
  for (const [id, cell] of state.cellEls) {
    if (!ids.has(id)) {
      cell.remove();
      state.cellEls.delete(id);
    }
  }

  for (const p of payload.providers) renderCell(p);

  // Card-level empty state: every provider is unavailable → clear message + open settings.
  const okN = payload.providers.filter(isOkish).length;
  const allFail = payload.providers.length > 0 && okN === 0;
  dpBanner.classList.toggle('hidden', !allFail);
  if (allFail) {
    dpBanner.textContent = window.I18N.t('allFail');
    dpBanner.title = window.I18N.t('openSettings');
    dpBanner.onclick = () => window.codenotch.action('settings');
  } else {
    dpBanner.onclick = null;
  }

  renderMini(payload.providers);
  renderTitle(payload);
  renderActivity(payload.activity);
  showDetail(currentPick());
}

/* --------------------------------------------------------------- modes --- */
function setMode(mode) {
  state.mode = mode;
  notch.classList.toggle('pill-mode', mode === 'pill');
  notch.classList.toggle('card-mode', mode === 'card');
}
function collapseSoon(delay = 420) {
  clearTimeout(state.collapseTimer);
  state.collapseTimer = setTimeout(() => {
    if (!state.pinned) window.codenotch.action('collapse');
  }, delay);
}

/* ------------------------------------------------------------ listeners ---
   Expand/collapse on hover is driven by the main process (which watches the
   real cursor position) — DOM mouse events are suppressed on drag regions and
   unreliable on a transparent always-on-top window. So no hover listeners here;
   only explicit buttons. */
$('btnRefresh').addEventListener('click', () => {
  pushBusy('fetch');
  window.codenotch.action('refresh');
  setTimeout(() => popBusy('fetch'), 1500);
});
$('btnPin').addEventListener('click', () => window.codenotch.action(state.pinned ? 'unpin' : 'pin'));
$('btnSettings').addEventListener('click', () => window.codenotch.action('settings'));

window.codenotch.onSnapshot((p) => {
  popBusy('fetch');
  render(p);
});
window.codenotch.onMode((mode) => {
  if (!state.pinned || mode === 'card') setMode(mode);
});

setMode('pill');
window.codenotch.action('refresh');

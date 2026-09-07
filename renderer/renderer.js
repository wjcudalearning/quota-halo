'use strict';

/* Codenotch for Windows — renderer. Renders one ring-cell per provider from
   snapshots pushed by the main process. */

const $ = (id) => document.getElementById(id);

const notch = $('notch');
const mini = $('mini');
const miniArc = $('miniArc');
const miniText = $('miniText');
const miniDots = $('miniDots');
const titleSub = $('titleSub');
const cellsEl = $('cells');
const activityDot = $('actDot');
const activityText = $('activityText');
const detailText = $('detailText');
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

function badgeLabel(p) {
  if (p.state !== 'ok') {
    return p.state === 'expired' ? 'EXPIRED' : p.state === 'needsAuth' ? 'SIGN IN' : p.state === 'error' ? (p.stale ? 'STALE' : 'ERROR') : p.state.toUpperCase();
  }
  return p.badge || 'OK';
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
    showDetail();
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

function showDetail() {
  const providers = state.payload ? state.payload.providers : [];
  const targetId = state.hovered;
  const p = targetId ? providers.find((x) => x.id === targetId) : null;
  const pick = p || heroOf(providers);
  if (!pick) {
    detailText.textContent = '';
    return;
  }
  const parts = [];
  const disp = pick.stale && pick.staleOf ? pick.staleOf : pick;
  if (disp.plan && disp.plan !== 'Personal') parts.push(disp.plan);
  if (disp.tier) parts.push(disp.tier);
  if (disp.derived) parts.push('~ counted locally');
  if (pick.state !== 'ok') {
    if (pick.stale && pick.staleOf) parts.push(`stale — last good ${timeAgo(pick.staleOf.updatedAt)}`);
    parts.push(pick.message || pick.state);
  } else {
    const rows = (disp.rows || []).slice(0, 3);
    parts.push(...rows.map((r) => `${r.k} ${r.v}`));
  }
  detailText.textContent = parts.join(' \u00b7 ');
}

function renderTitle(payload) {
  const providers = payload.providers;
  const okN = providers.filter(isOkish).length;
  titleSub.textContent = providers.length
    ? `${okN}/${providers.length} readable \u00b7 updated ${new Date(payload.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : '';
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
  if (rest.length > 4) {
    const m = document.createElement('span');
    m.className = 'more';
    m.textContent = `+${rest.length - 4}`;
    miniDots.appendChild(m);
  }
}

function renderActivity(act) {
  if (!act) {
    activityText.textContent = 'DSH sessions not found';
    activityDot.className = 'dot idle';
    popBusy('activity');
    return;
  }
  if (act.active) {
    activityText.textContent = 'DSH writing now\u2026';
    activityDot.className = 'dot ok pulse';
    pushBusy('activity');
  } else {
    const ago = act.lastActiveSecondsAgo;
    activityText.textContent = `last DSH activity ${ago < 90 ? ago + 's ago' : Math.round(ago / 60) + 'm ago'}`;
    activityDot.className = 'dot ok';
    popBusy('activity');
  }
}

function render(payload) {
  state.payload = payload;
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
  renderMini(payload.providers);
  renderTitle(payload);
  renderActivity(payload.activity);
  showDetail();
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

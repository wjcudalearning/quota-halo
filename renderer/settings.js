'use strict';

/* 設定視窗 — 每個變更立即生效。 */

const $ = (id) => document.getElementById(id);

const PROVIDER_META = [
  { id: 'deepseek', name: 'DeepSeek', desc: 'DSH 後端 · 餘額' },
  { id: 'openrouter', name: 'OpenRouter', desc: '預付點數餘額' },
  { id: 'claude', name: 'Claude', desc: 'Claude Code 用量上限' },
  { id: 'codex', name: 'Codex', desc: 'ChatGPT / OpenAI 用量視窗' },
  { id: 'antigravity', name: 'Antigravity', desc: 'Gemini Code Assist · 用量上限' },
];

const el = {
  providerList: $('providerList'),
  orKey: $('inORKey'),
  orKeysBtn: $('btnORKeys'),
  orShow: $('btnORShow'),
  orClear: $('btnORClear'),
  orVerify: $('btnORVerify'),
  orHint: $('orHint'),
  credentials: $('inCredentials'),
  browse: $('btnBrowse'),
  keyName: $('inKeyName'),
  probe: $('probe'),
  segEdge: $('segEdge'),
  inLocale: $('inLocale'),
  inOverlay: $('inOverlay'),
  pinned: $('inPinned'),
  seconds: $('inSeconds'),
  launch: $('inLaunch'),
  test: $('btnTest'),
  reset: $('btnReset'),
  clear: $('btnClear'),
  appVersion: $('appVersion'),
  status: $('status'),
  close: $('btnClose'),
};

let settings = {};
let flashTimer = null;
let orDebounce = null;
function flash(msg) {
  el.status.textContent = msg;
  el.status.className = 'status saved';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.status.textContent = '\u2014';
    el.status.className = 'status';
  }, 2000);
}

async function apply(patch) {
  await window.codenotch.setSettings(patch);
  settings = { ...settings, ...patch };
  showLastFour();
}

function renderProviders() {
  el.providerList.textContent = '';
  const flags = settings.providers || {};
  for (const meta of PROVIDER_META) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    const on = flags[meta.id] !== false;
    const check = document.createElement('label');
    check.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on;
    cb.addEventListener('change', async () => {
      await apply({ providers: { [meta.id]: cb.checked } });
      flash(cb.checked ? `已顯示 ${meta.name}` : `已隱藏 ${meta.name}`);
    });
    const box = document.createElement('span');
    box.className = 'p-name';
    box.textContent = meta.name;
    const desc = document.createElement('span');
    desc.className = 'p-desc';
    desc.textContent = meta.desc;
    check.append(cb, box);
    row.append(check, desc);
    el.providerList.appendChild(row);
  }
}

function lastFour(key) {
  if (!key || !key.startsWith('sk-or-')) return '';
  return '…' + key.slice(-4);
}
function showLastFour() {
  const hint = lastFour(el.orKey.value.trim());
  el.orVerify.textContent = hint ? `驗證連線（${hint}）` : '驗證連線';
}

function validateORKey() {
  const v = el.orKey.value.trim();
  el.orHint.classList.toggle('hidden', !v || v.startsWith('sk-or-'));
  showLastFour();
}

function saveORKey(instant) {
  clearTimeout(orDebounce);
  const doSave = async () => {
    await apply({ openrouterApiKey: el.orKey.value.trim() || '' });
    flash('OpenRouter 金鑰已存到本機設定');
  };
  if (instant) doSave();
  else orDebounce = setTimeout(doSave, 350);
}

async function probe() {
  const res = await window.codenotch.probeCredentials();
  const lines = [];
  const file = (p) => (res[p] && res[p].file ? ` @ ${res[p].file}` : '');
  lines.push(`DeepSeek：${res.deepseek && res.deepseek.found ? '已找到金鑰' : '尚無金鑰'}${file('deepseek')}`);
  lines.push(`OpenRouter：${res.openrouter && res.openrouter.found ? '已設定金鑰' : '沒有金鑰 — 請在上方新增'}`);
  lines.push(`Claude：${res.claude && res.claude.found ? '~/.claude/.credentials.json 存在' : '尚未登入'}`);
  lines.push(`Codex：${res.codex && res.codex.found ? '~/.codex/auth.json 存在' : '尚未登入'}`);
  lines.push('Antigravity：每次輪詢時從 Windows 認證管理員讀取');
  el.probe.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
}

function applyLocale() {
  document.querySelectorAll('[data-i18n]').forEach((n) => {
    n.textContent = window.I18N.t(n.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((n) => {
    n.placeholder = window.I18N.t(n.getAttribute('data-i18n-ph'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((n) => {
    n.title = window.I18N.t(n.getAttribute('data-i18n-title'));
  });
}

async function init() {
  const s = await window.codenotch.getSettings();
  settings = s;
  window.I18N.setLocale(s.locale || 'zh-TW');
  el.inLocale.value = window.I18N.getLocale() === 'en' ? 'en' : 'zh-TW';
  el.inOverlay.value = s.overlayLevel === 'normal' ? 'normal' : 'screen-saver';
  applyLocale();
  el.appVersion.textContent = 'v0.3.0';
  renderProviders();
  el.orKey.value = s.openrouterApiKey || '';
  validateORKey();
  el.credentials.value = s.credentialsPath || '';
  el.credentials.placeholder = '預設：~/.dsh/.credentials.yaml';
  el.keyName.value = s.keyName;
  el.seconds.value = s.refreshSeconds;
  el.pinned.checked = !!s.pinned;
  el.launch.checked = !!s.launchAtLogin;
  syncEdge(s.edge);
  await probe();
}

function syncEdge(edge) {
  for (const b of el.segEdge.querySelectorAll('.seg-btn')) {
    b.classList.toggle('active', b.dataset.edge === edge);
  }
}

el.orKey.addEventListener('input', () => { validateORKey(); saveORKey(false); });
el.orKey.addEventListener('change', () => { validateORKey(); saveORKey(true); });
el.orVerify.addEventListener('click', () => { window.codenotch.action('refresh'); flash('正在驗證 OpenRouter 連線…'); });
el.orKeysBtn.addEventListener('click', () => window.codenotch.openExternal('https://openrouter.ai/keys'));
el.orShow.addEventListener('click', () => {
  const t = el.orKey.type === 'password' ? 'text' : 'password';
  el.orKey.type = t;
  el.orShow.classList.toggle('on', t === 'text');
  el.orShow.title = t === 'text' ? '隱藏金鑰' : '顯示金鑰';
});
el.orClear.addEventListener('click', async () => {
  el.orKey.value = '';
  validateORKey();
  await apply({ openrouterApiKey: '' });
  flash('OpenRouter 金鑰已清除');
});
el.credentials.addEventListener('change', async () => {
  await apply({ credentialsPath: el.credentials.value.trim() });
  flash('憑證路徑已更新');
});
el.browse.addEventListener('click', async () => {
  const picked = await window.codenotch.pickCredentials();
  if (picked) {
    el.credentials.value = picked;
    await apply({ credentialsPath: picked });
    flash('憑證路徑已更新');
  }
});
el.keyName.addEventListener('change', async () => {
  await apply({ keyName: el.keyName.value.trim() || 'DEEPSEEK_API_KEY' });
  flash('金鑰名稱已更新');
});
el.segEdge.addEventListener('click', async (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  await apply({ edge: b.dataset.edge });
  syncEdge(b.dataset.edge);
  flash(`Notch 已移到${b.dataset.edge === 'bottom' ? '下方' : '上方'}邊緣`);
});
el.inLocale.addEventListener('change', async () => {
  const loc = el.inLocale.value;
  window.I18N.setLocale(loc);
  applyLocale();
  await apply({ locale: loc });
  flash(loc === 'en' ? 'Language set to English' : '已切換為繁體中文');
});
el.inOverlay.addEventListener('change', async () => {
  await apply({ overlayLevel: el.inOverlay.value });
  flash(el.inOverlay.value === 'normal' ? '改為一般置頂（不蓋全螢幕）' : '改為最高置頂（會蓋全螢幕）');
});
el.pinned.addEventListener('change', async () => {
  await apply({ pinned: el.pinned.checked });
  flash(el.pinned.checked ? '卡片已釘住展開' : '卡片會隨滑鼠移開收起');
});
el.seconds.addEventListener('change', async () => {
  const v = Math.max(10, Math.min(3600, Number(el.seconds.value) || 60));
  el.seconds.value = v;
  await apply({ refreshSeconds: v });
  flash(`每 ${v} 秒輪詢一次`);
});
el.launch.addEventListener('change', async () => {
  await apply({ launchAtLogin: el.launch.checked });
  flash(el.launch.checked ? '登入時將自動啟動' : '不再於登入時啟動');
});
el.test.addEventListener('click', () => {
  window.codenotch.action('refresh');
  flash('正在重整所有供應商…');
});
el.reset.addEventListener('click', async () => {
  if (!confirm('確認恢復預設值？會將螢幕邊緣、輪詢、釘住、語言等回復預設（不會動憑證）。')) return;
  await window.codenotch.setSettings({ refreshSeconds: 60, edge: 'top', pinned: false, launchAtLogin: false, openrouterApiKey: '' });
  settings = await window.codenotch.getSettings();
  el.orKey.value = ''; validateORKey();
  el.seconds.value = '60'; el.pinned.checked = false; el.launch.checked = false; syncEdge('top');
  flash('已恢復預設值');
});
el.clear.addEventListener('click', async () => {
  if (!confirm('確認清除本機設定與最後讀值快取？此動作無法復原。')) return;
  await window.codenotch.setSettings({ refreshSeconds: 60, edge: 'top', pinned: false, launchAtLogin: false, openrouterApiKey: '', credentialsPath: '', keyName: 'DEEPSEEK_API_KEY', providers: {}, notchPos: null });
  settings = await window.codenotch.getSettings();
  el.orKey.value = ''; validateORKey(); el.credentials.value = ''; el.keyName.value = 'DEEPSEEK_API_KEY';
  el.seconds.value = '60'; el.pinned.checked = false; el.launch.checked = false; syncEdge('top');
  renderProviders();
  flash('已清除本機設定');
});
el.close.addEventListener('click', () => {
  saveORKey(true);
  window.codenotch.action('close-settings');
});

// Esc closes the settings window.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    saveORKey(true);
    window.codenotch.action('close-settings');
  }
});

init();

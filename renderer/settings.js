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
  orHint: $('orHint'),
  credentials: $('inCredentials'),
  browse: $('btnBrowse'),
  keyName: $('inKeyName'),
  probe: $('probe'),
  segEdge: $('segEdge'),
  pinned: $('inPinned'),
  seconds: $('inSeconds'),
  launch: $('inLaunch'),
  test: $('btnTest'),
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

async function init() {
  const s = await window.codenotch.getSettings();
  settings = s;
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

function validateORKey() {
  const v = el.orKey.value.trim();
  el.orHint.classList.toggle('hidden', !v || v.startsWith('sk-or-'));
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

el.orKey.addEventListener('input', () => { validateORKey(); saveORKey(false); });
el.orKey.addEventListener('change', () => { validateORKey(); saveORKey(true); });
el.orKeysBtn.addEventListener('click', () => window.codenotch.openExternal('https://openrouter.ai/keys'));
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
el.close.addEventListener('click', () => {
  saveORKey(true);
  window.codenotch.action('close-settings');
});

init();

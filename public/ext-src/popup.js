// 签到面板 Cookie 助手 - popup.js
// DEFAULT_PANEL_URL 由面板在用户下载时动态注入（替换 __PANEL_URL__ 占位符），
// 扩展首次打开时自动带出，用户仍可手动修改。
const DEFAULT_PANEL_URL = '__PANEL_URL__';
// API Key 不从下载包里注入：由用户在面板「设置」页复制后手动填入，避免 Key 随文件传播、也方便随时更换。
const $ = (id) => document.getElementById(id);
const status = (msg, cls = '') => { const s = $('status'); s.textContent = msg; s.className = cls; };

let cookies = [];
let domain = '';
let pageUrl = '';

// 标题里的版本号从 manifest 读：以前 popup 里写死「2.2」而 manifest 已经是 2.3，
// 面板上显示「扩展在线 · v2.3」、扩展里写 2.2，看着像两个东西。
function fillVersion() {
  try {
    const el = $('title-ver');
    if (el) el.textContent = 'v' + ((chrome.runtime.getManifest() || {}).version || '');
  } catch { /* 忽略 */ }
}

// ---------- 配置读写 ----------
// API Key 属于凭据：存 storage.local（只在本机，不会跟着浏览器账号同步上云）。
// 老版本（≤ 2.3）把它写在 sync：这里读不到本地就回退读一次 sync，并搬过来、删掉云端那份。
function localArea() {
  try {
    const l = chrome.storage && chrome.storage.local;
    if (l && typeof l.get === 'function' && typeof l.set === 'function') return l;
  } catch { /* 忽略 */ }
  return chrome.storage.sync;
}
async function readCfg() {
  let got = {};
  try { got = (await localArea().get(['panelUrl', 'apiKey'])) || {}; } catch { got = {}; }
  if (!got.apiKey) {
    try {
      const s = await chrome.storage.sync.get(['apiKey']);
      if (s && s.apiKey) {
        got.apiKey = s.apiKey;
        try { await localArea().set({ apiKey: s.apiKey }); } catch { /* 忽略 */ }
        try { if (typeof chrome.storage.sync.remove === 'function') await chrome.storage.sync.remove(['apiKey']); } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
  }
  return got;
}
async function writeCfg(obj) {
  try { await localArea().set(obj); } catch { /* 忽略 */ }
}

// 面板地址规范化 + 校验。Cookie / API Key 都要发到这里，
// 公网地址一律要求 https（http 会让凭据明文经过公网）；
// 局域网地址允许 http（家里 NAS 常用 http://192.168.x.x，流量不出内网）。
function normalizePanelUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '';
    return u.origin + path;
  } catch { return ''; }
}
// 局域网主机名：回环、私有 IPv4 段、IPv6 本地地址、.local / 单标签主机名（mDNS、NetBIOS）
function isLanHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (!h.includes('.') || h.endsWith('.local')) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((x) => x > 255)) return false;
    if (n[0] === 10 || n[0] === 127) return true;
    if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
    if (n[0] === 192 && n[1] === 168) return true;
    if (n[0] === 169 && n[1] === 254) return true;
    return false;
  }
  if (h.includes(':')) return h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
  return false;
}
function panelUrlProblem(url) {
  let u;
  try { u = new URL(url); } catch { return '面板地址不是合法网址（示例：https://checkin.example.com）'; }
  if (u.protocol === 'https:') return '';
  if (u.protocol === 'http:' && isLanHost(u.hostname)) return '';
  return '面板地址必须是 https（局域网地址如 http://192.168.x.x:8787 可以用 http）—— 否则 Cookie 和 API Key 会明文经过公网';
}
// 读取输入框里的面板地址并校验；不合格时把提示写进状态栏并返回空串
async function panelUrlFromInput(showErr = status) {
  let url = normalizePanelUrl($('panel-url').value);
  if (!url) { showErr('请先填写签到面板地址（示例：https://checkin.example.com）', 'err'); return ''; }
  const problem = panelUrlProblem(url);
  if (problem) { showErr(problem, 'err'); return ''; }
  await writeCfg({ panelUrl: url });
  return url;
}

// 采集当前标签页的 Cookie，力求“精准而全面”：
// ① 主源 getAll({ url }) —— 与浏览器真正会发给该地址的 Cookie 完全一致
//    （自动考虑 domain 匹配含父域、path、secure、sameSite、是否过期），对任意网站都准。
// ② host-only 兜底 getAll({ domain: hostname })。
// ③ 尝试分区 Cookie（CHIPS），失败则跳过。
// 合并去重（name|domain|path），并按“路径长→域名→名称”排序，尽量贴近浏览器发送顺序。
// 刻意不猜父域（避免把 co.uk / com.cn 这种当成域名，反而混入无关 Cookie）。
async function collectCookies(tab) {
  const bag = new Map();
  const put = (list) => { for (const c of list || []) bag.set(`${c.name}|${c.domain}|${c.path}`, c); };
  let host = '';
  let origin = '';
  try { const u = new URL(tab.url); host = u.hostname; origin = u.origin; } catch { /* 忽略 */ }

  const queries = [];
  if (tab.url) queries.push({ url: tab.url });
  if (host) queries.push({ domain: host });
  if (origin) queries.push({ url: tab.url, partitionKey: { topLevelSite: origin } });

  for (const q of queries) {
    try { put(await chrome.cookies.getAll(q)); } catch { /* 忽略不支持的查询 */ }
  }

  const list = Array.from(bag.values());
  list.sort((a, b) =>
    (b.path || '').length - (a.path || '').length ||
    String(a.domain).localeCompare(String(b.domain)) ||
    String(a.name).localeCompare(String(b.name)));
  return list;
}

// Cookie 概况：Cookie 数 / 域数 / HttpOnly 数 / 会话与持久数 / 最近过期时间
function describeCookies(list) {
  const domains = new Set();
  let httpOnly = 0;
  let session = 0;
  let persistent = 0;
  for (const c of list) {
    domains.add(c.domain || '');
    if (c.httpOnly) httpOnly++;
    if (c.session) session++; else persistent++;
  }
  return { count: list.length, domains: domains.size, httpOnly, session, persistent };
}

async function init() {
  // 读取保存的面板地址和 API Key；没有保存过则用下载时注入的默认地址（面板动态生成 zip 时填入）
  const { panelUrl, apiKey } = await readCfg();
  const hasDefault = typeof DEFAULT_PANEL_URL !== 'undefined' && DEFAULT_PANEL_URL && DEFAULT_PANEL_URL.startsWith('http');
  if (panelUrl) {
    $('panel-url').value = panelUrl;
  } else if (hasDefault) {
    $('panel-url').value = DEFAULT_PANEL_URL;
    // 自动保存默认地址，避免下次为空
    writeCfg({ panelUrl: normalizePanelUrl(DEFAULT_PANEL_URL) || DEFAULT_PANEL_URL });
  }
  if (apiKey) $('api-key').value = apiKey;
  // 恢复录制状态显示（上次打开弹窗时可能正在录制）
  refreshRecState();

  // 获取当前标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith('http')) {
    status('请在目标网站页面使用', 'err');
    return;
  }
  const url = new URL(tab.url);
  domain = url.hostname;
  // pageUrl：当前页面的完整地址。OpenList 式凭据包需要它 —— 某些站点校验
  // Cookie + UA + Referer 三件套，采集时把页面地址一起带上，后续站点需要
  // Referer/Origin 时直接用它拼，不用再猜。
  pageUrl = tab.url;
  $('domain').textContent = '当前网站：' + domain;

  // 获取页面真实的 User-Agent（吾爱等站点要求 UA 与 Cookie 配对）
  let pageUA = '';
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => navigator.userAgent,
    });
    pageUA = result || '';
  } catch { /* 忽略，用默认 */ }

  // 精准而全面地抓取 Cookie（与浏览器实际发送的登录态一致）
  cookies = await collectCookies(tab);
  const stat = describeCookies(cookies);

  // 顺带抓 localStorage（部分站点把 token 放这里，如 akile）
  let localStore = {};
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const o = {};
        try { for (let i = 0; i < localStorage.length && i < 200; i++) { const k = localStorage.key(i); if (k) o[k] = String(localStorage.getItem(k) || '').slice(0, 2000); } } catch { /* 忽略 */ }
        return o;
      },
    });
    localStore = result || {};
  } catch { /* 忽略 */ }

  window._pageUA = pageUA;
  window._localStore = localStore;
  const lsCount = Object.keys(localStore).length;

  // 站点自动识别：页面指纹（detect.js 探针）+ Cookie 名 + localStorage 键 + 域名。
  // 探针失败（如 chrome:// 页面）也不影响，detectSite 照样能用后三种信号判定。
  let detected = null;
  try {
    let fp = null;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectPageFingerprint,
      });
      fp = result || null;
    } catch { /* 探针失败，用其余信号 */ }
    detected = detectSite(fp, cookies.map((c) => c.name), Object.keys(localStore), domain);
  } catch { /* 识别失败就当没识别，不挡发送 */ }
  window._detected = detected;
  const detectEl = $('detect');
  if (detected) {
    const nm = (typeof DETECT_SITE_NAMES !== 'undefined' && DETECT_SITE_NAMES[detected.site]) || detected.site;
    detectEl.className = 'detect';
    detectEl.textContent = '🔍 已识别：' + nm + '（' + detected.reason
      + (detected.confidence === 'high' ? '，发送后自动处理' : '，发送后会推荐预选、由你确认') + '）';
    detectEl.style.display = 'block';
  } else {
    detectEl.className = 'detect unknown';
    detectEl.textContent = '未能自动识别站点，发送后可能需要手动选一次';
    detectEl.style.display = 'block';
  }

  const countEl = $('count');
  if (cookies.length) {
    countEl.textContent = cookies.length + ' 个 Cookie';
    countEl.style.display = 'inline-block';
  } else {
    countEl.style.display = 'none';
  }
  status(
    cookies.length
      ? `已读取 ${cookies.length} 个 Cookie（${stat.domains} 个域 / ${stat.httpOnly} 个 HttpOnly）` + (lsCount ? ` + ${lsCount} 项 localStorage` : '')
      : '该网站没有 Cookie',
    cookies.length ? 'ok' : 'err'
  );
}

function cookieString() {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function payloadObj() {
  return {
    domain,
    pageUrl, // 采集时的完整页面地址（供后续站点拼 Referer/Origin 用）
    userAgent: window._pageUA || '',
    cookies: cookieString(),
    // 附带可读的分解信息，面板据此清晰展示：每个 Cookie 的名称/域/是否 HttpOnly
    cookieList: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || '',
      session: !!c.session,
      expirationDate: c.expirationDate || null,
    })),
    localStorage: window._localStore || {},
    // 站点自动识别结果：{ site, confidence: 'high'|'medium', reason }。
    // 面板收到后：high 直接用（不再让人手动选站点），medium 只做推荐预选。
    detectedSite: window._detected || null,
    stats: describeCookies(cookies),
    ts: Date.now(),
  };
}

function fullPayload() {
  return JSON.stringify(payloadObj());
}

$('btn-copy').onclick = async () => {
  if (!cookies.length) return status('没有可复制的 Cookie', 'err');
  // 复制完整 JSON：面板粘贴后自动解析出域名、UA、Cookie
  await navigator.clipboard.writeText(fullPayload());
  status(`已复制 ${cookies.length} 个 Cookie + UA，去面板「粘贴扩展内容」粘贴即可`, 'ok');
};

$('btn-send').onclick = async () => {
  if (!cookies.length) return status('没有可发送的 Cookie', 'err');
  const panelUrl = await panelUrlFromInput();
  if (!panelUrl) return;
  const apiKey = $('api-key').value.trim();
  const payload = payloadObj();

  // ① 首选「一次性交接码」：先把内容 POST 给面板，面板打开的地址里只带一个 16 位短码。
  //    好处：整包 Cookie / localStorage 不再进入地址栏，也不会写进浏览历史；
  //    短码 5 分钟有效、取一次即作废（面板端 /api/handoff/<code>）。
  if (apiKey) {
    try {
      const resp = await fetch(panelUrl + '/api/external/handoff', {
        credentials: 'omit', // API Key 鉴权，不带面板会话 Cookie
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify(payload),
      });
      if (resp.status === 401) return status('API Key 无效：请去面板「设置」页重新复制一次', 'err');
      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        if (data && data.code) {
          chrome.tabs.create({ url: panelUrl + '#handoff=' + data.code });
          return status('已打开面板，请在面板中确认保存（交接码 5 分钟内有效）', 'ok');
        }
      }
    } catch { /* 面板不可达 / 老面板没有这个接口 → 走下面的回退 */ }
  }

  // ② 回退：老面板（没有交接码接口）或没填 API Key 时，把内容编码进 URL hash。
  //    面板端 #ext-cookies= 分支还在，旧组合照旧能用。
  //    用 base64url 编码（+/= 替换为 -_.），避免特殊字符在地址栏被转义或截断。
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const enc = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  chrome.tabs.create({ url: panelUrl + '#ext-cookies=' + enc });
  status(apiKey ? '面板没有交接接口，已用旧方式打开（凭据随链接传递）' : '未填 API Key，已用旧方式打开（凭据随链接传递）', 'ok');
};

// 输入时不再「每敲一个键就写一次存储」：去抖 400ms，失焦时立刻落盘。
// （以前每敲一下都写盘，Key 输到一半的残值也会被存进去）
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCfgNow, 400);
}
function saveCfgNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeCfg({
    panelUrl: $('panel-url').value.trim().replace(/\/$/, ''),
    apiKey: $('api-key').value.trim(),
  });
}
$('panel-url').oninput = scheduleSave;
$('api-key').oninput = scheduleSave;
$('panel-url').onchange = saveCfgNow;
$('api-key').onchange = saveCfgNow;

fillVersion();

// ---------- 扩展更新检查 ----------
// Chrome 不允许未上架的扩展自己静默更新，所以这里做「检查 + 一键下载」：
// 有新版时显示下载按钮，用户解压覆盖后去 chrome://extensions 点「重新加载」即可。
// 版本号比对：按点分割逐段比数字（"2.9" < "2.10" < "2.11"）。
function cmpVer(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function checkExtUpdate() {
  let localVer = '';
  try { localVer = String((chrome.runtime.getManifest() || {}).version || ''); } catch { /* 忽略 */ }
  const btn = $('btn-update');
  const tip = $('update-tip');
  if (!localVer) return;
  // 面板地址：优先用输入框里已填的，没有就用注入的默认值
  let panelUrl = '';
  try {
    panelUrl = normalizePanelUrl($('panel-url').value);
    if (!panelUrl && typeof DEFAULT_PANEL_URL !== 'undefined' && DEFAULT_PANEL_URL.startsWith('http')) {
      panelUrl = normalizePanelUrl(DEFAULT_PANEL_URL);
    }
  } catch { /* 忽略 */ }
  if (!panelUrl) return; // 没填面板地址就不检查
  let remoteVer = '';
  try {
    const resp = await fetch(panelUrl + '/api/external/ext-version');
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      remoteVer = String((data && data.version) || '');
    }
  } catch { /* 面板不可达就静默跳过 */ }
  if (!remoteVer || cmpVer(remoteVer, localVer) <= 0) return; // 没有新版
  // 有新版：显示更新按钮和提示
  btn.style.display = 'inline-block';
  tip.style.display = 'block';
  tip.innerHTML = '';
  const t1 = document.createElement('div');
  t1.textContent = `发现新版本 v${remoteVer}（当前 v${localVer}）`;
  tip.appendChild(t1);
  const dl = document.createElement('button');
  dl.className = 'dl-btn';
  dl.textContent = '⬇️ 下载新版扩展';
  dl.onclick = () => {
    chrome.tabs.create({ url: panelUrl + '/cookie-helper-extension.zip' });
    const t2 = document.createElement('div');
    t2.style.marginTop = '6px';
    t2.textContent = '下载后解压覆盖原文件夹，再去 chrome://extensions 点「重新加载」即可。';
    // 只追加一次
    if (!tip.querySelector('.done-tip')) {
      t2.className = 'done-tip';
      tip.appendChild(t2);
    }
  };
  tip.appendChild(dl);
  btn.onclick = () => {
    tip.style.display = tip.style.display === 'none' ? 'block' : 'none';
  };
}

checkExtUpdate();

// 打开弹窗时顺手叫醒一次中继（后台常驻长轮询，本来就会自己跑）。
// 以前这里还有个「立即执行待办签到」按钮——它会挂住弹窗、也让用户以为要手动点才干活，已删掉：
// 面板点「执行」时后台会在 1 秒内接到单，不需要在弹窗上再点一次。
// 延到下一个 tick：先把弹窗自己的 UI 初始化完，再去叫醒后台，
// 不抢在主界面之前干活（后台不在时静默忽略，不影响取 Cookie）。
setTimeout(() => {
  try {
    const p = chrome.runtime.sendMessage({ action: 'runRelayNow' });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* 忽略 */ }
}, 0);

// 面板连接检查：验证面板地址和 API Key 是否可用
$('btn-check-conn').onclick = async () => {
  status('正在检查面板连接…', '');
  try {
    const panelUrl = await panelUrlFromInput();
    if (!panelUrl) return; // 提示已经在状态栏里
    const apiKey = $('api-key').value.trim();
    if (!apiKey) return status('请先填写 API Key（面板设置页获取）', 'err');

    // ① 检查面板是否可访问（用专用 ping 接口，不消费任务）
    let resp;
    try {
      resp = await fetch(panelUrl + '/api/external/ping', {
        credentials: 'omit', // API Key 鉴权，不带面板会话 Cookie
        headers: { 'X-Api-Key': apiKey },
      });
    } catch (e) {
      return status('连接失败：面板地址无法访问（' + (e.message || '网络错误') + '）', 'err');
    }
    // ② 检查 API Key 是否有效
    if (resp.status === 401) return status('连接失败：API Key 无效，请去面板设置页重新生成', 'err');
    if (!resp.ok) return status('连接失败：面板返回 HTTP ' + resp.status, 'err');
    // ③ 解析任务列表
    let data;
    try { data = await resp.json(); } catch { return status('连接失败：面板返回数据格式错误', 'err'); }
    status('连接正常 ✅ API Key 有效', 'ok');
  } catch (e) {
    status('检查失败：' + (e.message || e), 'err');
  }
};

// ---------- 签到录制 ----------
// 点「🎬 录制签到请求」→ 后台在当前标签页监听 90 秒 →
// 用户在页面上亲手点一次签到按钮 → 扩展抓到请求、生成草稿、自动打开面板预填。
// popup 关掉也没关系：录制状态在后台，抓到后会自动开面板标签页。
function showRecState(recording, deadline) {
  const note = $('record-note');
  const btn = $('btn-record');
  if (recording) {
    const left = Math.max(0, Math.round(((deadline || 0) - Date.now()) / 1000));
    note.style.display = '';
    note.textContent = `🔴 录制中…去页面上亲手点一次「签到」按钮（剩余约 ${left} 秒）。不想录了可再点一次按钮取消。`;
    btn.textContent = '⏹ 停止录制';
  } else {
    note.style.display = 'none';
    btn.textContent = '🎬 录制签到请求';
  }
}
async function refreshRecState() {
  try {
    const r = await chrome.runtime.sendMessage({ action: 'recState' });
    showRecState(!!(r && r.recording), r && r.deadline);
  } catch { /* 后台没醒：当没在录制 */ }
}
$('btn-record').onclick = async () => {
  let cur = null;
  try { cur = await chrome.runtime.sendMessage({ action: 'recState' }); } catch { /* 忽略 */ }
  if (cur && cur.recording) {
    await chrome.runtime.sendMessage({ action: 'recStop' }).catch(() => {});
    showRecState(false);
    return status('已停止录制', '');
  }
  const panelUrl = await panelUrlFromInput();
  if (!panelUrl) return;
  const apiKey = $('api-key').value.trim();
  if (!apiKey) return status('录制要用交接码发面板，请先填写 API Key（面板设置页获取）', 'err');
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch { /* 忽略 */ }
  if (!tab) return status('读不到当前标签页', 'err');
  let r;
  try {
    r = await chrome.runtime.sendMessage({ action: 'recStart', tabId: tab.id, panelUrl, apiKey });
  } catch (e) {
    return status('录制启动失败：' + (e && e.message ? e.message : '后台无响应'), 'err');
  }
  if (!r || !r.ok) return status('录制启动失败：' + ((r && r.error) || '未知错误'), 'err');
  showRecState(true, Date.now() + 90000);
  status('录制已开始：去页面上亲手点一次「签到」按钮，抓到后会自动打开面板', 'ok');
};

init();

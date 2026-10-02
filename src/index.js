// Worker 入口：REST API + Cron 调度。
// 认证：单管理员密码（PBKDF2 存 D1），会话为服务端 session + HttpOnly Cookie。

import { ensureSchema, getSetting, setSetting } from './db.js';
import { hashPassword, verifyPassword, encryptJSON, decryptJSON, decryptJSONWith, accountKey, randomHex } from './crypto.js';
import { handleExtZip } from './ext-zip.js';
import { EXT_FILES } from './ext-files.js';
import { runAll, runAccount } from './runner.js';
import { getSite, siteMeta, getBrowserScript } from './sites/index.js';
import { listCommunitySites, importSiteConfig, deleteCommunitySite, validateSiteConfig, makeCommunitySite, exportAccountConfig } from './community.js';
import { getNotifyConfig, setNotifyConfig, sendNotify, sendTelegram, telegramChats, validTelegramToken, validTelegramChatId, readNotifyRaw } from './notify.js';
import { checkPublicHttpUrl, safePublicFetch, isPrivateHost } from './lib/net-guard.js';
import { credentialExpiry } from './lib/cookie-info.js';
import { probeSignEndpoints } from './probe.js';
import { shouldRun, nextLastKey, validHour, validTime, validTz, accountHour, dayInTz, dayStartInTz, pastScheduleTime } from './schedule.js';
import { runHttpSteps } from './sites/http.js';
import { verifyExternalRequest } from './lib/ext-auth.js';
import { PANEL_VERSION } from './version.js';

// 外部请求鉴权已迁移到 src/lib/ext-auth.js（API Key + HMAC 签名 + 防重放）。

const SESSION_TTL_MS = 7 * 864e5;

// 「今天」以哪个时区为准：跟随设置里的 schedule_tz（默认 Asia/Shanghai）。
// 签到时间、状态列跨零点重置、当天签到记录查询必须用同一个时区，否则会差一天。
async function scheduleTz(db) {
  try { return (await getSetting(db, 'schedule_tz')) || 'Asia/Shanghai'; } catch { return 'Asia/Shanghai'; }
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 接口响应一律不缓存；声明不许嗅探类型，避免被当成脚本/HTML 解释
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

// 解析 Cookie 头。
//
// 【必须容错】decodeURIComponent 遇到一个孤零零的 `%`（`Cookie: a=%` 就够了）会抛 URIError。
// 解析失败会一路冒到入口的 catch → 500 —— 也就是说**任何人不登录、只发一个畸形 Cookie 头
// 就能让每个接口都回 500**（监控里看就是「面板全线挂掉」，实际什么都没坏）。
// 解不开的那一段按原文留着：这个值后面要拿去比对会话 id，留着原文不会误判成「已登录」。
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function parseCookies(req) {
  const h = req.headers.get('Cookie') || '';
  const out = {};
  for (const p of h.split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = safeDecode(p.slice(i + 1).trim());
  }
  return out;
}

// 库里那些「本来就该是 JSON」的列（headers / options / resp_headers）一律宽容解析。
// 一行坏数据（旧版本写的、手改的、写一半被打断的）不该让整条中继链路瘫掉：
// 扩展轮询一次 500，面板上看到的就是「本地网络全部失败」，而真正的原因却藏在一行 JSON 里。
function safeJson(text, fallback = {}) {
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// Secure 只在真正的 https 下加：局域网 http（如 NAS 的 http://192.168.x.x:8787）
// 下浏览器会直接拒收 Secure Cookie，导致「登录成功却所有接口 401、页面一直加载中」。
// 反向代理（Caddy/nginx）后看 X-Forwarded-Proto 识别 https。
function sessionCookie(sid, maxAgeSec, req) {
  let secure = false;
  try {
    const proto = (req.headers.get('x-forwarded-proto') || new URL(req.url).protocol || '').toLowerCase();
    secure = proto === 'https:' || proto === 'https';
  } catch { /* 识别不出就按 http 处理，至少保证局域网能用 */ }
  return `sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax;${secure ? ' Secure;' : ''} Max-Age=${maxAgeSec}`;
}

async function authed(env, req) {
  const sid = parseCookies(req).sid;
  if (!sid) return false;
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ?').bind(sid).first();
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
    return false;
  }
  return true;
}

// 请求体只能读一次（流不可重放），这里缓存原始文本：
// 既供 JSON 解析，又供扩展请求的签名校验（签名要覆盖 body）。
const RAW_BODY = new WeakMap();
// 单次请求体上限。面板所有接口最大的输入也就是「多步录制的 JSON」或一整包 Cookie，
// 512KB 绰绰有余；不设上限的话，一个几百 MB 的 body 就能把 Worker 的内存/CPU 吃掉。
const MAX_BODY_BYTES = 512 * 1024;
// 中继回传的响应体上限（base64 字符数，约 300KB 原始字节）。
// 签到接口的响应都是几十字节的 JSON，这个上限只用来挡住「扩展把整个网页回传回来」那类意外。
const RELAY_BODY_LIMIT = 400 * 1024;
// 请求体被截断过的标记（见 readBody）
const BODY_TRUNCATED = new WeakSet();

async function readBodyRaw(req) {
  if (RAW_BODY.has(req)) return RAW_BODY.get(req);
  let text = '';
  try { text = await req.text(); } catch { text = ''; }
  if (text.length > MAX_BODY_BYTES) {
    text = text.slice(0, MAX_BODY_BYTES);
    BODY_TRUNCATED.add(req);
  }
  RAW_BODY.set(req, text);
  return text;
}

async function readBody(req) {
  const text = await readBodyRaw(req);
  // 【截断的 JSON 不等于「空对象」】带 Content-Length 的超大请求体在上面已经早退（413），
  // 但**分块传输（chunked）没有这个头**：于是 text 被悄悄切掉一半 → JSON.parse 失败 →
  // 以前返回 `{}`，调用方拿着空对象照常往下走 —— PUT /api/settings 就是「把你所有通知设置写空」，
  // 而接口还回 200 OK。现在直接抛错，由入口转成 413，宁可报错也不默默清库。
  if (BODY_TRUNCATED.has(req)) {
    const e = new Error('请求体过大（上限 512KB）');
    e.code = 'BODY_TOO_LARGE';
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ---------- 登录限速（防「拿脚本一直猜管理密码」） ----------
// 面板只有一道管理密码，没有第二因素。所以必须限制试错频率：
// 同一个来源 15 分钟内错满 8 次，就锁 15 分钟。
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

function clientIp(req) {
  const raw = String(req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown');
  return (raw.split(',')[0].trim() || 'unknown').slice(0, 64);
}

async function loginLockInfo(env, req) {
  const ip = clientIp(req);
  try {
    const row = await env.DB.prepare('SELECT fails, first_at, locked_until FROM login_limits WHERE ip = ?').bind(ip).first();
    if (!row) return { ip, locked: false, remainMs: 0 };
    const now = Date.now();
    if (Number(row.locked_until) > now) return { ip, locked: true, remainMs: Number(row.locked_until) - now };
    if (now - Number(row.first_at) > LOGIN_WINDOW_MS) return { ip, locked: false, remainMs: 0 };
    return { ip, locked: false, remainMs: 0, fails: Number(row.fails) || 0 };
  } catch {
    // 表还不存在/数据库暂时不可用时不要把人锁在门外
    return { ip, locked: false, remainMs: 0 };
  }
}

async function recordLoginFail(env, req) {
  const ip = clientIp(req);
  const now = Date.now();
  try {
    const row = await env.DB.prepare('SELECT fails, first_at FROM login_limits WHERE ip = ?').bind(ip).first();
    let fails = 1;
    let first = now;
    if (row && now - Number(row.first_at) <= LOGIN_WINDOW_MS) {
      fails = (Number(row.fails) || 0) + 1;
      first = Number(row.first_at);
    }
    const lockedUntil = fails >= LOGIN_MAX_FAILS ? now + LOGIN_LOCK_MS : 0;
    await env.DB.prepare(
      'INSERT INTO login_limits(ip, fails, first_at, locked_until, updated_at) VALUES(?,?,?,?,?) '
      + 'ON CONFLICT(ip) DO UPDATE SET fails=excluded.fails, first_at=excluded.first_at, locked_until=excluded.locked_until, updated_at=excluded.updated_at'
    ).bind(ip, fails, first, lockedUntil, now).run();
    // 顺手清理过期记录（不需要每次都清）
    if (Math.random() < 0.1) {
      await env.DB.prepare('DELETE FROM login_limits WHERE updated_at < ?').bind(now - 86400000).run().catch(() => {});
    }
    return { fails, locked: lockedUntil > 0 };
  } catch {
    return { fails: 1, locked: false };
  }
}

async function clearLoginFail(env, req) {
  try { await env.DB.prepare('DELETE FROM login_limits WHERE ip = ?').bind(clientIp(req)).run(); } catch { /* 忽略 */ }
}

// 跨站请求兜底校验。会话 Cookie 是 SameSite=Lax（跨站表单 POST 本来就不带它），
// 这里再加一道：浏览器带来的 Origin 必须和面板同源。
// 注意：只有在夹带了会话 Cookie 时才校验 —— 扩展的 API Key 请求是另外一个体系。
function sameOrigin(req, url) {
  const origin = req.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === url.host; } catch { return false; }
}

async function createSession(env) {
  const sid = randomHex(24);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions(id, created_at, expires_at) VALUES(?,?,?)')
    .bind(sid, now, now + SESSION_TTL_MS)
    .run();
  return sid;
}

// 内置站点 + 社区导入的站点：每次请求读一次 D1（量很小，导入后立刻生效，不用重启）
async function loadCustomSites(env) {
  try {
    const list = await listCommunitySites(env.DB);
    return list.map((r) => makeCommunitySite(r.def));
  } catch {
    return [];
  }
}

async function handleApi(req, env, url) {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // 请求体上限：先看 Content-Length，明显超了就早退（不让后面的代码去读一个超大 body）
  const contentLength = Number(req.headers.get('Content-Length') || '0') || 0;
  if (contentLength > MAX_BODY_BYTES) return json({ error: '请求体过大（上限 512KB）' }, 413);

  // 跨站写操作兜底：带了会话 Cookie 的浏览器请求，Origin 必须是本面板。
  // 【2026-09-29 修】/api/external/* 走 API Key 鉴权（自定义请求头，CSRF 伪造不了），
  // 不适用这条会话 CSRF 检查：扩展回传中继结果时，浏览器会自动带上用户登录面板的
  // sid 会话 Cookie，而扩展的 fetch 没有 Origin 头 —— 以前这里直接 403，
  // 导致「中继结果回传失败（HTTP 403）」，签到了却写不回结果。
  if (method !== 'GET' && method !== 'HEAD' && !path.startsWith('/api/external/')
      && parseCookies(req).sid && !sameOrigin(req, url)) {
    return json({ error: '跨站请求被拒绝（Origin 与面板不一致）' }, 403);
  }

  // ---- 首次设置 / 登录：这两步**没有会话 Cookie**，上面那条「带 Cookie 才校验」的兜底正好盖不到 ----
  //   ├─ /api/setup：全新实例还没有管理密码。任何人诱使面板主人的浏览器打开一个恶意页面，
  //   │   就能用他的浏览器替你**设一个密码**（你没有做过的初始化）→ 真正的部署者被锁在门外。
  //   └─ /api/login：登录 CSRF。页面把你的浏览器登成攻击者的账号后，你接下来的所有操作
  //       都落在别人的账号上（而你自己完全看不出）。
  // 所以这两条一律要求「浏览器带来的 Origin 与面板同源」。非浏览器客户端（curl / 脚本 / 扩展）
  // 根本不带 Origin，sameOrigin 会放行 —— 命令行初始化照旧可用。
  if ((path === '/api/setup' || path === '/api/login') && !sameOrigin(req, url)) {
    return json({ error: '跨站请求被拒绝（Origin 与面板不一致）' }, 403);
  }

  // 扩展/外部请求鉴权：API Key +（可选）HMAC 签名与防重放。
  // 通过后顺手记下扩展活跃时间，用于面板展示「扩展在线」状态。
  // 返回 null 表示放行；否则返回应直接发回的 401 Response。
  const extGuard = async () => {
    const r = await verifyExternalRequest(req, env, env.DB, { getRawBody: () => readBodyRaw(req) });
    if (!r.ok) return json({ error: r.error || '鉴权失败' }, r.status || 401);
    const now = Date.now();
    try {
      await setSetting(env.DB, 'ext_last_seen', String(now));
      // 只在确实带了签名时更新，否则会把「上次成功签名」的时间抹掉
      if (r.signed) await setSetting(env.DB, 'ext_last_signed', String(now));
    } catch { /* 忽略 */ }
    return null;
  };

  // ---- 公开接口 ----
  if (path === '/api/status' && method === 'GET') {
    const hash = await getSetting(env.DB, 'admin_hash');
    const runtime = env.RUNTIME === 'docker' ? 'docker' : 'workers';
    return json({ setup_needed: !hash, logged_in: await authed(env, req), runtime });
  }

  if (path === '/api/setup' && method === 'POST') {
    if (await getSetting(env.DB, 'admin_hash')) return json({ error: '已经初始化过了' }, 400);
    const { password } = await readBody(req);
    if (!password || String(password).length < 8) return json({ error: '密码至少 8 位' }, 400);
    await setSetting(env.DB, 'admin_hash', await hashPassword(String(password)));
    const sid = await createSession(env);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sid, SESSION_TTL_MS / 1000, req) });
  }

  if (path === '/api/login' && method === 'POST') {
    const hash = await getSetting(env.DB, 'admin_hash');
    if (!hash) return json({ error: '尚未初始化，请先设置管理密码' }, 400);
    const lock = await loginLockInfo(env, req);
    if (lock.locked) {
      return json({ error: `密码尝试次数太多，请在 ${Math.max(1, Math.ceil(lock.remainMs / 60000))} 分钟后再试` }, 429);
    }
    const { password } = await readBody(req);
    if (!(await verifyPassword(String(password || ''), hash))) {
      const r = await recordLoginFail(env, req);
      if (r.locked) return json({ error: '密码错误次数过多，已临时锁定 15 分钟' }, 429);
      return json({ error: `密码错误（还可以再试 ${Math.max(0, LOGIN_MAX_FAILS - r.fails)} 次）` }, 401);
    }
    await clearLoginFail(env, req);
    const sid = await createSession(env);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sid, SESSION_TTL_MS / 1000, req) });
  }

  // ---- 外部上报接口（VM 定时任务 / 浏览器扩展用 API Key 认证，不走 session） ----
  if (path === '/api/external/report' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { account_id, status, message, detail, duration_ms } = await readBody(req);
    const acc = await env.DB.prepare('SELECT id, site, name FROM accounts WHERE id = ?').bind(Number(account_id)).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    // 校验 status 只允许 ok/fail/skip，防止非法值写入
    const validStatus = ['ok', 'fail', 'skip'].includes(status) ? status : 'fail';
    // 文本字段一律截断：上报通道只能用 API Key 调，但也不该让它往库里灌任意长度的内容
    const msgText = String(message || '').slice(0, 2000);
    const detailText = String(detail || '').slice(0, 8000);
    const dur = Math.max(0, Math.min(Number(duration_ms) || 0, 3600000));
    await env.DB.prepare(
      'INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)'
    ).bind(acc.id, acc.site, acc.name, validStatus, msgText, detailText, dur, Date.now()).run();
    await env.DB.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 500)').run();
    // 同步更新账号的上次结果；成功时记录今日已签到日期
    const fullAcc = await env.DB.prepare('SELECT meta FROM accounts WHERE id = ?').bind(acc.id).first();
    let rmeta = {};
    try { rmeta = JSON.parse(fullAcc?.meta || '{}'); } catch { /* 忽略 */ }
    if (validStatus === 'ok') {
      // 【「今天」要按站点自己的日界算】
      // 糊涂鳄（WordPress + RiPro）按 UTC 计日 —— 北京时间 08:00 才是它的新的一天。
      // 而账号行上「已签到/未签到」的判据是**站点日界**（前端 accountDay()，用 meta.dayTz）。
      // 这里如果拿面板时区去写，就会出现「扩展刚报成功、那一行却写着未签到」的自相矛盾
      // （北京时间 00:00~08:00 这一段最明显）。runner.js 一直用的是站点日界，这里以前漏了，
      // 变成同一天有三套算法。
      const siteDayTz = ((getSite(acc.site, await loadCustomSites(env)) || {}).dayTz) || '';
      rmeta.last_signin_date = dayInTz(new Date(), siteDayTz || (await scheduleTz(env.DB)));
    }
    await env.DB.prepare('UPDATE accounts SET last_status=?, last_msg=?, last_detail=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
      .bind(validStatus, message || '', detail || '', Date.now(), JSON.stringify(rmeta), Date.now(), acc.id).run();
    // 如果是手动任务队列中的，上报后删除（避免重复执行）
    await env.DB.prepare('DELETE FROM browser_manual_jobs WHERE account_id = ?').bind(acc.id).run().catch(() => {});
    return json({ ok: true });
  }

  // ---- 会话续命（alist 式）：扩展签到完，把浏览器里被站点轮换过的新 Cookie 回写面板 ----
  // alist 对网盘 token 的做法：请求过程中令牌被轮换（refresh token rotation），
  // 就把新令牌**当场写回存储**，而不是等它过期后人工重新填。
  // 我们这里同理：签到过程本身会让站点下发新会话（Set-Cookie / WAF 票 / 重发的登录名），
  // 签完还带着旧值存库里，等于让凭据「计划性报废」。这里给扩展一条**最小权限的回写通道**：
  //   ① 只改 cookie 字段（user_agent / localStorage 等其余凭据一律不碰）；
  //   ② 回写的域必须与账号站点同域（防一把被偷的 Key 拿别的站的 Cookie 污染账号）；
  //   ③ 内容与库里现有的一致或没有登录名时拒绝（噪音与降级都不要）。
  if (path === '/api/external/creds-rotation' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { account_id, domain, cookies } = await readBody(req);
    const acc = await env.DB.prepare('SELECT id, site, creds FROM accounts WHERE id = ?').bind(Number(account_id)).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    const newCookie = String(cookies || '').trim();
    if (!newCookie) return json({ error: '没有可回写的 Cookie' }, 400);
    if (newCookie.length > 32 * 1024) return json({ error: 'Cookie 内容过大（超过 32KB）' }, 413);
    // 同域校验：账号站点登记的域（含社区站点）。拿不到登记域的自定义站点不限制（与任务下发同一套规则）。
    const site = getSite(acc.site, await loadCustomSites(env));
    const declared = String((site && site.domain) || '').replace(/^www\./, '').toLowerCase();
    if (declared) {
      let host = '';
      try { host = new URL(String(domain || '')).hostname.toLowerCase(); } catch { host = ''; }
      const hostOk = host && (host === declared || host.endsWith('.' + declared) || declared.endsWith('.' + host));
      if (!hostOk) return json({ error: '回写的 Cookie 域与账号站点不一致，已拒绝' }, 400);
    }
    // 只认「真的带登录名的 Cookie」；与现有值一致就拒，免得每次签到都白写一遍库（D1 写有配额）。
    const pickNames = (str) => {
      const map = new Map();
      for (const part of String(str || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
      return map;
    };
    const SENSITIVE = /(_auth$|_auth|saltkey|^session|sessionid|passport|pwd|token)/i;
    const oldCreds = await decryptJSON(env, env.DB, acc.creds).catch(() => ({}));
    const oldCookie = String((oldCreds && oldCreds.cookie) || '').trim();
    const incoming = pickNames(newCookie);
    // 先算合并后的结果：一模一样就是纯重复上报，直接 409（不管有没有登录名）。
    // 只替换本次提交里出现的那几条，其余原样保留 —— 扩展抓的是整个 jar，
    // 里头可能有站点临时票；那些不重要，但**别的凭据字段（UA 等）绝不能动**。
    const merged = pickNames(oldCookie);
    for (const [k, v] of incoming) merged.set(k, v);
    const mergedStr = [...merged].map(([k, v]) => k + '=' + v).join('; ');
    if (mergedStr === oldCookie) return json({ error: 'Cookie 没有变化，不需要回写' }, 409);
    // 真有变化时，内容里必须认得登录名 —— 否则只是噪音（临时票/样式类），不值得写库。
    const newName = [...incoming.keys()].find((n) => SENSITIVE.test(n)) || '';
    if (!newName) return json({ error: '回写的内容里没有识别到登录名（auth/session/token 类 Cookie），已拒绝' }, 400);
    const enc = await encryptJSON(env, env.DB, { ...(oldCreds || {}), cookie: mergedStr });
    await env.DB.prepare('UPDATE accounts SET creds=?, updated_at=? WHERE id=?').bind(enc, Date.now(), acc.id).run();
    // 记一条轻量痕迹：哪天凭据出问题，能看出「它被自动续过命」
    let m = {};
    try { m = JSON.parse((await env.DB.prepare('SELECT meta FROM accounts WHERE id = ?').bind(acc.id).first())?.meta || '{}'); } catch { m = {}; }
    m.cred_rotated_at = Date.now();
    await env.DB.prepare('UPDATE accounts SET meta=? WHERE id=?').bind(JSON.stringify(m), acc.id).run().catch(() => {});
    return json({ ok: true, rotated: incoming.size, account_id: acc.id });
  }

  // ---- 外部查询账号状态（VM 跑之前检查是否启用） ----
  const mExtAcc = path.match(/^\/api\/external\/account\/(\d+)$/);
  if (mExtAcc && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const acc = await env.DB.prepare('SELECT id, site, name, enabled FROM accounts WHERE id = ?').bind(Number(mExtAcc[1])).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    return json({ id: acc.id, site: acc.site, name: acc.name, enabled: !!acc.enabled });
  }

  // ---- 外部查询账号凭据（VM 代签用，返回解密后的 cookie / user_agent 等） ----
  // 面板是唯一凭据源：用户在面板更新 Cookie 后，VM 下次运行自动取到最新值，无需手动同步文件
  const mExtCreds = path.match(/^\/api\/external\/account\/(\d+)\/creds$/);
  if (mExtCreds && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const acc = await env.DB.prepare('SELECT id, site, name, enabled, creds FROM accounts WHERE id = ?').bind(Number(mExtCreds[1])).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    let creds = {};
    try { creds = await decryptJSON(env, env.DB, acc.creds) || {}; } catch { /* 解密失败则返回空 */ }
    return json({
      id: acc.id,
      site: acc.site,
      name: acc.name,
      enabled: !!acc.enabled,
      cookie: creds.cookie || '',
      user_agent: creds.user_agent || '',
    });
  }

  // ---- 外部查询 NodeSeek 模式（VM 用） ----
  if (path === '/api/external/nodeseek-mode' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const mode = (await getSetting(env.DB, 'nodeseek_mode')) || 'random';
    return json({ mode });
  }

  // ---- 扩展连接检查（无副作用，不消费任务） ----
  if (path === '/api/external/ping' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    return json({ ok: true, version: PANEL_VERSION, time: Date.now() });
  }

  // ---- 扩展最新版本号（弹窗里的更新按钮用：比对本地版本，有新版就提示下载）----
  // 不需要 API Key：版本号不是敏感信息
  if (path === '/api/external/ext-version' && method === 'GET') {
    let ver = '';
    try {
      const m = JSON.parse(EXT_FILES['manifest.json'] || '{}');
      ver = String(m.version || '');
    } catch { /* 忽略 */ }
    return json({ ok: true, version: ver });
  }

  // ---- 浏览器扩展：任务已并入「本地网络中继」，这里不再下发脚本 ----
  // 浏览器模式（含站点默认 browser 的吾爱破解 / NodeSeek / V2EX / 看雪 / Discuz）统一走中继：
  // 站点逻辑仍在 Worker，HTTP 请求由扩展在用户本地网络中执行（见 runner.js），
  // 既解决了 MV3 无法执行面板脚本的问题，也避免与中继重复执行。
  // 若站点需要人工过人机验证，请用面板上的「打开验证页」，验证后重新「一键发送」刷新 Cookie。
  // ---- 浏览器导航签到（browser jobs）----
  // 适用于「脚本化请求整站读不到」的站点（典型：吾爱破解被网宿 WAF 保护，
  // 实测连 robots.txt 经中继都超时，只有真实页导航才能过挑战）。
  // 扩展每隔 1 分钟来领一次：导航到签到页 → 读结果 → POST /api/external/report 回填。
  if (path === '/api/external/browser-jobs' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const custom = await loadCustomSites(env);
    const jobs = [];
    const today = dayInTz(new Date(), await scheduleTz(env.DB));
    const now = Date.now();

    // 把一个账号变成扩展能执行的「导航签到」工单
    const jobFor = async (acc, site) => {
      if (!acc || !acc.enabled || !site || typeof site.browserJob !== 'function') return null;
      const creds = await decryptJSON(env, env.DB, acc.creds).catch(() => ({}));
      let meta = {};
      try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
      const j = site.browserJob(creds, { meta, env }) || {};
      const navigate = j.navigate_url || site.navigateUrl || '';
      if (!navigate) return null;
      return {
        account_id: acc.id,
        site: acc.site,
        site_name: site.name,
        domain: j.domain || site.domain || '',
        navigate_url: navigate,
        // 扩展端拿到页面后，如果还没签到，可以再去这个地址（页面上那个「去签到」链接的原样地址）
        sign_url: j.sign_url || site.navigateUrl || navigate,
        // 触发签到后回哪几页复查「服务端到底认成没认」：
        // 任务页上那条「去签到」链接还在 = 今天没签，链接没了/本行写着已完成 = 已签；
        // 站点也可以多给一个地址（如首页）——Discuz 顶部用户菜单里挂着同一个入口。
        // 站点自己声明（browserJob 里的 verify_urls / verify_url）；没声明就不复查，扩展那边不乱跳。
        verify_urls: Array.isArray(j.verify_urls) ? j.verify_urls.slice(0, 4) : [],
        verify_url: j.verify_url || '',
        // 站点声明「需要浏览器处于登录态」（吾爱破解这类：签到只能由浏览器亲自发，脚本路被 WAF 挡死）：
        // 把凭据一并交下去，由扩展写回浏览器 cookie jar —— 面板点一下就能签到，
        // 不需要人先去浏览器手工登录。**只有站点主动声明的才下发**，其他站点一律不带。
        // 老扩展没有这个能力时会忽略这两个字段（不影响原有流程）。
        inject_cookies: !!j.inject_cookies,
        cookie: j.inject_cookies ? String(creds.cookie || '') : '',
        // 报成功之前先回站点核对（首页状态才是服务端状态，结果页文案可能只是文案）
        confirm_before_report: !!j.confirm_before_report,
        script: null, // MV3 禁止 new Function，页内判定由扩展原生巡检验完成
        params: {},
      };
    };

    // ① 手动队列：面板点「浏览器签到」时写入，最优先
    const { results: manual } = await env.DB.prepare(
      'SELECT id, account_id FROM browser_manual_jobs ORDER BY created_at LIMIT 10'
    ).all().catch(() => ({ results: [] }));
    const queued = new Set();
    for (const row of manual || []) {
      // 领走就删（不管成不成），避免每分钟重复下发
      await env.DB.prepare('DELETE FROM browser_manual_jobs WHERE id = ?').bind(row.id).run().catch(() => {});
      const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(row.account_id).first();
      const j = await jobFor(acc, acc && getSite(acc.site, custom));
      if (j) { jobs.push(j); queued.add(acc.id); }
    }

    // ② 自动工单：声明了浏览器签到的站点（如吾爱破解），**到了它自己的签到时间**、
    //    当天又还没签上，才交给扩展去导航签到。
    //    节流：同一账号至少隔 60 分钟才自动下发一次，避免反复开标签页。
    //
    //    【必须按时间放行】以前这里只看「今天还没签上」，于是当地 0 点一过就立刻下发：
    //    用户把时间设成 08:05，吾爱破解却在半夜就被自动签了（反馈里写着
    //    「已交给浏览器执行」）—— 看上去就是「吾爱不跟随全局时间」。
    //    定时任务（cron）本来就只在该跑的时候才跑，这条自动下发也得遵守同一套时间。
    //    注意：面板上手动点的「浏览器签到」走的是上面 ① 手动队列，不受这里限制。
    const globalTime = (await getSetting(env.DB, 'schedule_time')) || '08';
    const panelTz = await scheduleTz(env.DB);
    const { results: autos } = await env.DB.prepare(
      'SELECT * FROM accounts WHERE enabled = 1 ORDER BY id'
    ).all();
    for (const acc of autos || []) {
      if (queued.has(acc.id)) continue;
      const site = getSite(acc.site, custom);
      if (!site || typeof site.browserJob !== 'function') continue;
      let m = {};
      try { m = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
      if (m.last_signin_date === today) continue; // 今天已签上，不用再打扰
      // 还没到它自己的签到时间（或已经超出当天的补跑窗口）→ 不下发
      if (!pastScheduleTime(new Date(), accountHour(acc.meta, globalTime), panelTz)) continue;
      if (m.browser_job_at && now - m.browser_job_at < 60 * 60 * 1000) continue;
      const j = await jobFor(acc, site);
      if (!j) continue;
      m.browser_job_at = now;
      await env.DB.prepare('UPDATE accounts SET meta = ? WHERE id = ?').bind(JSON.stringify(m), acc.id).run().catch(() => {});
      jobs.push(j);
    }
    return json({ jobs });
  }

  // ---- 一次性交接码（扩展 → 面板）----
  // 扩展不再把整包 Cookie 塞进 URL：先 POST 到这里暂存，URL 里只带一个短码，
  // 面板页面用短码取回。好处是登录凭据不再进入浏览器地址栏 / 历史记录。
  if (path === '/api/external/handoff' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const body = await readBody(req);
    const { domain, pageUrl, cookies, cookieList, userAgent, localStorage, stats, detectedSite } = body;
    // kind=record：扩展「录制签到」抓到的请求草稿。record 必须带 url；Cookie 允许为空。
    if (body.kind === 'record') {
      const record = body.record || {};
      if (!record.url) return json({ error: '录制内容缺少请求地址' }, 400);
      if (String(cookies || '').length > 200 * 1024) {
        return json({ error: 'Cookie 内容过大（超过 200KB），请只交接目标站点的 Cookie' }, 413);
      }
      const code = randomHex(16);
      const now = Date.now();
      await env.DB.prepare('INSERT INTO handoffs(code, payload, created_at, expires_at, used) VALUES(?,?,?,?,0)')
        .bind(code, JSON.stringify({
          kind: 'record',
          domain: String(domain || ''),
          pageUrl: String(pageUrl || ''),
          cookies: String(cookies || ''),
          userAgent: String(userAgent || ''),
          record: {
            method: String(record.method || 'GET').toUpperCase(),
            url: String(record.url || ''),
            headers: record.headers && typeof record.headers === 'object' ? record.headers : {},
            body: String(record.body || ''),
          },
          ts: now,
        }), now, now + 5 * 60 * 1000).run();
      await env.DB.prepare('DELETE FROM handoffs WHERE expires_at < ?').bind(now - 3600000).run().catch(() => {});
      return json({ ok: true, code, expires_in: 300 });
    }
    if (!cookies || !String(cookies).trim()) return json({ error: '没有可交接的 Cookie' }, 400);
    // 交接内容会整包塞进 D1 的一行里（SQLite 行的理论上限远小于此，超了就是写入报错 500）。
    // 入口那条 512KB 上限管的是「整个请求体」，这里再给实际要落库的 Cookie 串单独卡一道，
    // 免得一个超大页面把整个交接搞成「服务异常」。
    if (String(cookies).length > 200 * 1024) {
      return json({ error: 'Cookie 内容过大（超过 200KB），请只交接目标站点的 Cookie' }, 413);
    }
    const code = randomHex(16);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO handoffs(code, payload, created_at, expires_at, used) VALUES(?,?,?,?,0)')
      .bind(code, JSON.stringify({
        domain: String(domain || ''),
        pageUrl: String(pageUrl || ''), // 扩展采集时的完整页面地址（后续站点拼 Referer/Origin 用）
        cookies: String(cookies),
        cookieList: Array.isArray(cookieList) ? cookieList.slice(0, 300) : [],
        userAgent: String(userAgent || ''),
        localStorage: localStorage && typeof localStorage === 'object' ? localStorage : {},
        stats: stats && typeof stats === 'object' ? stats : {},
        // 扩展 ≥2.20 的站点自动识别结果：{ site, confidence, reason }，只收白名单内的值
        detectedSite: detectedSite && typeof detectedSite === 'object' && (detectedSite.confidence === 'high' || detectedSite.confidence === 'medium')
          ? { site: String(detectedSite.site || '').slice(0, 32), confidence: detectedSite.confidence, reason: String(detectedSite.reason || '').slice(0, 120) }
          : null,
        ts: now,
      }), now, now + 5 * 60 * 1000).run();
    await env.DB.prepare('DELETE FROM handoffs WHERE expires_at < ?').bind(now - 3600000).run().catch(() => {});
    return json({ ok: true, code, expires_in: 300 });
  }

  // ---- 扩展录制小日志（扩展 → 面板日志）----
  // 录制结束时（抓到请求 / 90 秒超时无抓获 / 交接失败）扩展 POST 一条小日志，
  // 写进 runs（site='record'，account_id 为空），面板「日志」页直接能看到
  // 本次录制抓到了什么、错在哪 —— 调试陌生站点时不用再猜。
  // 日志只留最近 100 条，D1 不会被撑大。
  if (path === '/api/external/record-log' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const body = await readBody(req);
    const summary = String(body.summary || '').slice(0, 200).trim();
    const detail = String(body.detail || '').slice(0, 8192);
    if (!summary && !detail) return json({ error: '日志内容为空' }, 400);
    const ok = body.ok === true;
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)'
    ).bind(null, 'record', '🎬 扩展录制', ok ? 'ok' : 'fail', summary || '（无摘要）', detail, 0, now).run();
    await env.DB.prepare(
      "DELETE FROM runs WHERE site = 'record' AND id NOT IN (SELECT id FROM runs WHERE site = 'record' ORDER BY id DESC LIMIT 100)"
    ).run().catch(() => {});
    return json({ ok: true });
  }

  // 面板页面凭短码取回交接内容：一次性 + 5 分钟过期 + 取完即作废
  if (path.startsWith('/api/handoff/') && method === 'GET') {
    // 同样要先容错再校验：`/api/handoff/%` 以前会让 decodeURIComponent 抛错 → 500
    // （未登录也能触发，监控里只会看到一条「服务异常」）。格式不对的一律按 400 回。
    const code = safeDecode(path.slice('/api/handoff/'.length));
    if (!/^[A-Za-z0-9]{16,64}$/.test(code)) return json({ error: '交接码格式不正确' }, 400);
    const row = await env.DB.prepare('SELECT code, payload, expires_at, used FROM handoffs WHERE code = ?').bind(code).first();
    if (!row) return json({ error: '交接码不存在或已被使用，请在扩展里重新发送' }, 404);
    if (row.used) return json({ error: '交接码已使用过，请在扩展里重新发送' }, 410);
    if (row.expires_at < Date.now()) return json({ error: '交接码已过期，请在扩展里重新发送' }, 410);
    await env.DB.prepare('UPDATE handoffs SET used = 1 WHERE code = ?').bind(row.code).run();
    let payload = {};
    try { payload = JSON.parse(row.payload); } catch { /* 忽略 */ }
    return json({ ok: true, payload });
  }

  // ---- 扩展报到：上报版本 / UA / 能力，面板据此显示「扩展在线 + 版本」----
  if (path === '/api/external/hello' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { version, ua, capabilities } = await readBody(req);
    const info = {
      version: String(version || '').slice(0, 24),
      ua: String(ua || '').slice(0, 200),
      capabilities: Array.isArray(capabilities) ? capabilities.slice(0, 20).map(String) : [],
      last_seen: Date.now(),
    };
    await setSetting(env.DB, 'ext_status', JSON.stringify(info));
    // 版本号统一从 src/version.js 取（以前这里是写死的 '2.3'，和 package.json 对不上）
    return json({ ok: true, server_version: PANEL_VERSION });
  }

  // ---- 扩展领取面板下发的指令（登录协助等）----
  if (path === '/api/external/commands' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const { results } = await env.DB.prepare(
      "SELECT id, kind, account_id, domain, login_url, payload FROM ext_commands WHERE status = 'pending' ORDER BY created_at LIMIT 5"
    ).all();
    return json({
      commands: (results || []).map((c) => {
        let payload = {};
        try { payload = JSON.parse(c.payload || '{}'); } catch { /* 忽略 */ }
        return { id: c.id, kind: c.kind, account_id: c.account_id, domain: c.domain || '', login_url: c.login_url || '', payload };
      }),
    });
  }

  // 扩展回传指令执行结果
  if (path.startsWith('/api/external/commands/') && path.endsWith('/result') && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const cid = path.slice('/api/external/commands/'.length, -'/result'.length);
    const { status, result } = await readBody(req);
    const st = status === 'done' ? 'done' : 'failed';
    await env.DB.prepare("UPDATE ext_commands SET status=?, result=?, updated_at=? WHERE id=? AND status='pending'")
      .bind(st, String(result || '').slice(0, 500), Date.now(), cid).run();
    // 顺手清理已经处理完的旧指令：这些行以前只被标成 done/failed、从来没人删，会慢慢堆着。
    await env.DB.prepare("DELETE FROM ext_commands WHERE status != 'pending' AND updated_at < ?")
      .bind(Date.now() - 3600000).run().catch(() => {});
    return json({ ok: true });
  }

  // ---- 诊断：中继队列状态（需要登录） ----
  if (path === '/api/diag/relay' && method === 'GET') {
    if (!(await authed(env, req))) return json({ error: '未登录' }, 401);
    try {
      const { results: pending } = await env.DB.prepare(
        "SELECT id, url, method, status, created_at FROM relay_jobs WHERE status = 'pending' ORDER BY created_at DESC LIMIT 10"
      ).all();
      const { results: recent } = await env.DB.prepare(
        "SELECT id, url, method, status, created_at FROM relay_jobs ORDER BY created_at DESC LIMIT 10"
      ).all();
      const lastPoll = await getSetting(env.DB, 'relay_last_poll');
      return json({
        pending: pending || [],
        recent: recent || [],
        last_poll: lastPoll ? new Date(Number(lastPoll)).toISOString() : null,
        last_poll_ago_sec: lastPoll ? Math.floor((Date.now() - Number(lastPoll)) / 1000) : null,
      });
    } catch (e) {
      return json({ error: '查询失败: ' + e.message }, 500);
    }
  }

  // ---- 本地网络中继代理 ----
  // Worker 把 HTTP 请求存入队列，浏览器扩展用用户本地网络执行后回传响应。
  // 适用于：站点逻辑复杂、希望逻辑保留在 Worker，但需要用户本地 IP 的场景。
  //
  // POST /api/external/relay { url, method, headers, body } → { job_id }
  //   body 为 base64（可空）；headers 为对象
  // GET /api/external/relay/:id → { status: pending|running|done|failed, response?, error? }
  //   response: { status, headers, body_base64 }
  //   running = 已被扩展领走（租约中），还没回传结果 —— 必须单独报出来，
  //   不能落进「done」的兜底分支（那会让面板看到「完成了但响应是空的」）。
  // GET /api/external/relay-pending → { jobs: [{ id, url, method, headers, body_base64 }] }（扩展轮询）
  // POST /api/external/relay/:id/result { status, headers, body_base64 } 或 { error }
  //   扩展执行完成后回传。**租约中的任务（running）也要收**：任务一被领走就是 running，
  //   只认 pending 会让每一次真实回传都落空（2026-09-28 线上「本地网络全废」的真凶）。

  // Worker 提交中继请求
  if (path === '/api/external/relay' && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { url, method, headers, body, options } = await readBody(req);
    if (!url || !/^https?:\/\//i.test(String(url))) {
      return json({ error: 'url 非法' }, 400);
    }
    // 【别让中继变成「用别人家里的网络扫内网」的工具】
    //
    // 中继这段代码是在**用户的浏览器里**执行的（扩展），出口就是他的家庭/公司网络。
    // 以前这里只检查「以 http 开头」，于是拿到 API Key 的人（或者一份恶意社区配置里
    // 写死的内网地址）就能让面板代它去请求 192.168.1.1/admin、路由器的管理页，
    // 甚至 169.254.169.254（如果浏览器跑在云主机上）—— 然后把响应正文从
    // GET /api/external/relay/:id 里原样读走。面板自己那个出站闸门管不到这一段。
    //
    // 只拦「字面上的内网/本机地址」，域名照旧放行（公司内网域名要能用）。
    // 注意：这里也不允许 user:pass@host 这种带凭据的地址 —— 没这个需求，且容易藏东西。
    let relayUrl = null;
    try { relayUrl = new URL(String(url)); } catch { relayUrl = null; }
    if (!relayUrl) return json({ error: 'url 非法' }, 400);
    if (relayUrl.username || relayUrl.password) return json({ error: '中继地址里不许带用户名/密码' }, 400);
    if (isPrivateHost(relayUrl.hostname)) {
      return json({ error: '拒绝中继到内网/本机地址（' + relayUrl.hostname + '）：中继是用你自己的网络发请求，面板不会让它去打内网' }, 400);
    }
    const id = 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO relay_jobs(id, url, method, headers, body, options, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).bind(
      id,
      String(url),
      String(method || 'GET').toUpperCase(),
      JSON.stringify(headers || {}),
      body ? String(body) : null, // base64
      JSON.stringify(options || {}),
      'pending',
      now,
      now
    ).run();
    // 清理 10 分钟前的旧任务（避免表无限增长）
    await env.DB.prepare("DELETE FROM relay_jobs WHERE created_at < ?").bind(now - 600000).run().catch(() => {});
    return json({ job_id: id });
  }

  // Worker 查询中继结果（轮询）
  const mRelayGet = path.match(/^\/api\/external\/relay\/([A-Za-z0-9_]+)$/);
  if (mRelayGet && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const job = await env.DB.prepare('SELECT * FROM relay_jobs WHERE id = ?').bind(mRelayGet[1]).first();
    if (!job) return json({ error: '任务不存在' }, 404);
    if (job.status === 'pending') return json({ status: 'pending' });
    // 租约中（扩展已经领走、正在执行）：如实报 running。
    // 【踩坑】以前没有这一条，running 会落到下面「done」的兜底分支，面板看到的就是
    // 「任务完成了，但状态/正文全是空」—— 于是「本地网络」这条路被误诊成「站点返回空」，
    // 站点模块再据此得出「站点不认这个接口」的错误结论（线上糊涂鳄就是这么报错的）。
    if (job.status === 'running') return json({ status: 'running' });
    if (job.status === 'failed') return json({ status: 'failed', error: job.error || '执行失败' });
    return json({
      status: 'done',
      response: {
        status: job.resp_status,
        headers: safeJson(job.resp_headers, {}),
        body_base64: job.resp_body || '',
      },
    });
  }

  // 扩展获取待执行的中继任务
  // 支持长轮询：?wait=20000 → 没有任务时挂起最多 20 秒（每 800ms 查一次 D1），
  // 一有任务立刻返回。这样「点执行」后扩展几乎立刻领走任务，不用等 30 秒的 alarm 周期
  // （Chrome 会把 alarms 的最小周期压到 0.5 分钟，短轮询必然导致每跳 15~30 秒延迟）。
  if (path === '/api/external/relay-pending' && method === 'GET') {
    const deny = await extGuard();
    if (deny) return deny;
    const startPollAt = Date.now();
    // 一次最多交给扩展几个任务（见 readPending 的说明）：2 个足够让新任务不被旧任务堵死
    const RELAY_HANDOUT_MAX = 2;
    const wait = Math.min(Math.max(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 0), 20000);
    const deadline = Date.now() + wait;
    const readPending = async () => {
      // ① 先把「租出去很久没人回」的任务判失败：扩展中途被关/Service Worker 被回收时，
      //    任务会永远停在 running，Worker 那边要白等到 90 秒超时。
      await env.DB.prepare(
        "UPDATE relay_jobs SET status='failed', error='扩展没有在 2 分钟内回传（可能被关闭或休眠），已放弃该请求', updated_at=? WHERE status='running' AND updated_at < ?"
      ).bind(Date.now(), Date.now() - 120000).run().catch(() => {});
      // ② 一次只发少量任务：扩展是**单飞**执行（每个请求最长 ~58 秒），一次塞 10 个会让
      //    排在后面的任务在 Worker 那边等到 90 秒超时 —— 线上 2026-09-28 的「扩展没有在 90 秒内回传」就是这么来的。
      const { results } = await env.DB.prepare(
        `SELECT id, url, method, headers, body, options FROM relay_jobs WHERE status = 'pending' ORDER BY created_at LIMIT ${RELAY_HANDOUT_MAX}`
      ).all();
      const rows = results || [];
      // ③ 发出去的同时标记为 running（租约）：避免另一位轮询/另一个突发把同一批任务重复执行两遍
      if (rows.length) {
        const now = Date.now();
        await env.DB.batch(rows.map((r) => env.DB.prepare(
          "UPDATE relay_jobs SET status='running', updated_at=? WHERE id=? AND status='pending'"
        ).bind(now, r.id))).catch(() => {});
      }
      return rows.map((j) => ({
        id: j.id,
        url: j.url,
        method: j.method,
        headers: safeJson(j.headers, {}),
        body_base64: j.body || null,
        options: safeJson(j.options, {}),
      }));
    };
    // 记录扩展最后轮询时间，用于判断扩展是否在线（自动中继）；
    // 同时记下扩展版本（?v=2.2），面板可以提醒用户版本是否陈旧。
    await setSetting(env.DB, 'relay_last_poll', String(Date.now())).catch(() => {});
    const extVer = String(url.searchParams.get('v') || '').slice(0, 16);
    if (extVer) await setSetting(env.DB, 'relay_version', extVer).catch(() => {});
    let jobs = await readPending();
    while (!jobs.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      jobs = await readPending();
    }
    // 长轮询期间也要保活「扩展在线」状态，否则面板会误判扩展已离线
    if (Date.now() - startPollAt > 5000) {
      await setSetting(env.DB, 'relay_last_poll', String(Date.now())).catch(() => {});
    }
    return json({ jobs, waited: wait > 0 });
  }

  // 扩展回传中继结果
  const mRelayResult = path.match(/^\/api\/external\/relay\/([A-Za-z0-9_]+)\/result$/);
  if (mRelayResult && method === 'POST') {
    const deny = await extGuard();
    if (deny) return deny;
    const { status, headers, body_base64, error } = await readBody(req);
    const now = Date.now();
    // 租约中的任务（running）同样要接受回传：任务一被领走就已标记为 running，
    // 只写 status='pending' 的话每一次真实回传都会匹配 0 行 —— 面板永远拿不到响应，
    // 等到超时再报「扩展没有在 2 分钟内回传」，而扩展其实早就答完了。
    // （结果只能写一次：写入后状态变 done，第二次回传自然不会命中。）
    if (error) {
      await env.DB.prepare("UPDATE relay_jobs SET status='failed', error=?, updated_at=? WHERE id=? AND status IN ('pending','running')")
        .bind(String(error).slice(0, 500), now, mRelayResult[1]).run();
    } else {
      // 回传的字段全部要过一道闸：这是唯一会写进 relay_jobs 的入口，
      // 一行写进去的东西之后会被 waitRelayResult 拼成「网站的响应」交给站点模块判断。
      // 以前三者都是原样落库：
      //   ├─ body_base64 可以塞几百 KB（同步写库 + 之后每次解码）；
      //   ├─ 不是合法 base64 的串会让运行时的 atob 直接抛错，报出来的是「Invalid character」；
      //   └─ status 可以写 99999，面板上就显示一个不存在的状态码。
      const rawBody = body_base64 ? String(body_base64) : '';
      if (rawBody.length > RELAY_BODY_LIMIT) {
        return json({ error: '回传的响应体过大（上限 300KB），请只回传签到接口的响应' }, 413);
      }
      if (rawBody && !/^[A-Za-z0-9+/=\s]+$/.test(rawBody)) {
        return json({ error: '响应体不是合法的 base64' }, 400);
      }
      const st = Number(status) || 0;
      if (st < 0 || st > 599) return json({ error: '状态码不合法' }, 400);
      const hdr = JSON.stringify(headers && typeof headers === 'object' ? headers : {});
      await env.DB.prepare("UPDATE relay_jobs SET status='done', resp_status=?, resp_headers=?, resp_body=?, updated_at=? WHERE id=? AND status IN ('pending','running')")
        .bind(
          st,
          hdr.slice(0, 8 * 1024),
          rawBody,
          now,
          mRelayResult[1]
        ).run();
    }
    return json({ ok: true });
  }

  if (!(await authed(env, req))) return json({ error: '未登录' }, 401);

  // ---- 登录后接口 ----
  if (path === '/api/logout' && method === 'POST') {
    const sid = parseCookies(req).sid;
    if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0, req) });
  }

  if (path === '/api/me' && method === 'GET') return json({ logged_in: true });

  if (path === '/api/sites' && method === 'GET') return json({ sites: siteMeta(await loadCustomSites(env)) });

  // ---- 社区站点配置（开源配套）：导入 / 列出 / 删除 / 导出 ----
  // 导入：粘贴一段 JSON，或给一个原始链接（Gist / raw 文件都行）
  if (path === '/api/sites/community' && method === 'GET') {
    const list = await listCommunitySites(env.DB);
    // author：导出配置时默认署的名字（开源共建署名，存在设置里）
    const author = (await getSetting(env.DB, 'community_author')) || '';
    return json({ sites: list, author });
  }
  if (path === '/api/sites/community/author' && method === 'PUT') {
    const { author } = await readBody(req);
    await setSetting(env.DB, 'community_author', String(author || '').slice(0, 60));
    return json({ ok: true });
  }    if (path === '/api/sites/community' && method === 'POST') {
    const body = await readBody(req);
    let raw = body.config;
    const url = String(body.url || '').trim();
    if (!raw && url) {
      // 只允许抓公网 http(s) 地址：不能让这个接口变成「探内网」的工具。
      // 注意要用 safePublicFetch 而不是裸 fetch —— 裸 fetch 会自动跟随重定向，
      // 一个公网短链回一句 Location: http://169.254.169.254/… 就绕过了这里的校验。
      const got = await safePublicFetch(url, { headers: { Accept: 'application/json,text/plain,*/*' } });
      if (!got.ok) return json({ error: got.error }, 400);
      try {
        const r = got.res;
        if (!r.ok) return json({ error: `拉取配置失败：HTTP ${r.status}` }, 502);
        raw = (await r.text()).slice(0, 200000);
      } catch (e) {
        return json({ error: '拉取配置失败：' + String((e && e.message) || e) }, 502);
      }
    }
    if (!raw) return json({ error: '请粘贴配置 JSON，或给出配置的原始链接' }, 400);
    const v = validateSiteConfig(raw);
    // 先预览后导入：dry_run=1 时只校验，不写库
    if (body.dry_run) return json({ ok: v.ok, errors: v.errors, warnings: v.warnings, config: v.def || null });
    if (!v.ok) return json({ error: v.errors.join('；'), errors: v.errors }, 400);
    try {
      const r = await importSiteConfig(env.DB, v.def, { overwrite: !!body.overwrite, source: url });
      return json({ ok: true, id: r.id, name: r.def.name, warnings: r.warnings });
    } catch (e) {
      return json({ error: String((e && e.message) || e), need_overwrite: !!e.needOverwrite }, e.needOverwrite ? 409 : 400);
    }
  }
  // 导入前先校验（dry_run）：面板据此显示“这份配置是什么、缺什么、会不会带凭据”
  if (path === '/api/sites/community/check' && method === 'POST') {
    const body = await readBody(req);
    const v = validateSiteConfig(body.config || body || {});
    return json({ ok: v.ok, errors: v.errors, warnings: v.warnings, config: v.def || null });
  }

  const mCommunity = path.match(/^\/api\/sites\/community\/([A-Za-z0-9_\-]+)$/);
  if (mCommunity && method === 'DELETE') {
    await deleteCommunitySite(env.DB, mCommunity[1]);
    return json({ ok: true });
  }
  if (mCommunity && method === 'GET') {
    const list = await listCommunitySites(env.DB);
    const one = list.find((s) => s.id === mCommunity[1]);
    if (!one) return json({ error: '没有导入过这个站点配置' }, 404);
    return json({ config: one.def, meta: { author: one.author, version: one.version, source: one.source } });
  }

  // ---- 反向：把一个账号录好的请求序列导出成可分享的社区配置 ----
  // 这是「开源共建」的另一半：你录一遍 → 导出 JSON → 发到 GitHub → 别人导入即可用。
  const mExport = path.match(/^\/api\/accounts\/(\d+)\/export-config$/);
  if (mExport && method === 'GET') {
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(Number(mExport[1])).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    const creds = await decryptJSON(env, env.DB, acc.creds);
    const meta = siteMeta(await loadCustomSites(env)).find((s) => s.id === acc.site) || {};
    const q = url.searchParams;
    const r = exportAccountConfig(
      { id: acc.id, name: acc.name, site: acc.site, creds },
      meta,
      {
        id: q.get('id') || '',
        name: q.get('name') || '',
        author: q.get('author') || '',
        version: q.get('version') || '',
        desc: q.get('desc') || '',
        source: q.get('source') || '',
      }
    );
    if (!r.ok && r.reason) return json({ error: r.reason }, 400);
    // 把作者默认值写进去：面板设置里的「开源署名」；没设就留空由前端问
    const author = q.get('author') || (await getSetting(env.DB, 'community_author')) || '';
    if (!author) { /* 留空不报错，前端会提示补署名 */ }
    if (author) r.config.author = author;
    return json({ ok: true, config: r.config, warnings: r.warnings, errors: r.errors });
  }

  // 账号列表（不含凭据，含 meta 以便前端渲染站点独立开关）
  if (path === '/api/accounts' && method === 'GET') {
    // 【creds 也要一并取出来，但绝不回传给前端】——
    // 「鼠标悬浮站点名看凭据到期时间」需要解密凭据才能算（WordPress 会话把到期时间写在
    // cookie 值里、Akile 的 JWT 写在 exp 里），所以顺手在这一趟里算好、只回结论，
    // 算完立刻 delete acc.creds（见下面第二趟循环）。
    const { results } = await env.DB.prepare(
      'SELECT id, name, site, enabled, creds, meta, last_status, last_msg, last_detail, last_run_at, created_at, updated_at FROM accounts ORDER BY id'
    ).all();
    const accounts = results || [];
    // ---- 账号行的「状态 + 反馈」自洽性修复（读列表顺手做，不需要用户点任何按钮）----
    //
    // 两种历史脏数据都在这修：
    //   ① 今日有成功记录但 meta 缺 last_signin_date（老版本留下的数据）→ 补上日期；
    //   ② 今日已经签上了、但最近一条记录不是 ok（例如后来的一次补跑撞上中继超时）
    //      → 反馈回填成「今天那次成功」的网站原话。
    //      否则那一行会变成「状态：✅ 已签到 + 反馈：签到失败：…超时」——自相矛盾，
    //      用户只能理解为「面板坏了」。
    //
    // 「今天」必须按**站点自己的日界**算（糊涂鳄按 UTC 计日，北京时间 08:00 才算新的一天）：
    // 拿面板时区去比，00:00–08:00 之间会把昨天的签到当成今天的，显示成「已签到」而实际还没签。
    const customSites = await loadCustomSites(env);
    const panelTz = await scheduleTz(env.DB);
    for (const acc of accounts) {
      let m = {};
      try { m = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
      const tz = ((getSite(acc.site, customSites) || {}).dayTz) || panelTz;
      const today = dayInTz(new Date(), tz);
      const dayStart = dayStartInTz(new Date(), tz);
      // 已经签上、而且最近一条也是成功 → 没什么可补的
      if (m.last_signin_date === today && acc.last_status === 'ok') continue;
      const okRun = await env.DB.prepare(
        "SELECT id FROM runs WHERE account_id = ? AND status = 'ok' AND created_at >= ? LIMIT 1"
      ).bind(acc.id, dayStart).first();
      if (!okRun) continue;
      m.last_signin_date = today;
      acc.meta = JSON.stringify(m);
      // 同时把网站反馈补上（取今日最后一条成功的 message + 网站原文）
      const lastOk = await env.DB.prepare(
        "SELECT message, detail FROM runs WHERE account_id = ? AND status = 'ok' AND created_at >= ? ORDER BY id DESC LIMIT 1"
      ).bind(acc.id, dayStart).first();
      if (lastOk?.message) {
        acc.last_msg = lastOk.message;
        acc.last_status = 'ok';
        acc.last_detail = lastOk.detail || '';
      }
      await env.DB.prepare('UPDATE accounts SET meta=?, last_msg=?, last_status=?, last_detail=?, updated_at=? WHERE id=?')
        .bind(acc.meta, acc.last_msg, acc.last_status, acc.last_detail || '', Date.now(), acc.id).run();
    }
    // ---- 凭据到期时间（鼠标悬浮站点名时的那句话）----
    // 单独一趟：上面那一趟里有 `continue`（今天已经签上的账号会提前跳过），
    // 把这件事混进去会让**已经签到的账号反而看不到有效期** —— 而它恰恰是最该看到的（说明还能撐多久）。
    let encKey = null;
    for (const acc of accounts) {
      const enc = acc.creds;
      delete acc.creds; // 密文（以及任何明文）都不发回前端
      if (!enc) continue;
      try {
        if (!encKey) encKey = await accountKey(env, env.DB);
        const exp = credentialExpiry(await decryptJSONWith(encKey, enc));
        if (exp.sessions.length || exp.tokens.length) acc.cred_exp = exp;
      } catch { /* 凭据解不开（例如换过 ENCRYPT_KEY）不该让整个账号列表挂掉 */ }
    }
    return json({ accounts });
  }

  // 新增账号
  if (path === '/api/accounts' && method === 'POST') {
    const { name, site, creds } = await readBody(req);
    // 【这里必须带上社区站点】/api/sites 是把内置站点 + 已导入的社区站点一起返回的，
    // 所以面板的「站点」下拉里选得到社区站点、表单体检也过。
    // 但这里以前只查内置的 —— 于是一保存就回「未知站点」，
    // 也就是「社区站点看着能选，却永远加不进去」。其它几处（改账号、执行、导出）都带上了。
    const s = getSite(site, await loadCustomSites(env));
    if (!s) return json({ error: '未知站点' }, 400);
    if (!name || !String(name).trim()) return json({ error: '请填写备注名' }, 400);
    for (const f of s.fields) {
      if (f.required && !(creds && String(creds[f.key] || '').trim())) {
        return json({ error: `缺少必填项：${f.label}` }, 400);
      }
    }
    const enc = await encryptJSON(env, env.DB, creds || {});
    const now = Date.now();
    const r = await env.DB.prepare(
      'INSERT INTO accounts(name, site, creds, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?)'
    ).bind(String(name).trim(), site, enc, 1, now, now).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  const mAcc = path.match(/^\/api\/accounts\/(\d+)(\/run)?$/);
  if (mAcc) {
    const id = Number(mAcc[1]);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);

    // 手动执行单个账号
    // （执行方式由 runner.js 统一决定：账号的 meta.execution、站点默认值、
    //   以及「走不通就自动换另一条」都在那里 —— 这里不再重复算一个没人用的 execMode）
    if (mAcc[2] === '/run' && method === 'POST') {
      const r = await runAccount(env, acc);
      return json({ ok: r.status === 'ok', result: r });
    }

    // 读取单个账号（含凭据，用于编辑回填）
    if (!mAcc[2] && method === 'GET') {
      const creds = await decryptJSON(env, env.DB, acc.creds);
      return json({ account: { id: acc.id, name: acc.name, site: acc.site, enabled: acc.enabled, creds } });
    }

    // 更新账号
    if (!mAcc[2] && method === 'PUT') {
      const { name, site, creds, enabled } = await readBody(req);
      const s = getSite(site || acc.site, await loadCustomSites(env));
      if (!s) return json({ error: '未知站点' }, 400);
      // 【换了站点就别再留着上一个站点的凭据】以前 site 能改、creds 不传，
      // 于是库里会出现「站点是 A、凭据是 B 的」这种账号：面板上一点异常都看不出来，
      // 但每次执行必然失败（拿着 B 的 Cookie 去打 A 的接口），用户只会觉得「莫名其妙签不上」。
      if (site && String(site) !== String(acc.site) && !creds) {
        return json({ error: '更换站点后要重新填写凭据（旧站点的 Cookie 不能给新站点用）' }, 400);
      }
      // 【必填项校验】POST 那条路一直有，PUT 漏了：于是「改账号时把一个必填项留空」能存进库，
      // 之后每次执行都失败，而面板要到执行那一刻才报错。用和新增完全一样的规则挡在保存前。
      if (creds) {
        for (const f of s.fields) {
          if (f.required && !String((creds && creds[f.key]) ?? '').trim()) {
            return json({ error: `缺少必填项：${f.label}` }, 400);
          }
        }
      }
      const enc = creds ? await encryptJSON(env, env.DB, creds) : acc.creds;
      await env.DB.prepare('UPDATE accounts SET name=?, site=?, creds=?, enabled=?, updated_at=? WHERE id=?')
        .bind(
          name && String(name).trim() ? String(name).trim() : acc.name,
          site || acc.site,
          enc,
          enabled == null ? acc.enabled : enabled ? 1 : 0,
          Date.now(),
          id
        )
        .run();
      return json({ ok: true });
    }

    // 删除账号
    if (!mAcc[2] && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  // 站点独立开关（如 NodeSeek 随机/固定签到）：切换后存入 accounts.meta.toggles
  const mToggle = path.match(/^\/api\/accounts\/(\d+)\/toggle$/);
  if (mToggle && method === 'POST') {
    const id = Number(mToggle[1]);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    const site = getSite(acc.site, await loadCustomSites(env));
    const { key, value } = await readBody(req);
    const def = site && site.toggles ? site.toggles.find((t) => t.key === key) : null;
    if (!def) return json({ error: '该站点不支持此开关' }, 400);
    let meta = {};
    try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
    meta.toggles = meta.toggles || {};
    meta.toggles[key] = !!value;
    await env.DB.prepare('UPDATE accounts SET meta=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(meta), Date.now(), id).run();
    return json({ ok: true, value: !!value });
  }

  // 账号独立签到时间：PUT /api/accounts/:id/schedule { hour: "08" 或 "" }
  // hour 为 ""（空）表示跟随全局时间；"00"~"23" 为该账号独立的整点小时
  const mSched = path.match(/^\/api\/accounts\/(\d+)\/schedule$/);
  if (mSched && method === 'PUT') {
    const id = Number(mSched[1]);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    const { hour } = await readBody(req);
    const h = String(hour || '').trim();
    if (h !== '' && !validTime(h)) return json({ error: '时间格式错误，请用 HH:MM（如 08:30）' }, 400);
    let meta = {};
    try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
    if (h === '') delete meta.sched_hour;
    else meta.sched_hour = validTime(h);
    await env.DB.prepare('UPDATE accounts SET meta=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(meta), Date.now(), id).run();
    return json({ ok: true, hour: meta.sched_hour || '' });
  }

  // 账号执行模式切换：PUT /api/accounts/:id/execution
  // 在 跟随默认 → browser → server → 跟随默认 之间循环
  // browser：扩展在用户浏览器中执行完整签到脚本 / 经扩展中继 HTTP（真浏览器环境）
  // server：面板本机直接请求（CF 版是机房 IP，Docker 版是 NAS 的家庭 IP）
  const mExec = path.match(/^\/api\/accounts\/(\d+)\/execution$/);
  if (mExec && method === 'PUT') {
    const id = Number(mExec[1]);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    let meta = {};
    try { meta = JSON.parse(acc.meta || '{}'); } catch { /* 忽略 */ }
    const cur = meta.execution || '';
    // 「本地网络 / 浏览器中继」只有浏览器扩展在线时才可用（扩展才是真正的浏览器环境）。
    const { isRelayAvailable } = await import('./lib/relay.js');
    const relayOk = await isRelayAvailable(env.DB);
    let next;
    const { target: want = '' } = await readBody(req);
    if (want === 'local') {
      if (!relayOk) return json({ error: '浏览器扩展当前离线，现在不能切换到「' + (env.RUNTIME === 'docker' ? '浏览器中继' : '本地网络') + '」。请先安装并打开扩展（顶部会显示在线状态），再试。' }, 400);
      next = 'browser';
    } else if (want === 'cf') {
      next = 'server';
    } else if (want === 'default') {
      next = '';
    } else {
      // 无参时循环切换：''（跟随默认） → 浏览器中继/本地网络 → 本机直连/CF 网络 → ''
      // 扩展离线时跳过「浏览器中继」这一档，避免切到一个根本跑不了的模式里出不来
      next = cur === '' ? 'browser' : cur === 'browser' ? 'server' : '';
      if (next === 'browser' && !relayOk) next = 'server';
    }
    if (next === '') delete meta.execution;
    else meta.execution = next;
    await env.DB.prepare('UPDATE accounts SET meta=?, updated_at=? WHERE id=?')
      .bind(JSON.stringify(meta), Date.now(), id).run();
    return json({ ok: true, execution: next || 'default', relay_online: relayOk });
  }

  // 签到时间设置：每天几点（整点，0-23）+ 时区
  if (path === '/api/schedule' && method === 'GET') {
    const time = (await getSetting(env.DB, 'schedule_time')) || '08';
    const tz = (await getSetting(env.DB, 'schedule_tz')) || 'Asia/Shanghai';
    // 心跳：面板据此显示「自动执行还活着吗」。
    // 没有它的时候，定时任务一旦停摆，用户只能看到「账号没签上」，完全不知道为什么。
    let last = null;
    try { last = JSON.parse((await getSetting(env.DB, 'cron_last_result')) || 'null'); } catch { last = null; }
    const cron_at = Number((await getSetting(env.DB, 'cron_last_at')) || '0') || 0;
    return json({ time, tz, last, cron_at });
  }
  if (path === '/api/schedule' && method === 'PUT') {
    const { time, tz } = await readBody(req);
    const h = validTime(time);
    const z = validTz(tz);
    if (!h) return json({ error: '时间格式错误，请用 HH:MM（如 08:30）' }, 400);
    if (!z) return json({ error: '时区无效' }, 400);
    await setSetting(env.DB, 'schedule_time', h);
    await setSetting(env.DB, 'schedule_tz', z);
    return json({ ok: true, time: h, tz: z });
  }

  // 多步录制：不保存，直接试运行 steps（用于编辑时验证）
  if (path === '/api/http-test' && method === 'POST') {
    const { steps } = await readBody(req);
    try {
      const r = await runHttpSteps(Array.isArray(steps) ? steps : []);
      return json({ ok: true, ...r });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) });
    }
  }

  // 手动执行全部启用的账号
  //
  // 【注意：面板 UI 已经不再调它】一个请求串完全部账号在 Cloudflare 上是走不通的 ——
  // 每个账号最坏要等 90 秒（本地中继），Cloudflare 对单个请求有约 100 秒的硬上限
  // （超了直接回 524 页面），浏览器那边更是 60 秒就自己掐断。
  // 面板现在改成逐账号发请求（见 public/index.html 的 btn-run-all），这里保留给 API 调用者。
  if (path === '/api/run-all' && method === 'POST') {
    const r = await runAll(env, { manual: true });
    return json({ ok: true, ...r });
  }

  // 手动「全部执行」的日报推送。
  // 为什么单独一个接口：UI 改成逐账号执行后，就没有一个「跑完全部」的服务端请求了，
  // 而推送日报原本挂在 /api/run-all 上 —— 不补这一下，开了推送的人手动跑一轮就收不到日报
  // （等于把一个已经存在的功能悄悄弄丢）。正文由面板把每一行的真实结果传上来，服务端只负责发。
  if (path === '/api/notify-report' && method === 'POST') {
    const { ok = 0, fail = 0, skip = 0, lines = [] } = await readBody(req);
    const list = (Array.isArray(lines) ? lines : []).slice(0, 60).map((l) => String(l).slice(0, 300));
    const body = `手动任务完成：成功 ${Number(ok) || 0} 个，失败 ${Number(fail) || 0} 个`
      + (Number(skip) ? `，跳过 ${Number(skip)} 个` : '')
      + (list.length ? '\n' + list.join('\n') : '');
    try {
      await sendNotify(env, env.DB, '签到日报', body);
    } catch (e) {
      return json({ error: '推送失败：' + String((e && e.message) || e) }, 502);
    }
    return json({ ok: true });
  }

  // 签到接口自动探测：输入网站首页，自动寻找候选签到接口
  // 面板出口连通性：从 Cloudflare 打几个常见站点（账号页「全局签到」卡右边那排小圆点）
  if (path === '/api/net-check' && method === 'GET') {
    const { checkNet } = await import('./lib/net-check.js');
    try {
      return json(await checkNet());
    } catch (e) {
      return json({ error: '检测失败：' + String((e && e.message) || e) }, 502);
    }
  }

  if (path === '/api/probe' && method === 'POST') {
    const { url, cookie } = await readBody(req);
    if (!url || !/^https?:\/\//i.test(String(url).trim())) {
      return json({ error: '请填写 http(s) 开头的网站地址' }, 400);
    }
    const chk = checkPublicHttpUrl(String(url).trim());
    if (!chk.ok) return json({ error: chk.error }, 400);
    try {
      const r = await probeSignEndpoints({ url: chk.url.href, cookie: String(cookie || '') });
      return json({ ok: true, ...r });
    } catch (e) {
      return json({ error: '探测失败：' + String((e && e.message) || e) }, 502);
    }
  }

  // 运行日志
  if (path === '/api/runs' && method === 'GET') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
    const accountId = parseInt(url.searchParams.get('account_id') || '0', 10) || 0;
    const status = url.searchParams.get('status') || '';
    const conds = [];
    const args = [];
    if (accountId) { conds.push('account_id = ?'); args.push(accountId); }
    if (status === 'ok' || status === 'fail') { conds.push('status = ?'); args.push(status); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { results } = await env.DB.prepare(`SELECT * FROM runs ${where} ORDER BY id DESC LIMIT ?`).bind(...args, limit).all();
    return json({ runs: results || [] });
  }

  // 清空日志（只删 runs，不动 accounts：账号和登录信息不受影响）
  if (path === '/api/runs' && method === 'DELETE') {
    const accountId = parseInt(url.searchParams.get('account_id') || '0', 10) || 0;
    if (accountId) await env.DB.prepare('DELETE FROM runs WHERE account_id = ?').bind(accountId).run();
    else await env.DB.prepare('DELETE FROM runs').run();
    return json({ ok: true });
  }

  // 通知设置
  if (path === '/api/settings' && method === 'GET') {
    return json({ settings: await getNotifyConfig(env, env.DB) });
  }
  if (path === '/api/settings' && method === 'PUT') {
    const b = await readBody(req);
    // 保存前先把明显填错的挡下来：与其等哪天日报发不出去，不如现在就告诉你是哪一格
    const token = String(b.telegram_bot_token || '').trim();
    if (token && !validTelegramToken(token)) {
      return json({ error: 'Telegram Bot Token 格式不对。找 @BotFather 复制完整的一串，形如 123456789:AAE...' }, 400);
    }
    const chat = b.telegram_chat_id !== undefined ? String(b.telegram_chat_id || '').trim() : '';
    if (chat && !validTelegramChatId(chat)) {
      return json({ error: 'Chat ID 应该是一串数字（群/频道是负数），或 @频道名。不确定就点「自动获取」' }, 400);
    }
    // 出站地址（Webhook / Bark 服务器）也要过闸门。
    // 这两格以前只查了「以 http(s):// 开头」，而它们是**面板自己会去 POST 的地址**：
    // 填一个内网地址，每次签到日报就变成一次对内网的探测（而且会把签到结果发过去）。
    // 反正 Worker 根本连不上内网，与其等到「推送失败」再排查，不如保存时就说清楚。
    for (const [field, label] of [['webhook_url', 'Webhook 地址'], ['bark_server', 'Bark 服务器']]) {
      const v = String(b[field] || '').trim();
      if (!v) continue; // 空 = 用默认值，不拦
      const chk = checkPublicHttpUrl(v);
      if (!chk.ok) return json({ error: `${label}不可用：${chk.error}` }, 400);
    }
    await setNotifyConfig(env, env.DB, b);
    return json({ ok: true, settings: await getNotifyConfig(env, env.DB) });
  }

  // ---- 推送：发一条测试消息（只发 Telegram，不打扰其它渠道） ----
  if (path === '/api/notify-test' && method === 'POST') {
    const b = await readBody(req);
    const raw = await readNotifyRaw(env, env.DB);
    // 允许「直接用页面上刚填、还没保存」的值来测试，省一步
    const token = String(b.telegram_bot_token || '').trim() || raw.telegram_bot_token;
    const chat = b.telegram_chat_id !== undefined ? String(b.telegram_chat_id || '').trim() : raw.telegram_chat_id;
    if (!token) return json({ error: '请先填写 Telegram Bot Token' }, 400);
    if (!chat) return json({ error: '请先填写 Chat ID（不确定就点「自动获取」）' }, 400);
    const now = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const r = await sendTelegram(token, chat, '签到面板 · 测试消息', '收到这条消息就说明推送配置成功了 ✅\n发送时间（北京时间）：' + now);
    if (!r.ok) return json({ error: r.error }, 502);
    return json({ ok: true });
  }

  // ---- 推送：自动获取 Telegram Chat ID ----
  // 读取这个 Bot 最近收到过消息的会话。这也是最快搞清楚「Chat ID 填什么」的办法。
  if (path === '/api/notify-telegram-chats' && method === 'POST') {
    const b = await readBody(req);
    const raw = await readNotifyRaw(env, env.DB);
    const token = String(b.telegram_bot_token || '').trim() || raw.telegram_bot_token;
    if (!token) return json({ error: '请先填写 Telegram Bot Token' }, 400);
    if (!validTelegramToken(token)) return json({ error: 'Bot Token 格式不对，形如 123456789:AAE...' }, 400);
    const r = await telegramChats(token);
    if (!r.ok) return json({ error: r.error || '读取失败', chats: [] }, 502);
    return json({ ok: true, chats: r.chats, hint: r.chats.length ? '' : (r.error || '') });
  }

  // NodeSeek 模式（前端设置用）
  if (path === '/api/nodeseek-mode' && method === 'GET') {
    const mode = (await getSetting(env.DB, 'nodeseek_mode')) || 'random';
    return json({ mode });
  }
  if (path === '/api/nodeseek-mode' && method === 'PUT') {
    const { mode } = await readBody(req);
    if (mode !== 'random' && mode !== 'fixed') return json({ error: '无效的模式' }, 400);
    await setSetting(env.DB, 'nodeseek_mode', mode);
    return json({ ok: true });
  }

  // ---- 扩展用 API Key ----
  // 【只显示一次】Key 在生成的那一刻回一次明文，之后任何时候都只能看到掩码。
  // 以前 GET 直接把完整 Key 回给浏览器：任何一次 XSS / 恶意扩展 / 共享屏幕
  // 都能把那串钥匙拿走（它能指挥用户的浏览器用他的登录态发请求）。
  // 而且它**只能重新生成**，不提供「查看」。
  if (path === '/api/ext-key' && method === 'GET') {
    const key = (await getSetting(env.DB, 'external_api_key')) || '';
    // 用环境变量固定下来的 Key（来自 Worker Secret）：面板里生成不会生效，必须如实告诉用户
    const fromSecret = !!(env.EXTERNAL_API_KEY);
    return json({
      has_key: !!key || fromSecret,
      masked: fromSecret ? '（由环境变量 EXTERNAL_API_KEY 固定）' : (key ? key.slice(0, 4) + '…' + key.slice(-4) : ''),
      from_secret: fromSecret,
      created_at: Number((await getSetting(env.DB, 'external_api_key_at')) || 0) || null,
      // 老前端会读 key 这个字段：故意回空串，不再把明文交出去
      key: '',
    });
  }
  if (path === '/api/ext-key/rotate' && method === 'POST') {
    if (env.EXTERNAL_API_KEY) {
      return json({ error: '这个面板把 API Key 固定成了环境变量（EXTERNAL_API_KEY），面板里生成不会生效。请到 Cloudflare 控制台删掉这个 Secret 后再试。' }, 400);
    }
    const key = randomHex(24); // 48 位十六进制，够随机也好复制
    await setSetting(env.DB, 'external_api_key', key);
    await setSetting(env.DB, 'external_api_key_at', String(Date.now()));
    // 明文只在这一刻回一次
    return json({
      ok: true,
      key,
      note: '这串 Key 只显示这一次，关掉页面后就看不到了。请立刻复制到扩展弹窗里保存。',
    });
  }

  // 中继状态（扩展是否在线 + 队列里堆了多少）：前端展示用
  // 单独把 backlog 透出来很重要：线上曾出现「扩展显示在线、但每个请求都超时」，
  // 根因是队列堆了太多请求（扩展单飞执行，一个个慢慢做），面板上却看不出来。
  if (path === '/api/relay-status' && method === 'GET') {
    const last = parseInt((await getSetting(env.DB, 'relay_last_poll')) || '0', 10) || 0;
    const online = Date.now() - last < 90000;
    const version = (await getSetting(env.DB, 'relay_version')) || '';
    const { relayBacklog } = await import('./lib/relay.js');
    const backlog = await relayBacklog(env.DB);
    const latestVersion = (() => { try { return String(JSON.parse(EXT_FILES['manifest.json'] || '{}').version || ''); } catch { return ''; } })();
    return json({ online, last_poll: last, version, latest_version: latestVersion, backlog });
  }

  // 修改管理密码
  if (path === '/api/change-password' && method === 'POST') {
    const { old_password, new_password } = await readBody(req);
    const hash = await getSetting(env.DB, 'admin_hash');
    if (!(await verifyPassword(String(old_password || ''), hash || ''))) {
      return json({ error: '原密码错误' }, 401);
    }
    const np = String(new_password || '');
    if (np.length < 8) return json({ error: '新密码至少 8 位' }, 400);
    await setSetting(env.DB, 'admin_hash', await hashPassword(np));
    // 【重要】改密码 = 把以前所有登录过的浏览器踢下线。
    // 否则「觉得密码泄露了、于是改密码」这件事根本不起作用 —— 偷到的那份会话还能用 7 天。
    await env.DB.prepare('DELETE FROM sessions').run().catch(() => {});
    const sid = await createSession(env);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sid, SESSION_TTL_MS / 1000, req) });
  }

  // ---- 扩展连接状态（面板展示用）----
  if (path === '/api/ext-status' && method === 'GET') {
    const lastSeen = parseInt((await getSetting(env.DB, 'ext_last_seen')) || '0', 10) || 0;
    const lastSigned = parseInt((await getSetting(env.DB, 'ext_last_signed')) || '0', 10) || 0;
    let info = {};
    try { info = JSON.parse((await getSetting(env.DB, 'ext_status')) || '{}'); } catch { /* 忽略 */ }
    let pending = 0;
    try {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM ext_commands WHERE status = 'pending'").first();
      pending = (row && row.n) || 0;
    } catch { /* 忽略 */ }
    return json({
      online: !!lastSeen && Date.now() - lastSeen < 120000,
      last_seen_ago_sec: lastSeen ? Math.floor((Date.now() - lastSeen) / 1000) : null,
      version: info.version || '',
      latest_version: (() => { try { return String(JSON.parse(EXT_FILES['manifest.json'] || '{}').version || ''); } catch { return ''; } })(),
      ua: info.ua || '',
      capabilities: info.capabilities || [],
      signed_recently: !!lastSigned && Date.now() - lastSigned < 600000,
      require_sign: (await getSetting(env.DB, 'ext_require_sign')) === '1',
      pending_commands: pending,
    });
  }

  // ---- 扩展签名策略开关（默认关闭以兼容旧版扩展）----
  if (path === '/api/ext-security' && method === 'GET') {
    return json({ require_sign: (await getSetting(env.DB, 'ext_require_sign')) === '1' });
  }
  if (path === '/api/ext-security' && method === 'PUT') {
    const { require_sign } = await readBody(req);
    await setSetting(env.DB, 'ext_require_sign', require_sign ? '1' : '0');
    return json({ ok: true, require_sign: !!require_sign });
  }

  // ---- 浏览器导航签到：面板点一下，让扩展开标签页去真的打开签到页（适合被 WAF 拦死的站点）----
  // 返回后立即返回，结果由扩展跑完 POST /api/external/report 回填到这一行。
  const mBrowserSign = path.match(/^\/api\/accounts\/(\d+)\/browser-sign$/);
  if (mBrowserSign && method === 'POST') {
    const id = Number(mBrowserSign[1]);
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    const site = getSite(acc.site, await loadCustomSites(env));
    if (!site || typeof site.browserJob !== 'function') {
      return json({ error: '该站点不支持浏览器导航签到（它可以用普通请求直接签）' }, 400);
    }
    const { isRelayAvailable } = await import('./lib/relay.js');
    if (!(await isRelayAvailable(env.DB))) {
      return json({ error: '浏览器扩展离线：浏览器导航签到需要扩展在线（它会用你自己的浏览器打开签到页）' }, 400);
    }
    const now = Date.now();
    await env.DB.prepare('INSERT INTO browser_manual_jobs(account_id, created_at) VALUES(?,?)').bind(id, now).run();
    await env.DB.prepare('DELETE FROM browser_manual_jobs WHERE created_at < ?').bind(now - 3600000).run().catch(() => {});
    const j = site.browserJob(await decryptJSON(env, env.DB, acc.creds).catch(() => ({})), { meta: {} }) || {};
    return json({
      ok: true,
      queued: true,
      site_name: site.name,
      navigate_url: j.navigate_url || site.navigateUrl || '',
      hint: '已交给浏览器扩展：它会打开一个标签页完成签到，完成后自动把结果写回这一行（通常 1 分钟内）',
    });
  }

  // ---- 让扩展帮某个账号打开登录页（登录/过验证后自动把新 Cookie 交接回面板）----
  if (path.startsWith('/api/accounts/') && path.endsWith('/assist') && method === 'POST') {
    const id = Number(path.slice('/api/accounts/'.length, -'/assist'.length));
    const acc = await env.DB.prepare('SELECT id, site, name FROM accounts WHERE id = ?').bind(id).first();
    if (!acc) return json({ error: '账号不存在' }, 404);
    const meta = siteMeta(await loadCustomSites(env)).find((s) => s.id === acc.site) || {};
    const login = meta.login || {};
    const loginUrl = login.url || (meta.domain ? 'https://' + meta.domain + '/' : '');
    if (!loginUrl) return json({ error: '该站点没有登记登录地址，请手动在浏览器打开站点登录后再用扩展抓取' }, 400);
    // 登录地址来自站点元数据（社区站点的话就是「别人的 JSON」）。
    // 不能让一份恶意配置把扩展导航到 http://127.0.0.1:xxxx/ 这类地方 ——
    // 那个页面是攻击者控制的，而扩展会在上面执行抓取 Cookie 的脚本。
    const loginChk = checkPublicHttpUrl(loginUrl);
    if (!loginChk.ok) return json({ error: '这个站点登记的登录地址不能用：' + loginChk.error }, 400);
    const cid = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO ext_commands(id, kind, account_id, domain, login_url, payload, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(cid, 'open_login', id, meta.domain || '', loginUrl,
        JSON.stringify({ site: acc.site, name: acc.name, captcha: login.captcha || 'maybe', note: login.note || '' }),
        'pending', now, now).run();
    return json({ ok: true, command_id: cid, login_url: loginUrl, captcha: login.captcha || 'maybe', note: login.note || '' });
  }

  return json({ error: '未知接口' }, 404);
}

// 由 Worker 自己生成的那些响应（zip 下载、404 等）也补上安全头。
// 静态页面（public/）的头由同目录的 _headers 文件负责，两边保持一致。
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()',
};
function harden(res) {
  if (!res || !res.headers) return res;
  const h = new Headers(res.headers);
  for (const k of Object.keys(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, SECURITY_HEADERS[k]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      await ensureSchema(env.DB);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, env, url);
      // 扩展下载：动态生成 zip，把当前面板地址注入进去（扩展自动带出面板地址；API Key 仍需手动填）
      if (url.pathname === '/cookie-helper-extension.zip') return harden(await handleExtZip(req, env));
      // 旧地址保留（老书签/老文档照旧能下）；新地址不再带版本号
      if (url.pathname === '/checkin-helper.zip') return harden(await handleExtZip(req, env));
      if (url.pathname === '/cookie-plugin-2.2.zip') return harden(await handleExtZip(req, env));
      // 非 API 请求交给静态资源（public 目录）
      if (env.ASSETS) {
        const res = await env.ASSETS.fetch(req);
        // 静态资源存在则直接返回；不存在才回退到 index.html（SPA）
        // 注意这里**故意不包 harden()**：静态资源的头由 public/_headers 管，
        // 在 Worker 里再包一层会把那些规则盖掉（官方文档明确说 _headers 不作用于 Worker 生成的响应）。
        if (res.status !== 404) return res;
      }
      return harden(new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    } catch (e) {
      // 请求体超限（分块传输绕过了 Content-Length 早退）也要报 413，而不是含混的 500
      if (e && e.code === 'BODY_TOO_LARGE') return json({ error: '请求体过大（上限 512KB）' }, 413);
      return json({ error: '服务异常：' + String((e && e.message) || e) }, 500);
    }
  },

  // Cron 触发：每分钟触发一次，按各账号的签到时间（独立时间或全局时间）
  // 判断是否该执行。每个账号独立记录上次执行 key：成功则当天不再跑；
  // 失败/结果未知则隔一会儿自动补跑（见 schedule.js 的 shouldRun / nextLastKey）。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchema(env.DB);
          const globalTime = (await getSetting(env.DB, 'schedule_time')) || '08';
          const tz = (await getSetting(env.DB, 'schedule_tz')) || 'Asia/Shanghai';
          // 各账号上次执行记录：{ accountId: "YYYY-MM-DD HH:MM" }（成功）
          //                    { accountId: "YYYY-MM-DD HH:MM@YYYY-MM-DD HH:MM" }（失败/结果未知，带尝试时刻）
          let lastMap = {};
          try { lastMap = JSON.parse((await getSetting(env.DB, 'sched_last_map')) || '{}'); } catch { /* 忽略 */ }
          // 带上 name：定时日报要按账号名列出来
          const { results } = await env.DB.prepare('SELECT id, site, name, meta FROM accounts WHERE enabled = 1').all();
          const now = new Date();
          // 单次 Cron 的时间预算：宁可少跑几个账号，也不要让本次执行拖过一分钟 ——
          // 上一次还没跑完、下一分钟又来一轮，会同时往中继队列里塞任务，扩展（单飞执行）根本跟不上，
          // 结果就是所有账号一起超时（线上 2026-09-28 的连续刷屏就是这么来的）。
          // 没跑到的账号下一分钟自然会轮到（它们的 key 还没写）。
          const startedAt = Date.now();
          const BUDGET_MS = 45000;
          // 【必须有这一行】以前它只被赋值、没有声明。ES 模块是严格模式，
          // 第一个到点的账号执行到 `changed = true` 就会抛 ReferenceError，
          // 而这个异常被下面那个大 try 吞掉 —— 表现就是：每分钟的定时任务都在
          // 这里整体中断，面板上「时间到了却什么都没发生」，日志里一条都看不到。
          let changed = false;
          let ranCount = 0;
          let okCount = 0;
          let failCount = 0;
          let skipCount = 0;
          const reportLines = [];
          for (const acc of results || []) {
            if (Date.now() - startedAt > BUDGET_MS) break;
            // 【每个账号单独包一层】整段循环共用一个 try 时，任意一个账号抛异常
            // （配置错误、站点模块 bug、D1 抖动…）都会让**后面所有账号都不再执行**，
            // 面板上还看不出任何异常。现在一个账号出问题只影响它自己。
            try {
              // 执行方式交给 runner.js 统一决定（账号 meta.execution 在 runner 里读；
              // 站点默认值也由 runner 用 site.execution / executionFor 处理）。
              const hour = accountHour(acc.meta, globalTime);
              const lastKey = lastMap[String(acc.id)];
              const { run, key, nowKey } = shouldRun(now, hour, tz, lastKey);
              if (!run) continue;
              changed = true;
              ranCount++;
              // 【关键】先持久化「已尝试」再真正执行。
              // 一次签到可能要等中继 90 秒，若 Worker 在这中间被回收，
              // 原来「跑完再一起写」的写法会丢掉这个 key → 下一分钟又跑一遍 → 永远重复。
              // 写失败形态（key@尝试时刻）后：若中途被打断，也只是过 15 分钟再补一次。
              lastMap[String(acc.id)] = nextLastKey(key, nowKey, 'fail');
              await setSetting(env.DB, 'sched_last_map', JSON.stringify(lastMap)).catch(() => {});
              let runRes = null;
              try {
                const full = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(acc.id).first();
                if (full) runRes = await runAccount(env, full);
              } catch (e) {
                console.error('[cron] account', acc.id, e);
              }
              // 成功（或已交给扩展去做）才改成「今天不用再跑」；否则保留失败形态等自动补跑。
              if ((runRes && runRes.status === 'ok') || (runRes && runRes.retryable === false)) {
                lastMap[String(acc.id)] = key;
                await setSetting(env.DB, 'sched_last_map', JSON.stringify(lastMap)).catch(() => {});
              }
              // 日报用：把这一轮的真实结论收起来（status 拿不到就按失败计）
              const st = (runRes && runRes.status) || 'fail';
              if (st === 'ok') okCount++;
              else if (st === 'skip') skipCount++;
              else failCount++;
              const icon = st === 'ok' ? '✅' : st === 'skip' ? '⏭️' : '❌';
              reportLines.push(`${icon} ${acc.name || acc.site}：${String((runRes && runRes.message) || '（无反馈）').slice(0, 200)}`);
              // 账号之间稍作间隔，降低被目标站点限流的概率
              await new Promise((r) => setTimeout(r, 1200));
            } catch (e) {
              console.error('[cron] account', acc.id, e);
            }
          }
          if (changed) await setSetting(env.DB, 'sched_last_map', JSON.stringify(lastMap)).catch(() => {});

          // ---- 后台凭据续期（独立于签到）----
          // 每小时最多跑一轮：把「站点声明了 renew() 的账号」里快过期的凭据提前换新。
          // 故意放在签到主循环之后、且不计入上面的 ranCount/日报 —— 这是保养，
          // 不是签到；续期自己的成败写在账号 meta 里（renew_ok_at / renew_fail_*），
          // 前端「凭据到期时间」悬浮提示会展示，失败且快过期时会推送提醒。
          try {
            const { renewCredentials } = await import('./lib/renew.js');
            const renewRes = await renewCredentials(env, env.DB, await loadCustomSites(env).catch(() => []));
            if (renewRes && renewRes.ran && renewRes.details && renewRes.details.length) {
              console.log('[cron] 凭据续期：' + renewRes.details.join('；'));
            }
          } catch (e) {
            console.error('[cron] 凭据续期失败', e);
          }

          // 心跳：记下「这次自动检查是什么时候跑的、跑了几个」。
          // 没到点的大多数分钟（ranCount=0）不必写库，所以最多半小时写一次 ——
          // 这样面板既能显示「自动执行还活着」，也几乎不增加 D1 写入。
          // 【顺序】心跳要写在推送日报**之前**：webhook 万一挂住不动，
          // 用户至少还能从心跳看出「定时任务确实跑过了」，而不是一片空白。
          const prevBeat = Number((await getSetting(env.DB, 'cron_last_at').catch(() => '0')) || 0) || 0;
          if (ranCount > 0 || Date.now() - prevBeat > 30 * 60000) {
            const beat = { at: Date.now(), ran: ranCount, ok: okCount, total: (results || []).length, planned: changed };
            await setSetting(env.DB, 'cron_last_at', String(beat.at)).catch(() => {});
            await setSetting(env.DB, 'cron_last_result', JSON.stringify(beat)).catch(() => {});
          }

          // ---- 定时签到日报（推送通知）----
          // 【以前只有手动点「全部执行」才会推送】README 承诺的是「每天定时自动签到 + 推签到日报」，
          // 而 runAll()（带推送的那个）只被 /api/run-all 调用，定时任务是逐账号跑 runAccount 的 ——
          // 于是自动签到这条路上**永远收不到任何通知**，用户只能自己回面板看。
          // 现在补上：一轮真的跑了账号就推送一次，同一天只推一次（失败后的自动补跑不再重复刷）。
          if (ranCount > 0) {
            try {
              const reportDay = dayInTz(now, tz);
              if ((await getSetting(env.DB, 'notify_report_day')) !== reportDay) {
                const body = `自动签到：成功 ${okCount} 个 · 跳过 ${skipCount} 个 · 失败 ${failCount} 个\n`
                  + reportLines.join('\n')
                  + '\n（有失败/跳过的，面板会在 15 分钟后自动补跑一次，以面板上的最终结果为准）';
                const { sendNotify } = await import('./notify.js');
                await sendNotify(env, env.DB, '签到日报（自动）', body);
                await setSetting(env.DB, 'notify_report_day', reportDay).catch(() => {});
              }
            } catch (e) {
              console.error('[cron] 推送日报失败', e);
            }
          }
          // 运行日志只保留最近 500 条。
          // （手动「全部执行」那条路一直有这一步，定时这条路没有 —— 而失败重试每小时会写好几条，
          //   长期不清理只会让 runs 表一直长。）
          if (ranCount > 0) {
            await env.DB.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 500)')
              .run().catch(() => {});          }
        } catch (e) {
          console.error('[cron]', e);
        }
      })().catch((e) => console.error('[cron]', e))
    );
  },
};

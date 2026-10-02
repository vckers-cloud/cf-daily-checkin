// 定时/手动执行引擎：遍历启用的账号 → 调用站点模块签到 → 写运行日志 → 推送汇总。

import { ensureSchema, getSetting } from './db.js';
import { decryptJSON, encryptJSON } from './crypto.js';
import { mergeCookies } from './lib/web.js';
import { getSite } from './sites/index.js';
import { listCommunitySites, makeCommunitySite } from './community.js';
import { sendNotify } from './notify.js';
import { dayInTz } from './schedule.js';
import { OUTCOME } from './lib/signals.js';
import { diagnose } from './lib/doctor.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 中继队列超过这个数就先不添乱（扩展单飞执行，堆积 = 集体超时）
const RELAY_BACKLOG_LIMIT = 3;

// ---------- 账号执行锁 ----------
// 【为什么必须要】Worker 的一个 isolate 会**同时**处理多个请求，globalThis 是共享的。
// 而「本地网络」这条路线是靠临时改写 globalThis.fetch 实现的，两个账号同时跑就会：
//
//   A：记住「原 fetch」→ 改成中继
//   B：记住的「原 fetch」其实是 A 的中继版本 → 又改成自己的中继
//   A 跑完 → 还原成**真原版**（此时 B 还在跑：B 的请求已经不再经过中继了）
//   B 跑完 → 还原成它记住的那份 = **中继版本**
//
// 最后那一步会让改动永久留在 isolate 里：之后任何标着「CF 网络」的账号，
// 请求都会被静默地借用户的浏览器发出去（直到 isolate 被回收），而面板上一个字都不会显示。
// 反向的情况同样坏：标着「本地网络」的账号可能实际走的是 CF 直连 ——
// 用户看到的结论与真实出口相反，是最难查的那类 bug。
//
// 所以：**同一时刻只允许一个账号在跑**。这不是为了省资源，而是因为
//   ① 签到是写操作，本来就不该并发（同一次签到发两遍不是无害的）；
//   ② 扩展端本来就是**单飞**执行中继任务，并发塞进去只会一起排队超时。
// 代价：两个手动的「执行」会排队而不是并行 —— 这正是我们想要的。
let ACCOUNT_LOCK = Promise.resolve();
function withAccountLock(fn) {
  const run = ACCOUNT_LOCK.then(fn, fn);
  // 排队链不能因为某一轮抛错而断掉：吞掉结果，只留顺序
  ACCOUNT_LOCK = run.then(() => {}, () => {});
  return run;
}
// 仅供测试：等所有排队的执行跑完（生产代码不要用）
export function accountLockIdle() {
  return ACCOUNT_LOCK;
}
// 凭据续期（src/lib/renew.js）与签到共用同一把账号锁：同一账号的签到和续期
// 不能同时跑（都会读写它的凭据）。
export { withAccountLock };
// 仅供测试：Set-Cookie 静默回写（生产代码走 runAccount 内部调用）
export { applyCookieRefresh };

// 执行路线的对外名字（面板「网站反馈」里会带上，排障时一眼能看出这次请求从哪个网络出去）
// Cloudflare 版叫「CF 直连 / 本地网络」；Docker 版没有 Cloudflare 机房，
// 叫「本机直连 / 浏览器中继」才诚实（NAS 本来就在本地网络，"本地网络"的真实含义是"走真实浏览器"）。
export const ROUTE_NAME = { server: 'CF 直连', relay: '本地网络' };
export function routeName(env, route) {
  if (env && env.RUNTIME === 'docker') {
    return route === 'relay' ? '浏览器中继' : route === 'server' ? '本机直连' : (ROUTE_NAME[route] || route);
  }
  return ROUTE_NAME[route] || route;
}

// 是否跑在 Node.js 上（Docker 版 / 本地 node）。
// Cloudflare Workers 里没有 process.versions.node（且 navigator.userAgent 带 Cloudflare-Workers），
// 需要 TCP 长连接的站点（如 Telegram 的 MTProto）只能在这里返回 true 的环境跑。
export function isNodeRuntime() {
  try {
    if (typeof navigator !== 'undefined' && /cloudflare-workers/i.test(navigator.userAgent || '')) return false;
    return typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  } catch {
    return false;
  }
}

// 纯函数：要不要因为「需要 Node.js」拦截这个站点。onNode 由调用方传 isNodeRuntime()，
// 抽出来是为了单测能确定性地覆盖 Workers/Node 两种分支。
export function needNodeSkip(site, onNode) {
  if (site && site.requiresNode && !onNode) {
    return `${site.name}：需要 Docker 版才能跑（要 TCP 长连接，Cloudflare Workers 没有）。请用 docker compose 部署后再启用此账号，步骤见 docker/README.md「Telegram 签到」。`;
  }
  return null;
}

// 把一条路线的失败压成几个字，给面板上那一行用。
//
// 为什么要压：面板「网站反馈」列一行只有两百多像素宽，把 `HTTP 403 Forbidden
// Client IP 172.70.215.118 reason:UrlACL` 这种原文搬进去，用户能看到的只有开头两个词。
// 完整原因照旧留在日志与错误信息里（要排障看那个），面板上只需要「换了、为什么换」。
export function shortReason(e) {
  const m = String((e && e.message) || e || '');
  if (/UrlACL|Forbidden|Client IP|\b40[13]\b/.test(m)) return '被机房 IP 拦';
  // 「执行完了但响应丢了」优先级要高于下面的「扩展不在线」：
  // 这条错误里也带「扩展」两字（是扩展执行了请求），但它不是离线，别误导用户。
  if (/空响应|没把网站的响应带回来/.test(m)) return '没带回响应';
  if (/没等到回包|没有回包|没收到回包|结果未知/.test(m)) return '没等到回包';
  if (/超时|timeout|timed out/i.test(m)) return '超时';
  if (/fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN|socket|handshake|certificate|SSL|TLS/i.test(m)) return '连不上';
  if (/扩展/.test(m)) return '扩展不在线';
  return m.replace(/\s+/g, ' ').slice(0, 20);
}

// 「换一条网络路线重试可能有救」的失败长什么样？
//
// 线上 2026-09-28 的教训（糊涂鳄 dj.hutue.cn）：该站从 Cloudflare 直连**完全正常**
// （首页 200、签到接口 0.4 秒回 {"status":"0","msg":"今日已签到，请明日再来"}），
// 但旧策略是「扩展在线就一律走本地中继」；中继是单飞执行，前面吾爱破解的浏览器工单
// 要占掉将近一分钟，糊涂鳄被挤成「中继执行超时（45秒）」→ 面板记「失败」，
// 可网站那边其实早就签好了。用户看到的就是「面板跟网站对不上」。
//
// 所以失败必须分两类：
//   · 网络层失败（中继没人接单 / 没等到回包 / 连不上 / 被机房 IP 拦）→ 换个出口真的可能不一样；
//   · 站点明确回答（Cookie 已失效 / 要人机验证 / 业务失败）→ 换个出口结果一模一样，
//     再打一遍只会白等，还可能在同一分钟里连打两次签到接口。
export function isRouteFailure(e) {
  const msg = String((e && e.message) || e || '');
  const outcome = (e && e.outcome) || '';
  if (outcome === 'relay' || outcome === 'relay-unknown' || outcome === OUTCOME.WAF) return true;
  // 【踩坑 2026-09-29】这里原本写的是字面量 `'need-login'`，而 signals.js 里
  // OUTCOME.NEED_LOGIN 的值是 `'need_login'`（下划线）—— 两边对不上，于是
  // 「站点已给出业务结论（未登录）→ 不换路线」这条规则**从来没生效过**：
  // 只要错误文案里恰好出现「超时 / 本地网络 / fetch failed」之类的词，
  // 面板就会换另一条网络出口把同一个签到接口再打一遍。
  // 改用真常量，并新增 route.test.mjs 的用例钉住这一条。
  if (outcome === OUTCOME.CAPTCHA || outcome === OUTCOME.NEED_LOGIN) return false;
  return /中继|本地网络|没等到回包|没有回包|没收到回包|超时|timeout|timed out|fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN|socket|handshake|certificate|SSL|TLS|UrlACL|Forbidden|HTTP 5\d\d/i.test(msg);
}

// 把一个账号排进「浏览器导航签到」队列（去重：同一账号 10 分钟内已排过就不再排）。
// 为什么必须去重：定时器每次失败都可能触发一次改道，原来不去重会排出一堆工单，
// 扩展那边就会反复开标签页签到（线上吾爱破解曾每分钟被排一次）。
async function queueBrowserJob(db, accountId) {
  try {
    const dup = await db
      .prepare('SELECT id FROM browser_manual_jobs WHERE account_id = ? AND created_at > ? LIMIT 1')
      .bind(accountId, Date.now() - 10 * 60000)
      .first();
    if (dup) return false;
    await db.prepare('INSERT INTO browser_manual_jobs(account_id, created_at) VALUES(?,?)').bind(accountId, Date.now()).run();
    return true;
  } catch {
    return false;
  }
}

// 「今天」以哪个时区为准：跟随面板设置里的 schedule_tz（默认 Asia/Shanghai）。
// 状态列跨零点重置需要和签到时间用同一个时区，否则会差一天。
async function scheduleTz(db) {
  try { return (await getSetting(db, 'schedule_tz')) || 'Asia/Shanghai'; } catch { return 'Asia/Shanghai'; }
}

// ---- Set-Cookie 静默回写（OpenList 式凭据续期）----
// 站点模块签到成功后，可通过 res.cookieRefresh 带回网站轮换下来的新 Cookie
//（"name=value; name2=value2"）。这里就地合并进账号凭据并加密存回 D1，
// 下一次执行直接用新 Cookie —— 参考 OpenList quark 驱动静默回写 __puus 的做法。
// 覆盖三种存法：① 标准 cookie 字段；② 自定义 HTTP 单步的 headers JSON 里的 Cookie 头；
// ③ 多步/社区站点的每个步骤 headers 里带 Cookie 头的。
// 只在调用方确认签到成功（res.ok）后调用：失败时的 Set-Cookie 可能是登出态，
// 合并进去会把还能用的旧 Cookie 覆盖掉。
// 返回 true = 凭据确实变了并已存库。
async function applyCookieRefresh(env, db, account, creds, refresh) {
  const fresh = String(refresh || '').trim();
  if (!fresh) return false;
  let changed = false;
  // ① 标准 cookie 字段（v2ex / kanxue / misign 等）
  if ('cookie' in creds || String(creds.cookie || '')) {
    const oldC = String(creds.cookie || '');
    const merged = mergeCookies(oldC, fresh);
    if (merged !== oldC) { creds.cookie = merged; changed = true; }
  }
  // ②/③ headers JSON（自定义 HTTP 单步 / 多步 / 社区站点）
  const mergeHeaderJson = (jsonStr) => {
    let h;
    try { h = JSON.parse(String(jsonStr || '')); } catch { return null; }
    if (!h || typeof h !== 'object') return null;
    const key = Object.keys(h).find((k) => String(k).toLowerCase() === 'cookie');
    if (!key) return null;
    const oldC = String(h[key] || '');
    // 模板写法（{"Cookie": "{{cookie}}"）：真值在 creds.cookie 里，① 已处理，这里不动
    if (oldC.includes('{{')) return null;
    const merged = mergeCookies(oldC, fresh);
    if (merged === oldC) return null;
    h[key] = merged;
    return JSON.stringify(h);
  };
  if (creds.headers) {
    const nh = mergeHeaderJson(creds.headers);
    if (nh) { creds.headers = nh; changed = true; }
  }
  if (Array.isArray(creds.steps)) {
    for (const st of creds.steps) {
      if (!st || !st.headers) continue;
      const nh = mergeHeaderJson(st.headers);
      if (nh) { st.headers = nh; changed = true; }
    }
  }
  if (!changed) return false;
  // 加密写回：失败就抛，调用方把失败记进 detail，但不影响本次签到结论
  const enc = await encryptJSON(env, db, creds);
  await db.prepare('UPDATE accounts SET creds = ?, updated_at = ? WHERE id = ?')
    .bind(enc, Date.now(), account.id).run();
  return true;
}

export async function runAccount(env, account) {
  const db = env.DB;
  const t0 = Date.now();
  let status = 'ok';
  let message = '';
  let detail = ''; // 网站原始回馈（站点模块可返回 detail），日志页展示
  let meta = {};
  let handedOff = false; // 已交给扩展去执行（不需要定时器再重试）
  // 换路记录：它是唯一能说清楚「面板为什么多打了一次」的线索，
  // 所以声明在 try 外面 —— 失败路径（catch）也要能把它写进 meta。
  const switchNotes = [];
  // 每条路线「现在能不能用」的结论也放外面：失败提示要能告诉用户
  // 「另一条路线是用不了还是没试过」，两句话的下一步完全不同。
  let routeState = [];
  // 这次实际试过的路线（catch 里要说清「另一条到底试没试」）
  const triedRoutes = [];
  try {
    meta = JSON.parse(account.meta || '{}');
  } catch { /* 忽略 */ }

  // 社区导入的站点（声明式配置）也在这里注册起来：账号可能用的是社区站点
  let customSites = [];
  try {
    customSites = (await listCommunitySites(db)).map((r) => makeCommunitySite(r.def));
  } catch { /* 老库没有 community_sites 表时忽略 */ }

  try {
    const site = getSite(account.site, customSites);
    if (!site) throw new Error('未知站点：' + account.site);
    // 需要 Node.js 的站点（如 Telegram 签到用的 MTProto 要 TCP 长连接）：
    // Cloudflare Workers 没有 TCP，进路线解析没有意义 —— 直接记一条说清楚的失败，
    // 不重试（retryable: false），免得每 15 分钟空转一次还写一堆看不懂的日志。
    const needNodeMsg = needNodeSkip(site, isNodeRuntime());
    if (needNodeMsg) {
      const now = Date.now();
      const duration = now - t0;
      await db
        .prepare('INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind(account.id, account.site, account.name, 'fail', needNodeMsg, '', duration, now)
        .run();
      await db
        .prepare('UPDATE accounts SET last_status=?, last_msg=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
        .bind('fail', needNodeMsg, now, JSON.stringify(meta), now, account.id)
        .run();
      return { status: 'fail', message: needNodeMsg, duration_ms: duration, retryable: false };
    }
    // 先把凭据解出来：路线默认值可能是**按站点地址**决定的（见下面的 executionFor），
    // 同一个站点模块可能管着多个域名，默认路线不一定相同。
    const creds = await decryptJSON(env, db, account.creds);
    const ctx = { env, db, account, meta };

    // ---- 执行路线解析（路线 = 这些 HTTP 请求从哪个网络出去）----
    // server = Cloudflare 机房直连；relay = 借用户本机网络（浏览器扩展中继）。
    //
    // 说明：原「浏览器模式」已并入本地中继。MV3 禁止 new Function，扩展无法执行面板下发的脚本，
    // 所以站点逻辑仍保留在 Worker，只把 HTTP 请求交给扩展在用户本地网络中发出（带用户 Cookie）。
    //
    // 规则：
    //   ① 手动指定（面板切换，meta.execution）→ 只走那一条，绝不偷偷换（用户明确要求的行为要尊重）。
    //   ② 自动：优先「上次真正走通的那条路线」（meta.exec_route），没有记录时按站点默认
    //      （server 站先试直连，browser 站先试本地网络）；失败且属于网络层 → 换另一条再试一次。
    //   ③ 站点已有明确结论（Cookie 失效 / 人机验证 / 业务失败）→ 不换路，见 isRouteFailure 的说明。
    const manual = meta.execution || '';
    // 站点默认路线：优先问站点模块（它能按具体域名回答），否则用站点声明的静态值。
    // 为什么需要按域名问：糊涂鳄这一个模块管两个独立站 ——
    //   dj.hutue.cn 从 CF 直连完全正常；hutue.cn 从 CF 连**首页**都被站点 WAF 回
     //   `error code: 1002`（实测 2026-09-28），只能走本地网络。
    const siteDefault = (typeof site.executionFor === 'function' ? site.executionFor(creds && creds.site_url) : '') || site.execution || 'server';
    const lastRoute = meta.exec_route === 'relay' || meta.exec_route === 'server' ? meta.exec_route : '';
    let routePlan;
    // 手动固定的那条路线**优先**，但另一条仍然留作兜底。
    //
    // 【语义修正 2026-09-28】原先把「手动固定」实现成「只走这一条，绝不用另一条」：
    // 用户把 hutue.cn 固定成「CF 网络」后，而该域名从 CF 机房 IP 连首页都被站点 WAF
    // 回 `error code 1002`（同日实测），于是每一轮都注定失败 —— 账号永远签不上，
    // 面板上只有一句「遇到网站安全防护」。可那个账号走「本地网络」本来是能签的。
    // 固定的本意是「优先用我指定的这条」，不是「宁可不签到也不用另一条」：
    // 现在真的改走了会在「网站反馈」里写明「手动固定的 X 对本站不通，已临时改走 Y」，
    // 并提示把「执行方式」切回「自动」，用户随时可以改回只走那一条。
    const pinnedRoute = (manual === 'relay' || manual === 'browser') ? 'relay' : (manual === 'server' ? 'server' : '');
    // 兜底与失败提示都要用到「手动固定的是哪条」，所以在这里定下来（catch 里取不到 try 内的局部量）。
    const pinnedForPlan = pinnedRoute;
    if (pinnedRoute) routePlan = [pinnedRoute, pinnedRoute === 'relay' ? 'server' : 'relay'];
    else {
      // 站点默认路线：'relay'/'browser' 都表示「先走本地网络」，其余按「先走 CF 直连」。
      // （踩过：以前只认 'browser'，于是站点按域名返回的 'relay' 默认值被默默当成 server，
      //    hutue.cn 就会先去 CF 白撞一次 WAF。）
      const firstRoute = lastRoute || (siteDefault === 'browser' || siteDefault === 'relay' ? 'relay' : 'server');
      routePlan = firstRoute === 'relay' ? ['relay', 'server'] : ['server', 'relay'];
    }

    const { isRelayAvailable, relayBacklog } = await import('./lib/relay.js');
    let skipReason = '';
    // 每条路线「现在能不能用」：直连总能试；本地中继要扩展在线、且队列不忙。
    for (const route of routePlan) {
      if (route !== 'relay') { routeState.push({ route }); continue; }
      if (!(await isRelayAvailable(db))) {
        // 文案不写死「切到云端执行」：固定走 CF 网络的账号看到这句会莫名（它本来就在 CF 上）。
        routeState.push({ route, skip: '需要浏览器扩展在线（本地网络中继）。请安装并打开扩展（顶部会显示在线状态）后重试；若该站从 CF 网络也能访问，可在「执行方式」里选「CF 网络」。' });
      } else if ((await relayBacklog(db)) >= RELAY_BACKLOG_LIMIT) {
        // 扩展是单飞执行，队列已经堆了请求：现在再排只会一起超时（会记成失败）。
        routeState.push({ route, skip: '本地中继正忙（队列里还有未完成的请求，扩展会按顺序一个个执行），本次先跳过，稍后会自动重试。' });
      } else {
        routeState.push({ route });
      }
    }
    const runnable = routeState.filter((s) => !s.skip);
    // 固定那条路线现在**根本跑不了**（扩展离线 / 中继队列积压）时，不许拿另一条偷偷顶替：
    // 这两种情况都是「此刻做不了」，不是「这条路对这个站点不通」——
    // 如实报「跳过 · 稍后自动重试」，用户看得见原因，想换也随时能换。
    // （真正会触发兜底的是另一件事：固定的那条**跑过了**且因网络层原因没成，见下面的换路逻辑。）
    const pinnedSkipped = pinnedForPlan ? routeState.find((s) => s.route === pinnedForPlan && s.skip) : null;
    if (pinnedSkipped) {
      skipReason = `已固定走「${routeName(env, pinnedForPlan)}」，但现在用不了：${pinnedSkipped.skip}`;
    } else if (!runnable.length) {
      skipReason = routeState.map((s) => s.skip).filter(Boolean).join(' ') || '没有可用的执行路线';
    }
    // 只能靠浏览器导航签到的站点（如吾爱破解）：扩展离线时「脚本化 + 中继」本身毫无意义，
    // 直接记「跳过 + 稍后自动重试」，别去云端白打一次注定被 WAF 拦的请求。
    if (typeof site.browserJob === 'function' && site.preferNavigationSign && !(await isRelayAvailable(db))) {
      skipReason = `${site.name}：该站点只能由浏览器完成签到（脚本化请求会被 WAF 拦死），但浏览器扩展当前离线 —— 打开浏览器后会自动重试`;
    }

    if (skipReason) {
      // 执行模式需要扩展但扩展不在线：不记为失败，记为跳过；不覆盖上次网站真实回馈。
      // retryable：这类跳过是暂时的（用户一会儿打开浏览器就能签），定时器该自动补跑。
      delete meta.route_note; // 本次没真正出去过请求，别让上一轮的路线记录冒充本次结果
      const duration = Date.now() - t0;
      const now = Date.now();
      await db
        .prepare('INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind(account.id, account.site, account.name, 'skip', skipReason, '', duration, now)
        .run();
      await db
        .prepare('UPDATE accounts SET last_status=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
        .bind('skip', now, JSON.stringify(meta), now, account.id)
        .run();
      return { status: 'skip', message: skipReason, duration_ms: duration, retryable: true };
    }

    // ---- 被 WAF 整站拦死的站点：不在这里白等，直接交给「浏览器导航签到」----
    // 吾爱破解（www.52pojie.cn）的网宿 WAF 会让**脚本化请求整站读不到**：
    // 实测 2026-09-28，同一浏览器里 example.com / static.52pojie.cn 都是 200，
    // 而主站的 robots.txt、portal.php、home.php 全部挂到超时（45s/90s 白白浪费，
    // 用户看到的就是「本地网络执行失败：中继执行超时」）。这种站点只有**真实页导航**
    // 能过挑战，所以把任务入队，由扩展打开标签页完成（等同人手点一下）。
    if (typeof site.browserJob === 'function' && site.preferNavigationSign) {
      const { isRelayAvailable } = await import('./lib/relay.js');
      if (await isRelayAvailable(db)) {
        const now = Date.now();
        await queueBrowserJob(db, account.id);
        delete meta.route_note; // 交给浏览器去做了，本次没有脚本化路线可言
        const msg = `${site.name}：已交给浏览器执行 —— 该站点的脚本化请求会被 WAF 拦死（本地中继读不到），改由扩展打开标签页完成签到，结果通常 1 分钟内自动写回这一行`;
        const duration = Date.now() - t0;
        await db
          .prepare('INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)')
          .bind(account.id, account.site, account.name, 'skip', msg, '', duration, now)
          .run();
        await db
          .prepare('UPDATE accounts SET last_status=?, last_msg=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
          .bind('skip', msg, now, JSON.stringify(meta), now, account.id)
          .run();
        // 已经交给扩展去做了（谁去做、做没做由扩展写回），定时器不要再排一次
        return { status: 'skip', message: msg, duration_ms: duration, retryable: false };
      }
    }

    // 逐条路线尝试：网络层失败才换下一条，站点给出的业务结论一律照实回报。
    //
    // 【整段包在账号锁里】不只是「走中继」那一段 —— 直连的那一轮同样要串起来：
    // 中继是靠改写 globalThis.fetch 实现的，只要它改着，**同一 isolate 里任何**
    // 直连请求也会一并被劫持（用户看到「CF 网络」，实际走的是他家宽带）。
    // 顺序、还原、异常路径的细节见文件顶部 withAccountLock 的说明。
    let res = null;
    let lastErr = null;
    let usedRoute = '';
    await withAccountLock(async () => {
      for (const st of runnable) {
        triedRoutes.push(st.route);
        try {
          if (st.route === 'relay') {
            // 中继模式：透明替换 global fetch，站点代码无需修改，HTTP 经扩展走用户本地网络
            const { relayFetch } = await import('./lib/relay.js');
            // 还原目标是「进这一段之前的那份 fetch」。
            // 它可能不是真的全局 fetch（测试台架会临时替换它，那是故意为之），
            // 但**一定不是另一个账号的中继版本** —— 同一时刻只可能有一个账号在跑（上面的锁）。
            const prevFetch = globalThis.fetch;
            globalThis.fetch = (url, init) => relayFetch(db, url, init);
            // 告知站点模块「当前走本地网络」：重定向无法用 manual（opaqueredirect 读不到头），需改用 follow
            ctx.relayDb = db;
            try {
              res = await site.run(creds, ctx);
            } finally {
              globalThis.fetch = prevFetch;
              delete ctx.relayDb;
            }
          } else {
            res = await site.run(creds, ctx);
          }
          usedRoute = st.route;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const alt = runnable.find((s) => !triedRoutes.includes(s.route));
          // 「结果未知」例外：请求**已经发出去了**，只是没等到回包 —— 换个出口再发一遍
          // 可能把同一次签到写两次，而且换条路也问不出「上一条到底送达没有」。
          // 这种如实记「结果未知」并交给自动补跑复核（站点模块自己会重打同一接口确认），
          // 比赌一次重发更靠谱。其余网络层失败（被机房 IP 拦、连不上、空响应）才是真该换路。
          const unknown = (e && e.outcome) === 'relay-unknown';
          if (alt && isRouteFailure(e) && !unknown) {
            // 这条网络出口不行，换另一条。记下来写进「网站反馈」，让用户能看出面板做了什么。
            switchNotes.push(`${routeName(env, st.route)}失败（${shortReason(e)}）`);
            continue;
          }
          throw e;
        }
      }
    });
    if (lastErr) throw lastErr;
    // 记住真正走通的路线：下次优先用它，省掉一次注定失败的尝试
    if (usedRoute) meta.exec_route = usedRoute;
    // Set-Cookie 静默回写：站点签到成功且网站轮换了 Cookie 时，就地合并存回 D1。
    // 回写失败只记进 detail（下次还会再试），不影响本次签到结论。
    if (res && res.ok && typeof res.cookieRefresh === 'string' && res.cookieRefresh.trim()) {
      try {
        if (await applyCookieRefresh(env, db, account, creds, res.cookieRefresh)) {
          meta.cookie_refreshed_at = Date.now();
        }
      } catch (e) {
        detail = (detail ? detail + '｜' : '') + 'Cookie 回写失败：' + String((e && e.message) || e).slice(0, 120);
      }
    }
    // 这次实际走的路线 + 换路记录。单独存在 meta 里（不塞进 detail）：
    // detail 是「网站原话」，要被反馈分类器读，混进我们自己的话会污染判断
    // （比如换路记录里的「超时」二字会让面板误报一条超时建议）。
    //
    // 手动固定却改走了另一条：必须明说，并且写清「这是临时兜底、固定值没变」。
    // 否则用户看到「明明固定了 CF 网络，怎么走成本地网络了」会以为是面板乱来。
    const pinnedFallback = pinnedForPlan && usedRoute && usedRoute !== pinnedForPlan;
    meta.route_note = !switchNotes.length
      ? `路线：${routeName(env, usedRoute) || '未知'}`
      : pinnedFallback
        ? `手动固定的「${routeName(env, pinnedForPlan)}」对本站不通（${switchNotes.join('；')}），已临时改走「${routeName(env, usedRoute)}」——固定值没有改，想让面板自己挑路线就点「执行方式 → 自动」`
        : `自动改走 —— ${switchNotes.join('；')}`;

    status = res.ok ? 'ok' : 'fail';
    message = String(res.message || '').slice(0, 800);
    detail = String(res.detail || '').slice(0, 800);
  } catch (e) {
    const rawMsg = String((e && e.message) || e);
    detail = String((e && e.detail) || '').slice(0, 800);
    // 本次没有走通的路线：把「换过路但都没成」如实写下来
    //（好过让上一轮的路线记录冒充本次结果 —— 那才是真正的假状态）
    if (switchNotes.length) meta.route_note = `两条路线都没成功 —— ${switchNotes.join('；')}`;
    else delete meta.route_note;
    const siteObj = getSite(account.site, customSites);
    // 中继超时 + 该站点支持浏览器导航签到 → 自动改道（省得用户每次都看 45 秒超时）
    if (typeof siteObj?.browserJob === 'function' && /中继请求超时|中继执行超时|等待本地网络响应超时/.test(rawMsg)) {
      try {
        await queueBrowserJob(db, account.id);
        status = 'skip';
        handedOff = true;
        message = `${siteObj.name}：本地中继读不到该站点（被 WAF 拦死），已自动改用浏览器导航签到（扩展会打开标签页完成），结果稍后自动写回`;
      } catch {
        status = 'fail';
        message = rawMsg.slice(0, 800);
      }
    } else if (e && e.outcome === 'relay-unknown') {
      // 本地中继没等到回包：请求**可能已经送达**站点（签到可能已生效），只是响应丢了。
      // 这时既不能报成功（没凭据），也不能报失败（冤枉站点，用户看到「失败」但网站其实签了）。
      // 记为「结果未知」，不写 last_signin_date（不冒充成功），并让定时器稍后自动补跑复核。
      status = 'skip';
      message = rawMsg.slice(0, 800);
    } else {
      status = 'fail';
      message = rawMsg.slice(0, 800);
    }

    // 「手动固定了一条路线、而这条路对本站根本走不通」时，只写「失败」会让人以为站点坏了。
    //
    // 实测依据（2026-09-28）：hutue.cn 从 CF 机房直连连**首页**都被站点 WAF 回
    // `error code: 1002`（同站的 dj.hutue.cn 从 CF 直连却完全正常）；而本机 IP 直连同一个
    // 签到接口 178ms 就回 {"status":"0","msg":"今日已签到，请明日再来"}。
    // 也就是说：站点没问题、面板也没问题，是「手动指定的那条出口」不对。
    // （用 meta.execution 而不是 try 里的 manual：那个变量在 try 作用域内，catch 里取不到）
    const pinned = String(meta.execution || '');
    if (pinned && isRouteFailure(e)) {
      const pinRoute = (pinned === 'browser' || pinned === 'relay') ? 'relay' : 'server';
      const cur = routeName(env, pinRoute) || pinned;
      const otherRoute = pinRoute === 'relay' ? 'server' : 'relay';
      // 另一条路线这次是「用不了」还是「试了也没成」？两种情况给的话必须不一样：
      //   · 用不了（如扩展不在线）→ 打开浏览器/装扩展就会自动重试，切「自动」也救不了；
      //   · 试了没成 → 说明两条都不通，用户该去查 Cookie / 站点状态。
      const otherSkip = (routeState.find((s) => s.route === otherRoute) || {}).skip || '';
      const triedOther = triedRoutes.includes(otherRoute);
      const advice = otherSkip
        ? `另一条「${routeName(env, otherRoute)}」现在也用不了：${otherSkip}`
        : triedOther
          ? `另一条「${routeName(env, otherRoute)}」也试过了，同样没成 —— 两条出口都不通，多半是 Cookie 失效或站点在维护`
          : `把该账号的「执行方式」切回「自动」，面板会改走「${routeName(env, otherRoute)}」重试`;
      message = (message + `　（当前固定走「${cur}」，这条路线对本站不通；${advice}）`).slice(0, 1000);
    }
  }

  const duration = Date.now() - t0;
  const now = Date.now();
  // 失败自诊断：给日志加一句能直接照着做的建议（成功/跳过不打扰）
  const diag = diagnose({ status, message, detail, runtime: env && env.RUNTIME });
  if (diag) message = (message + '｜' + diag).slice(0, 1000);
  await db
    .prepare('INSERT INTO runs(account_id, site, name, status, message, detail, duration_ms, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(account.id, account.site, account.name, status, message, detail, duration, now)
    .run();
  // 站点可以用 dayTz 声明自己的「一天」从几点算起，默认跟面板设置一致。
  // 踩过的坑：糊涂鳄（WordPress + RiPro）按 UTC 计日，也就是北京时间 08:00 才重置。
  // 若一律按面板的北京时间记「今天」，08:00 之后面板会继续显示「已签到」，
  // 而站点那边其实已是新的一天（用户手动点签到还能领到积分）——看起来就像「假签到」。
  const siteDayTz = (getSite(account.site, customSites) || {}).dayTz || '';
  const effDayTz = siteDayTz || (await scheduleTz(db));
  const todayKey = dayInTz(new Date(now), effDayTz);

  // 签到成功时记录「今日」已签到日期（用于状态列显示 已签到/未签到）。
  // 只有 status === 'ok' 才写：fail / skip 一律不写，保证过了当地 00:00
  // 状态统一回到「未签到」，而只有当天真正签到成功才变回「已签到」。
  if (status === 'ok') meta.last_signin_date = todayKey;

  // ---- 账号行上的「状态 + 反馈」必须自洽 ----
  // 线上真实现象（糊涂鳄）：今天 10:54 已经签上了，12:07 的一次补跑撞上中继超时，
  // 于是那一行变成「状态：✅ 已签到 + 反馈：签到失败：……超时」—— 自相矛盾，
  // 用户只能理解为「面板坏了」。今天既然已经签上了，这一行就该继续显示**今天那次成功**的原话。
  // 这次失败并不隐藏：它完整写在运行日志里（上面的 INSERT 已经落库），
  // 只是不该让它冒充「今天的结果」。
  let rowStatus = status;
  let rowMsg = message;
  let rowDetail = detail || '';
  if (status !== 'ok' && meta.last_signin_date === todayKey) {
    try {
      const { dayStartInTz } = await import('./schedule.js');
      const lastOk = await db
        .prepare("SELECT message, detail FROM runs WHERE account_id = ? AND status = 'ok' AND created_at >= ? ORDER BY id DESC LIMIT 1")
        .bind(account.id, dayStartInTz(new Date(now), effDayTz)).first();
      if (lastOk) {
        rowStatus = 'ok';
        rowMsg = lastOk.message || rowMsg;
        rowDetail = lastOk.detail || '';
      }
    } catch { /* 老库没有 runs 表时忽略，退化为原本行为 */ }
  }

  await db
    .prepare('UPDATE accounts SET last_status=?, last_msg=?, last_detail=?, last_run_at=?, meta=?, updated_at=? WHERE id=?')
    .bind(rowStatus, rowMsg, rowDetail, now, JSON.stringify(meta), now, account.id)
    .run();

  return { status, message, duration_ms: duration, retryable: status !== 'ok' && !handedOff };
}

export async function runAll(env, { manual = false } = {}) {
  const db = env.DB;
  await ensureSchema(db);
  const { results } = await db.prepare('SELECT * FROM accounts WHERE enabled = 1 ORDER BY id').all();
  const accounts = results || [];

  let ok = 0;
  let fail = 0;
  let skip = 0;
  const lines = [];

  for (const acc of accounts) {
    const r = await runAccount(env, acc);
    if (r.status === 'ok') ok++;
    else if (r.status === 'skip') skip++;
    else fail++;
    const icon = r.status === 'ok' ? '✅' : r.status === 'skip' ? '⏭️' : '❌';
    lines.push(`${icon} ${acc.name}：${r.message}`);
    // 账号之间稍作间隔，降低被目标站点限流的概率
    await sleep(1200);
  }

  // 仅保留最近 500 条运行记录
  await db.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 500)').run();

  const body = `${manual ? '手动' : '定时'}任务完成：成功 ${ok} 个，失败 ${fail} 个\n` + lines.join('\n');
  await sendNotify(env, db, '签到日报', body);

  return { ok, fail, total: accounts.length, lines };
}

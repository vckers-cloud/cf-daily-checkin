// 执行路线（HTTP 从哪个网络出去）测试：node test/route.test.mjs
//
// 背景（线上 2026-09-28 实测）：糊涂鳄 dj.hutue.cn 从 Cloudflare 直连**完全正常**
// —— 首页 200、签到接口 0.4 秒回 {"status":"0","msg":"今日已签到，请明日再来"}。
// 但旧策略是「扩展在线就一律走本地中继」，中继是单飞执行，前面吾爱破解的浏览器工单
// 要占掉将近一分钟，糊涂鳄就被挤成「中继执行超时（45秒）」→ 面板记「失败」，
// 网站那边其实早就签好了：用户看到的就是「面板跟网站对不上」。
//
// 本文件钉住修好之后的规矩：
//   ① 站点默认 server 的账号（糊涂鳄），自动模式先走「CF 直连」，不该碰中继队列；
//   ② 直连走不通（网络层失败）→ 自动换本地网络，并把换路写进 meta.route_note；
//   ③ 站点已给出业务结论（Cookie 失效 / 人机验证）→ 不换路，不白打第二遍；
//   ④ 手动固定的路线不许被偷偷换掉。
import assert from 'node:assert/strict';
import { encryptJSON } from '../src/crypto.js';
import { runAccount, isRouteFailure, routeName } from '../src/runner.js';
import { OUTCOME } from '../src/lib/signals.js';
import { getSite } from '../src/sites/index.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const origFetch = globalThis.fetch; // 每个用例收尾都还原，避免相互污染

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const HOME = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/wp-content/themes/ripro/assets/css/main.css"></head>'
  + '<body><a class="click-qiandao zzhuti_qd_1" href="javascript:;">打卡签到</a></body></html>';
const OK_JSON = JSON.stringify({ status: '1', msg: '签到成功，赠送5晶石' });

// 极简 D1 fake：够 runner + lib/relay.js 跑完一条链路
//
// relayPendingFirst：头几轮轮询先回「扩展还在做」。
// 【为什么需要它】默认（立刻 done）时中继那段是**纯微任务**，一个宏任务就跑完，
// 事件循环压根不会让出去 —— 于是「两个账号并发」这种用例永远碰不到真正的重叠，
// 写成通过的也只是自欺。让它先 pending，waitRelayResult 就会 sleep(300ms)，
// 这个真实的空档才是线上出事的那个窗口（扩展正在跑，别的请求同时进来）。
function fakeDb({ relayOnline = true, relayBody = OK_JSON, backlog = 0, lastOkRun = null, relayEmpty = false, relayPendingFirst = 0 } = {}) {
  const state = { relayJobs: [], runs: [], accountUpdates: [] };
  const jobs = {};
  const polls = {};
  return {
    state,
    jobs,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async run() {
          if (/INSERT INTO relay_jobs/i.test(sql)) {
            state.relayJobs.push({ id: stmt._args[0], url: stmt._args[1], method: stmt._args[2] });
            // 扩展「立刻领走并回传」：中继一旦被使用，就一定能拿到响应；
            // relayEmpty = 中继执行了但没把响应带回来（线上 2026-09-28 的真实故障）
            jobs[stmt._args[0]] = relayEmpty
              ? { status: 'done', resp_status: null, resp_headers: '{}', resp_body: '' }
              : { status: 'done', resp_status: 200, resp_headers: '{}', resp_body: b64(relayBody) };
          }
          if (/INSERT INTO runs/i.test(sql)) state.runs.push(stmt._args);
          if (/UPDATE accounts/i.test(sql)) state.accountUpdates.push(stmt._args);
          return {};
        },
        async all() { return { results: [] }; },
        async first() {
          if (/COUNT\(\*\)/i.test(sql)) return { n: backlog };
          if (/FROM settings/i.test(sql)) {
            const key = stmt._args[0];
            if (key === 'relay_last_poll') return { value: String(relayOnline ? Date.now() : Date.now() - 10 * 60000) };
            if (key === 'schedule_tz') return { value: 'Asia/Shanghai' };
            return null;
          }
          if (/FROM relay_jobs WHERE id = \?/i.test(sql)) {
            const id = stmt._args[0];
            polls[id] = (polls[id] || 0) + 1;
            if (relayPendingFirst && polls[id] <= relayPendingFirst) return { status: 'pending', url: 'x', method: 'GET' };
            return jobs[id] || null;
          }
          // 今天最近一次成功记录（runner 在「已签过又被补跑失败」时要拿它回填账号行）
          if (/FROM runs/i.test(sql) && /status = 'ok'/i.test(sql)) return lastOkRun;
          return null;
        },
      };
      return stmt;
    },
    async batch() { return []; },
  };
}

async function account(db, site, meta, siteUrl = 'https://dj.hutue.cn') {
  const env = { DB: db, ENCRYPT_KEY: 'El771KvGwTGzl6K9C2dqmMOsOBYgF3LR9pIm/FvTEbs=' };
  const creds = await encryptJSON(env, db, { site_url: siteUrl, cookie: 'c=x' });
  return { env, acc: { id: 7, site, name: '单机', creds, meta: JSON.stringify(meta), enabled: 1 } };
}

// 直连侧：按 URL 给响应（绝对不带中继）
function mockServerFetch({ fail = false, home = HOME, post = OK_JSON } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || 'GET' });
    if (fail) throw new TypeError('fetch failed');
    const body = u.endsWith('/') ? home : post;
    return { status: 200, text: async () => body };
  };
  return calls;
}

// ---- ① 站点声明：糊涂鳄默认 server（直连实测可用，不需要中继） ----
await t('糊涂鳄站点默认走 CF 直连（execution=server），不再默认依赖中继', async () => {
  const s = getSite('hutue');
  assert.ok(s, 'hutue 站点应已注册');
  assert.equal(s.execution, 'server', '糊涂鳄从 CF 直连实测正常，默认路线必须是 server');
});

await t('自动模式 + server 站点 + 扩展在线：先走直连，**不碰**中继队列', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', {}); // meta.execution 为空 = 自动
  const calls = mockServerFetch();
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok', '直连应该就能签上，实际：' + r.message);
  assert.equal(db.state.relayJobs.length, 0, '自动模式不该把糊涂鳄塞进中继队列（这正是线上超时的根因）');
  assert.ok(calls.some((c) => c.url === 'https://dj.hutue.cn/'), '应直连访问过站点首页');
  const meta = JSON.parse(db.state.accountUpdates[0][4]);
  assert.equal(meta.exec_route, 'server', '应记住「直连走通了」，下次优先直连');
  assert.equal(meta.route_note, '路线：CF 直连', '没换路时只记路线，不该有换路文案');
});

// ---- ② 直连走不通 → 自动改走本地网络 ----
await t('直连网络层失败时自动改走本地网络，并如实记下「换过路」', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', {});
  mockServerFetch({ fail: true }); // 直连：连不上
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok', '换到本地网络后应该签上，实际：' + r.message);
  assert.ok(db.state.relayJobs.length > 0, '直连不通时必须真的走中继');
  const meta = JSON.parse(db.state.accountUpdates[0][4]);
  assert.equal(meta.exec_route, 'relay', '应记住「本地网络走通了」');
  assert.match(meta.route_note, /自动改走/, '换过路要写进 route_note，实际：' + meta.route_note);
  assert.match(meta.route_note, /CF 直连失败/, '要写清楚是哪条路线失败才换的，实际：' + meta.route_note);
});

await t('记住的路线优先：exec_route=relay 的账号先走本地网络，不再先试直连', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', { exec_route: 'relay' });
  const calls = mockServerFetch(); // 直连侧不该被调到
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok');
  assert.ok(db.state.relayJobs.length >= 1, '应直接走中继');
  assert.ok(db.state.relayJobs.some((j) => j.url === 'https://dj.hutue.cn/'), '中继里应能看到站点首页请求');
  assert.equal(calls.length, 0, '记住 relay 后不该再先打一次直连');
});

// ---- ③ 业务结论不换路（换个网络出口结果一样，白跑还多打一次签到接口） ----
await t('站点回「Cookie 已失效」时**不**换路线（业务结论与网络出口无关）', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', {});
  const LOGIN_HOME = '<html><body><form id="loginform" action="/wp-login.php" method="post">'
    + '<input name="log"><input name="pwd"></form></body></html>';
  mockServerFetch({ home: LOGIN_HOME });
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'fail');
  assert.match(r.message, /Cookie 已失效/);
  assert.equal(db.state.relayJobs.length, 0, '业务结论不该触发换路（白跑一次中继）');
  const meta = JSON.parse(db.state.accountUpdates[0][4]);
  assert.equal(meta.route_note, undefined, '没走通的这一次不该留路线记录');
});

await t('扩展离线时：走不通的路线不白打（直连被跳过时不会去中继队列排队）', async () => {
  const db = fakeDb({ relayOnline: false });
  const { env, acc } = await account(db, 'hutue', { exec_route: 'relay' });
  mockServerFetch({ fail: true });
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  // 记住的是 relay，但扩展离线：不该死等中继，应换直连（失败也是真实结果）
  assert.equal(db.state.relayJobs.length, 0, '扩展离线时不该往中继队列里塞任务');
});

// ---- ④ 手动固定的路线「优先」，但不是「宁可不签到也不用另一条」 ----
//
// 【语义修正 2026-09-28】用户把 hutue.cn 钉在「CF 网络」上，而该域名从 CF 机房 IP
// 连首页都被站点 WAF 回 `error code 1002`（同日实测）—— 旧行为是「固定了就只走这一条」，
// 于是这个账号每一轮都注定失败、永远签不上，面板上只留一句「遇到网站安全防护」。
// 固定的本意是「优先用我指定的这条」；另一条能签上就应该临时兜底，
// 但必须写明「固定值没改、这次是兜底」，并把「切回自动」的入口指给用户。
await t('手动固定「CF 网络」+ 直连失败 + 扩展在线 → 临时改走本地网络签上，并写明这是兜底', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', { execution: 'server' });
  mockServerFetch({ fail: true });
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok', '另一条路线能签上就不该让它白白签不上，实际：' + r.status + ' / ' + r.message);
  assert.ok(db.state.relayJobs.length > 0, '应当真的走中继兜底');
  const meta = JSON.parse(db.state.accountUpdates[0][4]);
  assert.equal(meta.execution, 'server', '兜底不能偷偷改掉用户固定的执行方式');
  assert.match(meta.route_note, /手动固定的「CF 直连」对本站不通/, '要写明是手动固定那条不通：' + meta.route_note);
  assert.match(meta.route_note, /已临时改走「本地网络」/);
  assert.match(meta.route_note, /固定值没有改/, '要明确告诉用户固定值还在');
});

await t('手动固定「本地网络」且中继走通时，不做多余的直连兜底', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', { execution: 'relay' });
  const calls = mockServerFetch({});
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 0, '固定的路线走通了，就不该再去打另一条');
  assert.ok(db.state.relayJobs.length >= 1, '手动指定中继就该真的走中继');
});

// ---- ③.5 同一模块管两个独立站：默认路线按域名给 ----
// hutue.cn 从 CF 机房 IP 连首页都被站点 WAF 拦（实测 `error code: 1002`），
// 而 dj.hutue.cn 从 CF 直连完全正常 —— 默认路线不能一刀切。
await t('糊涂鳄：hutue.cn 默认走本地网络，dj.hutue.cn 默认走 CF 直连', async () => {
  const s = getSite('hutue');
  assert.equal(s.executionFor('https://hutue.cn'), 'relay', 'hutue.cn 从 CF 会被 WAF 拦，应默认走本地网络');
  assert.equal(s.executionFor('https://dj.hutue.cn'), 'server', 'dj.hutue.cn 从 CF 直连正常');
});

await t('自动模式 + hutue.cn：先走本地网络，不会先去 CF 白撞一次 WAF', async () => {
  const db = fakeDb({ relayOnline: true });
  const { env, acc } = await account(db, 'hutue', {}, 'https://hutue.cn');
  const calls = mockServerFetch({}); // 直连侧不该被调到
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok', '实际：' + r.status + ' / ' + r.message);
  assert.equal(calls.length, 0, 'hutue.cn 不该先去打一次注定被 WAF 拦的直连请求');
  assert.ok(db.state.relayJobs.length >= 1, '应该真的走中继');
  assert.equal(JSON.parse(db.state.accountUpdates[0][4]).exec_route, 'relay');
});

// ---- ④.5 中继「执行了但响应是空」= 链路失败，能换路 ----
//
// 线上事故（2026-09-28，用户报「糊涂鳄用本地网络签到失败」）：
//   中继把响应丢了 → 面板只看到「（无响应）」→ 站点模块把它解释成「站点不认这个接口」，
//   挨个重打 5 个候选接口，最后报「签到失败：… 站点不认这个接口」。
//   站点其实一直在正常回答（实测：带面板那份 Cookie 直连，user_qiandao 0.2 秒就回
//   {"status":"0","msg":"今日已签到，请明日再来"}）。
// 规矩：这种「空响应」是**网络层失败**，不是站点结论——自动模式必须换另一条路线重试。
await t('自动模式下中继回空响应 → 换走 CF 直连并签上，而不是骂站点不认接口', async () => {
  const db = fakeDb({ relayOnline: true, relayEmpty: true });
  const { env, acc } = await account(db, 'hutue', { exec_route: 'relay' }); // 记住的路线是中继
  const calls = mockServerFetch(); // 直连侧可达
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok', '换到直连后应该能签上，实际：' + r.status + ' / ' + r.message);
  assert.ok(calls.some((c) => c.url === 'https://dj.hutue.cn/'), '应该真的换到直连重试');
  assert.doesNotMatch(r.message, /站点不认这个接口/, '空响应不是站点结论，不能这么报');
  const meta = JSON.parse(db.state.accountUpdates[0][4]);
  assert.equal(meta.exec_route, 'server', '换通的那条路线要记住');
  assert.match(meta.route_note, /自动改走/);
  assert.match(meta.route_note, /没带回响应/, '换路原因要说清是「响应没带回来」：' + meta.route_note);
  assert.doesNotMatch(meta.route_note, /扩展不在线/, '扩展是在线的，别误导');
});

await t('手动固定「本地网络」+ 中继回空响应 → 临时改走直连，并且不许把空响应说成站点结论', async () => {
  const db = fakeDb({ relayOnline: true, relayEmpty: true });
  const { env, acc } = await account(db, 'hutue', { execution: 'relay' });
  const calls = mockServerFetch({});
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'ok', '固定中继但中继丢了响应，直连能签上就该签上，实际：' + r.status + ' / ' + r.message);
  assert.equal(calls.length > 0, true, '应该换到直连重试');
  assert.doesNotMatch(r.message, /站点不认这个接口/, '空响应不是站点结论，不能这么报');
  const meta = JSON.parse(db.state.accountUpdates[0][4]);
  assert.match(meta.route_note, /手动固定的「本地网络」对本站不通/, '要写明是固定那条不通：' + meta.route_note);
  assert.match(meta.route_note, /已临时改走「CF 直连」/);
  assert.doesNotMatch(meta.route_note, /自动改走/, '这是手动固定的兜底，不能写成「自动改走」');
});

// ---- ④.8 两条路线都不成时，反馈要说清「试过哪条、为什么不行」 ----
// 用户真实处境（2026-09-28）：hutue.cn 被手动钉在「CF 网络」上，而这条出口对本站根本不通。
// 只写一句「遇到网站安全防护（WAF）」会让人以为站点坏了 —— 必须给出下一步。
await t('手动钉在「CF 网络」、两条路线都不成时，反馈里说清「另一条也试了」并给出下一步', async () => {
  const db = fakeDb({ relayOnline: true, relayEmpty: true }); // 直连不通，中继也丢了响应
  const { env, acc } = await account(db, 'hutue', { execution: 'server' }, 'https://hutue.cn');
  mockServerFetch({ fail: true }); // 直连：CF 出口对本站不通
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  assert.equal(r.status, 'fail');
  assert.ok(db.state.relayJobs.length > 0, '固定那条不通时，另一条该去试一次');
  assert.match(r.message, /当前固定走「CF 直连」/);
  assert.match(r.message, /另一条「本地网络」也试过了/, '要写清另一条到底试没试：' + r.message);
  assert.doesNotMatch(r.message, /切回「自动」/, '两条都试过了，再让人切「自动」是废话');
});

await t('手动钉在「CF 网络」、另一条路线根本用不了时，要说清「为什么用不了」', async () => {
  const db = fakeDb({ relayOnline: false }); // 扩展离线：本地网络这条路用不了
  const { env, acc } = await account(db, 'hutue', { execution: 'server' }, 'https://hutue.cn');
  mockServerFetch({ fail: true });
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  // 连不上 = 请求压根没发出去，这次确实没签成 → 如实记 fail（但要说清下一步）。
  assert.equal(r.status, 'fail', '实际：' + r.status + ' / ' + r.message);
  assert.match(r.message, /连不上站点/, '要区分「连不上」和「结果未知」：' + r.message);
  assert.match(r.message, /当前固定走「CF 直连」/);
  assert.match(r.message, /另一条「本地网络」现在也用不了/, '要区分「用不了」和「试了没成」：' + r.message);
  assert.match(r.message, /扩展/, '原因要说清是扩展不在线');
  assert.doesNotMatch(r.message, /云端执行/, '别建议一个它已经钉住的值');
  assert.equal(db.state.relayJobs.length, 0, '扩展离线时不该往中继队列里塞任务');
});

// ---- ⑤ 已签到当天：补跑失败不许改写「今天的结果」 ----
await t('今天已签上过，之后一次补跑失败不会把账号行改成「已签到 + 签到失败」', async () => {
  const { dayInTz } = await import('../src/schedule.js');
  const todayUtc = dayInTz(new Date(), 'UTC'); // 糊涂鳄按 UTC 计日
  const okMsg = '今日已签到，请明日再来';
  // 另一条路线此刻也用不了（扩展离线）：于是这次补跑真的没有结果 —— 用来验证「行上仍显示今天那次成功」。
  // （若扩展在线，固定「CF 直连」的账号现在会自动兜底走中继签上，那样就测不到这个场景了。）
  const db = fakeDb({ relayOnline: false, lastOkRun: { message: okMsg, detail: '网站返回：{"status":"0"} · 接口 user_qiandao' } });
  const { env, acc } = await account(db, 'hutue', { last_signin_date: todayUtc, execution: 'server' });
  mockServerFetch({ fail: true }); // 这次补跑连不上（直连失败，另一条又用不了）
  let r;
  try { r = await runAccount(env, acc); } finally { globalThis.fetch = origFetch; }
  // 运行日志必须如实记下这次失败……
  // （连不上站点 = 请求没发出去，是一次真实失败；「结果未知」只留给「发出去了没等到回包」。）
  assert.equal(r.status, 'fail');
  assert.equal(db.state.runs.length, 1);
  assert.equal(db.state.runs[0][3], 'fail');
  // ……但账号那一行显示的是**今天那次成功**的原话（状态与反馈自洽）
  const row = db.state.accountUpdates[0];
  assert.equal(row[0], 'ok', '账号行状态应保持「已签到」');
  assert.equal(row[1], okMsg, '账号行反馈应仍是今天那次成功的网站原话，实际：' + row[1]);
  assert.match(String(row[2] || ''), /user_qiandao/, '网站原文也要回填');
});

// ---- ⑤.5 并发安全：一个账号走中继时，不能把另一个「CF 网络」的账号也一起劫持 ----
//
// 【为什么这是真 bug】走本地网络的实现是临时把 globalThis.fetch 换成中继版本，
// 而一个 Worker isolate 的 globalThis 是**所有并发请求共享**的。两个账号同时跑时会：
//   A 记住原 fetch → 改成中继；B 记住的「原 fetch」其实是 A 的中继版本 → 也改成中继；
//   A 跑完还原；B 跑完还原成它记住的那份 = **中继版本** ——
//   这把改动就永久留在 isolate 里：之后任何标着「CF 网络」的账号都会被静默地
//   借用户的浏览器发请求，而面板上一个字都不会说。
// 修法：同一时刻只允许一个账号在跑（runner.js 的 withAccountLock）。
await t('两个账号同时跑：走中继的那个不能把直连的账号也带进中继，也不能把中继留在全局', async () => {
  const dbRelay = fakeDb({ relayOnline: true, relayPendingFirst: 1 }); // 先让中继真的「等一轮」，造出真实的时间窗
  const relayAcc = await account(dbRelay, 'hutue', { exec_route: 'relay' }, 'https://hutue.cn');
  const dbDirect = fakeDb({ relayOnline: true });
  const directAcc = await account(dbDirect, 'hutue', {}, 'https://dj.hutue.cn');
  const calls = mockServerFetch({});
  const mockFn = globalThis.fetch;
  // 【为什么不用 setTimeout 轮询】中继那一段是**纯微任务**：fakeDb 的 run/first 都是 async，
  // 但没有真 I/O，所以「换成中继 → 发请求 → 还原」整个窗口在一个宏任务里就跑完了，
  // 定时器根本没有机会插进去 —— 轮询永远看不到「已换掉」那一刻，用例会假失败。
  // 改成在**赋值发生的那一瞬间**把另一个账号也放出去：这正是要防的真实并发时序
  // （定时任务 + 手动点「执行」/ 同一行被连点两下）。
  let patchAssignments = 0;
  let held = mockFn;
  let pB = null;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get: () => held,
    set: (v) => {
      if (v !== mockFn) patchAssignments++; // 只看「被换成非台架版本」，还原不算
      held = v;
      if (v !== mockFn && !pB) pB = runAccount(directAcc.env, directAcc.acc);
    },
  });
  try {
    const rA = await runAccount(relayAcc.env, relayAcc.acc); // 它会在这里面换掉 fetch
    assert.ok(patchAssignments >= 1, '中继那个账号压根没切进「本地网络」，这条用例就失去意义了');
    assert.ok(pB, '没能抓住「A 切进本地网络」那一刻，用例失去意义');
    const rB = await pB;
    assert.equal(rA.status, 'ok', '中继那个：' + rA.message);
    assert.equal(rB.status, 'ok', '直连那个：' + rB.message);
    assert.ok(dbRelay.state.relayJobs.length >= 1, '中继那个应该真的走中继');
    // 两个队列都要查：漏出去的补丁指向 A 自己那份 db，所以 B 的请求可能落在**任意一边**，
    // 只看 dbDirect 会漏掉（实测锁定前就是落在 dbRelay 队列里）。
    const hijacked = [...dbRelay.state.relayJobs, ...dbDirect.state.relayJobs]
      .filter((j) => /dj\.hutue\.cn/.test(String(j.url)));
    assert.equal(hijacked.length, 0,
      '直连那个账号的请求被中继接走了 —— fetch 补丁漏到了另一个账号上：' + JSON.stringify(hijacked));
    assert.ok(calls.some((c) => c.url === 'https://dj.hutue.cn/'), '直连那个账号应该走真正的直连通路');
    // 收尾：全局 fetch 必须还是台架那一份。随便打一个地址，应该进 calls，
    // 而不是被接进中继队列（那是「中继版本被永久留在了全局」的表现）。
    assert.equal(held, mockFn, '全局 fetch 被留成了中继版本（之后所有直连都会被静默劫持）');
    const before = calls.length;
    await globalThis.fetch('https://still-direct.example/');
    assert.equal(calls.length, before + 1, '全局 fetch 被留成了中继版本（之后所有直连都会被静默劫持）');
  } finally {
    delete globalThis.fetch;
    globalThis.fetch = origFetch;
  }
});

// ---- ⑥ 失败分类：哪些才值得换一条网络路线 ----
await t('isRouteFailure：网络层失败算「值得换路」，业务/验证结论不算', async () => {
  assert.equal(isRouteFailure(new Error('等待本地网络响应超时：扩展没有在 90 秒内回传')), true);
  assert.equal(isRouteFailure(new Error('本地网络失败：中继执行超时（45秒），已放弃该请求')), true);
  assert.equal(isRouteFailure(new Error('fetch failed')), true);
  assert.equal(isRouteFailure(new Error('HTTP 403 Forbidden Client IP 1.2.3.4 reason:UrlACL')), true);
  const relayUnknown = new Error('签到结果未知：请求已发出但没等到回包');
  relayUnknown.outcome = 'relay-unknown';
  assert.equal(isRouteFailure(relayUnknown), true, '结果未知时更该换条路问出真相');

  assert.equal(isRouteFailure(new Error('Cookie 已失效，请重新登录后复制新的 Cookie')), false);
  const login = new Error('登录已失效'); login.outcome = OUTCOME.NEED_LOGIN; // 真常量是 need_login（下划线）
  assert.equal(isRouteFailure(login), false);
  const cap = new Error('遇到人机验证'); cap.outcome = OUTCOME.CAPTCHA;
  assert.equal(isRouteFailure(cap), false);

  // 【回归 2026-09-29】站点已给出「未登录」这个业务结论时，即使文案里带着
  // 「本地网络 / 超时」这些词，也不该换条网络出去重打一遍签到接口。
  // 旧代码把常量写成了 'need-login'，于是这条规则从来没生效过 ——
  // 线上表现就是「面板换条路又打了一次签到接口」（同一个账号白挨两次）。
  const enriched = new Error('登录已失效，请重新获取 Cookie｜Cookie 体检：属于 hutue.cn 的会话 demo-user 已过期'
    + '｜说明：hutue.cn 走「本地网络」时，签到用的是浏览器里的登录态');
  enriched.outcome = OUTCOME.NEED_LOGIN;
  assert.equal(isRouteFailure(enriched), false, 'need_login 必须优先于文案里的关键词');
  assert.equal(isRouteFailure(new Error('签到失败：还没绑定手机号')), false);
});

await t('路线名：Docker 版叫本机直连/浏览器中继，CF 版叫 CF 直连/本地网络', () => {
  assert.equal(routeName({}, 'server'), 'CF 直连');
  assert.equal(routeName({}, 'relay'), '本地网络');
  assert.equal(routeName({ RUNTIME: 'docker' }, 'server'), '本机直连');
  assert.equal(routeName({ RUNTIME: 'docker' }, 'relay'), '浏览器中继');
  assert.equal(routeName({ RUNTIME: 'docker' }, 'unknown'), 'unknown');
});

console.log(`\n${n} 组通过`);

// 后台自动续期测试：node test/renew.test.mjs（纯 mock，不依赖网络）
// 覆盖：akile.renew() 的五种返回形态 + renewCredentials() 的整轮调度
import assert from 'node:assert/strict';
import { akile, jwtExp } from '../src/sites/akile.js';
import { encryptJSON } from '../src/crypto.js';
import { renewCredentials } from '../src/lib/renew.js';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    globalThis.__calls = calls;
    for (const [match, resp] of routes) {
      if (String(url).includes(match)) {
        const body = typeof resp === 'function' ? resp(calls.length) : resp;
        const status = body && body.__http ? body.__http : 200;
        return { status, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    throw new Error('unexpected url: ' + url);
  };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (expDeltaSec) => `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expDeltaSec })}.sig`;
const LONG_TOKEN = fakeJwt(20 * 3600);
const SOON_TOKEN = fakeJwt(2 * 3600);
const NEW_TOKEN = fakeJwt(24 * 3600);

const checkinOk = { status_code: 0, status_msg: '签到成功', data: { amount: 8 } };
const refreshOk = (tok) => ({ status_code: 0, status_msg: 'ok', data: { token: tok } });

function fakeCtx() {
  const writes = [];
  const FIXED_KEY = Buffer.alloc(32, 7).toString('base64');
  const db = {
    prepare: (sql) => ({
      bind: (...args) => ({ run: async () => { writes.push({ sql, args }); return {}; } }),
      first: async () => ({ value: FIXED_KEY }),
    }),
  };
  return { ctx: { env: {}, db, account: { id: 'acc1' } }, writes };
}

await t('renew：长期 token 还没到时间，不发请求', async () => {
  mockFetch([['any', checkinOk]]);
  globalThis.__calls = [];
  const r = await akile.renew({ token: LONG_TOKEN }, fakeCtx().ctx);
  assert.equal(r.renewed, false);
  assert.equal(r.reason, 'not-due');
  assert.equal(globalThis.__calls.length, 0);
});

await t('renew：临期 token 刷新并回写，新 exp 向后', async () => {
  mockFetch([['/v1/user/refreshToken', refreshOk(NEW_TOKEN)]]);
  const { ctx, writes } = fakeCtx();
  const oldExp = jwtExp(SOON_TOKEN);
  const r = await akile.renew({ token: SOON_TOKEN }, ctx);
  assert.equal(r.renewed, true);
  assert.ok(r.exp > oldExp, '新 token 的 exp 必须向后');
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /UPDATE accounts/);
});

await t('renew：站点 401 拒绝 → rejected（不是 network）', async () => {
  mockFetch([['/v1/user/refreshToken', { status_code: 401, status_msg: '无效token' }]]);
  const r = await akile.renew({ token: SOON_TOKEN }, fakeCtx().ctx);
  assert.equal(r.renewed, false);
  assert.equal(r.reason, 'rejected');
  assert.match(r.detail, /无效token/);
});

await t('renew：请求抛错 → network（值得换路线重试）', async () => {
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  const r = await akile.renew({ token: SOON_TOKEN }, fakeCtx().ctx);
  assert.equal(r.renewed, false);
  assert.equal(r.reason, 'network');
  assert.match(r.detail, /fetch failed/);
});

await t('renew：存的不是 JWT → invalid，不发请求', async () => {
  mockFetch([['any', checkinOk]]);
  globalThis.__calls = [];
  const r = await akile.renew({ token: 'PHPSESSID=abc; foo=1' }, fakeCtx().ctx);
  assert.equal(r.renewed, false);
  assert.equal(r.reason, 'invalid');
  assert.equal(globalThis.__calls.length, 0);
});

await t('renew：接口成功但没给 data.token → rejected（结构变了要能看出来）', async () => {
  mockFetch([['/v1/user/refreshToken', { status_code: 0, status_msg: 'ok', data: {} }]]);
  const r = await akile.renew({ token: SOON_TOKEN }, fakeCtx().ctx);
  assert.equal(r.renewed, false);
  assert.equal(r.reason, 'rejected');
  assert.match(r.detail, /data\.token/);
});

// ---------- renewCredentials 整轮 ----------
const ENC_KEY = Buffer.alloc(32, 9).toString('base64');
const ENV = { ENCRYPT_KEY: ENC_KEY };

function fakeDb(accounts) {
  const settings = {};
  const updates = [];
  // 有状态：meta / creds 的回写要能被后面的 first() 读到（否则"同一天不重复提醒"测不起来）
  const byId = new Map(accounts.map((a) => [String(a.id), { ...a }]));
  const list = () => [...byId.values()].filter((a) => a.enabled);
  return {
    settings, updates,
    prepare: (sql) => ({
      bind: (...args) => ({
        run: async () => {
          if (sql.startsWith('UPDATE accounts')) {
            updates.push({ sql, args });
            const row = byId.get(String(args[args.length - 1]));
            if (row && /SET meta/.test(sql)) row.meta = args[0];
            if (row && /SET creds/.test(sql)) row.creds = args[0];
          }
          return {};
        },
        first: async () => {
          if (sql.startsWith('SELECT value FROM settings')) {
            const k = args[0];
            return settings[k] !== undefined ? { value: settings[k] } : null;
          }
          if (sql.startsWith('SELECT * FROM accounts')) {
            return byId.get(String(args[0])) || null;
          }
          return null;
        },
        all: async () => {
          if (sql.includes('FROM accounts WHERE enabled')) return { results: list() };
          return { results: [] };
        },
      }),
      first: async () => null,
      all: async () => {
        if (sql.includes('FROM accounts WHERE enabled')) return { results: list() };
        return { results: [] };
      },
      run: async () => {
        return {};
      },
    }),
  };
}

// fakeDb 的 prepare().bind().run() 要能处理 setSetting 的 INSERT…ON CONFLICT：
// 上面 bind().run() 没记 settings，这里单独包一层
function settingsAwareDb(accounts) {
  const db = fakeDb(accounts);
  const origPrepare = db.prepare;
  db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    if (sql.startsWith('INSERT INTO settings')) {
      const origBind = stmt.bind;
      stmt.bind = (...args) => {
        const r = origBind(...args);
        const origRun = r.run;
        r.run = async () => { db.settings[args[0]] = args[1]; return origRun(); };
        return r;
      };
    }
    return stmt;
  };
  return db;
}

async function makeAccounts() {
  const db0 = settingsAwareDb([]);
  const soonCreds = await encryptJSON(ENV, db0, { token: SOON_TOKEN });
  const longCreds = await encryptJSON(ENV, db0, { token: LONG_TOKEN });
  const plainCookie = await encryptJSON(ENV, db0, { cookie: 'sessionid=abc123' });
  return [
    { id: 1, site: 'akile', name: 'Akile', enabled: 1, meta: '{}', creds: soonCreds },
    { id: 2, site: 'akile', name: 'Akile长期', enabled: 1, meta: '{}', creds: longCreds },
    { id: 3, site: 'v2ex', name: 'V2EX', enabled: 1, meta: '{}', creds: plainCookie }, // 没有 renew → 只做到期预警；这份 Cookie 里没写到期时间，不该被碰
  ];
}

await t('renewCredentials：临期账号被续期并写 meta；长期/无 renew 的不动', async () => {
  mockFetch([['/v1/user/refreshToken', refreshOk(NEW_TOKEN)]]);
  const db = settingsAwareDb(await makeAccounts());
  const res = await renewCredentials(ENV, db, []);
  assert.equal(res.ran, true);
  assert.equal(res.checked, 3, '三个账号都会被扫（akile 走续期，v2ex 走到期预警）');
  assert.equal(res.renewed, 1);
  const upd = db.updates.find((u) => /SET meta/.test(u.sql) && String(u.args[2]) === '1');
  assert.ok(upd, '账号 1 写了 meta');
  const m = JSON.parse(upd.args[0]);
  assert.ok(m.renew_ok_at > 0);
  // 凭据本身也被换了（saveToken 走的 UPDATE accounts SET creds=…）
  const credUpd = db.updates.find((u) => /creds/.test(u.sql) && String(u.args[2]) === '1');
  assert.ok(credUpd, '账号 1 的 creds 被回写');
  assert.ok(!db.updates.some((u) => /SET meta/.test(u.sql) && String(u.args[u.args.length - 1]) === '3'), 'v2ex 的 meta 不该被碰（它的 Cookie 里没写到期时间）');
});

await t('renewCredentials：一小时内不重复跑', async () => {
  mockFetch([['any', refreshOk(NEW_TOKEN)]]);
  globalThis.__calls = [];
  const db = settingsAwareDb(await makeAccounts());
  db.settings['renew_last_at'] = String(Date.now());
  const res = await renewCredentials(ENV, db, []);
  assert.equal(res.ran, false);
  assert.equal(globalThis.__calls.length, 0);
});

await t('renewCredentials：网络失败记 fail 原因，不抛错', async () => {
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  const db = settingsAwareDb(await makeAccounts());
  const res = await renewCredentials(ENV, db, []);
  assert.equal(res.ran, true);
  assert.equal(res.failed, 1);
  const upd = db.updates.find((u) => /SET meta/.test(u.sql) && String(u.args[u.args.length - 1]) === '1');
  const m = JSON.parse(upd.args[0]);
  assert.equal(m.renew_fail_reason, 'network');
  assert.match(m.renew_fail_detail, /socket hang up/);
});

console.log(`\n${n} passed`);

// ---------- 纯 Cookie 站点的到期预警 ----------
const wpCookie = (expDeltaSec) =>
  `wordpress_logged_in_abc=testuser|${Math.floor(Date.now() / 1000) + expDeltaSec}|sessiontoken`;

async function cookieAccounts(cookieStr, meta = '{}') {
  const db0 = settingsAwareDb([]);
  const creds = await encryptJSON(ENV, db0, { cookie: cookieStr });
  return [{ id: 7, site: 'hutue', name: '糊涂鳄', enabled: 1, meta, creds }];
}

await t('到期预警：Cookie 剩 2 小时 → 提醒一次并记 exp_alert_day', async () => {
  mockFetch([]);
  const db = settingsAwareDb(await cookieAccounts(wpCookie(2 * 3600)));
  const res = await renewCredentials(ENV, db, []);
  assert.equal(res.ran, true);
  assert.ok(res.details.some((d) => d.includes('Cookie 快过期')), '详情里要有预警：' + res.details.join('|'));
  const upd = db.updates.find((u) => /SET meta/.test(u.sql));
  assert.ok(upd, '要写 exp_alert_day');
  assert.ok(JSON.parse(upd.args[0]).exp_alert_day, 'exp_alert_day 已记');
});

await t('到期预警：同一天不重复提醒', async () => {
  mockFetch([]);
  const db = settingsAwareDb(await cookieAccounts(wpCookie(2 * 3600)));
  const r1 = await renewCredentials(ENV, db, []);
  assert.ok(r1.details.some((d) => d.includes('Cookie 快过期')), '第一轮要提醒');
  db.settings['renew_last_at'] = '0'; // 放行第二轮
  db.updates.length = 0;
  const r2 = await renewCredentials(ENV, db, []);
  assert.equal(r2.details.length, 0, '第二轮不该再提醒：' + r2.details.join('|'));
  assert.ok(!db.updates.some((u) => /SET meta/.test(u.sql)), '第二轮不该再写 meta');
});

await t('到期预警：Cookie 还有 10 天 → 不打扰', async () => {
  mockFetch([]);
  globalThis.__calls = [];
  const db = settingsAwareDb(await cookieAccounts(wpCookie(10 * 86400)));
  const res = await renewCredentials(ENV, db, []);
  assert.equal(res.details.length, 0);
  assert.ok(!db.updates.some((u) => /SET meta/.test(u.sql)), '不该写 meta');
});

await t('到期预警：已经过期的 Cookie → 也提醒（文案是"已经过期"）', async () => {
  mockFetch([]);
  const db = settingsAwareDb(await cookieAccounts(wpCookie(-3600)));
  const res = await renewCredentials(ENV, db, []);
  assert.ok(res.details.some((d) => d.includes('Cookie 快过期')));
});

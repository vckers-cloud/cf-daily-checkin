// AkileCloud（akile.ai）每日签到 —— token 方式
// 2026-09-27 实测结论：Akile 登录接口会识别非浏览器客户端，即使账号密码完全正确
// 也返回"密码错误"（用户已用面板内复制出的密码在网页无痕登录成功，面板代码链路审计无问题）。
// 因此账号密码登录改由用户在浏览器手动完成，面板只保存 akile-token（localStorage），
// 每日用 token 调签到接口；token 临近过期（12h，与网页逻辑一致）自动调用 refreshToken
// 续期并回写 D1，续期失败则提示重新获取。
//
// token 获取：浏览器登录 akile.ai 后，F12 → Application → Local Storage → akile-token；
// 或用面板账号弹窗里的「复制取 token 小书签」，在 akile.ai 页面点书签一键复制。

import { encryptJSON } from '../crypto.js';

const UA = 'Mozilla/5.0 (Linux; Android 13; KB2000 Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const API = 'https://api.akile.ai/api';
const REFRESH_AHEAD_SEC = 12 * 3600; // 与网页一致：过期前 12 小时刷新
const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

function okCode(code) {
  return code === 0 || code === 200 || code === '0' || code === '200';
}

// 从 JWT 读 exp（只解析不校验）；非 JWT 返回 0（= 不主动刷新，照常试签到）
export function jwtExp(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return 0;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    const exp = Number(payload.exp);
    return exp > 0 ? exp : 0;
  } catch {
    return 0;
  }
}

async function apiGet(path, token) {
  const res = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: token },
  });
  let body = null;
  // 先读文本再解析，避免 body 被消费两次
  let raw = '';
  try { raw = await res.text(); } catch { /* 忽略 */ }
  try {
    body = JSON.parse(raw);
  } catch {
    const snippet = String(raw || '').slice(0, 500);
    const err = new Error(`网站返回非 JSON（HTTP ${res.status}）：${snippet || '空响应'}`);
    err.detail = snippet;
    throw err;
  }
  return { httpStatus: res.status, body };
}

// 用旧 token 换新 token（结构化结果——调用方必须分清「被站点拒绝」和「网络没通」：
// 前者再试也没用，后者换条路线/过会儿重试可能有用。原来一律返回 null，
// 网络抖一下就会被当成「token 已死」，用户看到的就是莫名其妙的「请重新获取）。
//   { token }            —— 换到了新 token
//   { rejected, detail } —— 站点明确拒绝（401 / status_code 非成功码）：旧 token 已死
//   { network, detail }  —— 请求没发出去或没回来（超时/断网/被拦）：值得重试
async function tryRefresh(token) {
  let res;
  try {
    res = await apiGet('/v1/user/refreshToken', token);
  } catch (e) {
    return { network: true, detail: String((e && e.message) || e || '请求失败').slice(0, 160) };
  }
  const { httpStatus, body } = res;
  if (httpStatus === 401 || !okCode(body.status_code)) {
    const msg = String((body && body.status_msg) || '').slice(0, 120);
    return { rejected: true, detail: `HTTP ${httpStatus} · ${msg || '无返回文案'}` };
  }
  const nt = body && body.data && body.data.token;
  if (!nt) {
    return { rejected: true, detail: `HTTP ${httpStatus} · 接口成功了但没给新 token（返回里没有 data.token）` };
  }
  return { token: String(nt) };
}

// 签到主流程用（行为不变：失败一律 null，由 run() 按原来的文案报错）
async function refreshToken(token) {
  const r = await tryRefresh(token);
  return r.token || null;
}

// 续期成功后回写 D1，下次直接用新 token（失败不影响本次签到）
async function saveToken(ctx, token) {
  try {
    const { env, db, account } = ctx || {};
    if (!env || !db || !account) return;
    const enc = await encryptJSON(env, db, { token });
    await db.prepare('UPDATE accounts SET creds=?, updated_at=? WHERE id=?')
      .bind(enc, Date.now(), account.id).run();
  } catch {
    /* 忽略回写失败 */
  }
}

function authFailed(httpStatus, body) {
  if (httpStatus === 401) return true;
  const msg = String((body && body.status_msg) || '');
  return /过期|无效|未登录|unauthorized|token/i.test(msg);
}

export const akile = {
  id: 'akile',
  name: 'AkileCloud',
  desc: 'Akile 云服务器每日签到，奖励 1~10 AK币。token 方式签到：浏览器登录 akile.ai 后复制 akile-token，面板自动续期。',
  fields: [
    {
      key: 'token',
      label: 'akile-token（注意：不是 Cookie）',
      type: 'textarea',
      required: true,
      placeholder: '浏览器登录 akile.ai 后，从 localStorage 复制 akile-token（一段 eyJ... 开头的 JWT）粘贴到这里',
    },
  ],
  tips: '一句话记住：这个框要的是 akile-token，**不是 Cookie**。它们在两个完全不同的地方：Cookie 在 F12 → Application → Cookies，token 在 F12 → Application → Local Storage → akile-token（值以 eyJ 开头，是一段 JWT）。粘贴 Cookie 会被服务器拒绝，面板也只能回「登录已过期」，看着就像「我明明更新了」。最省事的取法：在浏览器登录 akile.ai → 点下方「复制取 token 小书签」→ 在 akile.ai 页面点该书签，token 会自动复制 → 回到面板粘贴保存。另外一个细节：Akile 的 token 大约只活一天（实测 exp 与签发时间相差 12～24 小时）。面板会在后台每小时检查一次，到期前 12 小时自动续期并回写，你一般不用管；万一续期失败（比如网络不通），面板会提前提醒你手动更新，而不是等 token 死了才报错。',

  async run(creds, ctx = {}) {
    let token = String(creds.token || '').trim();
    if (!token) throw new Error('请先填写 akile-token（在浏览器登录 akile.ai 后复制）');

    // 【先看清楚填进来的到底是什么】
    //
    // 线上案例（2026-09-29）：用户说「我更新了 Cookie」，可面板里这一行永远只会说
    // 「登录已过期，请重新从浏览器复制 akile-token」——因为他更新的是 **Cookie**，
    // 而 Akile 要的是 localStorage 里的 `akile-token`（一段 JWT），两者不是一个东西。
    // 所以先分辨值形态，把话说清楚，别拿一个 Cookie 去当 Authorization 白打一次请求。
    const looksJwt = JWT_RE.test(token);
    if (!looksJwt) {
      const looksCookie = token.includes('=') || token.includes(';');
      throw new Error(looksCookie
        ? '这个值看起来是一段 Cookie —— Akile 不吃 Cookie，它要的是浏览器 localStorage 里的 akile-token（一段形如 eyJ... 的 JWT）。'
          + '获取方式：在浏览器登录 akile.ai → F12 → Application → Local Storage → 复制 akile-token → 粘到面板；'
          + '或者用账号弹窗里的「复制取 token 小书签」一键复制。'
        : '这个值不像是 akile-token（它应该是一段形如 eyJ... 的 JWT）。'
          + '请到浏览器 localStorage 里复制 akile-token 再粘一次。');
    }

    // 过期了照样先试一次续期：偶尔站点会把 token 的有效期放宽（服务端可能不校验 exp）。
    // 但**结论文案**必须说清到底是「过期」还是「被拒」——这正是用户反复卡住的地方：
    // 线上（2026-09-29）面板里那个 token 的 exp 是 07:00:55，而用户一直在更新 **Cookie**，
    // 两边说的根本不是同一个东西。
    const nowSec = Date.now() / 1000;
    const exp0 = jwtExp(token);
    const expiredAt = exp0 && exp0 < nowSec ? exp0 : 0;

    // 临近过期先续期（与网页逻辑一致）
    const exp = exp0;
    if (exp && exp - REFRESH_AHEAD_SEC < nowSec) {
      const nt = await refreshToken(token);
      if (nt) {
        token = nt;
        await saveToken(ctx, token);
      }
    }

    let chk = await apiGet('/v1/user/Checkin', token);
    // token 失效：续期一次再试
    if (authFailed(chk.httpStatus, chk.body)) {
      const nt = await refreshToken(token);
      if (!nt) {
        const expT = exp0 ? new Date(exp0 * 1000).toLocaleString('zh-CN') : '';
        throw new Error(expiredAt
          ? '面板里这个 akile-token 已经过期了（它 ' + expT + ' 就到期了；Akile 的 token 只活一天左右，'
            + '过期后连续期接口也会拒绝）。请在浏览器重新登录 akile.ai 后复制一个新的 akile-token。'
          : 'Akile 拒了面板里这个 akile-token'
            + (expT ? '（它自身写着 ' + expT + ' 到期，还没到期却被拒）' : '（它没有携带有效期，也无法续期）')
            + '。常见原因：① 这个 token 是别的账号/另一个浏览器的；② 已在别处退出登录把它作废了；'
            + '③ 浏览器还在用同一个账号（token 被刷新过）。请重新登录 akile.ai 复制一个新的 akile-token。');
      }
      token = nt;
      await saveToken(ctx, token);
      chk = await apiGet('/v1/user/Checkin', token);
    }

    const msg = String((chk.body && chk.body.status_msg) || '');
    if (okCode(chk.body.status_code)) {
      const d = chk.body.data || {};
      const amount = d.amount ?? d.akCoin ?? d.coin ?? '';
      // 站点的 status_msg 经常就是「签到成功」四个字，直接用它，不再加前缀
      // （以前会变成「签到成功：签到成功」）；有结构化金额时用金额说人话
      return { ok: true, message: amount ? `签到成功，获得 ${amount} AK币` : (msg || '签到成功') };
    }
    // 主文案用网站原话（status_msg），拿不到才用我们的套话
    if (msg.includes('已签到')) return { ok: true, message: msg || '今日已签到，无需重复' };
    throw new Error('签到失败：' + (msg || `status_code=${chk.body.status_code}`));
  },

  // 后台自动续期（独立于签到流程）：调度器每小时调用一次，提前把快过期的 token 换新。
  // 约定（别的站点以后也可以照这个实现，调度器只认这个形状）：
  //   { renewed: true, exp }                                  —— 已换新并回写 D1（exp 为新 token 的到期秒数）
  //   { renewed: false, reason: 'not-due', exp }               —— 还没到续期时间，不用管
  //   { renewed: false, reason: 'invalid', exp: 0 }            —— 存的值不是 JWT（等签到流程去跟用户说清楚）
  //   { renewed: false, reason: 'network', exp, detail }       —— 网络没通：调度器会换路线再试/下小时再试
  //   { renewed: false, reason: 'rejected', exp, detail }      —— 站点拒绝：旧 token 已死，只能手动重新获取
  // 注意：这里用的 globalThis.fetch 由调用方按路线准备好（中继=用户本地网络 / 直连=机房网络）。
  async renew(creds, ctx = {}) {
    const token = String(creds.token || '').trim();
    if (!JWT_RE.test(token)) return { renewed: false, reason: 'invalid', exp: 0 };
    const exp = jwtExp(token);
    if (!exp) return { renewed: false, reason: 'not-due', exp: 0 };
    if (exp - Date.now() / 1000 > REFRESH_AHEAD_SEC) return { renewed: false, reason: 'not-due', exp };
    const r = await tryRefresh(token);
    if (r.token) {
      await saveToken(ctx, r.token);
      return { renewed: true, exp: jwtExp(r.token) || 0 };
    }
    if (r.rejected) return { renewed: false, reason: 'rejected', exp, detail: r.detail };
    return { renewed: false, reason: 'network', exp, detail: r.detail };
  },

  // 浏览器端签到脚本：在用户浏览器中运行，使用用户本地网络（绕过 CF IP 限制）
  execution: 'browser', // 改为默认浏览器执行（CF 到 akile 网络不稳定）
  domain: 'api.akile.ai', // 浏览器执行时的目标域名
  browserScript: {
    script: async (params) => {
      const token = String(params.token || '').trim();
      if (!token) return { ok: false, message: '请先填写 akile-token' };
      const res = await fetch('https://api.akile.ai/api/v1/user/Checkin', {
        headers: { 'Authorization': token, 'Accept': 'application/json' },
        credentials: 'include',
      });
      const body = await res.json().catch(() => null);
      if (!body) return { ok: false, message: `接口异常（HTTP ${res.status}），稍后重试` };
      const okCode = (c) => c === 0 || c === 200 || c === '0' || c === '200';
      const msg = String(body.status_msg || '');
      if (okCode(body.status_code)) {
        const d = body.data || {};
        const amount = d.amount ?? d.akCoin ?? d.coin ?? '';
        return { ok: true, message: amount ? `签到成功，获得 ${amount} AK币` : (msg || '签到成功') };
      }
      if (/过期|无效|未登录|unauthorized|token/i.test(msg) || res.status === 401) {
        // 这是浏览器端脚本（用的是页面自己 localStorage 里的 token），
        // 走到这里说明 token 真的被服务器拒了 —— 直接把站点原话给出来，别只说「过期」。
        return { ok: false, message: 'Akile 拒绝了当前 token' + (msg ? '（网站原话：' + msg + '）' : '（HTTP ' + res.status + '）')
          + '，请在 akile.ai 重新登录后复制新的 akile-token' };
      }
      if (msg.includes('已签到')) return { ok: true, message: msg || '今日已签到，无需重复' };
      return { ok: false, message: '签到失败：' + (msg || `status_code=${body.status_code}`) };
    },
  },
};

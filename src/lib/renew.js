// 后台凭据续期：独立于签到流程，每小时扫一遍账号，做两件事：
//   ① 有 renew() 的站点（如 Akile）：快过期的凭据提前换新并回写；
//   ② 纯 Cookie 的站点（没有刷新接口、手里也没密码，续不了）：凭据里写着到期时间
//      的，剩不到 24 小时就提前预警，提醒用户去重新抓（每天每个账号一次）。
//
// 为什么需要（2026-10-01）：Akile 的 token 只有 ~24h 寿命，原来续期只发生在
// 签到那一刻；那一刻网络一抖（CF 到 Akile 本来就不稳定）或扩展离线，续期就被
// 静默吞掉——旧 token 当时还能用，签到照样成功，用户毫无察觉；第二天 token
// 一死，就只能手动重新登录获取。这个独立任务治的就是这个：提前续、失败了
// 提前说，不等死了才让用户手动。
//
// 站点侧约定见 akile.js 的 renew() 注释；调度器只认那个形状，别的新站点
// 照着实现就能接入。

import { getSite } from '../sites/index.js';
import { decryptJSON } from '../crypto.js';
import { getSetting, setSetting } from '../db.js';
import { withAccountLock } from '../runner.js';
import { credentialExpiry } from './cookie-info.js';

const RENEW_INTERVAL_MS = 60 * 60 * 1000; // 每小时最多跑一轮（12 小时窗口内约有 12 次机会）
const ALERT_WITHIN_MS = 6 * 3600 * 1000; // 剩不到 6 小时就死、且续期失败 → 推送提醒（每天一次）
const EXP_ALERT_WITHIN_MS = 24 * 3600 * 1000; // 纯 Cookie 站点：凭据剩不到 24 小时 → 到期预警（每天每个账号一次）

const REASON_TEXT = {
  network: '网络没通',
  rejected: '站点拒绝续期（旧凭据已失效）',
  invalid: '存的凭据格式不对',
  error: '续期过程出错',
};

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleString('zh-CN',
      { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// 一次续期尝试：扩展在线先走用户本地网络（中继），再走直连兜底。
// 只有「网络失败」值得换路线再试；not-due/已换新/被拒绝/代码异常都不用再试。
async function renewWithRoutes(env, db, account, site, creds) {
  const routes = [];
  try {
    const { isRelayAvailable } = await import('./relay.js');
    if (await isRelayAvailable(db)) routes.push('relay');
  } catch { /* 扩展状态查不到就当离线，直连兜底 */ }
  routes.push('server');
  let last = null;
  for (const route of routes) {
    let restore = null;
    if (route === 'relay') {
      const { relayFetch } = await import('./relay.js');
      const prev = globalThis.fetch;
      globalThis.fetch = (url, init) => relayFetch(db, url, init);
      restore = () => { globalThis.fetch = prev; };
    }
    try {
      const r = await site.renew(creds, { env, db, account });
      last = { route, ...r };
      if (r.renewed || r.reason !== 'network') break;
    } catch (e) {
      last = { route, renewed: false, reason: 'error', exp: 0, detail: String((e && e.message) || e).slice(0, 200) };
      break;
    } finally {
      if (restore) restore();
    }
  }
  return last;
}

function metaOf(acc) {
  try { return JSON.parse(acc.meta || '{}'); } catch { return {}; }
}

// 纯 Cookie 站点的「到期预警」：Cookie 没有刷新接口、面板手里也没有密码，
// 技术上续不了 —— 但能提前发现快死了，提前一天告诉用户去重新抓，
// 而不是等第二天签到失败才看到「登录已失效」。
// 只认凭据里自己写着的到期时间（WordPress 会话 / JWT），没有的不猜。
async function checkExpiryAlert(env, db, full, site, creds) {
  const now = Date.now();
  let nearest = 0;
  let anyExpired = false;
  try {
    const { sessions, tokens } = credentialExpiry(creds);
    const all = [...(sessions || []), ...(tokens || [])].filter((x) => x && x.exp > 0);
    if (!all.length) return 'no-info';
    const live = all.filter((x) => !x.expired).map((x) => x.exp).sort((a, b) => a - b);
    nearest = live.length ? live[0] : 0;
    anyExpired = all.some((x) => x.expired);
  } catch { return 'no-info'; }
  const dying = nearest > 0 && nearest - now < EXP_ALERT_WITHIN_MS;
  if (!dying && !anyExpired) return 'fine';
  // 同一天同一个账号只提醒一次
  const m = metaOf(full);
  try {
    const tz = (await getSetting(db, 'schedule_tz').catch(() => '')) || 'Asia/Shanghai';
    const { dayInTz } = await import('../schedule.js').catch(() => ({}));
    const day = typeof dayInTz === 'function' ? dayInTz(new Date(), tz) : new Date().toDateString();
    if (m.exp_alert_day === day) return 'already';
    const { sendNotify } = await import('../notify.js');
    const leftH = nearest > now ? Math.max(1, Math.round((nearest - now) / 3600000)) : 0;
    const when = nearest > now
      ? `将在 ${fmtTime(nearest)} 过期（还剩约 ${leftH} 小时）`
      : '已经过期了';
    await sendNotify(env, db,
      'Cookie 即将过期',
      `${full.name || site.name} 的登录 Cookie ${when}。Cookie 没有自动续期，` +
      `请在浏览器重新登录该网站（确认页面上能看到自己的用户名），再用扩展「发送到面板」更新一次。`);
    m.exp_alert_day = day;
    await db.prepare('UPDATE accounts SET meta = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(m), now, full.id).run().catch(() => {});
    return 'notified';
  } catch (e) {
    console.error('[renew] 到期预警失败', e);
    return 'error';
  }
}

export async function renewCredentials(env, db, customSites = []) {
  let lastRun = 0;
  try { lastRun = Number(await getSetting(db, 'renew_last_at')) || 0; } catch { /* 忽略 */ }
  if (Date.now() - lastRun < RENEW_INTERVAL_MS) return { ran: false, reason: 'too-soon' };
  await setSetting(db, 'renew_last_at', String(Date.now())).catch(() => {});

  const { results } = await db.prepare(
    'SELECT id, site, name, meta, creds FROM accounts WHERE enabled = 1'
  ).all().catch(() => ({ results: [] }));

  const summary = { ran: true, checked: 0, renewed: 0, failed: 0, details: [] };
  for (const acc of results || []) {
    let site = null;
    try { site = getSite(acc.site, customSites); } catch { /* 忽略 */ }
    if (!site) continue;
    // 和签到共用账号锁：同一账号的签到和续期不能同时跑（都会读写它的凭据）
    try {
      await withAccountLock(async () => {
        const full = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(acc.id).first();
        if (!full || !full.enabled) return;
        let creds = {};
        try { creds = await decryptJSON(env, db, full.creds); } catch { return; }
        summary.checked++;
        // 没有 renew() 的站点（纯 Cookie、手里没密码）：续不了，但能做「到期预警」
        if (typeof site.renew !== 'function') {
          const st = await checkExpiryAlert(env, db, full, site, creds);
          if (st === 'notified') {
            summary.details.push(`⚠️ ${full.name || site.name}：Cookie 快过期，已提醒重新获取`);
          }
          return;
        }
        const r = await renewWithRoutes(env, db, full, site, creds);
        if (!r) return;
        const m = metaOf(full);
        const now = Date.now();
        let touched = false;
        if (r.renewed) {
          m.renew_ok_at = now;
          m.renew_ok_exp = r.exp || 0;
          delete m.renew_fail_at;
          delete m.renew_fail_reason;
          delete m.renew_fail_detail;
          touched = true;
          summary.renewed++;
          summary.details.push(`✅ ${full.name || site.name}：token 已自动续期` + (r.exp ? `（新有效期至 ${fmtTime(r.exp * 1000)}）` : ''));
        } else if (r.reason === 'not-due' || r.reason === 'invalid') {
          // 还没到时间 / 凭据格式不对（后者等签到流程去跟用户说清楚，这里不打扰）
        } else {
          m.renew_fail_at = now;
          m.renew_fail_reason = r.reason;
          m.renew_fail_detail = String(r.detail || '').slice(0, 200);
          touched = true;
          summary.failed++;
          summary.details.push(`❌ ${full.name || site.name}：自动续期失败（${REASON_TEXT[r.reason] || r.reason}）${r.detail ? '：' + String(r.detail).slice(0, 120) : ''}`);
        }
        if (touched) {
          await db.prepare('UPDATE accounts SET meta = ?, updated_at = ? WHERE id = ?')
            .bind(JSON.stringify(m), now, full.id).run().catch(() => {});
        }
        // 续期失败、且凭据剩不到 6 小时就死（或已经死了）→ 推送提醒（每天一次，免得每小时刷屏）
        if (!r.renewed && (r.reason === 'network' || r.reason === 'rejected' || r.reason === 'error')
          && r.exp && r.exp * 1000 - now < ALERT_WITHIN_MS) {
          try {
            const tz = (await getSetting(db, 'schedule_tz').catch(() => '')) || 'Asia/Shanghai';
            const { dayInTz } = await import('../schedule.js').catch(() => ({}));
            const day = typeof dayInTz === 'function' ? dayInTz(new Date(), tz) : new Date().toDateString();
            if ((await getSetting(db, 'renew_alert_day').catch(() => '')) !== `renew:${day}`) {
              const { sendNotify } = await import('../notify.js');
              const expStr = fmtTime(r.exp * 1000);
              const when = r.exp * 1000 <= now
                ? `已经过期（${expStr}），且自动续期失败了`
                : `将在 ${expStr} 过期（还剩不到 6 小时），但自动续期失败了`;
              await sendNotify(env, db,
                '凭据自动续期失败',
                `${full.name || site.name} 的登录凭据${when}：` +
                `${REASON_TEXT[r.reason] || r.reason}${r.detail ? '（' + String(r.detail).slice(0, 120) + '）' : ''}。` +
                `面板会继续每小时重试；若一直失败，请手动重新获取凭据。`);
              await setSetting(db, 'renew_alert_day', `renew:${day}`).catch(() => {});
            }
          } catch (e) {
            console.error('[renew] 推送提醒失败', e);
          }
        }
      });
    } catch (e) {
      console.error('[renew] account', acc.id, e);
    }
  }
  return summary;
}

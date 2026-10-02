// 失败自诊断（「医生」）
// ---------------------------------------------------------------------------
// 签到失败时最劝退的不是失败本身，而是不知道该干什么。
// 这里根据 classifySignal 的判定 + 错误文本里的关键字，给出一句能直接照着做的中文建议，
// runner 会把它拼在日志 message 后面（「｜💡 诊断：…」）。
//
// 原则：
//   · 只在 status === 'fail' 时用；成功/跳过不打扰。
//   · 宁缺毋滥：匹配不上任何规则就返回空串，不硬凑一句正确的废话。
//   · 每条建议必须是一个「动作」（重抓 Cookie / 切中继 / 等明天），不说空话。
//   · 纯函数、零依赖，Worker / Node 均可运行。

import { classifySignal, OUTCOME } from './signals.js';

const TIMEOUT_MARKS = [
  '超时', 'timeout', 'timed out', 'fetch failed', 'failed to fetch',
  'econnrefused', 'econnreset', 'enotfound', 'network error', '网络错误',
  '请求异常', '连接被拒绝', 'dns',
];
const EXT_OFFLINE_MARKS = ['扩展不在线', '中继不在线', '本地网络不在线', 'relay offline', 'extension offline'];

// 每条规则：test(text, sig) 命中 → tip(docker) 返回建议文案。顺序即优先级。
// docker = true 时是 Docker 版（NAS 本机网络）：没有「Cloudflare 机房」这条路线，
// 「本地网络」的真实含义是「扩展在真实浏览器标签页里发请求」（真浏览器指纹 + 登录态）。
const RULES = [
  {
    test: (t) => EXT_OFFLINE_MARKS.some((m) => t.includes(m)),
    tip: (docker) => docker
      ? '扩展不在线，走不了浏览器中继。检查扩展是否开着、API Key 是否填对；也可以保持「自动」，面板会改用本机直连再试。'
      : '扩展不在线，中继走不通。检查扩展是否开着、API Key 是否有效；或把该账号的执行方式切回「云端」。',
  },
  {
    test: (t, sig) => sig.outcome === OUTCOME.NEED_LOGIN || /status\s*[:=]\s*401\b|http\s*401\b/i.test(t) && /登录|login|unauthorized/i.test(t),
    tip: () => '网站认为你没登录。先去网站确认账号正常，再用扩展重新抓一次 Cookie 更新到这个账号。',
  },
  {
    test: (t, sig) => sig.outcome === OUTCOME.CAPTCHA,
    tip: (docker) => docker
      ? '撞上人机验证：本机直连用的是程序指纹，过不了"是不是真人"这一关。把执行方式切到「浏览器中继」，让扩展在真实浏览器标签页里代签（先在浏览器里登录好该网站）。'
      : '撞上人机验证。去浏览器里手动过一次验证，再用扩展重抓 Cookie；也可以把执行方式切到「浏览器」让扩展代签。',
  },
  {
    test: (t, sig) => sig.outcome === OUTCOME.WAF || /http\s*403\b|status\s*[:=]\s*403\b/i.test(t),
    tip: (docker) => docker
      ? '被网站安全防护拦了。把该账号的执行方式切到「浏览器中继」，用真实浏览器再试。'
      : '被网站安全防护拦了（机房 IP）。把该账号的执行方式切到「中继」或「浏览器」，走你自己的网络再试。',
  },
  {
    test: (t, sig) => sig.outcome === OUTCOME.RATE_LIMIT,
    tip: () => '请求太频繁被限流。别手动连点，等明天的定时任务自动跑就行。',
  },
  {
    test: (t, sig) => sig.outcome === OUTCOME.PAUSED,
    tip: () => '网站暂停了签到功能，等它恢复后再试。',
  },
  {
    test: (t) => TIMEOUT_MARKS.some((m) => t.toLowerCase().includes(m.toLowerCase())),
    tip: (docker) => docker
      ? '网络没连上。先确认网站在你浏览器里能正常打开；能打开就把执行方式切到「浏览器中继」再试一次。'
      : '网络没连上。先确认网站在你浏览器里能正常打开；能打开就把执行方式切到「中继」再试一次。',
  },
];

export function diagnose({ status, message, detail, runtime } = {}) {
  if (status !== 'fail') return '';
  const msg = String(message || '');
  // 已经带过诊断就不再叠加（runner 重试/复核路径可能多次经过这里）
  if (msg.includes('💡')) return '';
  const text = `${msg}\n${String(detail || '')}`;
  const sig = classifySignal(text);
  const docker = runtime === 'docker';
  for (const r of RULES) {
    try {
      if (r.test(text, sig)) return `💡 诊断：${r.tip(docker)}`;
    } catch { /* 规则内部不该抛错，抛了就跳过这条 */ }
  }
  return '';
}

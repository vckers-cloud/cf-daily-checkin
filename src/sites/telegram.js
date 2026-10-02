// Telegram 群/机器人签到 —— Docker 版专属。
//
// 原理：用 MTProto（gramjs）以「你的 Telegram 账号」身份登录，给指定的
// bot/群发签到指令（如 /checkin），读 bot 的回执判定成功还是已签到。
//
// 为什么只能跑 Docker：MTProto 需要 TCP 长连接，Cloudflare Workers 没有
// TCP socket，在 Workers 上这个模块根本连不上。所以模块声明了 requiresNode，
// runner 在 Workers 上会直接跳过并提示换 Docker 版（不会每 15 分钟空重试）。
//
// 首次使用（一次性）：
//   1. https://my.telegram.org → API development tools → 建应用 → 拿到 api_id / api_hash
//   2. docker exec -it <容器名> node docker/telegram-login.mjs   ← 按提示登录，输出 Session
//   3. 面板「添加账号」选 Telegram 签到，把 Session 粘进去
// 详细步骤见 docker/README.md「Telegram 签到」一节。

// 等待回执的超时（秒）：bot 一般几秒内就回，45 秒没回就当这次没戏
const REPLY_TIMEOUT_MS = 45000;

function splitKeywords(raw, fallback) {
  const list = String(raw || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

function hitKeywords(text, keywords) {
  const t = String(text || '');
  return keywords.some((k) => k && t.includes(k));
}

// 按 bot 回执判结论。返回 { ok, message, detail }，message 是一句话结论。
export function judgeTelegramReply(text, creds) {
  const doneKw = splitKeywords(creds.done_keywords, ['已签到', '已经签到', '重复签到', 'already']);
  const okKw = splitKeywords(creds.ok_keywords, ['签到成功', '成功', '领取成功']);
  const detail = `TG 回执：${String(text || '').slice(0, 300)}`;
  if (hitKeywords(text, doneKw)) {
    return { ok: true, message: '今日已签到', detail };
  }
  if (hitKeywords(text, okKw)) {
    return { ok: true, message: '签到成功', detail };
  }
  const err = new Error(`签到结果未知：${String(text || '').slice(0, 80) || 'bot 没有回复可识别的内容'}`);
  err.detail = detail;
  err.judged = true; // 已经是最终结论，run() 里不要再包一层
  throw err;
}

// gramjs（telegram 包）内部 require 了 net/fs 等 Node 内置模块，Workers 里根本没有。
// esbuild 会静态分析 import() 的字符串字面量并试图打包 —— 必须让它分析不出来，
// 否则整个 CF 构建都会挂（2026-09-30 实测：v2.18.0 起所有构建因此失败，线上停在 v2.17.1）。
// 所以这里用变量拼模块名：esbuild 遇到非常量 specifier 会原样保留为运行时 import。
// 安全性：Workers 上这个函数永远不会被调用（runner 的 requiresNode 提前拦截，
// 见 needNodeSkip），只有 Docker/Node 运行时才会真正执行到这里，而那里 telegram 包是装好了的。
const TG_PKG = 'tele' + 'gram';
// 默认客户端工厂：真连 Telegram（gramjs）。动态 import ——
// 顶层静态 import 'telegram' 会让 Cloudflare Workers 在加载站点注册表时就炸，
// 而这个模块在 Workers 上只是「被注册、从不被执行」。
async function defaultTgFactory({ apiId, apiHash, session }) {
  const [{ TelegramClient }, { StringSession }, { NewMessage }] = await Promise.all([
    import(TG_PKG),
    import(TG_PKG + '/sessions/index.js'),
    import(TG_PKG + '/events/index.js'),
  ]);
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
  });
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    // 先挂好回执监听再发指令：回来的是「发指令之后、对方发来的第一条文字消息」
    sendAndWaitReply: (target, message, timeoutMs) =>
      new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, val) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { client.removeEventHandler(handler); } catch { /* 忽略 */ }
          fn(val);
        };
        const timer = setTimeout(
          () => finish(reject, new Error(`等待签到回执超时（${Math.round(timeoutMs / 1000)}s），对方可能没回复`)),
          timeoutMs
        );
        const handler = async (event) => {
          const msg = event && event.message;
          if (!msg || msg.out) return; // 只要对方发来的（过滤掉自己发出去的指令回显）
          const text = msg.text || msg.message || '';
          if (!text) return;
          finish(resolve, String(text));
        };
        client.addEventHandler(handler, new NewMessage({}));
        client.sendMessage(target, { message }).catch((e) => finish(reject, e));
      }),
  };
}

export const telegram = {
  id: 'telegram',
  name: 'Telegram 签到',
  desc: '给指定 TG 机器人/群发签到指令。Docker 版专属（MTProto 要 TCP，Workers 跑不了）。',
  // 在 Docker 里走本机直连即可；Workers 上会被 runner 提前拦截（requiresNode）
  execution: 'server',
  // 需要 Node.js（TCP 长连接）：runner 在非 Node 环境直接给明确提示，不空转重试
  requiresNode: true,
  domain: 'telegram.org',
  fields: [
    {
      key: 'api_id',
      label: 'API ID',
      type: 'text',
      required: true,
      placeholder: 'my.telegram.org 申请到的数字 ID',
    },
    {
      key: 'api_hash',
      label: 'API Hash',
      type: 'text',
      required: true,
      placeholder: 'my.telegram.org 申请到的 hash',
    },
    {
      key: 'session',
      label: 'Session',
      type: 'textarea',
      required: true,
      placeholder: 'docker exec -it 容器名 node docker/telegram-login.mjs 登录后输出的那段',
    },
    {
      key: 'target',
      label: '签到目标',
      type: 'text',
      required: true,
      placeholder: '@机器人用户名 或 群链接，如 @checkin_bot',
    },
    {
      key: 'command',
      label: '签到指令',
      type: 'text',
      required: false,
      placeholder: '/checkin（默认）',
    },
    {
      key: 'ok_keywords',
      label: '成功关键词',
      type: 'text',
      required: false,
      placeholder: '签到成功（多个用 | 分隔）',
    },
    {
      key: 'done_keywords',
      label: '已签到关键词',
      type: 'text',
      required: false,
      placeholder: '已签到（多个用 | 分隔）',
    },
  ],
  tips: 'Docker 版专属：先去 my.telegram.org 建应用拿 api_id/api_hash，再用 docker/telegram-login.mjs 登录一次拿到 Session，粘到上面。Session 等于你的 TG 登录态，面板加密存储，不要外传。',
  login: {
    kind: 'none',
    captcha: 'none',
    url: 'https://my.telegram.org',
    note: '先去 my.telegram.org 建应用（拿 api_id/api_hash），再用登录脚本拿 Session',
  },

  async run(creds, ctx) {
    const apiId = Number(creds.api_id);
    const apiHash = String(creds.api_hash || '').trim();
    const session = String(creds.session || '').trim();
    const target = String(creds.target || '').trim();
    const command = String(creds.command || '').trim() || '/checkin';
    if (!apiId || !apiHash) {
      const err = new Error('请先填好 API ID / API Hash（my.telegram.org 申请）');
      err.detail = '';
      throw err;
    }
    if (!session) {
      const err = new Error('请先填 Session：docker exec -it 容器名 node docker/telegram-login.mjs 登录后会输出');
      err.detail = '';
      throw err;
    }
    if (!target) {
      const err = new Error('请填写签到目标（@机器人用户名 或 群链接）');
      err.detail = '';
      throw err;
    }
    // 测试注入点：单测传 ctx.tgFactory 伪造客户端，避免真连 Telegram
    const factory = (ctx && ctx.tgFactory) || defaultTgFactory;
    let client;
    try {
      client = await factory({ apiId, apiHash, session });
    } catch (e) {
      const err = new Error(`Telegram 客户端初始化失败：${e.message || e}（Docker 镜像里是否装了 telegram 依赖？）`);
      err.detail = String((e && e.stack) || e).slice(0, 300);
      throw err;
    }
    try {
      await client.connect();
      const reply = await client.sendAndWaitReply(target, command, REPLY_TIMEOUT_MS);
      return judgeTelegramReply(reply, creds);
    } catch (e) {
      if (e && e.judged) throw e; // judgeTelegramReply 已经给了最终结论，原样抛出
      // 连接/授权类错误给明确指引
      const m = String((e && e.message) || e || '');
      if (/auth|unauthor|SESSION_REVOKED|expired/i.test(m)) {
        const err = new Error('TG 登录已失效，请用 docker/telegram-login.mjs 重新登录拿新的 Session');
        err.detail = m.slice(0, 300);
        throw err;
      }
      const err = new Error(`TG 签到失败：${m.slice(0, 80)}`);
      err.detail = m.slice(0, 300);
      throw err;
    } finally {
      try { await client.disconnect(); } catch { /* 忽略 */ }
    }
  },
};

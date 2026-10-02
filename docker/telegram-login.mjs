// Telegram 登录脚本（一次性）：交互式登录你的 TG 账号，输出 Session 字符串。
//
// 用法（在跑容器的机器上，-it 必须，否则没法交互输入）：
//   docker exec -it daily-checkin-panel node docker/telegram-login.mjs
//
// 流程：输入 api_id / api_hash（my.telegram.org 申请）→ 手机号 → 手机验证码 →
//       两步验证密码（没设直接回车）→ 输出 Session。
// 把输出的那段 Session 完整粘到面板「Telegram 签到」账号的 Session 栏即可。
// Session 等于你的 TG 登录态，不要截图外传。

import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

try {
  const apiId = Number((await ask('API ID（my.telegram.org 上的数字）：')).trim());
  const apiHash = (await ask('API Hash：')).trim();
  const phone = (await ask('手机号（带国家码，如 +8613800000000）：')).trim();
  if (!apiId || !apiHash || !phone) {
    console.error('API ID / API Hash / 手机号都要填，退出。');
    process.exit(1);
  }

  let TelegramClient, StringSession;
  try {
    ({ TelegramClient } = await import('telegram'));
    ({ StringSession } = await import('telegram/sessions/index.js'));
  } catch {
    console.error('缺少 telegram 依赖，请先在容器里执行：npm install telegram');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });
  console.log('正在连接 Telegram……（手机会收到验证码）');
  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => (await ask('手机验证码：')).trim(),
    password: async () => (await ask('两步验证密码（没设直接回车）：')).trim(),
    onError: (err) => console.log('提示：' + (err && err.message ? err.message : err)),
  });

  const session = client.session.save();
  console.log('\n================ 登录成功 ================');
  console.log('把下面这段 Session 完整粘到面板「Telegram 签到」账号的 Session 栏：\n');
  console.log(session);
  console.log('\n==========================================');
  await client.disconnect();
} catch (e) {
  console.error('登录失败：' + ((e && e.message) || e));
  process.exit(1);
} finally {
  rl.close();
}

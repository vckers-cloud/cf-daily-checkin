// Docker 入口：把 Cloudflare Worker（src/index.js 的 fetch / scheduled）跑在 Node.js 上。
//
//   HTTP 请求  → worker.fetch(req, env, ctx)
//   每分钟定时 → worker.scheduled({ cron }, env, ctx)（对齐 wrangler.toml 的 crons）
//
// 环境变量：
//   PORT              监听端口（默认 8787）
//   HOST              监听地址（默认 0.0.0.0）
//   DB_PATH           SQLite 文件路径（默认 /data/checkin.sqlite，compose 里挂了 volume）
//   ENCRYPT_KEY       必填：账号凭据加密密钥，投入使用后绝不能改（openssl rand -hex 32）
//   EXTERNAL_API_KEY  选填：兼容老 Cloudflare Secret 的外部 API Key
//   TZ                时区（默认 Asia/Shanghai，只影响日志时间显示；签到时间走面板设置）

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import worker from '../src/index.js';
import { createD1, createAssets } from './adapter.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || '/data/checkin.sqlite';
const PUBLIC_DIR = new URL('../public', import.meta.url).pathname;

if (process.env.ENCRYPT_KEY) {
  // 格式不对时面板会在第一次加解密时报一句能看懂的话，这里先预检，启动就拦下来。
  const m = String(process.env.ENCRYPT_KEY).replace(/\s+/g, '');
  let ok = false;
  try { ok = Buffer.from(m, 'base64').length === 32 && /^[A-Za-z0-9+/=]+$/.test(m); } catch { ok = false; }
  if (!ok) {
    console.error('❌ ENCRYPT_KEY 格式不对：必须是 32 字节的 base64（openssl rand -base64 32 生成）。');
    process.exit(1);
  }
}
mkdirSync(dirname(DB_PATH), { recursive: true });

// 和 Cloudflare 上的 env 对齐：DB/ASSETS/密钥 保持一致，另加 RUNTIME 标识运行环境。
const env = {
  DB: createD1(DB_PATH),
  ASSETS: createAssets(PUBLIC_DIR),
  ENCRYPT_KEY: process.env.ENCRYPT_KEY,
  RUNTIME: 'docker',
};
if (process.env.EXTERNAL_API_KEY) env.EXTERNAL_API_KEY = process.env.EXTERNAL_API_KEY;

// waitUntil：Worker 里用来「响应先回、善后慢慢做」。
// 这里顺手记下来，关机时等它们收尾完再关数据库，避免写一半被掐掉。
const pending = new Set();
const ctx = {
  waitUntil: (p) => {
    const pr = Promise.resolve(p);
    pending.add(pr);
    pr.catch((e) => console.error('[waitUntil]', e)).finally(() => pending.delete(pr));
  },
};

const server = http.createServer(async (nodeReq, nodeRes) => {
  try {
    const chunks = [];
    for await (const c of nodeReq) chunks.push(c);
    const body = Buffer.concat(chunks);
    const host = nodeReq.headers.host || `127.0.0.1:${PORT}`;
    // 扩展下载包里的面板地址就是从这里的 origin 注入的，所以 Host 必须透传正确。
    const url = `http://${host}${nodeReq.url}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else headers.set(k, v);
    }
    const init = { method: nodeReq.method, headers };
    if (body.length > 0 && nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') init.body = body;

    const wres = await worker.fetch(new Request(url, init), env, ctx);

    // set-cookie 可能有多条，entries() 会把它拼坏，单独处理。
    const outHeaders = {};
    wres.headers.forEach((v, k) => { outHeaders[k] = v; });
    const setCookies = typeof wres.headers.getSetCookie === 'function' ? wres.headers.getSetCookie() : [];
    if (setCookies.length > 0) outHeaders['set-cookie'] = setCookies;
    nodeRes.writeHead(wres.status, outHeaders);
    if (wres.body) nodeRes.end(Buffer.from(await wres.arrayBuffer()));
    else nodeRes.end();
  } catch (e) {
    console.error('[http]', e);
    if (!nodeRes.headersSent) nodeRes.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    nodeRes.end('服务异常');
  }
});

// 定时：对齐到下一分钟整点再跑，和 Cloudflare Cron 一样每分钟触发一次。
// 面板自己的 shouldRun 有幂等（sched_last_map），即使某次延迟也不会重复签到。
function armCron() {
  const next = Math.ceil((Date.now() + 1) / 60000) * 60000;
  setTimeout(async () => {
    armCron();
    try {
      await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, ctx);
    } catch (e) {
      console.error('[cron]', e);
    }
  }, Math.max(0, next - Date.now()));
}

server.listen(PORT, HOST, () => {
  console.log(`✅ 签到面板已启动：http://${HOST === '0.0.0.0' ? '本机IP' : HOST}:${PORT}`);
  console.log(`   数据文件：${DB_PATH}`);
  if (process.env.ENCRYPT_KEY) console.log('   凭据加密：使用环境变量 ENCRYPT_KEY（投入使用后不要改）');
  else console.log('   凭据加密：未设置 ENCRYPT_KEY，首次使用时自动生成并存入数据库（备份好 /data 目录）');
  console.log('   定时任务：每分钟（和 Cloudflare Cron 一致）');
  armCron();
});

function shutdown(signal) {
  console.log(`\n${signal}，正在关闭…`);
  server.close(async () => {
    // 等 cron/善后任务收尾（最多 8 秒），再关数据库
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    } catch { /* 忽略 */ }
    try { env.DB.close(); } catch { /* 忽略 */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 15000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

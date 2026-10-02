// Telegram 签到模块测试：node test/telegram.test.mjs（纯 mock，不连 Telegram）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { telegram, judgeTelegramReply } from '../src/sites/telegram.js';
import { nodeseek } from '../src/sites/nodeseek.js';
import { SITES, siteMeta } from '../src/sites/index.js';
import { isNodeRuntime, needNodeSkip } from '../src/runner.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

// 伪造的 TG 客户端：按剧本回 reply，或抛 error
function fakeFactory({ reply, error }) {
  return async () => ({
    connect: async () => {},
    disconnect: async () => {},
    sendAndWaitReply: async (target, message) => {
      assert.equal(target, '@checkin_bot');
      assert.equal(message, '/checkin');
      if (error) throw error;
      return reply;
    },
  });
}

const creds = {
  api_id: '12345',
  api_hash: 'hash',
  session: 'sess',
  target: '@checkin_bot',
  command: '/checkin',
};

await t('站点已注册：requiresNode=true，siteMeta 透出', () => {
  assert.ok(SITES.find((s) => s.id === 'telegram'), 'SITES 里要有 telegram');
  const meta = siteMeta().find((s) => s.id === 'telegram');
  assert.equal(meta.requiresNode, true);
  assert.ok(meta.fields.find((f) => f.key === 'session'), '要有 Session 字段');
  assert.ok(meta.fields.find((f) => f.key === 'target'), '要有签到目标字段');
});

await t('isNodeRuntime：node 下为 true', () => {
  assert.equal(isNodeRuntime(), true);
});

await t('needNodeSkip：Workers 下拦截 telegram，Node 下放行，普通站点不受影响', () => {
  const onWorkers = needNodeSkip(telegram, false);
  assert.match(onWorkers, /需要 Docker 版/);
  assert.match(onWorkers, /Telegram 签到/);
  assert.equal(needNodeSkip(telegram, true), null);
  assert.equal(needNodeSkip(nodeseek, false), null);
});

await t('回执判定：成功关键词', () => {
  const r = judgeTelegramReply('签到成功，获得 10GB 流量', creds);
  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
  assert.match(r.detail, /TG 回执/);
});

await t('回执判定：已签到', () => {
  const r = judgeTelegramReply('你今天已经签到过了', creds);
  assert.equal(r.ok, true);
  assert.match(r.message, /已签到/);
});

await t('回执判定：自定义关键词', () => {
  const r = judgeTelegramReply('checkin done', { ...creds, ok_keywords: 'done|finished' });
  assert.equal(r.ok, true);
});

await t('回执判定：未知回执抛错且带 judged 标记（run 里不再包第二层）', () => {
  assert.throws(
    () => judgeTelegramReply('哈哈哈', creds),
    (e) => {
      assert.equal(e.judged, true);
      assert.match(e.message, /签到结果未知/);
      assert.match(e.detail, /哈哈哈/);
      return true;
    }
  );
});

await t('run：成功', async () => {
  const r = await telegram.run(creds, { tgFactory: fakeFactory({ reply: '签到成功' }) });
  assert.equal(r.ok, true);
  assert.match(r.message, /签到成功/);
});

await t('run：未知回执原样抛出（不包"TG 签到失败"第二层）', async () => {
  await assert.rejects(
    telegram.run(creds, { tgFactory: fakeFactory({ reply: '哈哈哈' }) }),
    (e) => {
      assert.match(e.message, /^签到结果未知/);
      return true;
    }
  );
});

await t('run：缺 Session 给明确指引', async () => {
  await assert.rejects(telegram.run({ ...creds, session: '' }, {}), /Session/);
});

await t('run：缺签到目标给明确指引', async () => {
  await assert.rejects(telegram.run({ ...creds, target: '' }, {}), /签到目标/);
});

await t('run：依赖缺失给明确指引', async () => {
  const badFactory = async () => {
    throw new Error("Cannot find package 'telegram'");
  };
  await assert.rejects(telegram.run(creds, { tgFactory: badFactory }), /telegram 依赖/);
});

await t('run：授权失效给重登指引', async () => {
  const authFactory = async () => ({
    connect: async () => {
      throw new Error('AUTH_KEY_UNREGISTERED');
    },
    disconnect: async () => {},
    sendAndWaitReply: async () => {
      throw new Error('unreachable');
    },
  });
  await assert.rejects(telegram.run(creds, { tgFactory: authFactory }), /重新登录/);
});

await t('docker-compose：IPv6 修复——默认 host 网络模式', () => {
  const yml = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  assert.match(yml, /network_mode:\s*["']?host["']?/);
});

console.log(`\n全部 ${n} 组通过`);

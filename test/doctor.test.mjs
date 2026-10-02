// 失败自诊断测试：node test/doctor.test.mjs（纯函数，无网络）
import assert from 'node:assert/strict';
import { diagnose } from '../src/lib/doctor.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

await t('非失败状态不诊断', () => {
  assert.equal(diagnose({ status: 'ok', message: '签到成功', detail: '' }), '');
  assert.equal(diagnose({ status: 'skip', message: '跳过', detail: '' }), '');
});

await t('登录失效 → 重抓 Cookie', () => {
  const d = diagnose({ status: 'fail', message: '登录已失效，请重新获取 Cookie', detail: '请先登录' });
  assert.ok(d.includes('重新抓一次 Cookie'), d);
});

await t('401 + login → 登录建议', () => {
  const d = diagnose({ status: 'fail', message: '步骤1：状态码 401，期望 200', detail: '{"msg":"unauthorized"}' });
  assert.ok(d.includes('没登录'), d);
});

await t('人机验证 → 手动过验证', () => {
  const d = diagnose({ status: 'fail', message: '遇到滑块验证', detail: '请拖动滑块完成验证' });
  assert.ok(d.includes('人机验证'), d);
});

await t('WAF/403 → 切中继', () => {
  const d = diagnose({ status: 'fail', message: '遇到网站安全验证', detail: 'Request blocked' });
  assert.ok(d.includes('中继'), d);
  const d2 = diagnose({ status: 'fail', message: 'HTTP 403', detail: '' });
  assert.ok(d2.includes('中继'), d2);
});

await t('限流 → 等明天', () => {
  const d = diagnose({ status: 'fail', message: '请求过于频繁', detail: '' });
  assert.ok(d.includes('明天'), d);
});

await t('暂停签到 → 等恢复', () => {
  const d = diagnose({ status: 'fail', message: '网站暂停签到', detail: '' });
  assert.ok(d.includes('恢复'), d);
});

await t('超时 → 查网络/切中继', () => {
  const d = diagnose({ status: 'fail', message: '签到请求异常（fetch failed）', detail: '' });
  assert.ok(d.includes('中继'), d);
});

await t('扩展不在线 → 检查扩展', () => {
  const d = diagnose({ status: 'fail', message: '本地中继请求超时：扩展不在线', detail: '' });
  assert.ok(d.includes('扩展不在线'), d);
});

await t('未知错误不硬凑', () => {
  assert.equal(diagnose({ status: 'fail', message: '某种没见过的错误', detail: 'xyz' }), '');
});

await t('已带诊断不再叠加', () => {
  const m = '失败｜💡 诊断：xxx';
  assert.equal(diagnose({ status: 'fail', message: m, detail: '' }), '');
});

await t('Docker：人机验证 → 指浏览器中继（不提 CF 网络）', () => {
  const d = diagnose({ status: 'fail', message: '遇到 Cloudflare 人机验证', detail: 'challenge', runtime: 'docker' });
  assert.ok(d.includes('浏览器中继'), d);
  assert.ok(!d.includes('CF 网络'), d);
  assert.ok(!d.includes('本地网络'), d);
});

await t('Docker：WAF → 指浏览器中继', () => {
  const d = diagnose({ status: 'fail', message: 'HTTP 403', detail: '', runtime: 'docker' });
  assert.ok(d.includes('浏览器中继'), d);
});

await t('Docker：扩展离线 → 说浏览器中继不可用', () => {
  const d = diagnose({ status: 'fail', message: '本地中继请求超时：扩展不在线', detail: '', runtime: 'docker' });
  assert.ok(d.includes('浏览器中继'), d);
});

await t('CF：人机验证 → 旧文案不变', () => {
  const d = diagnose({ status: 'fail', message: '遇到滑块验证', detail: '' });
  assert.ok(!d.includes('浏览器中继'), d);
  const d2 = diagnose({ status: 'fail', message: '遇到滑块验证', detail: '', runtime: 'workers' });
  assert.ok(!d2.includes('浏览器中继'), d2);
});

console.log(`\n${n} 个断言全部通过`);

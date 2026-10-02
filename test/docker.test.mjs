// docker/adapter.mjs 的单测：D1 兼容层 + _headers 解析 + MIME。
// 用法：node test/docker.test.mjs（tools/verify.mjs 会自动跑）
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createD1, parseHeadersFile, matchHeaders, mimeFor } from '../docker/adapter.mjs';

test('D1：建表/插入/查询/更新/删除', () => {
  const db = createD1(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
  const r1 = db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').bind('a', 1).run();
  assert.equal(r1.success, true);
  assert.equal(r1.meta.last_row_id, 1);
  const r2 = db.prepare('INSERT INTO t (name, n) VALUES (?, ?)').bind('b', 2).run();
  assert.equal(r2.meta.last_row_id, 2);

  const all = db.prepare('SELECT * FROM t ORDER BY id').all();
  assert.equal(all.results.length, 2);
  assert.equal(all.results[0].name, 'a');

  const one = db.prepare('SELECT name FROM t WHERE id = ?').bind(2).first();
  assert.equal(one.name, 'b');

  const none = db.prepare('SELECT name FROM t WHERE id = ?').bind(99).first();
  assert.equal(none, null); // D1 无行返回 null，不是 undefined

  const up = db.prepare('UPDATE t SET n = ? WHERE id = ?').bind(9, 1).run();
  assert.equal(up.meta.changes, 1);
  db.prepare('DELETE FROM t WHERE id = ?').bind(2).run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM t').first().c, 1);
  db.close();
});

test('D1：undefined/boolean 转义成 SQLite 能接受的值', () => {
  const db = createD1(':memory:');
  db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').bind(undefined, true).run();
  const row = db.prepare('SELECT * FROM t').first();
  assert.equal(row.a, null);
  assert.equal(row.b, 1);
  db.close();
});

test('D1：batch 是事务性的，失败整体回滚', () => {
  const db = createD1(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)');
  db.prepare('INSERT INTO t (v) VALUES (?)').bind('keep').run();
  const stmts = [
    db.prepare('INSERT INTO t (v) VALUES (?)').bind('ok1'),
    db.prepare('INSERT INTO t (v) VALUES (?)').bind('keep'), // UNIQUE 冲突
  ];
  assert.throws(() => db.batch(stmts));
  // ok1 也被回滚了，只剩原来那条
  assert.equal(db.prepare('SELECT COUNT(*) c FROM t').first().c, 1);
  db.close();
});

test('D1：batch 成功返回每条 run 的结果', () => {
  const db = createD1(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const out = db.batch([
    db.prepare('INSERT INTO t (v) VALUES (?)').bind('x'),
    db.prepare('INSERT INTO t (v) VALUES (?)').bind('y'),
  ]);
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.success));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM t').first().c, 2);
  db.close();
});

test('_headers：通配 + 精确路径都能匹配', () => {
  const rules = parseHeadersFile([
    '# 注释',
    '/*',
    '  X-Frame-Options: DENY',
    '',
    '/a.zip',
    '  Cache-Control: no-store',
  ].join('\n'));
  const root = matchHeaders(rules, '/index.html');
  assert.ok(root.some(([k, v]) => k === 'X-Frame-Options' && v === 'DENY'));
  assert.equal(matchHeaders(rules, '/a.zip').length, 2);
  assert.equal(matchHeaders(rules, '/b.zip').length, 1); // 只有通配
});

test('mimeFor：常见后缀', () => {
  assert.equal(mimeFor('a.html'), 'text/html; charset=utf-8');
  assert.equal(mimeFor('a.JS'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('a.svg'), 'image/svg+xml');
  assert.equal(mimeFor('a.unknownext'), 'application/octet-stream');
});

// Docker 运行时适配层：把 Worker 依赖的 Cloudflare 环境（D1 / ASSETS）
// 用 Node.js 内置能力实现出来。面板代码（src/）一行不用改。
//
//   env.DB     → node:sqlite 上的 D1 兼容层（prepare/bind/run/all/first/batch）
//   env.ASSETS → public/ 目录 + public/_headers 头规则 + SPA 回退
//
// 注意：接口形状刻意对齐 D1（返回值带 success/meta，first() 无行返回 null），
// 以后即使换回 Cloudflare 也不会有行为差。

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// D1 只接受 null/number/string/ArrayBuffer 等；JS 的 undefined/boolean
// 在 node:sqlite 里会炸，转成 SQLite 能懂的样子（D1 侧本来也只传这几种）。
function toSqliteValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class D1Statement {
  constructor(sqlite, sql) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params.map(toSqliteValue);
    return this;
  }
  run() {
    const r = this.sqlite.prepare(this.sql).run(...this.params);
    const out = {
      success: true,
      meta: {
        changes: Number(r.changes),
        last_row_id: Number(r.lastInsertRowid),
        rows_read: 0,
        rows_written: Number(r.changes),
      },
    };
    return out;
  }
  all() {
    const rows = this.sqlite.prepare(this.sql).all(...this.params);
    return {
      success: true,
      results: rows,
      meta: { changes: 0, last_row_id: 0, rows_read: rows.length, rows_written: 0 },
    };
  }
  first() {
    const row = this.sqlite.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
}

// path 为 ':memory:' 时走内存库（单测用）；否则落盘。
export function createD1(path) {
  const sqlite = new DatabaseSync(path);
  // WAL：定时任务和 HTTP 请求可能交错写，WAL 比回滚日志更扛并发。
  try { sqlite.exec('PRAGMA journal_mode = WAL;'); } catch { /* 内存库无所谓 */ }
  return {
    prepare: (sql) => new D1Statement(sqlite, sql),
    // D1 的 batch 是事务性的：要么全成功，要么全回滚。
    batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const out = statements.map((s) => s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        try { sqlite.exec('ROLLBACK'); } catch { /* 忽略 */ }
        throw e;
      }
    },
    exec: (sql) => {
      sqlite.exec(sql);
      return { success: true };
    },
    // 容器退出时用得到；平时不用调。
    close: () => sqlite.close(),
  };
}

// ---- public/_headers 解析 ----
// 格式：一段一个路径（精确路径，或 /* 前缀通配），下面缩进行是「头: 值」。
// 注释行 # 开头，空行分隔。
export function parseHeadersFile(text) {
  const rules = [];
  let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!/^\s/.test(raw) && !line.includes(':')) {
      cur = { pattern: line, headers: [] };
      rules.push(cur);
    } else if (cur && line.includes(':')) {
      const i = line.indexOf(':');
      cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

export function matchHeaders(rules, pathname) {
  const out = [];
  for (const r of rules) {
    if (r.pattern.endsWith('/*')) {
      if (pathname.startsWith(r.pattern.slice(0, -1))) out.push(...r.headers);
    } else if (pathname === r.pattern) {
      out.push(...r.headers);
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.zip': 'application/zip',
};

export function mimeFor(filename) {
  const i = filename.lastIndexOf('.');
  const ext = i >= 0 ? filename.slice(i).toLowerCase() : '';
  return MIME[ext] || 'application/octet-stream';
}

// 对齐 Cloudflare Workers Static Assets 的行为：
// 文件存在就 serve；目录 → index.html；都不存在 → SPA 回退到 index.html（200）。
// （wrangler.toml 里 not_found_handling = "single-page-application"）
export function createAssets(publicDir) {
  const root = resolve(publicDir);
  let rules = [];
  try {
    rules = parseHeadersFile(readFileSync(join(root, '_headers'), 'utf8'));
  } catch { /* 没有 _headers 就不加头 */ }

  return {
    async fetch(req) {
      const url = new URL(req.url);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
      const rel = pathname.replace(/^\/+/, '');
      const file = resolve(root, rel);
      // 防目录穿越：解析完必须还在 public 里
      if (file !== root && !file.startsWith(root + sep)) {
        return new Response('Not Found', { status: 404 });
      }
      let st = null;
      try { st = statSync(file); } catch { /* 不存在 */ }
      let target;
      if (st && st.isDirectory()) target = join(file, 'index.html');
      else if (st) target = file;
      else target = join(root, 'index.html'); // SPA 回退
      let body;
      try { body = readFileSync(target); } catch {
        return new Response('Not Found', { status: 404 });
      }
      const headers = new Headers({ 'Content-Type': mimeFor(target) });
      for (const [k, v] of matchHeaders(rules, pathname)) headers.set(k, v);
      return new Response(body, { status: 200, headers });
    },
  };
}

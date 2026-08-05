/**
 * sync-server/server.mjs — 提肛陪伴多端同步后端(自建,端到端加密)
 *
 * 零 npm 依赖:node:http + node:sqlite(Node 22+ 内置;24 实测无需 flag)。
 * 只存取密文 blob,永不解密、不解析内容、不收主密码 —— 主密码绝不离开设备。
 * 由 nginx 反代 443 → 127.0.0.1:8787(CORS 全在 nginx 加,见 nginx.conf.example)。
 *
 * 端点:
 *   OPTIONS *           preflight 短路 204 + CORS
 *   GET  /sync?key=<u>  拉密文  {ok:true,blob} | {ok:false,error:'none'}(无数据)
 *   PUT  /sync?key=<u>  推密文  body {blob}(≤1MB)→ {ok:true};覆盖存储(last-write-wins)
 *   GET  /health        探活    {ok:true}
 *
 * 冲突处理:后端不处理,last-write-wins 覆盖;合并由客户端做(拉→解密→mergeForSync→加密→推)。
 *
 * 限流(持久存储必须防滥用):
 *   · 同 userId PUT > 1 次/10s → 429 {ok:false,error:'rate'}(用 updated_at 判)
 *   · 单 IP 全部端点 > 20 次/分 → 429(内存 Map + 时间窗,进程重启清零可接受;单机够用)
 *   nginx 层另配 limit_req 兜底(见 nginx.conf.example)。
 *
 * 环境变量:
 *   HOST     默认 127.0.0.1(只监听回环,nginx 反代,不直接暴露)
 *   PORT     默认 8787
 *   DB_PATH  默认 本文件同目录 data/sync.db
 */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const DB_PATH =
  process.env.DB_PATH || fileURLToPath(new URL('./data/sync.db', import.meta.url));

const MAX_BLOB_BYTES = 1024 * 1024; // 1MB 密文上限
const MAX_BODY_BYTES = MAX_BLOB_BYTES + 4096; // JSON 外壳余量
const USER_PUT_INTERVAL_MS = 10_000; // 同 userId PUT 最小间隔
const IP_RATE_WINDOW_MS = 60_000; // 单 IP 限流时间窗
const IP_RATE_LIMIT = 20; // 时间窗内请求上限
const MAX_KEY_LEN = 128;

/* ---------------- SQLite ---------------- */

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS blobs(
    user_id TEXT PRIMARY KEY,
    blob TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    put_count INTEGER NOT NULL DEFAULT 0
  );
`);

/* ---------------- 单 IP 限流(内存时间窗) ---------------- */

const ipHits = new Map(); // ip -> number[](窗口内时间戳)

function clientIp(req) {
  // 只监听回环:直接对端永远是 nginx 或本地测试。nginx 用 proxy_set_header
  // X-Forwarded-For $remote_addr; 覆写,后端拿到的就是真实客户端 IP。
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

function checkIpLimit(ip, now = Date.now()) {
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < IP_RATE_WINDOW_MS);
  if (hits.length >= IP_RATE_LIMIT) {
    ipHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return true;
}

/* ---------------- 响应工具 ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*', // 应用无 cookie/凭据,用 * 最简
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(body);
}

/* ---------------- 端点 ---------------- */

function handleHealth(res) {
  send(res, 200, { ok: true });
}

function handleGetSync(res, key) {
  const row = db.prepare('SELECT "blob" AS b FROM blobs WHERE user_id = ?').get(key);
  if (row) send(res, 200, { ok: true, blob: row.b });
  else send(res, 200, { ok: false, error: 'none' }); // 远端无数据(首次)
}

function handlePutSync(req, res, key) {
  // 同 userId 10s 内只允许一次 PUT(用 updated_at 判:成功写入才刷新窗口)
  const row = db.prepare('SELECT updated_at FROM blobs WHERE user_id = ?').get(key);
  const now = Date.now();
  if (row && now - row.updated_at < USER_PUT_INTERVAL_MS) {
    send(res, 429, { ok: false, error: 'rate' });
    return;
  }

  let blob;
  try {
    const parsed = JSON.parse(String(req.body));
    blob = parsed && typeof parsed.blob === 'string' ? parsed.blob : '';
  } catch {
    send(res, 400, { ok: false, error: 'bad-request' });
    return;
  }
  if (!blob) {
    send(res, 400, { ok: false, error: 'bad-request' });
    return;
  }
  if (Buffer.byteLength(blob, 'utf8') > MAX_BLOB_BYTES) {
    send(res, 413, { ok: false, error: 'too-big' });
    return;
  }

  db.prepare(
    `INSERT INTO blobs (user_id, "blob", updated_at, put_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id) DO UPDATE SET
       "blob" = excluded."blob",
       updated_at = excluded.updated_at,
       put_count = blobs.put_count + 1`,
  ).run(key, blob, now);

  send(res, 200, { ok: true });
}

/* ---------------- body 读取(带 1MB 上限) ---------------- */

function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    cb(err);
  };
  req.on('data', (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      send(res, 413, { ok: false, error: 'too-big' });
      req.destroy(); // 丢弃连接,不再消费多余字节
      finish(new Error('too-big'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (done) return;
    req.body = Buffer.concat(chunks).toString('utf8');
    finish(null);
  });
  req.on('error', () => finish(new Error('read-error')));
}

/* ---------------- HTTP 服务 ---------------- */

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const ip = clientIp(req);
  if (!checkIpLimit(ip)) {
    console.log(`${new Date().toISOString()} 429 ip=${ip} ${req.method} ${req.url}`);
    send(res, 429, { ok: false, error: 'rate' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/health') {
    handleHealth(res);
    return;
  }
  if (path === '/sync') {
    const key = String(url.searchParams.get('key') || '');
    if (!key || key.length > MAX_KEY_LEN) {
      console.log(`${new Date().toISOString()} 400 ip=${ip} ${req.method} ${req.url}`);
      send(res, 400, { ok: false, error: 'bad-key' });
      return;
    }
    if (req.method === 'GET') {
      handleGetSync(res, key);
      return;
    }
    if (req.method === 'PUT') {
      // 有 Content-Length 就前置拒绝超限 body,不必读完;chunked(无该头)走 readBody 内上限
      const cl = Number(req.headers['content-length']);
      if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
        send(res, 413, { ok: false, error: 'too-big' });
        return;
      }
      readBody(req, res, (err) => {
        if (err) return;
        handlePutSync(req, res, key);
      });
      return;
    }
    send(res, 405, { ok: false, error: 'method' });
    return;
  }

  send(res, 404, { ok: false, error: 'not-found' });
});

server.listen(PORT, HOST, () => {
  console.log(`sync-server listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
});

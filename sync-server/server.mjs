/**
 * sync-server/server.mjs — 提肛陪伴多端同步后端(自建,端到端加密)
 *
 * 零 npm 依赖:node:http + node:sqlite(Node 22+ 内置;24 实测无需 flag)。
 * 只存取密文 blob,永不解密、不解析内容、不收主密码 —— 主密码绝不离开设备。
 * 默认只监听 127.0.0.1;实际 1Panel/Docker 部署由 systemd 显式绑定 docker0 网关。
 * CORS 与 no-store 由后端直接返回,反代层无需重复维护。
 *
 * 端点:
 *   OPTIONS *           preflight 短路 204 + CORS
 *   GET    /sync?key=<u>  拉密文  {ok:true,blob} | {ok:false,error:'none'}(无数据)
 *   PUT    /sync?key=<u>  推密文  body {blob}(≤1MB)→ {ok:true};覆盖存储(last-write-wins)
 *   DELETE /sync?key=<u>  删桶    {ok:true} —— **幂等**:桶不存在也返回 ok
 *   GET    /health        探活    {ok:true}
 *
 * 孤儿桶(两道防线,见 DEVELOPMENT.md D38):
 *   端到端加密的后端只有密文,分不清一个桶是被弃用了还是主人半年没打开 —— 只能等
 *   客户端来说,或者按时间兜底。所以两道一起上:
 *   ① DELETE:用户在设置里「换新同步 ID」时客户端主动删掉旧桶(即时,但只覆盖这一条路径);
 *   ② TTL 清扫:超过 ORPHAN_TTL_MS 未更新的桶启动时+每天删一次(兜底,不依赖客户端)。
 *   只有 ② 能把"只增不减"变成有界:清 localStorage / 卸载 PWA / 换手机不迁移
 *   都不会有人来调 DELETE。
 *
 * 冲突处理:后端不处理,last-write-wins 覆盖;合并由客户端做(拉→解密→mergeForSync→加密→推)。
 *
 * 限流(持久存储必须防滥用):
 *   · 同 userId PUT > 1 次/3s → 429 {ok:false,error:'rate'}(用 updated_at 判)
 *   · 单 IP 全部端点 > 20 次/分 → 429(内存 Map + 时间窗,进程重启清零可接受;单机够用)
 *   nginx 层另配 limit_req 兜底(见 nginx.conf.example)。
 *
 * 日志:userId 是读写凭据,**绝不整条打印**。日志只记 pathname + key 前 8 位(见 logLine)。
 *   nginx 侧也要关掉 /sync 的 access_log,否则默认 log_format 会把 ?key= 整条写盘。
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
// 同 userId PUT 最小间隔。3s 而非 10s:多设备共用同一个 userId(手填同步 ID 后)
// 会共享这个额度——手机推完 10s 内打开电脑就撞 429,同步显得"偶尔不灵"。
// 防滥用的本意是拦脚本狂刷,3s 足够;客户端收到 rate 还会自动延后重试一次。
const USER_PUT_INTERVAL_MS = 3_000;
const IP_RATE_WINDOW_MS = 60_000; // 单 IP 限流时间窗
const IP_RATE_LIMIT = 20; // 时间窗内请求上限
const MAX_KEY_LEN = 128;
// 孤儿桶兜底:超过这么久没 PUT 过的桶视为废弃,清扫掉。
// 180 天是刻意给足的:活跃用户每次同步都会刷新 updated_at,永远碰不到这条线;
// 真正会被删的是"卸载了/换手机了/清了浏览器数据"的桶。**但这是会删数据的设置**——
// 抄着 userId+主密码、半年多没开过应用、指望回来从远端恢复的用户会拿不到数据
// (本机还在的用户不受影响:下次 push 会重新建桶)。要更保守就把这个数字调大。
const ORPHAN_TTL_MS = Number(process.env.ORPHAN_TTL_MS || 180 * 24 * 60 * 60 * 1000);
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每天扫一次(启动时先扫一次)
// userId 必须是 UUID(客户端 newUserId() 的产物);任意字符串不许建桶。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  // 生产只监听宿主 docker0 网关:直接对端应为 1Panel OpenResty。反代用
  // X-Forwarded-For 覆写真实客户端 IP;8787 不得对公网开放。
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

/* ---------------- 日志(凭据不落盘) ---------------- */

// userId 是**读写凭据**:知道它就能 GET 密文、PUT 覆盖。它出现在 ?key= 里,
// 所以任何打印 req.url 的日志都等于把凭据写进 journal —— 日志泄露即凭据泄露。
// 这里统一走 logLine():URL 只留 pathname,key 只留前 8 位用于排查关联。
// nginx 侧同样要关掉该 location 的 access_log(见 nginx.conf.example)。
function keyTag(key) {
  const s = String(key || '');
  return s ? `${s.slice(0, 8)}…` : '-';
}

function logLine(status, ip, req, key) {
  const path = String(req.url || '').split('?')[0];
  console.log(`${new Date().toISOString()} ${status} ip=${ip} ${req.method} ${path} key=${keyTag(key)}`);
}

/* ---------------- 响应工具 ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*', // 应用无 cookie/凭据,用 * 最简
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store', // 密文与 none 响应都不能被浏览器/中间代理缓存
  'X-Content-Type-Options': 'nosniff',
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
  // 同 userId 3s 内只允许一次 PUT(用 updated_at 判:成功写入才刷新窗口)
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

/**
 * 删桶。**故意幂等**:桶不存在也回 {ok:true} ——
 * ① 客户端拿"成功"当"远端已经没有这份数据了",不存在本来就满足这个后置条件;
 * ② 不泄露"这个 UUID 存不存在"(虽然要先猜中一个 v4 UUID 才问得出来);
 * ③ 客户端重试安全(网络超时后重发不会拿到假失败)。
 *
 * 不需要额外鉴权:userId 本来就是读写凭据,知道它的人已经能 PUT 覆盖整个桶了,
 * DELETE 不扩大攻击面(这也正是主密码必须与 userId 分开的原因,见 D35)。
 */
function handleDeleteSync(res, key) {
  db.prepare('DELETE FROM blobs WHERE user_id = ?').run(key);
  send(res, 200, { ok: true });
}

/* ---------------- 孤儿桶清扫(TTL 兜底) ---------------- */

function sweepOrphans(now = Date.now()) {
  const cutoff = now - ORPHAN_TTL_MS;
  const info = db.prepare('DELETE FROM blobs WHERE updated_at < ?').run(cutoff);
  const removed = Number(info.changes || 0);
  // 只记条数,不记 userId:清扫是批量操作,逐个打 key 等于把一批凭据写进 journal。
  if (removed > 0) {
    console.log(`${new Date().toISOString()} sweep removed=${removed} ttl_days=${Math.round(ORPHAN_TTL_MS / 86400000)}`);
  }
  return removed;
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
  for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const ip = clientIp(req);
  if (!checkIpLimit(ip)) {
    logLine(429, ip, req, new URL(req.url, 'http://localhost').searchParams.get('key'));
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
    const rawKey = String(url.searchParams.get('key') || '');
    // 必须是 UUID:客户端 newUserId() 只生成 UUID v4,后端同样校验,
    // 免得任意字符串都能建桶(如手填时打成 "testuser" 会撞上别人/测试残留的桶)。
    // 客户端也校验,但纯前端校验可绕过,这里是最终防线。
    if (!UUID_RE.test(rawKey) || rawKey.length > MAX_KEY_LEN) {
      logLine(400, ip, req, rawKey);
      send(res, 400, { ok: false, error: 'bad-key' });
      return;
    }
    // UUID 大小写等价;统一小写,避免 API 直调时同一个 UUID 被拆成两个 SQLite 桶。
    const key = rawKey.toLowerCase();
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
    if (req.method === 'DELETE') {
      logLine(200, ip, req, key);
      handleDeleteSync(res, key);
      return;
    }
    send(res, 405, { ok: false, error: 'method' });
    return;
  }

  send(res, 404, { ok: false, error: 'not-found' });
});

server.listen(PORT, HOST, () => {
  console.log(`sync-server listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
  // 启动时先扫一次,之后每天一次。unref():清扫定时器不该成为进程存活的理由。
  sweepOrphans();
  setInterval(sweepOrphans, SWEEP_INTERVAL_MS).unref();
});

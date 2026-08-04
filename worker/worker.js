/**
 * 提肛陪伴 — 全站计数服务(零依赖,Cloudflare Worker + Durable Object)
 *
 * 用途:给纯静态 PWA 提供两个全局数字——
 *   ·「此刻 X 人在做」:正在训练中的实时人数(WebSocket 会话 + 心跳保活)
 *   ·「总访问 X」:累计页面访问量(DO storage,可持久化)
 * 数据只经 Cloudflare,不经过任何第三方统计服务。
 *
 * 接口:
 *   GET   /stats     → { online, doing, visits }   (初始值 / 降级轮询)
 *   POST  /visit     → 计入一次访问(body: { visitorId }),返回 { visits }
 *   WS    /ws        → 双向协议,见下方「客户端协议」
 *
 * 客户端协议(客户端→服务端,每帧一个 JSON 字符串):
 *   {"type":"hello","visitorId":"…"}        连接建立后立即发送
 *   {"type":"training","on":true|false}     开始/结束训练时发送
 *   {"type":"ping"}                         心跳(≥ 每 10s 一次,兼作会话活跃标记)
 * 服务端→客户端:
 *   {"type":"stats","online":n,"doing":m,"visits":v}
 *   (连接建立、任一计数变化、以及周期广播时推送)
 *
 * 部署:见 worker/README.md。免费额度对个人站绰绰有余。
 */

const STATS_INTERVAL_MS = 10000; // 周期广播间隔
const STALE_AFTER_MS = 30000; // 超过该时长未收到任何消息的会话判定掉线并剔除

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName('global'));
    return stub.fetch(request);
  },
};

export class Presence {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /** server-ws -> { training:boolean, lastSeen:number } */
    this.sessions = new Map();
    this.broadcastTimer = null;
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/ws' || request.headers.get('Upgrade') === 'websocket') {
      return this.handleSocket(request);
    }
    if (path === '/visit' && request.method === 'POST') {
      return this.handleVisit(request);
    }
    return this.handleStats();
  }

  /* ---------------- 实时会话(在做 / 在线人数) ---------------- */

  async handleSocket(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return this.json({ error: '需要 WebSocket 升级头' }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session = { training: false, lastSeen: Date.now() };
    this.sessions.set(server, session);

    server.addEventListener('message', (event) => {
      const s = this.sessions.get(server);
      if (!s) return;
      s.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type === 'training') {
        const on = !!msg.on;
        if (s.training !== on) {
          s.training = on;
          this.broadcast(); // 有人在训练/结束训练,立刻广播
        }
      }
    });

    server.addEventListener('close', () => {
      this.sessions.delete(server);
      this.broadcast();
    });
    server.addEventListener('error', () => {
      try {
        server.close();
      } catch {
        /* 已关闭 */
      }
    });

    this.ctx.acceptWebSocket(server);
    this.ensureBroadcastTimer();
    // 让新连接尽快拿到当前数;同时把自身训练状态带上去
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  ensureBroadcastTimer() {
    if (this.broadcastTimer !== null) return;
    this.broadcastTimer = setInterval(() => this.broadcast(), STATS_INTERVAL_MS);
  }

  pruneStale() {
    const now = Date.now();
    for (const [ws, s] of this.sessions) {
      if (now - s.lastSeen > STALE_AFTER_MS) {
        this.sessions.delete(ws);
        try {
          ws.close(1000, 'stale');
        } catch {
          /* 已关闭 */
        }
      }
    }
  }

  countActive() {
    this.pruneStale();
    let online = 0;
    let doing = 0;
    for (const s of this.sessions.values()) {
      online++;
      if (s.training) doing++;
    }
    return { online, doing };
  }

  async broadcast() {
    const { online, doing } = this.countActive();
    const visits = (await this.ctx.storage.get('visits')) || 0;
    const payload = JSON.stringify({ type: 'stats', online, doing, visits });
    for (const ws of this.sessions.keys()) {
      try {
        ws.send(payload);
      } catch {
        /* 连接已断,close 事件会清理 */
      }
    }
  }

  /* ---------------- 总访问(DO storage 持久化) ---------------- */

  async handleVisit(request) {
    let visitorId = '';
    try {
      visitorId = String((await request.json()).visitorId || '').slice(0, 64);
    } catch {
      /* body 缺失也可计数 */
    }
    const visits = ((await this.ctx.storage.get('visits')) || 0) + 1;
    await this.ctx.storage.put('visits', visits);
    void visitorId; // 预留:需要「来客(UV)」时用 visitorId 去重即可,当前规格只统计总访问
    return this.json({ visits });
  }

  /* ---------------- 状态查询 ---------------- */

  async handleStats() {
    const { online, doing } = this.countActive();
    const visits = (await this.ctx.storage.get('visits')) || 0;
    return this.json({ online, doing, visits });
  }
}

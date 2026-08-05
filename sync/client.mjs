// sync/client.mjs — 同步浏览器客户端(零依赖,可复用)
// 只做网络与降级,不做加密/合并(那在 core/sync.js);不依赖 app.js,可整体迁到 time-logger。
//
// origin 参数化:不硬编码后端地址 —— 换甲骨文 / 未来换 Worker / 本地开发,改传入的 origin 即可,
// 端到端加密不受影响(后端永远只见密文)。
//
// 错误降级约定:所有函数 try/catch,任何失败都返回 {ok:false, error},**不抛**。
// CORS 失败与断网在浏览器里都是 TypeError "Failed to fetch",无法精确区分 → 统一 'network'
// (UX 文案写「连接失败,检查网络」)。超时 10s(AbortController),超时也算 network。

export const SYNC_TIMEOUT_MS = 10000;

/**
 * GET <origin>/sync?key=<userId> → 拉密文。
 * 成功: { ok:true, blob }——blob 为 encryptBlob 返回的对象(线路上是密文 JSON 串,这里解析回对象)
 * 远端无数据(首次): { ok:false, error:'none', blob:null }
 * 网络/超时: { ok:false, error:'network' }
 */
export async function syncPull(origin, userId) {
  try {
    const url = `${origin}/sync?key=${encodeURIComponent(userId)}`;
    const { res, network } = await request(url);
    if (network) return { ok: false, error: 'network' };
    if (!res.ok) return { ok: false, error: 'network' };
    const data = await res.json();
    if (data && data.ok === true) {
      let blob = data.blob;
      if (typeof blob === 'string') {
        try {
          blob = JSON.parse(blob);
        } catch {
          /* 保留原串:非合法密文对象,decryptBlob 会安全拒绝 */
        }
      }
      return { ok: true, blob };
    }
    if (data && data.ok === false && data.error === 'none') return { ok: false, error: 'none', blob: null };
    return { ok: false, error: 'unknown' };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/**
 * PUT <origin>/sync?key=<userId> body {blob} → 推密文(覆盖,last-write-wins)。
 * blob 可以是 encryptBlob 的对象或已序列化字符串,上线前统一序列化为密文 JSON 串(server 契约是字符串)。
 * 成功: { ok:true };限流: { ok:false, error:'rate' };超限: { ok:false, error:'too-big' };网络: { ok:false, error:'network' }
 */
export async function syncPush(origin, userId, blob) {
  try {
    const url = `${origin}/sync?key=${encodeURIComponent(userId)}`;
    const payload = typeof blob === 'string' ? blob : JSON.stringify(blob);
    const { res, network } = await request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: payload }),
    });
    if (network) return { ok: false, error: 'network' };
    if (res.status === 413) return { ok: false, error: 'too-big' };
    if (res.status === 429) return { ok: false, error: 'rate' };
    if (!res.ok) return { ok: false, error: 'unknown' };
    const data = await res.json();
    return data && data.ok === true ? { ok: true } : { ok: false, error: 'unknown' };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** GET <origin>/health → 探活。{ ok:true } | { ok:false, error:'network'|'unknown' } */
export async function syncProbe(origin) {
  try {
    const { res, network } = await request(`${origin}/health`);
    if (network) return { ok: false, error: 'network' };
    if (!res.ok) return { ok: false, error: 'unknown' };
    const data = await res.json();
    return data && data.ok === true ? { ok: true } : { ok: false, error: 'unknown' };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** fetch 封装:10s 超时;网络/超时 → { network:true },HTTP 响应 → { res }。不抛。 */
async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { res };
  } catch {
    return { network: true };
  } finally {
    clearTimeout(timer);
  }
}

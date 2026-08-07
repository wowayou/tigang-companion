// core/sync.js — 多端同步纯函数(端到端加密 + LWW 合并)
// 约束:不访问 DOM / Date.now() / localStorage;crypto 作参数注入(默认 globalThis.crypto)。
// 本模块零依赖,可整体迁到 time-logger。
//
// 加密模型:主密码永不离开设备;AES-GCM-256 + PBKDF2-SHA256(200000 轮)。
// 后端只存 {v,salt,iv,ct,iter} 密文 blob,永远看不到明文。GCM 自带完整性校验:
// 密文被篡改 / 主密码错误 → decryptBlob 返回 {ok:false},绝不会解出半截乱码。
// crypto.subtle 需要安全上下文(https / localhost),PWA 部署在 https 下满足。

export const PBKDF2_ITERATIONS = 200000;

/* ---------------- base64 工具(浏览器与 Node 通用) ---------------- */

function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000; // 分段,避免大 blob 撑爆函数调用栈
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromB64(str) {
  const bin = atob(String(str));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/* ---------------- 端到端加密 ---------------- */

/**
 * 加密 {records, settings} → 密文 blob 对象(可 JSON.stringify 后上后端)。
 * salt/iv 每次随机生成;iter 固定 200000。返回 {v:1, salt, iv, ct, iter}(全 base64)。
 */
export async function encryptBlob(plaintextObj, passphrase, crypto = globalThis.crypto) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(plaintextObj)));

  return {
    v: 1,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
    iter: PBKDF2_ITERATIONS,
  };
}

/**
 * 解密 blob → {ok:true, data} | {ok:false, error}。
 * 错误主密码 / 损坏密文 / 非法 blob 一律返回 {ok:false},**不抛**——调用方静默降级纯本地。
 */
export async function decryptBlob(blob, passphrase, crypto = globalThis.crypto) {
  try {
    if (!blob || typeof blob !== 'object' || blob.v !== 1) return { ok: false, error: 'bad-blob' };
    const salt = fromB64(blob.salt);
    const iv = fromB64(blob.iv);
    const ct = fromB64(blob.ct);
    const iter = Number.isFinite(Number(blob.iter)) ? Number(blob.iter) : PBKDF2_ITERATIONS;

    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return { ok: true, data: JSON.parse(new TextDecoder().decode(pt)) };
  } catch {
    return { ok: false, error: 'decrypt-failed' };
  }
}

/* ---------------- LWW 合并 ---------------- */

/** 记录指纹:与 storage.js mergeRecords 的口径一致(不含 ts——同指纹 = 同一次训练内容)。 */
function fingerprint(r) {
  return `${r.dateStr}|${r.completedReps}|${r.totalReps}|${r.durationSec}|${r.finished ? 1 : 0}`;
}

/** 记录的可选 ts:缺失/非法视为 0(旧记录向后兼容)。 */
function tsOf(r) {
  const n = Number(r && r.ts);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function asRecords(arr) {
  return Array.isArray(arr) ? arr.filter((r) => r && typeof r === 'object' && r.dateStr) : [];
}

/**
 * 同步合并(local/remote 各是一端记录数组;record 可带可选 ts:number)。
 * 规则:
 *   1) 同指纹(dateStr|completedReps|totalReps|durationSec|finished)去重 —— 不计 conflict;
 *      去重时保留 ts 较大者(同一次训练,后来写入的那端胜)。
 *   2) 同 dateStr 不同指纹 → LWW:有 ts 取大;ts 相同 / 都无 ts → 留 remote。每被淘汰一条 conflicts++。
 *   3) 其余(不同日期的记录)全保留。
 * 返回 { merged, conflicts }。merged 按 dateStr 升序(内容决定的稳定顺序,与输入顺序无关)。
 * 已知取舍:同一天多次不同内容的训练在同步时按「日」合并(LWW 只留最新那条),见 DEVELOPMENT D31。
 */
export function mergeForSync(local, remote) {
  const byFingerprint = new Map(); // fp -> record(同指纹保留 ts 最大者)
  const byDate = new Map(); // dateStr -> record[](LWW 候选)
  const remoteSet = new Set(asRecords(remote));

  for (const r of asRecords(local)) {
    const fp = fingerprint(r);
    const prev = byFingerprint.get(fp);
    if (prev) {
      if (tsOf(r) > tsOf(prev)) byFingerprint.set(fp, r);
      continue; // 同指纹去重,不计 conflict
    }
    byFingerprint.set(fp, r);
  }
  for (const r of asRecords(remote)) {
    const fp = fingerprint(r);
    const prev = byFingerprint.get(fp);
    if (prev) {
      if (tsOf(r) > tsOf(prev)) byFingerprint.set(fp, r);
      continue;
    }
    byFingerprint.set(fp, r);
  }

  // date 分组从 byFingerprint 汇总(同指纹被更高 ts 替换后,分组自然反映最终记录)
  for (const rec of byFingerprint.values()) {
    const list = byDate.get(rec.dateStr) || [];
    list.push(rec);
    byDate.set(rec.dateStr, list);
  }

  const merged = [];
  let conflicts = 0;
  for (const list of byDate.values()) {
    let winner = list[0];
    let winnerTs = tsOf(winner);
    let winnerRemote = remoteSet.has(winner);
    for (const rec of list.slice(1)) {
      const t = tsOf(rec);
      const isRemote = remoteSet.has(rec);
      // ts 大者胜;ts 相同 → remote 胜(「都无 ts 留 remote」是它的特例)
      if (t > winnerTs || (t === winnerTs && isRemote && !winnerRemote)) {
        winner = rec;
        winnerTs = t;
        winnerRemote = isRemote;
      }
    }
    conflicts += list.length - 1; // 该日期被淘汰的记录数
    merged.push(winner);
  }

  merged.sort((a, b) => (a.dateStr < b.dateStr ? -1 : a.dateStr > b.dateStr ? 1 : 0));
  return { merged, conflicts };
}

/* ---------------- userId ---------------- */

/** 生成匿名 userId(crypto.randomUUID,122 位熵,不可枚举;它是密文桶的读写凭据,仍须保密)。 */
export function newUserId(crypto = globalThis.crypto) {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 校验并规范化用户手填的同步 ID(多端要指向同一个桶,ID 靠用户从设备 A 复制到设备 B)。
 * 宽容处理:去首尾空白、统一小写(UUID 大小写等价)。
 * 只接受 UUID v4 —— 手填时打成任意字符串会撞上别人的桶或建出垃圾桶,后端也做同样校验。
 * @returns {{ok:true, userId:string} | {ok:false, error:string}}
 */
export function normalizeUserId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'empty' };
  if (!UUID_RE.test(s)) return { ok: false, error: 'format' };
  return { ok: true, userId: s.toLowerCase() };
}

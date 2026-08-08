import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PBKDF2_ITERATIONS,
  MIN_ACCEPTED_ITERATIONS,
  MAX_ACCEPTED_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  checkPassphrase,
  encryptBlob,
  decryptBlob,
  mergeForSync,
  normalizeUserId,
  newUserId,
} from '../core/sync.js';

const crypto = globalThis.crypto;

// 测试用 base64 往返(Node 全局有 atob/btoa)
const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (str) => new Uint8Array(Buffer.from(str, 'base64'));

const sampleData = {
  records: [
    { dateStr: '2026-08-01', completedReps: 12, totalReps: 12, durationSec: 150, finished: true, ts: 1722768000000 },
  ],
  settings: { presetKey: 'advanced', holdSec: 0, sound: false },
};

test('encryptBlob/decryptBlob 往返(records+settings)', async () => {
  const blob = await encryptBlob(sampleData, '主密码 123', crypto);
  assert.equal(typeof blob, 'object');
  assert.equal(blob.v, 1);
  assert.equal(blob.iter, PBKDF2_ITERATIONS);
  assert.equal(typeof blob.salt, 'string');
  assert.equal(typeof blob.iv, 'string');
  assert.equal(typeof blob.ct, 'string');

  const result = await decryptBlob(blob, '主密码 123', crypto);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, sampleData);

  // 同一明文两次加密 → 密文不同(salt/iv 随机),解密都正确
  const again = await encryptBlob(sampleData, '主密码 123', crypto);
  assert.notEqual(again.ct, blob.ct);
  const result2 = await decryptBlob(again, '主密码 123', crypto);
  assert.equal(result2.ok, true);
  assert.deepEqual(result2.data, sampleData);
});

test('错误主密码 → {ok:false}(不抛)', async () => {
  const blob = await encryptBlob(sampleData, 'right-pass', crypto);
  const result = await decryptBlob(blob, 'wrong-pass', crypto);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('损坏 blob(ct 改一字节)→ {ok:false} 不抛', async () => {
  const blob = await encryptBlob(sampleData, 'pw', crypto);
  const bytes = fromB64(blob.ct);
  bytes[0] ^= 0xff; // 翻一字节
  const tampered = { ...blob, ct: toB64(bytes) };
  const result = await decryptBlob(tampered, 'pw', crypto);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'decrypt-failed');
});

test('非法/垃圾 blob → {ok:false} 不抛', async () => {
  assert.equal((await decryptBlob(null, 'pw', crypto)).ok, false);
  assert.equal((await decryptBlob('garbage-string', 'pw', crypto)).ok, false);
  assert.equal((await decryptBlob(42, 'pw', crypto)).ok, false);
  assert.equal((await decryptBlob({ v: 2, salt: 'x', iv: 'y', ct: 'z' }, 'pw', crypto)).ok, false);
  assert.equal((await decryptBlob({ v: 1, salt: '!!!', iv: '!!!', ct: '!!!', iter: 1 }, 'pw', crypto)).ok, false);
  assert.equal((await decryptBlob(undefined, 'pw', crypto)).ok, false);
});

// iter 来自后端响应 = 不可信输入。越界必须在 deriveKey **之前**拒绝:
// iter:1e9 会把主线程冻在派生上(DoS),iter:1 则把爆破成本降到可在线穷举。
test('越界 iter 在派生前被拒(bad-iter,不冻主线程)', async () => {
  const blob = await encryptBlob(sampleData, 'pw-long-enough', crypto);

  for (const bad of [1, 999, MIN_ACCEPTED_ITERATIONS - 1, MAX_ACCEPTED_ITERATIONS + 1, 1e9, -1, 0]) {
    const result = await decryptBlob({ ...blob, iter: bad }, 'pw-long-enough', crypto);
    assert.equal(result.ok, false, `iter=${bad} 应被拒`);
    assert.equal(result.error, 'bad-iter', `iter=${bad} 应报 bad-iter`);
  }

  // 非整数 / 缺失 / 非数字同样拒绝(旧 blob 一律带 iter,缺失即异常)
  for (const bad of [undefined, null, '600000abc', NaN, Infinity, 1.5]) {
    const result = await decryptBlob({ ...blob, iter: bad }, 'pw-long-enough', crypto);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'bad-iter');
  }
});

// 轮数升级(200000→600000)必须向后兼容:线上已有 200000 轮的 blob,
// 它们按自己的 iter 解,不能因为常量变了就解不开。手工造一个旧 blob 来验。
test('旧 iter(200000)的 blob 仍可解密(轮数升级向后兼容)', async () => {
  const LEGACY_ITER = 200000;
  assert.ok(
    LEGACY_ITER >= MIN_ACCEPTED_ITERATIONS && LEGACY_ITER <= MAX_ACCEPTED_ITERATIONS,
    '200000 必须留在接受区间内,否则线上老用户的密文全部解不开',
  );

  const pass = 'legacy-pass-ok';
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: LEGACY_ITER, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(sampleData)));

  const legacyBlob = { v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct), iter: LEGACY_ITER };
  const result = await decryptBlob(legacyBlob, pass, crypto);
  assert.equal(result.ok, true, '200000 轮的旧 blob 必须仍能解开');
  assert.deepEqual(result.data, sampleData);

  // 新写入的 blob 用新轮数
  const fresh = await encryptBlob(sampleData, pass, crypto);
  assert.equal(fresh.iter, PBKDF2_ITERATIONS);
  assert.equal(PBKDF2_ITERATIONS, 600000);
});

test('checkPassphrase:守住下限(userId 泄露后这是唯一防线)', () => {
  assert.equal(checkPassphrase('').ok, false);
  assert.equal(checkPassphrase('').error, 'empty');
  assert.equal(checkPassphrase(null).error, 'empty');
  assert.equal(checkPassphrase(undefined).error, 'empty');

  // 录屏里用户输的就是 3–4 位:必须拒绝
  assert.equal(checkPassphrase('123').error, 'too-short');
  assert.equal(checkPassphrase('abcd').error, 'too-short');
  assert.equal(checkPassphrase('a'.repeat(MIN_PASSPHRASE_LENGTH - 1)).error, 'too-short');

  // 纯数字搜索空间小:8 位够长但不够强
  assert.equal(checkPassphrase('12345678').error, 'digits-only');
  assert.equal(checkPassphrase('12345678901').error, 'digits-only');
  assert.equal(checkPassphrase('123456789012').ok, true); // 12 位纯数字放行

  assert.equal(checkPassphrase('a'.repeat(MIN_PASSPHRASE_LENGTH)).ok, true);
  assert.equal(checkPassphrase('correct horse battery').ok, true);

  // 中文按 UTF-16 length 计,不按字节 —— 「主密码 123」只有 7 个字符,照样太短。
  // 每个汉字的熵远高于一个字母,但下限用统一口径守,不为中文开特例(实现简单 > 精确)。
  assert.equal(checkPassphrase('主密码 123').error, 'too-short');
  assert.equal(checkPassphrase('我的提肛训练主密码').ok, true); // 9 个汉字 → 过线
});

test('旧记录(无 ts)+ 新记录(有 ts)混合,不丢', () => {
  const local = [
    { dateStr: '2026-08-01', completedReps: 12, totalReps: 12, durationSec: 150, finished: true }, // 旧记录无 ts
  ];
  const remote = [
    { dateStr: '2026-08-02', completedReps: 24, totalReps: 24, durationSec: 300, finished: true, ts: 500 },
    { dateStr: '2026-08-03', completedReps: 6, totalReps: 6, durationSec: 60, finished: false, ts: 600 },
  ];
  const { merged, conflicts } = mergeForSync(local, remote);
  assert.equal(conflicts, 0);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((r) => r.dateStr),
    ['2026-08-01', '2026-08-02', '2026-08-03'],
  );
  // 无 ts 的旧记录保留,没被丢弃
  assert.ok(merged.every((r) => !('ts' in r) || typeof r.ts === 'number'));
  assert.deepEqual(merged.find((r) => r.dateStr === '2026-08-01'), local[0]);
});

test('同 dateStr 不同指纹 → LWW(有 ts 取大),conflicts 计数', () => {
  const local = [
    { dateStr: '2026-08-01', completedReps: 10, totalReps: 12, durationSec: 100, finished: true, ts: 1000 },
  ];
  const remote = [
    { dateStr: '2026-08-01', completedReps: 6, totalReps: 12, durationSec: 60, finished: true, ts: 2000 },
  ];
  const { merged, conflicts } = mergeForSync(local, remote);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], remote[0]); // ts 大者(远端)胜
  assert.equal(conflicts, 1);
});

test('同 dateStr 都无 ts → 留 remote', () => {
  const local = [
    { dateStr: '2026-08-01', completedReps: 10, totalReps: 12, durationSec: 100, finished: true },
  ];
  const remote = [
    { dateStr: '2026-08-01', completedReps: 6, totalReps: 12, durationSec: 60, finished: true },
  ];
  const { merged, conflicts } = mergeForSync(local, remote);
  assert.deepEqual(merged, [remote[0]]);
  assert.equal(conflicts, 1);
});

test('同 dateStr 平 ts → 留 remote', () => {
  const local = [
    { dateStr: '2026-08-01', completedReps: 10, totalReps: 12, durationSec: 100, finished: true, ts: 777 },
  ];
  const remote = [
    { dateStr: '2026-08-01', completedReps: 6, totalReps: 12, durationSec: 60, finished: true, ts: 777 },
  ];
  const { merged, conflicts } = mergeForSync(local, remote);
  assert.deepEqual(merged, [remote[0]]);
  assert.equal(conflicts, 1);
});

test('同指纹 → 不叠加,conflicts=0', () => {
  const a = [
    { dateStr: '2026-08-01', completedReps: 12, totalReps: 12, durationSec: 150, finished: true, ts: 100 },
  ];
  const b = [
    { dateStr: '2026-08-01', completedReps: 12, totalReps: 12, durationSec: 150, finished: true, ts: 200 },
  ];
  const { merged, conflicts } = mergeForSync(a, b);
  assert.equal(merged.length, 1);
  assert.equal(conflicts, 0);
  assert.equal(merged[0].ts, 200, '同指纹保留 ts 较大者');
});

test('合并稳定:打乱顺序,merged 与 conflicts 一致', () => {
  const local = [
    { dateStr: '2026-08-03', completedReps: 12, totalReps: 12, durationSec: 150, finished: true, ts: 300 },
    { dateStr: '2026-08-01', completedReps: 10, totalReps: 12, durationSec: 100, finished: true, ts: 100 },
  ];
  const remote = [
    { dateStr: '2026-08-02', completedReps: 24, totalReps: 24, durationSec: 300, finished: true, ts: 200 },
    { dateStr: '2026-08-01', completedReps: 6, totalReps: 12, durationSec: 60, finished: true, ts: 500 }, // 同日期冲突,ts 大胜
  ];
  const r1 = mergeForSync(local, remote);
  const r2 = mergeForSync([...remote].reverse(), [...local].reverse());
  assert.deepEqual(r2, r1, '顺序无关');
  assert.deepEqual(
    r1.merged.map((r) => r.dateStr),
    ['2026-08-01', '2026-08-02', '2026-08-03'],
  );
  assert.equal(r1.conflicts, 1);
  assert.deepEqual(r1.merged[0], remote[1], 'ts=500 的记录胜出');
});

test('null/非法入参 → 空结果,不抛', () => {
  assert.deepEqual(mergeForSync(null, undefined), { merged: [], conflicts: 0 });
  assert.deepEqual(mergeForSync([], []), { merged: [], conflicts: 0 });
  assert.deepEqual(mergeForSync('oops', 42), { merged: [], conflicts: 0 });
  const { merged, conflicts } = mergeForSync([{ dateStr: '2026-08-01', completedReps: 3, totalReps: 3, durationSec: 30, finished: true }], []);
  assert.equal(merged.length, 1);
  assert.equal(conflicts, 0);
});

test('normalizeUserId:合法/非法/空白/大小写/首尾空格', () => {
  const id = '7309f8e0-d5a4-4a6b-8e15-295b3f9a1c42';
  assert.deepEqual(normalizeUserId(id), { ok: true, userId: id });
  // 大小写不敏感,统一小写
  assert.deepEqual(normalizeUserId(id.toUpperCase()), { ok: true, userId: id });
  // 首尾空白宽容
  assert.deepEqual(normalizeUserId(`  ${id}  `), { ok: true, userId: id });
  // 非法格式
  assert.equal(normalizeUserId('').ok, false);
  assert.equal(normalizeUserId('testuser').ok, false);
  assert.equal(normalizeUserId('not-a-uuid').ok, false);
  assert.equal(normalizeUserId( '7309f8e0-d5a4-4a6b-8e15-295b3f9a1c4').ok, false); // 少一位
  assert.equal(normalizeUserId('7309f8e0-d5a4-4a6b-8e15-295b3f9a1c422').ok, false); // 多一位
  // null/undefined 防御
  assert.equal(normalizeUserId(null).ok, false);
  assert.equal(normalizeUserId(undefined).ok, false);
});

test('newUserId:合法 UUID v4 格式,且两次不同', () => {
  const id = newUserId(crypto);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(id, newUserId(crypto));
});

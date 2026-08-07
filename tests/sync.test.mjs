import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PBKDF2_ITERATIONS,
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

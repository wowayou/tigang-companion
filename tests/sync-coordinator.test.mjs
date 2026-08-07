import test from 'node:test';
import assert from 'node:assert/strict';

import { SyncCoordinator } from '../sync/coordinator.mjs';

const USER_A = '7309f8e0-d5a4-4a6b-8e15-295b3f9a1c42';
const USER_B = '21fbf023-17f8-43f4-b418-2fc0a837b8b0';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeTimers() {
  let nextId = 1;
  const jobs = new Map();
  return {
    jobs,
    setTimer(fn, ms) {
      const id = nextId++;
      jobs.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      jobs.delete(id);
    },
    async runNext() {
      const next = [...jobs.entries()].sort((a, b) => a[1].ms - b[1].ms || a[0] - b[0])[0];
      assert.ok(next, '应存在待执行 timer');
      jobs.delete(next[0]);
      next[1].fn();
      await Promise.resolve();
    },
  };
}

function harness(overrides = {}) {
  let data = {
    records: [{ dateStr: '2026-08-07', completedReps: 12, totalReps: 12, durationSec: 120, finished: true, ts: 1 }],
    settings: { sync: { enabled: true }, sound: true },
  };
  const events = [];
  const busy = [];
  const timers = overrides.timers || fakeTimers();
  const coordinator = new SyncCoordinator({
    origin: 'https://sync.example.test',
    enabled: true,
    userId: USER_A,
    passphrase: 'correct horse battery staple',
    pull: async () => ({ ok: false, error: 'none' }),
    push: async () => ({ ok: true }),
    encrypt: async (payload) => ({ encrypted: payload }),
    decrypt: async () => ({ ok: true, data: { records: [] } }),
    merge: (local, remote) => ({ merged: [...local, ...remote], conflicts: 0 }),
    readData: () => data,
    applyMergedRecords: (records) => { data = { ...data, records }; },
    isOnline: () => true,
    now: () => 123456,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onEvent: (event) => events.push(event),
    onBusy: (value) => busy.push(value),
    ...overrides,
  });
  return {
    coordinator,
    events,
    busy,
    timers,
    getData: () => data,
    setData: (next) => { data = next; },
  };
}

test('拉取失败时绝不推送', async () => {
  let pushes = 0;
  const h = harness({
    pull: async () => ({ ok: false, error: 'network' }),
    push: async () => { pushes += 1; return { ok: true }; },
  });

  const result = await h.coordinator.syncNow();
  assert.deepEqual(result, { ok: false, error: 'network' });
  assert.equal(pushes, 0);
  assert.ok(h.events.some((event) => event.code === 'pull-network'));
});

test('解密失败锁住自动同步;改主密码后才允许重新拉取', async () => {
  let pushes = 0;
  const h = harness({
    pull: async () => ({ ok: true, blob: { ciphertext: true } }),
    decrypt: async () => ({ ok: false, error: 'decrypt-failed' }),
    push: async () => { pushes += 1; return { ok: true }; },
  });

  const result = await h.coordinator.syncNow();
  assert.equal(result.error, 'decrypt-failed');
  assert.equal(pushes, 0);
  assert.equal(h.coordinator.decryptFailed, true);
  assert.equal(h.coordinator.schedule(), false, '错误密码下本地变化不能排自动同步');

  h.coordinator.setPassphrase('corrected passphrase');
  assert.equal(h.coordinator.decryptFailed, false);
  assert.equal(h.coordinator.schedule(), true, '密码变化后可重新排完整同步');
  assert.equal(h.timers.jobs.size, 1);
});

test('拉取过程中切换同步 ID:旧结果作废,不合并也不推送', async () => {
  const pulled = deferred();
  let applied = 0;
  let pushes = 0;
  const h = harness({
    pull: async () => pulled.promise,
    applyMergedRecords: () => { applied += 1; },
    push: async () => { pushes += 1; return { ok: true }; },
  });

  const run = h.coordinator.syncNow();
  await Promise.resolve();
  h.coordinator.setUserId(USER_B);
  pulled.resolve({ ok: true, blob: { ciphertext: true } });

  assert.deepEqual(await run, { ok: false, error: 'stale' });
  assert.equal(applied, 0);
  assert.equal(pushes, 0);
});

test('加密过程中切换同步 ID:密文不会写入新桶', async () => {
  const encryptStarted = deferred();
  const encrypted = deferred();
  const pushedIds = [];
  const h = harness({
    encrypt: async () => {
      encryptStarted.resolve();
      return encrypted.promise;
    },
    push: async (_origin, userId) => {
      pushedIds.push(userId);
      return { ok: true };
    },
  });

  const run = h.coordinator.syncNow();
  await encryptStarted.promise;
  h.coordinator.setUserId(USER_B);
  encrypted.resolve({ ciphertext: true });

  assert.deepEqual(await run, { ok: false, error: 'stale' });
  assert.deepEqual(pushedIds, []);
});

test('本地变化的防抖任务执行完整 pull→merge→push,不是盲推', async () => {
  const calls = [];
  const h = harness({
    pull: async () => { calls.push('pull'); return { ok: false, error: 'none' }; },
    encrypt: async () => { calls.push('encrypt'); return { ciphertext: true }; },
    push: async () => { calls.push('push'); return { ok: true }; },
  });

  assert.equal(h.coordinator.schedule(), true);
  assert.deepEqual(calls, []);
  await h.timers.runNext();
  await h.coordinator.whenIdle();
  assert.deepEqual(calls, ['pull', 'encrypt', 'push']);
});

test('限流重试会重新拉取,不会复用旧快照直接推送', async () => {
  const calls = [];
  let pushes = 0;
  const h = harness({
    pull: async () => { calls.push('pull'); return { ok: false, error: 'none' }; },
    encrypt: async () => ({ ciphertext: true }),
    push: async () => {
      calls.push('push');
      pushes += 1;
      return pushes === 1 ? { ok: false, error: 'rate' } : { ok: true };
    },
  });

  assert.equal((await h.coordinator.syncNow()).error, 'rate');
  assert.deepEqual(calls, ['pull', 'push']);
  assert.equal(h.timers.jobs.size, 1, '应排一次受控重试');

  await h.timers.runNext();
  await h.coordinator.whenIdle();
  assert.deepEqual(calls, ['pull', 'push', 'pull', 'push']);
});

test('切换身份会同时取消防抖与限流重试 timer', async () => {
  const h = harness({
    push: async () => ({ ok: false, error: 'rate' }),
  });

  h.coordinator.schedule();
  assert.equal(h.timers.jobs.size, 1);
  h.coordinator.setUserId(USER_B);
  assert.equal(h.timers.jobs.size, 0, '防抖 timer 已取消');

  await h.coordinator.syncNow();
  assert.equal(h.timers.jobs.size, 1, '限流重试已排队');
  h.coordinator.setPassphrase('another passphrase');
  assert.equal(h.timers.jobs.size, 0, '密码变化取消限流重试');
});

test('同步进行中又发生本地变化:当前流水线结束后必定再跑一轮', async () => {
  const firstPull = deferred();
  let pulls = 0;
  const h = harness({
    pull: async () => {
      pulls += 1;
      return pulls === 1 ? firstPull.promise : { ok: false, error: 'none' };
    },
  });

  const firstRun = h.coordinator.syncNow();
  assert.equal(h.coordinator.schedule(), true);
  await h.timers.runNext(); // timer 撞上在途 run → 标记 rerun

  firstPull.resolve({ ok: false, error: 'none' });
  await firstRun;
  assert.equal(h.timers.jobs.size, 1, '第一轮完成后重新排防抖同步');

  await h.timers.runNext();
  await h.coordinator.whenIdle();
  assert.equal(pulls, 2);
});

test('成功拉取后先合并再上传,上传内容是不可变深快照', async () => {
  const remoteRecord = { dateStr: '2026-08-06', completedReps: 8, totalReps: 8, durationSec: 80, finished: true, ts: 2 };
  let encryptedPayload;
  const h = harness({
    pull: async () => ({ ok: true, blob: { ciphertext: true } }),
    decrypt: async () => ({ ok: true, data: { records: [remoteRecord] } }),
    encrypt: async (payload) => {
      encryptedPayload = payload;
      return { ciphertext: true };
    },
  });

  const result = await h.coordinator.syncNow();
  assert.equal(result.ok, true);
  assert.equal(encryptedPayload.records.length, 2);
  assert.notEqual(encryptedPayload.records, h.getData().records);

  h.getData().records.push({ dateStr: 'later' });
  assert.equal(encryptedPayload.records.length, 2, '后续本地修改不能改变已加密快照');
});

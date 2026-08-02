import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY,
  DEFAULT_SETTINGS,
  load,
  save,
  clearAll,
  exportJSON,
} from '../core/storage.js';

// 测试用 fake storage(只实现 getItem/setItem/removeItem)
function fakeStorage(initialRaw) {
  const map = new Map();
  if (initialRaw !== undefined) map.set(STORAGE_KEY, initialRaw);
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

const defaults = () => ({ records: [], settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) });

test('STORAGE_KEY 与 DEFAULT_SETTINGS 契约', () => {
  assert.equal(STORAGE_KEY, 'tigang-companion.v1');
  assert.deepEqual(DEFAULT_SETTINGS, {
    presetKey: 'standard',
    custom: { contractSec: 5, relaxSec: 5, repsPerSet: 12, sets: 3, restSec: 30, prepareSec: 3 },
    holdSec: 0,
    sound: true,
    voice: false,
    vibration: true,
    reminder: { enabled: false, time: '21:00' },
  });
});

test('v1 存档(无 holdSec/voice)升级后拿到新默认键,且不改变已有取值', () => {
  const v1Raw = JSON.stringify({
    records: [{ dateStr: '2026-01-01', completedReps: 12, totalReps: 36, durationSec: 200, finished: true }],
    settings: {
      presetKey: 'advanced',
      custom: { contractSec: 5, relaxSec: 5, repsPerSet: 12, sets: 3, restSec: 30, prepareSec: 3 },
      sound: false,
      vibration: true,
      reminder: { enabled: true, time: '07:30' },
    },
  });
  const loaded = load(fakeStorage(v1Raw));
  assert.equal(loaded.settings.holdSec, 0, '老用户默认不启用维持阶段');
  assert.equal(loaded.settings.voice, false, '语音默认关,升级不该突然开始外放');
  // 原有设置一个都不能被覆盖
  assert.equal(loaded.settings.presetKey, 'advanced');
  assert.equal(loaded.settings.sound, false);
  assert.deepEqual(loaded.settings.reminder, { enabled: true, time: '07:30' });
  assert.equal(loaded.records.length, 1);
});

test('空存储 → 默认值', () => {
  assert.deepEqual(load(fakeStorage()), defaults());
  assert.deepEqual(load(fakeStorage('')), defaults());
});

test('损坏 JSON → 默认值', () => {
  assert.deepEqual(load(fakeStorage('{ not json')), defaults());
  assert.deepEqual(load(fakeStorage('undefined')), defaults());
  assert.deepEqual(load(fakeStorage('"just a string"')), defaults());
  assert.deepEqual(load(fakeStorage('[1,2,3]')), defaults());
  assert.deepEqual(load(fakeStorage('null')), defaults());
  // records 不是数组 → 空数组
  assert.deepEqual(load(fakeStorage(JSON.stringify({ records: 'oops' }))), defaults());
});

test('getItem 抛异常 → 默认值(不抛出)', () => {
  const broken = {
    getItem() {
      throw new Error('SecurityError: localStorage 不可用');
    },
    setItem() {},
    removeItem() {},
  };
  assert.deepEqual(load(broken), defaults());
  assert.deepEqual(load({}), defaults()); // storage 缺方法
  assert.deepEqual(load(undefined), defaults()); // 无 globalThis.localStorage(Node 环境)
});

test('load 返回全新对象,不与 DEFAULT_SETTINGS 共享引用', () => {
  const a = load(fakeStorage());
  const b = load(fakeStorage());
  assert.notEqual(a.settings, DEFAULT_SETTINGS);
  assert.notEqual(a.settings.reminder, DEFAULT_SETTINGS.reminder);
  assert.notEqual(a.settings.custom, DEFAULT_SETTINGS.custom);
  assert.notEqual(a.settings, b.settings);
  a.settings.sound = false;
  a.settings.reminder.time = '07:00';
  a.settings.custom.sets = 9;
  a.records.push({ x: 1 });
  assert.equal(DEFAULT_SETTINGS.sound, true);
  assert.equal(DEFAULT_SETTINGS.reminder.time, '21:00');
  assert.equal(DEFAULT_SETTINGS.custom.sets, 3);
  assert.deepEqual(load(fakeStorage()), defaults());
});

test('save/load 往返', () => {
  const storage = fakeStorage();
  const data = {
    records: [
      { dateStr: '2026-08-01', completedReps: 36, totalReps: 36, durationSec: 408, finished: true },
      { dateStr: '2026-07-31', completedReps: 5, totalReps: 36, durationSec: 60, finished: false },
    ],
    settings: {
      presetKey: 'advanced',
      custom: { contractSec: 7, relaxSec: 7, repsPerSet: 8, sets: 2, restSec: 15, prepareSec: 2 },
      holdSec: 4,
      sound: false,
      voice: false,
      vibration: false,
      reminder: { enabled: true, time: '07:30' },
    },
  };
  assert.equal(save(data, storage), true);
  assert.equal(typeof storage.map.get(STORAGE_KEY), 'string');
  assert.deepEqual(load(storage), data);
  // 二次保存覆盖
  assert.equal(save({ records: [], settings: { presetKey: 'quick' } }, storage), true);
  assert.equal(load(storage).settings.presetKey, 'quick');
});

test('旧版本 settings 缺键 → 合并出新默认键(浅合并 + reminder/custom 二级合并)', () => {
  const legacy = JSON.stringify({
    records: [{ dateStr: '2026-01-01', completedReps: 10, totalReps: 10, durationSec: 90, finished: true }],
    settings: { presetKey: 'beginner', sound: false }, // 老版本没有 vibration/reminder/custom
  });
  const loaded = load(fakeStorage(legacy));
  assert.deepEqual(loaded.settings, {
    presetKey: 'beginner',
    sound: false,
    voice: false,
    holdSec: 0,
    vibration: true,
    custom: DEFAULT_SETTINGS.custom,
    reminder: DEFAULT_SETTINGS.reminder,
  });
  assert.equal(loaded.records.length, 1);

  // reminder 只有一半的键
  const partial = load(fakeStorage(JSON.stringify({ settings: { reminder: { enabled: true } } })));
  assert.deepEqual(partial.settings.reminder, { enabled: true, time: '21:00' });

  // custom 只有一半的键
  const partialCustom = load(fakeStorage(JSON.stringify({ settings: { custom: { contractSec: 9 } } })));
  assert.deepEqual(partialCustom.settings.custom, { ...DEFAULT_SETTINGS.custom, contractSec: 9 });

  // settings 类型非法 → 全默认
  assert.deepEqual(load(fakeStorage(JSON.stringify({ settings: 'oops' }))).settings, DEFAULT_SETTINGS);
  assert.deepEqual(load(fakeStorage(JSON.stringify({ settings: null }))).settings, DEFAULT_SETTINGS);
  assert.deepEqual(
    load(fakeStorage(JSON.stringify({ settings: { reminder: 'oops', custom: 42 } }))).settings.reminder,
    DEFAULT_SETTINGS.reminder,
  );
});

test('save 异常(如超配额)→ false', () => {
  const quotaExceeded = {
    getItem: () => null,
    setItem() {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem() {},
  };
  assert.equal(save(defaults(), quotaExceeded), false);
  assert.equal(save(defaults(), undefined), false); // 无 storage
  assert.equal(save(defaults(), {}), false); // storage 缺方法
  // 循环引用导致 JSON.stringify 抛错也返回 false
  const cyclic = { records: [] };
  cyclic.self = cyclic;
  assert.equal(save(cyclic, fakeStorage()), false);
});

test('clearAll 清空后 load 回到默认值', () => {
  const storage = fakeStorage();
  save({ records: [{ dateStr: '2026-08-01', completedReps: 1, totalReps: 1, durationSec: 1, finished: true }], settings: {} }, storage);
  assert.equal(storage.map.has(STORAGE_KEY), true);
  assert.equal(clearAll(storage), true);
  assert.equal(storage.map.has(STORAGE_KEY), false);
  assert.deepEqual(load(storage), defaults());
  assert.equal(clearAll(undefined), false); // 异常被捕获
});

test('exportJSON:带 app/version 头的缩进 JSON', () => {
  const data = defaults();
  const text = exportJSON(data);
  assert.equal(typeof text, 'string');
  assert.deepEqual(JSON.parse(text), { app: 'tigang-companion', version: 1, ...data });
  assert.equal(text, JSON.stringify({ app: 'tigang-companion', version: 1, ...data }, null, 2));
  assert.ok(text.includes('\n  "records"'), '应为 2 空格缩进');
  assert.ok(text.startsWith('{\n  "app": "tigang-companion",\n  "version": 1,'));
});

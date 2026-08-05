import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY,
  DEFAULT_SETTINGS,
  load,
  save,
  clearAll,
  exportJSON,
  parseBackup,
  mergeRecords,
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
    softCue: true,
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
  assert.equal(loaded.settings.softCue, true, '轻提示默认开,老用户升级后直接拿到倒数/呼吸引导');
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
      softCue: false,
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
    softCue: true,
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

test('parseBackup:导出文件往返 + 设置补新默认键', () => {
  const data = defaults();
  data.records = [{ dateStr: '2026-08-04', completedReps: 12, totalReps: 12, durationSec: 150, finished: true }];
  const result = parseBackup(exportJSON(data));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.records, data.records);
  // 旧备份缺新默认键(如 reminder)→ 补上,且不覆盖已有值
  const legacy = JSON.stringify({
    app: 'tigang-companion', version: 1,
    records: data.records,
    settings: { presetKey: 'advanced', holdSec: 5 },
  });
  const up = parseBackup(legacy);
  assert.equal(up.ok, true);
  assert.equal(up.data.settings.presetKey, 'advanced');
  assert.equal(up.data.settings.holdSec, 5);
  assert.equal(up.data.settings.reminder.enabled, false, '缺的 reminder 键补默认');
  assert.equal(up.data.settings.voice, false);
});

test('parseBackup:损坏/非本应用文件 → 明确报错,不给半成品', () => {
  assert.deepEqual(parseBackup(''), { ok: false, error: '文件为空' });
  assert.deepEqual(parseBackup('   '), { ok: false, error: '文件为空' });
  assert.deepEqual(parseBackup('not json'), { ok: false, error: '不是合法的 JSON 文件' });
  assert.deepEqual(parseBackup('42'), { ok: false, error: '不是提肛陪伴的备份文件' });
  assert.deepEqual(parseBackup('{"foo":1}'), { ok: false, error: '备份里既没有打卡记录,也没有设置' });
});

test('parseBackup:逐条净化非法记录', () => {
  const result = parseBackup(JSON.stringify({
    records: [
      { dateStr: '2026-08-04', completedReps: '12', totalReps: 12, durationSec: 150, finished: true }, // 字符串数值可接受
      { dateStr: '08/04', completedReps: 1, totalReps: 1, durationSec: 1, finished: true },             // 日期格式非法 → 丢弃
      { dateStr: '2026-08-05', completedReps: -3, totalReps: 5, durationSec: 'abc', finished: 1 },      // 负值归零、坏字段归零、finished 严格布尔
      'garbage',
    ],
    settings: { presetKey: 'quick' },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.records, [
    { dateStr: '2026-08-04', completedReps: 12, totalReps: 12, durationSec: 150, finished: true },
    { dateStr: '2026-08-05', completedReps: 0, totalReps: 5, durationSec: 0, finished: false },
  ]);
  assert.equal(result.data.settings.presetKey, 'quick');
});

test('mergeRecords:指纹去重,重复导入不叠加', () => {
  const existing = [
    { dateStr: '2026-08-01', completedReps: 10, totalReps: 12, durationSec: 120, finished: true },
    { dateStr: '2026-08-02', completedReps: 6, totalReps: 12, durationSec: 90, finished: false },
  ];
  const imported = [
    { dateStr: '2026-08-02', completedReps: 6, totalReps: 12, durationSec: 90, finished: false }, // 与现有重复 → 不加
    { dateStr: '2026-08-03', completedReps: 12, totalReps: 12, durationSec: 150, finished: true },
  ];
  const merged = mergeRecords(existing, imported);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0], existing[0]);
  assert.deepEqual(merged[1], existing[1]);
  assert.deepEqual(merged[2], imported[1]);
  assert.notEqual(merged, existing, '不可变:返回新数组');
  assert.deepEqual(mergeRecords(existing, []), existing);
  assert.deepEqual(mergeRecords(null, imported), imported);
});

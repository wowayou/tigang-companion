import test from 'node:test';
import assert from 'node:assert/strict';

import {
  localDateStr,
  addDays,
  makeRecord,
  computeStreak,
  totals,
  lastNDays,
  longestStreak,
} from '../core/stats.js';

const rec = (dateStr, opts = {}) =>
  makeRecord({
    dateStr,
    completedReps: opts.completedReps ?? 12,
    totalReps: opts.totalReps ?? 12,
    durationSec: opts.durationSec ?? 120,
    finished: opts.finished ?? true,
  });

test('localDateStr:本地日期分量 + 补零', () => {
  assert.equal(localDateStr(new Date(2026, 0, 5, 13, 30)), '2026-01-05');
  assert.equal(localDateStr(new Date(2026, 8, 7, 0, 0, 0)), '2026-09-07');
  assert.equal(localDateStr(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31'); // 本地日末不跨天
  assert.equal(localDateStr(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01'); // 本地日初不跨天
  assert.equal(localDateStr(new Date(2024, 1, 29, 12)), '2024-02-29');
  const s = localDateStr(new Date(2026, 5, 9));
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
});

test('addDays:跨月/跨年/闰年/零偏移', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-02-01', -1), '2026-01-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29'); // 闰年
  assert.equal(addDays('2025-02-28', 1), '2025-03-01'); // 平年
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-06-15', 0), '2026-06-15');
  assert.equal(addDays('2026-06-15', 30), '2026-07-15');
  assert.equal(addDays('2026-06-15', -365), '2025-06-15');
  // 连续调用可逆
  let d = '2026-08-01';
  for (let i = 0; i < 400; i++) d = addDays(d, 1);
  for (let i = 0; i < 400; i++) d = addDays(d, -1);
  assert.equal(d, '2026-08-01');
});

test('makeRecord:5 个字段、数值取整、finished 转 boolean', () => {
  const r = makeRecord({ dateStr: '2026-08-01', completedReps: 11.6, totalReps: 12.2, durationSec: 95.4, finished: 1 });
  assert.deepEqual(r, {
    dateStr: '2026-08-01',
    completedReps: 12,
    totalReps: 12,
    durationSec: 95,
    finished: true,
  });
  assert.deepEqual(Object.keys(r).sort(), ['completedReps', 'dateStr', 'durationSec', 'finished', 'totalReps']);
  const bad = makeRecord({ dateStr: '2026-08-01', completedReps: NaN, totalReps: undefined, durationSec: 'x', finished: 0 });
  assert.deepEqual(bad, { dateStr: '2026-08-01', completedReps: 0, totalReps: 0, durationSec: 0, finished: false });
  assert.equal(makeRecord({ dateStr: '2026-08-01', finished: '' }).finished, false);
  assert.equal(makeRecord({ dateStr: '2026-08-01', finished: true }).finished, true);
  // JSON 可序列化
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('computeStreak:空记录 → 0', () => {
  assert.equal(computeStreak([], '2026-08-01'), 0);
  assert.equal(computeStreak(undefined, '2026-08-01'), 0);
  assert.equal(computeStreak(null, '2026-08-01'), 0);
});

test('computeStreak:仅今天 → 1', () => {
  assert.equal(computeStreak([rec('2026-08-01')], '2026-08-01'), 1);
});

test('computeStreak:今昨连续 → 2(同日多条只算一天)', () => {
  const records = [rec('2026-07-31'), rec('2026-08-01'), rec('2026-08-01')];
  assert.equal(computeStreak(records, '2026-08-01'), 2);
  // 跨月连续 5 天
  const five = ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01'].map((d) => rec(d));
  assert.equal(computeStreak(five, '2026-08-01'), 5);
});

test('computeStreak:仅昨天(今天还没练)→ 1', () => {
  assert.equal(computeStreak([rec('2026-07-31')], '2026-08-01'), 1);
  // 昨天及之前连续,今天未练 → 从昨天起算
  const records = ['2026-07-29', '2026-07-30', '2026-07-31'].map((d) => rec(d));
  assert.equal(computeStreak(records, '2026-08-01'), 3);
});

test('computeStreak:断档', () => {
  // 今天有,前天有,昨天断 → 只算今天
  assert.equal(computeStreak([rec('2026-08-01'), rec('2026-07-30')], '2026-08-01'), 1);
  // 今天和昨天都没有 → 锚点(昨天)无记录 → 0
  assert.equal(computeStreak([rec('2026-07-29'), rec('2026-07-30')], '2026-08-01'), 0);
});

test('computeStreak:finished=false 不计入', () => {
  assert.equal(computeStreak([rec('2026-08-01', { finished: false })], '2026-08-01'), 0);
  // 昨天完成、今天只有未完成记录 → 从昨天起算 1
  assert.equal(
    computeStreak([rec('2026-07-31'), rec('2026-08-01', { finished: false })], '2026-08-01'),
    1,
  );
  // 中间那天只有未完成记录 → 断档
  const records = [
    rec('2026-07-30'),
    rec('2026-07-31', { finished: false }),
    rec('2026-08-01'),
  ];
  assert.equal(computeStreak(records, '2026-08-01'), 1);
});

test('totals:聚合 sessions/finishedSessions/totalReps/totalDurationSec/activeDays', () => {
  const records = [
    rec('2026-07-30', { completedReps: 10, durationSec: 100 }),
    rec('2026-07-30', { completedReps: 12, durationSec: 120 }),
    rec('2026-07-31', { completedReps: 5, durationSec: 40, finished: false }),
    rec('2026-08-01', { completedReps: 36, durationSec: 400 }),
  ];
  assert.deepEqual(totals(records), {
    sessions: 4,
    finishedSessions: 3,
    totalReps: 63, // 未完成记录的收缩次数也计入累计
    totalDurationSec: 660,
    activeDays: 2, // 07-30 与 08-01(07-31 只有未完成记录)
  });
  assert.deepEqual(totals([]), {
    sessions: 0,
    finishedSessions: 0,
    totalReps: 0,
    totalDurationSec: 0,
    activeDays: 0,
  });
  assert.deepEqual(totals(undefined), {
    sessions: 0,
    finishedSessions: 0,
    totalReps: 0,
    totalDurationSec: 0,
    activeDays: 0,
  });
});

test('lastNDays:长度恰为 n、旧→新、末项为今天', () => {
  const out = lastNDays([], '2026-08-01', 35);
  assert.equal(out.length, 35);
  assert.equal(out[34].dateStr, '2026-08-01');
  assert.equal(out[0].dateStr, addDays('2026-08-01', -34));
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i].dateStr, addDays(out[i - 1].dateStr, 1), '日期不连续');
  }
  assert.deepEqual(out[10], { dateStr: addDays('2026-08-01', -24), finishedCount: 0, reps: 0 });
  assert.equal(lastNDays([], '2026-08-01', 7).length, 7);
  assert.equal(lastNDays([], '2026-08-01', 1)[0].dateStr, '2026-08-01');
  assert.deepEqual(lastNDays([], '2026-08-01', 0), []);
});

test('lastNDays:空日补零、当天多条聚合、区间外记录不计', () => {
  const records = [
    rec('2026-08-01', { completedReps: 12 }),
    rec('2026-08-01', { completedReps: 10 }),
    rec('2026-08-01', { completedReps: 3, finished: false }),
    rec('2026-07-30', { completedReps: 8 }),
    rec('2026-01-01', { completedReps: 99 }), // 区间外
  ];
  const out = lastNDays(records, '2026-08-01', 5);
  assert.deepEqual(out, [
    { dateStr: '2026-07-28', finishedCount: 0, reps: 0 },
    { dateStr: '2026-07-29', finishedCount: 0, reps: 0 },
    { dateStr: '2026-07-30', finishedCount: 1, reps: 8 },
    { dateStr: '2026-07-31', finishedCount: 0, reps: 0 },
    { dateStr: '2026-08-01', finishedCount: 2, reps: 25 }, // 未完成记录的 reps 也累加
  ]);
  // 跨月边界日期正确
  const cross = lastNDays([rec('2026-07-31', { completedReps: 7 })], '2026-08-02', 3);
  assert.deepEqual(cross.map((d) => d.dateStr), ['2026-07-31', '2026-08-01', '2026-08-02']);
  assert.equal(cross[0].reps, 7);
});

test('longestStreak:空数组 / 全是 finished:false → 0', () => {
  assert.equal(longestStreak([]), 0);
  assert.equal(longestStreak(undefined), 0);
  assert.equal(longestStreak(null), 0);
  const allUnfinished = [
    rec('2026-08-01', { finished: false }),
    rec('2026-08-02', { finished: false }),
  ];
  assert.equal(longestStreak(allUnfinished), 0);
});

test('longestStreak:单天 → 1', () => {
  assert.equal(longestStreak([rec('2026-08-01')]), 1);
});

test('longestStreak:连续 3 天 → 3', () => {
  const records = ['2026-08-01', '2026-08-02', '2026-08-03'].map((d) => rec(d));
  assert.equal(longestStreak(records), 3);
});

test('longestStreak:有断档时取最长的一段', () => {
  // 5 天一段(07-01..07-05) + 断档 + 2 天一段(07-10..07-11) → 最长 5
  const records = [
    '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05',
    '2026-07-10', '2026-07-11',
  ].map((d) => rec(d));
  assert.equal(longestStreak(records), 5);
});

test('longestStreak:同一天多条记录不重复计数', () => {
  const records = [
    rec('2026-08-01'),
    rec('2026-08-01'),
    rec('2026-08-02'),
    rec('2026-08-02'),
    rec('2026-08-02'),
  ];
  assert.equal(longestStreak(records), 2);
});

test('longestStreak:跨月、跨年边界连续 3 天', () => {
  const records = ['2025-12-30', '2025-12-31', '2026-01-01'].map((d) => rec(d));
  assert.equal(longestStreak(records), 3);
});

test('longestStreak:记录顺序打乱后结果不变(函数内部排序)', () => {
  const inOrder = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'].map((d) => rec(d));
  const shuffled = [inOrder[3], inOrder[0], inOrder[4], inOrder[1], inOrder[2]];
  assert.equal(longestStreak(shuffled), 5);
});

test('longestStreak 与 computeStreak 的区别:历史连续过、现在已断档很久', () => {
  // 2026-01 月连续打卡 7 天,之后再无记录;"今天"是 2026-08-02,早已断档
  const records = [
    '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04',
    '2026-01-05', '2026-01-06', '2026-01-07',
  ].map((d) => rec(d));
  assert.equal(computeStreak(records, '2026-08-02'), 0);
  assert.equal(longestStreak(records), 7);
});

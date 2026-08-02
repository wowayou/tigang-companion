import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRecord, addDays } from '../core/stats.js';
import {
  ACHIEVEMENTS,
  DEFAULT_DAILY_GOAL,
  computeMetrics,
  evaluate,
  unlockedIds,
  newlyUnlocked,
  dailyGoal,
} from '../core/achievements.js';

const rec = (dateStr, opts = {}) =>
  makeRecord({
    dateStr,
    completedReps: opts.completedReps ?? 12,
    totalReps: opts.totalReps ?? 12,
    durationSec: opts.durationSec ?? 120,
    finished: opts.finished ?? true,
  });

const VALID_METRICS = new Set(['finishedSessions', 'bestStreak', 'activeDays', 'totalReps']);

// ---------------------------------------------------------------------------
// ACHIEVEMENTS 契约
// ---------------------------------------------------------------------------

test('ACHIEVEMENTS:12 枚,字段齐全,id 唯一,metric 合法,threshold 为正整数', () => {
  assert.equal(ACHIEVEMENTS.length, 12);
  const ids = new Set();
  for (const def of ACHIEVEMENTS) {
    assert.equal(typeof def.id, 'string');
    assert.ok(def.id.length > 0);
    assert.equal(typeof def.icon, 'string');
    assert.equal(typeof def.name, 'string');
    assert.equal(typeof def.desc, 'string');
    assert.ok(VALID_METRICS.has(def.metric), `未知 metric: ${def.metric}`);
    assert.ok(Number.isInteger(def.threshold), `threshold 应为整数: ${def.id}`);
    assert.ok(def.threshold > 0, `threshold 应为正数: ${def.id}`);
    assert.ok(!ids.has(def.id), `重复 id: ${def.id}`);
    ids.add(def.id);
  }
  assert.equal(ids.size, 12);
});

// ---------------------------------------------------------------------------
// computeMetrics
// ---------------------------------------------------------------------------

test('computeMetrics:空记录时所有指标为 0', () => {
  const m = computeMetrics([], '2026-08-02');
  assert.deepEqual(m, {
    streak: 0,
    bestStreak: 0,
    activeDays: 0,
    finishedSessions: 0,
    totalReps: 0,
    totalDurationSec: 0,
    todayFinished: 0,
    todayReps: 0,
  });
  assert.deepEqual(computeMetrics(undefined, '2026-08-02'), m);
  assert.deepEqual(computeMetrics(null, '2026-08-02'), m);
});

test('computeMetrics:混合记录(含未完成、含今天与往日)逐项手算校验', () => {
  const todayStr = '2026-08-02';
  const records = [
    rec('2026-07-31', { completedReps: 10, durationSec: 100 }), // 完成,昨天
    rec('2026-08-01', { completedReps: 20, durationSec: 200 }), // 完成,前天
    rec(todayStr, { completedReps: 15, durationSec: 150 }), // 完成,今天
    rec(todayStr, { completedReps: 5, durationSec: 50, finished: false }), // 未完成,今天
    rec('2026-07-15', { completedReps: 8, durationSec: 80, finished: false }), // 未完成,孤立的一天
  ];

  const m = computeMetrics(records, todayStr);

  // finishedSessions:只数 finished:true → 07-31, 08-01, 08-02(第一条) = 3
  assert.equal(m.finishedSessions, 3);
  // activeDays:finished:true 的不同日期 → 07-31 / 08-01 / 08-02 = 3(07-15 未完成不算)
  assert.equal(m.activeDays, 3);
  // totalReps:包含未完成记录 → 10+20+15+5+8 = 58
  assert.equal(m.totalReps, 58);
  // totalDurationSec:同理包含未完成 → 100+200+150+50+80 = 580
  assert.equal(m.totalDurationSec, 580);
  // streak:07-31,08-01,08-02 连续三天,今天有完成记录 → 3
  assert.equal(m.streak, 3);
  // bestStreak:与 streak 相同的连续段(07-15 孤立且未完成,不参与)→ 3
  assert.equal(m.bestStreak, 3);
  // todayFinished:今天 finished:true 的记录数 → 1
  assert.equal(m.todayFinished, 1);
  // todayReps:今天全部记录的 completedReps 之和(不论是否完成)→ 15+5 = 20
  assert.equal(m.todayReps, 20);
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

test('evaluate:空记录 → 全部未解锁', () => {
  const result = evaluate([], '2026-08-02');
  assert.equal(result.unlockedCount, 0);
  assert.equal(result.total, 12);
  assert.equal(result.badges.length, 12);
  for (const b of result.badges) {
    assert.equal(b.unlocked, false);
    assert.equal(b.current, 0);
    assert.equal(b.progress, 0);
  }
  // 全部并列于 0 进度 → next 取定义顺序最靠前的一枚
  assert.equal(result.next.id, 'first-session');
});

test('evaluate:每枚徽章都有 current/unlocked/remaining/progress,progress 与 remaining 公式正确', () => {
  const records = [rec('2026-08-01', { completedReps: 30 }), rec('2026-08-02', { completedReps: 20 })];
  const result = evaluate(records, '2026-08-02');
  for (const b of result.badges) {
    assert.equal(typeof b.current, 'number');
    assert.equal(typeof b.unlocked, 'boolean');
    assert.equal(typeof b.remaining, 'number');
    assert.equal(typeof b.progress, 'number');
    assert.ok(b.progress >= 0 && b.progress <= 1, `progress 越界: ${b.id}=${b.progress}`);
    assert.equal(b.progress, Math.min(1, b.current / b.threshold));
    assert.equal(b.remaining, Math.max(0, b.threshold - b.current));
    assert.equal(b.unlocked, b.current >= b.threshold);
  }
});

test('evaluate:边界值 — current === threshold 解锁,current === threshold-1 不解锁', () => {
  const findBadge = (result, id) => result.badges.find((b) => b.id === id);

  const exact = evaluate([rec('2026-08-02', { completedReps: 100 })], '2026-08-02');
  const repsExact = findBadge(exact, 'reps-100');
  assert.equal(repsExact.current, 100);
  assert.equal(repsExact.unlocked, true);
  assert.equal(repsExact.remaining, 0);
  assert.equal(repsExact.progress, 1);

  const short = evaluate([rec('2026-08-02', { completedReps: 99 })], '2026-08-02');
  const repsShort = findBadge(short, 'reps-100');
  assert.equal(repsShort.current, 99);
  assert.equal(repsShort.unlocked, false);
  assert.equal(repsShort.remaining, 1);
});

test('evaluate:next 是未解锁里进度最高的一枚,并列时取定义顺序靠前的', () => {
  // 5 个互不相邻的完成日 → activeDays=5、bestStreak=1;每天 completedReps=10 → totalReps=50
  const dates = ['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-07', '2026-01-09'];
  const records = dates.map((d) => rec(d, { completedReps: 10 }));
  const result = evaluate(records, '2026-08-02');

  assert.equal(result.metrics.activeDays, 5);
  assert.equal(result.metrics.bestStreak, 1);
  assert.equal(result.metrics.totalReps, 50);

  // reps-100(50/100=0.5) 与 days-10(5/10=0.5) 并列最高,reps-100 定义顺序更靠前
  assert.equal(result.next.id, 'reps-100');

  // nextByMetric:每类指标各自定义顺序最靠前的未解锁徽章
  assert.equal(result.nextByMetric.bestStreak.id, 'streak-3');
  assert.equal(result.nextByMetric.activeDays.id, 'days-10');
  assert.equal(result.nextByMetric.totalReps.id, 'reps-100');
  // finishedSessions 只有一枚徽章(first-session),已解锁 → 不出现在 nextByMetric 里
  assert.ok(!('finishedSessions' in result.nextByMetric));
});

test('evaluate:全部解锁时 next === null', () => {
  const todayStr = '2026-08-02';
  const startStr = addDays(todayStr, -149); // 150 天连续
  const records = [];
  let cursor = startStr;
  for (let i = 0; i < 150; i++) {
    records.push(rec(cursor, { completedReps: 100 }));
    cursor = addDays(cursor, 1);
  }
  const result = evaluate(records, todayStr);
  assert.equal(result.metrics.finishedSessions, 150);
  assert.equal(result.metrics.bestStreak, 150);
  assert.equal(result.metrics.activeDays, 150);
  assert.equal(result.metrics.totalReps, 15000);
  assert.equal(result.unlockedCount, 12);
  assert.equal(result.next, null);
  for (const b of result.badges) assert.equal(b.unlocked, true);
});

// ---------------------------------------------------------------------------
// unlockedIds
// ---------------------------------------------------------------------------

test('unlockedIds:与 evaluate().badges 过滤结果一致,顺序为定义顺序', () => {
  const records = [
    rec('2026-08-01', { completedReps: 100 }),
    rec('2026-08-02', { completedReps: 400 }),
  ];
  const todayStr = '2026-08-02';
  const ids = unlockedIds(records, todayStr);
  const expected = evaluate(records, todayStr)
    .badges.filter((b) => b.unlocked)
    .map((b) => b.id);
  assert.deepEqual(ids, expected);
  // 顺序应与 ACHIEVEMENTS 定义顺序一致
  const defOrder = ACHIEVEMENTS.map((d) => d.id).filter((id) => ids.includes(id));
  assert.deepEqual(ids, defOrder);
});

test('unlockedIds:空记录 → 空数组', () => {
  assert.deepEqual(unlockedIds([], '2026-08-02'), []);
});

// ---------------------------------------------------------------------------
// newlyUnlocked
// ---------------------------------------------------------------------------

test('newlyUnlocked:新解锁 1 枚', () => {
  const result = newlyUnlocked(['first-session'], ['first-session', 'streak-3']);
  assert.deepEqual(result.map((d) => d.id), ['streak-3']);
});

test('newlyUnlocked:新解锁多枚,按定义顺序返回', () => {
  const result = newlyUnlocked([], ['reps-100', 'first-session']);
  assert.deepEqual(result.map((d) => d.id), ['first-session', 'reps-100']);
});

test('newlyUnlocked:没有新解锁 → 空数组', () => {
  assert.deepEqual(newlyUnlocked(['first-session'], ['first-session']), []);
  assert.deepEqual(newlyUnlocked([], []), []);
});

test('newlyUnlocked:before 里有而 after 里没有的不算(不返回负向差集)', () => {
  const result = newlyUnlocked(['first-session', 'streak-3'], ['first-session']);
  assert.deepEqual(result, []);
});

test('newlyUnlocked:undefined/null 不抛错', () => {
  assert.deepEqual(newlyUnlocked(undefined, undefined), []);
  assert.deepEqual(newlyUnlocked(null, null), []);
  assert.deepEqual(
    newlyUnlocked(null, ['first-session']).map((d) => d.id),
    ['first-session'],
  );
  assert.deepEqual(newlyUnlocked(['first-session'], undefined), []);
});

// ---------------------------------------------------------------------------
// dailyGoal
// ---------------------------------------------------------------------------

test('dailyGoal:今天没完成 → done 0 / met false / remaining 1(默认 goal=1)', () => {
  const g = dailyGoal([], '2026-08-02');
  assert.equal(g.done, 0);
  assert.equal(g.goal, DEFAULT_DAILY_GOAL);
  assert.equal(g.met, false);
  assert.equal(g.remaining, 1);
  assert.equal(g.progress, 0);
});

test('dailyGoal:今天完成 1 次 → met true(默认 goal=1)', () => {
  const g = dailyGoal([rec('2026-08-02')], '2026-08-02');
  assert.equal(g.done, 1);
  assert.equal(g.met, true);
  assert.equal(g.remaining, 0);
  assert.equal(g.progress, 1);
});

test('dailyGoal:goal=3 时的中间态', () => {
  const records = [rec('2026-08-02'), rec('2026-08-02')];
  const g = dailyGoal(records, '2026-08-02', 3);
  assert.equal(g.done, 2);
  assert.equal(g.goal, 3);
  assert.equal(g.met, false);
  assert.equal(g.remaining, 1);
  assert.equal(g.progress, 2 / 3);
});

test('dailyGoal:goal 非法值(0、-1、NaN、undefined)回落成至少 1', () => {
  for (const bad of [0, -1, NaN, undefined]) {
    const g = dailyGoal([], '2026-08-02', bad);
    assert.equal(g.goal, 1, `goal=${bad} 应回落为 1`);
  }
});

test('dailyGoal:只统计 dateStr===todayStr 且 finished:true 的记录', () => {
  const records = [
    rec('2026-08-01'), // 昨天完成,不算
    rec('2026-08-02', { finished: false }), // 今天但未完成,不算
    rec('2026-08-02'), // 今天完成,算
  ];
  const g = dailyGoal(records, '2026-08-02');
  assert.equal(g.done, 1);
  assert.equal(g.met, true);
});

// ---------------------------------------------------------------------------
// 纯函数性
// ---------------------------------------------------------------------------

test('纯函数性:不修改传入的 records,同一份数据换 todayStr 得到不同但确定的结果', () => {
  const records = [
    rec('2026-07-31', { completedReps: 10 }),
    rec('2026-08-01', { completedReps: 20 }),
    rec('2026-08-02', { completedReps: 15 }),
  ];
  const snapshot = structuredClone(records);

  const metricsA = computeMetrics(records, '2026-08-02');
  const evalA = evaluate(records, '2026-08-02');
  const idsA = unlockedIds(records, '2026-08-02');
  const goalA = dailyGoal(records, '2026-08-02');

  assert.deepEqual(records, snapshot, 'records 数组内容被修改');

  // 不依赖 Date.now():同一份 records,换一个 todayStr 应得到不同但确定的结果
  const metricsB = computeMetrics(records, '2026-07-31');
  assert.notDeepEqual(metricsA, metricsB);
  // 确定性:同参数重复调用结果一致
  const metricsA2 = computeMetrics(records, '2026-08-02');
  assert.deepEqual(metricsA, metricsA2);

  assert.deepEqual(records, snapshot, 'records 数组内容被修改(第二轮调用后)');

  // evaluate / unlockedIds / dailyGoal 同样不修改输入且结果确定
  assert.deepEqual(evaluate(records, '2026-08-02'), evalA);
  assert.deepEqual(unlockedIds(records, '2026-08-02'), idsA);
  assert.deepEqual(dailyGoal(records, '2026-08-02'), goalA);
  assert.deepEqual(records, snapshot, 'records 数组内容被修改(第三轮调用后)');
});

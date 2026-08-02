// core/achievements.js — 成就徽章 / 今日目标(纯函数)
// 约束:不访问 DOM、不调用 Date.now()、不访问 localStorage;今天的日期由调用方以 todayStr 传入。

import { longestStreak, computeStreak, totals } from './stats.js';

/**
 * 徽章定义。metric 指向 computeMetrics 返回的字段名,达到 threshold 即解锁。
 * 顺序即徽章墙的展示顺序(按解锁难度递增,4 列 × 3 行)。
 *
 * 连续类一律看 bestStreak(历史最长)而非当前连续:断档不该收回已经拿到的徽章。
 */
export const ACHIEVEMENTS = [
  { id: 'first-session', icon: '🌱', name: '迈出第一步', desc: '完成 1 次训练',   metric: 'finishedSessions', threshold: 1 },
  { id: 'streak-3',      icon: '🔥', name: '三日不辍',   desc: '连续打卡 3 天',    metric: 'bestStreak',       threshold: 3 },
  { id: 'reps-100',      icon: '💯', name: '百次收缩',   desc: '累计 100 次收缩',  metric: 'totalReps',        threshold: 100 },
  { id: 'streak-7',      icon: '⚡', name: '一周不断',   desc: '连续打卡 7 天',    metric: 'bestStreak',       threshold: 7 },
  { id: 'days-10',       icon: '📗', name: '十日之功',   desc: '累计打卡 10 天',   metric: 'activeDays',       threshold: 10 },
  { id: 'reps-500',      icon: '🌊', name: '五百次',     desc: '累计 500 次收缩',  metric: 'totalReps',        threshold: 500 },
  { id: 'streak-14',     icon: '🏅', name: '双周坚持',   desc: '连续打卡 14 天',   metric: 'bestStreak',       threshold: 14 },
  { id: 'days-30',       icon: '📅', name: '满月打卡',   desc: '累计打卡 30 天',   metric: 'activeDays',       threshold: 30 },
  { id: 'reps-2000',     icon: '🗻', name: '两千次',     desc: '累计 2000 次收缩', metric: 'totalReps',        threshold: 2000 },
  { id: 'streak-30',     icon: '👑', name: '月度不断',   desc: '连续打卡 30 天',   metric: 'bestStreak',       threshold: 30 },
  { id: 'days-100',      icon: '🎯', name: '百日打卡',   desc: '累计打卡 100 天',  metric: 'activeDays',       threshold: 100 },
  { id: 'reps-10000',    icon: '🏆', name: '万次收缩',   desc: '累计 10000 次收缩', metric: 'totalReps',       threshold: 10000 },
];

export const DEFAULT_DAILY_GOAL = 1;

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function asArray(records) {
  return Array.isArray(records) ? records : [];
}

/**
 * 徽章与目标要用到的全部指标。
 * @returns {{streak:number,bestStreak:number,activeDays:number,finishedSessions:number,
 *            totalReps:number,totalDurationSec:number,todayFinished:number,todayReps:number}}
 */
export function computeMetrics(records, todayStr) {
  const t = totals(records);
  let todayFinished = 0;
  let todayReps = 0;
  for (const r of asArray(records)) {
    if (!r || r.dateStr !== todayStr) continue;
    if (r.finished === true) todayFinished += 1;
    const n = Number(r.completedReps);
    todayReps += Number.isFinite(n) ? Math.round(n) : 0;
  }
  return {
    streak: computeStreak(records, todayStr),
    bestStreak: longestStreak(records),
    activeDays: t.activeDays,
    finishedSessions: t.finishedSessions,
    totalReps: t.totalReps,
    totalDurationSec: t.totalDurationSec,
    todayFinished,
    todayReps,
  };
}

/** 单枚徽章 + 当前进度。 */
function decorate(def, metrics) {
  const current = Number(metrics[def.metric]) || 0;
  return {
    ...def,
    current,
    unlocked: current >= def.threshold,
    remaining: Math.max(0, def.threshold - current),
    progress: def.threshold > 0 ? clamp01(current / def.threshold) : 1,
  };
}

/**
 * 徽章墙的完整数据。
 * next = 未解锁徽章里进度最高的那枚(并列时取定义顺序靠前的);全部解锁则为 null。
 * nextByMetric = 每类指标各自的下一枚,用于「再练 2 天解锁『一周不断』」这类定向提示。
 */
export function evaluate(records, todayStr) {
  const metrics = computeMetrics(records, todayStr);
  const badges = ACHIEVEMENTS.map((def) => decorate(def, metrics));

  let next = null;
  const nextByMetric = {};
  for (const b of badges) {
    if (b.unlocked) continue;
    if (!next || b.progress > next.progress) next = b;
    if (!(b.metric in nextByMetric)) nextByMetric[b.metric] = b;
  }

  return {
    metrics,
    badges,
    unlockedCount: badges.filter((b) => b.unlocked).length,
    total: badges.length,
    next,
    nextByMetric,
  };
}

/** 当前已解锁的徽章 id 数组(定义顺序)。 */
export function unlockedIds(records, todayStr) {
  const metrics = computeMetrics(records, todayStr);
  return ACHIEVEMENTS.filter((def) => (Number(metrics[def.metric]) || 0) >= def.threshold).map((d) => d.id);
}

/**
 * 本次训练新解锁了哪些徽章:传入写入记录「前」的 id 数组与「后」的 id 数组。
 * @returns {object[]} 新解锁徽章的定义(定义顺序)
 */
export function newlyUnlocked(beforeIds, afterIds) {
  const before = new Set(asArray(beforeIds));
  const after = new Set(asArray(afterIds));
  return ACHIEVEMENTS.filter((def) => after.has(def.id) && !before.has(def.id));
}

/**
 * 今日目标进度(默认每天完成 1 次训练)。
 * @returns {{done:number,goal:number,met:boolean,remaining:number,progress:number}}
 */
export function dailyGoal(records, todayStr, goal = DEFAULT_DAILY_GOAL) {
  const target = Math.max(1, Math.round(Number(goal) || DEFAULT_DAILY_GOAL));
  const { todayFinished } = computeMetrics(records, todayStr);
  return {
    done: todayFinished,
    goal: target,
    met: todayFinished >= target,
    remaining: Math.max(0, target - todayFinished),
    progress: clamp01(todayFinished / target),
  };
}

// core/stats.js — 打卡 / 连续天数 / 热力图数据(纯函数)
// 约束:不访问 DOM、不调用 Date.now()、不访问 localStorage。
// 打卡记录只存本地日期字符串 'YYYY-MM-DD',避免时区/跨天 bug。

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function asArray(records) {
  return Array.isArray(records) ? records : [];
}

/** Date 对象 → 'YYYY-MM-DD'(本地时间分量,补零)。 */
export function localDateStr(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 日期字符串加减天数(用 Date.UTC 做算术,不受本地时区/夏令时影响)。 */
export function addDays(dateStr, delta) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const step = Number(delta);
  const t = Date.UTC(y, m - 1, d + (Number.isFinite(step) ? Math.trunc(step) : 0));
  const dt = new Date(t);
  return `${pad4(dt.getUTCFullYear())}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 生成一条打卡记录:数值取整、finished 转 boolean。 */
export function makeRecord({ dateStr, completedReps, totalReps, durationSec, finished } = {}) {
  return {
    dateStr: String(dateStr ?? ''),
    completedReps: toInt(completedReps),
    totalReps: toInt(totalReps),
    durationSec: toInt(durationSec),
    finished: Boolean(finished),
  };
}

function finishedDateSet(records) {
  const set = new Set();
  for (const r of asArray(records)) {
    if (r && r.finished === true && r.dateStr) set.add(r.dateStr);
  }
  return set;
}

/**
 * 连续打卡天数:只有 finished===true 的记录算"完成当天打卡"。
 * 锚点:今天有完成记录则从今天起算,否则从昨天起算;锚点无记录 → 0;向前逐日累计。
 */
export function computeStreak(records, todayStr) {
  const done = finishedDateSet(records);
  if (done.size === 0) return 0;
  let cursor = done.has(todayStr) ? todayStr : addDays(todayStr, -1);
  if (!done.has(cursor)) return 0;
  let streak = 0;
  while (done.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * 历史最长连续打卡天数(与今天无关,只看记录本身)。
 * 徽章用它而不是 computeStreak:断档后已解锁的徽章不该被收回。
 */
export function longestStreak(records) {
  const dates = [...finishedDateSet(records)].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of dates) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

/** 汇总:{ sessions, finishedSessions, totalReps, totalDurationSec, activeDays }。 */
export function totals(records) {
  const list = asArray(records);
  let finishedSessions = 0;
  let totalReps = 0;
  let totalDurationSec = 0;
  const activeDates = new Set();
  for (const r of list) {
    if (!r) continue;
    if (r.finished === true) {
      finishedSessions += 1;
      if (r.dateStr) activeDates.add(r.dateStr);
    }
    totalReps += toInt(r.completedReps);
    totalDurationSec += toInt(r.durationSec);
  }
  return {
    sessions: list.length,
    finishedSessions,
    totalReps,
    totalDurationSec,
    activeDays: activeDates.size,
  };
}

/**
 * 最近 n 天(旧→新,最后一项为 todayStr),长度恰为 n。
 * @returns {{dateStr:string,finishedCount:number,reps:number}[]}
 */
export function lastNDays(records, todayStr, n) {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  const byDate = new Map();
  for (const r of asArray(records)) {
    if (!r || !r.dateStr) continue;
    let entry = byDate.get(r.dateStr);
    if (!entry) {
      entry = { finishedCount: 0, reps: 0 };
      byDate.set(r.dateStr, entry);
    }
    if (r.finished === true) entry.finishedCount += 1;
    entry.reps += toInt(r.completedReps);
  }
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const dateStr = addDays(todayStr, -i);
    const entry = byDate.get(dateStr);
    out.push({
      dateStr,
      finishedCount: entry ? entry.finishedCount : 0,
      reps: entry ? entry.reps : 0,
    });
  }
  return out;
}

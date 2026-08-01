// core/engine.js — 训练状态机(纯函数)
// 约束:不访问 DOM、不调用 Date.now()、不访问 localStorage。
// 所有时间戳由调用方以 nowMs(毫秒)传入;所有更新均为不可变更新(返回新对象)。

export const PRESETS = {
  beginner: { name: '新手入门', contractSec: 3, relaxSec: 3, repsPerSet: 10, sets: 2, restSec: 20, prepareSec: 3 },
  standard: { name: '标准训练', contractSec: 5, relaxSec: 5, repsPerSet: 12, sets: 3, restSec: 30, prepareSec: 3 },
  advanced: { name: '进阶耐力', contractSec: 10, relaxSec: 10, repsPerSet: 10, sets: 3, restSec: 30, prepareSec: 3 },
  quick:    { name: '快速爆发', contractSec: 1, relaxSec: 1, repsPerSet: 20, sets: 2, restSec: 20, prepareSec: 3 },
};

// 字段范围(顺序即 validateConfig 返回对象的键顺序)
const FIELD_RANGES = {
  contractSec: { min: 1, max: 30 },
  relaxSec:    { min: 1, max: 30 },
  repsPerSet:  { min: 1, max: 50 },
  sets:        { min: 1, max: 10 },
  restSec:     { min: 0, max: 180 },
  prepareSec:  { min: 0, max: 10 },
};

const CONFIG_KEYS = Object.keys(FIELD_RANGES);

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * 校验并夹取配置。非法/缺失字段回落到 standard 的对应值,再夹到范围内并取整。
 * @param {object} raw
 * @returns {{contractSec:number,relaxSec:number,repsPerSet:number,sets:number,restSec:number,prepareSec:number}}
 */
export function validateConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of CONFIG_KEYS) {
    const { min, max } = FIELD_RANGES[key];
    const n = toFiniteNumber(src[key]);
    const base = n === null ? PRESETS.standard[key] : n;
    out[key] = Math.round(clamp(base, min, max));
  }
  return out;
}

/**
 * 创建一个 idle 态会话(纯数据,可 JSON 序列化)。
 */
export function createSession(rawConfig) {
  return {
    config: validateConfig(rawConfig),
    phase: 'idle',
    setIndex: 0,
    repIndex: 0,
    phaseEndsAt: null,
    paused: false,
    pausedRemainingMs: null,
    completedReps: 0,
    startedAt: null,
    finishedAt: null,
  };
}

/** prepare/contract/relax/rest 对应秒数;其他阶段(idle/done)为 0。 */
export function phaseDurationSec(config, phase) {
  if (!config) return 0;
  switch (phase) {
    case 'prepare': return config.prepareSec;
    case 'contract': return config.contractSec;
    case 'relax': return config.relaxSec;
    case 'rest': return config.restSec;
    default: return 0;
  }
}

/** 一次完整训练的总时长(秒)。 */
export function totalDurationSec(config) {
  const { prepareSec, contractSec, relaxSec, repsPerSet, sets, restSec } = config;
  return (
    prepareSec +
    sets * repsPerSet * contractSec +
    sets * (repsPerSet - 1) * relaxSec +
    (sets - 1) * restSec
  );
}

/** 仅 idle 可调;prepareSec>0 进 prepare,否则直接 contract。 */
export function start(state, nowMs) {
  if (!state || state.phase !== 'idle') return state;
  const phase = state.config.prepareSec > 0 ? 'prepare' : 'contract';
  return {
    ...state,
    phase,
    setIndex: 0,
    repIndex: 0,
    phaseEndsAt: nowMs + phaseDurationSec(state.config, phase) * 1000,
    paused: false,
    pausedRemainingMs: null,
    completedReps: 0,
    startedAt: nowMs,
    finishedAt: null,
  };
}

/**
 * 推进状态机。非运行态(idle/done/paused)或未到边界时原样返回同一引用。
 * 跨边界用 while 循环,一次 tick 可跨多个阶段;
 * 新阶段 phaseEndsAt = 旧 phaseEndsAt + 新阶段时长×1000(边界累加,不产生漂移)。
 */
export function tick(state, nowMs) {
  if (!state) return state;
  if (state.paused) return state;
  if (state.phase === 'idle' || state.phase === 'done') return state;
  if (typeof state.phaseEndsAt !== 'number') return state;
  if (nowMs < state.phaseEndsAt) return state;

  const config = state.config;
  let phase = state.phase;
  let setIndex = state.setIndex;
  let repIndex = state.repIndex;
  let completedReps = state.completedReps;
  let phaseEndsAt = state.phaseEndsAt;
  let finishedAt = state.finishedAt;

  // 安全阀:validateConfig 保证 contractSec/relaxSec ≥ 1,循环必然收敛;此处只防御非法外部状态。
  let guard = 0;
  while (phase !== 'done' && typeof phaseEndsAt === 'number' && nowMs >= phaseEndsAt) {
    if (++guard > 1e6) break;
    const boundary = phaseEndsAt;

    if (phase === 'contract') {
      completedReps += 1;
      if (repIndex < config.repsPerSet - 1) {
        // 本组还有下一次收缩:进入 relax,索引指向下一次收缩
        repIndex += 1;
        phase = 'relax';
      } else if (setIndex < config.sets - 1) {
        // 本组结束,进入下一组
        setIndex += 1;
        repIndex = 0;
        phase = config.restSec > 0 ? 'rest' : 'contract';
      } else {
        // 全部完成
        phase = 'done';
        finishedAt = boundary;
        phaseEndsAt = null;
        break;
      }
    } else {
      // prepare / relax / rest → contract(索引不变)
      phase = 'contract';
    }

    phaseEndsAt = boundary + phaseDurationSec(config, phase) * 1000;
  }

  return { ...state, phase, setIndex, repIndex, phaseEndsAt, completedReps, finishedAt };
}

/** 运行中才生效;记 pausedRemainingMs = max(0, phaseEndsAt - nowMs)。 */
export function pause(state, nowMs) {
  if (!state || state.paused) return state;
  if (state.phase === 'idle' || state.phase === 'done') return state;
  if (typeof state.phaseEndsAt !== 'number') return state;
  return {
    ...state,
    paused: true,
    pausedRemainingMs: Math.max(0, state.phaseEndsAt - nowMs),
    phaseEndsAt: null,
  };
}

/** paused 才生效;phaseEndsAt = nowMs + pausedRemainingMs。 */
export function resume(state, nowMs) {
  if (!state || !state.paused) return state;
  const remaining = typeof state.pausedRemainingMs === 'number' ? state.pausedRemainingMs : 0;
  return {
    ...state,
    paused: false,
    pausedRemainingMs: null,
    phaseEndsAt: nowMs + remaining,
  };
}

/** 回到同配置的 idle 态。 */
export function reset(state) {
  return createSession(state ? state.config : undefined);
}

/** 当前阶段剩余毫秒;idle/done→0;paused→pausedRemainingMs。 */
export function remainingInPhaseMs(state, nowMs) {
  if (!state) return 0;
  if (state.phase === 'idle' || state.phase === 'done') return 0;
  if (state.paused) {
    return Math.max(0, typeof state.pausedRemainingMs === 'number' ? state.pausedRemainingMs : 0);
  }
  if (typeof state.phaseEndsAt !== 'number') return 0;
  return Math.max(0, state.phaseEndsAt - nowMs);
}

/** 当前阶段结束之后、剩余所有阶段的时长(秒)。 */
function remainingAfterPhaseSec(config, phase, setIndex, repIndex) {
  const { contractSec, relaxSec, repsPerSet, sets, restSec } = config;
  const setCost = repsPerSet * contractSec + (repsPerSet - 1) * relaxSec;
  const laterSets = (sets - 1 - setIndex) * (restSec + setCost);
  if (phase === 'contract') {
    // 本组剩余 (repsPerSet-1-repIndex) 次 收缩+放松
    return (repsPerSet - 1 - repIndex) * (contractSec + relaxSec) + laterSets;
  }
  if (phase === 'prepare' || phase === 'relax' || phase === 'rest') {
    // 下一个阶段是第 (setIndex, repIndex) 次收缩
    return (repsPerSet - repIndex) * contractSec + (repsPerSet - 1 - repIndex) * relaxSec + laterSets;
  }
  return 0;
}

/** 当前阶段剩余 + 之后所有阶段时长(秒)。idle→整场时长,done→0。 */
export function remainingTotalSec(state, nowMs) {
  if (!state) return 0;
  if (state.phase === 'done') return 0;
  if (state.phase === 'idle') return totalDurationSec(state.config);
  return (
    remainingInPhaseMs(state, nowMs) / 1000 +
    remainingAfterPhaseSec(state.config, state.phase, state.setIndex, state.repIndex)
  );
}

/** 0..1 的整体进度;= 1 - remainingTotal/total;done→1,idle→0。 */
export function overallProgress(state, nowMs) {
  if (!state) return 0;
  if (state.phase === 'done') return 1;
  if (state.phase === 'idle') return 0;
  const total = totalDurationSec(state.config);
  if (!(total > 0)) return 0;
  return clamp(1 - remainingTotalSec(state, nowMs) / total, 0, 1);
}

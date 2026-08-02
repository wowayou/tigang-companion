import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS,
  validateConfig,
  createSession,
  start,
  tick,
  pause,
  resume,
  reset,
  phaseDurationSec,
  totalDurationSec,
  remainingInPhaseMs,
  remainingTotalSec,
  overallProgress,
} from '../core/engine.js';

// 规格 §6.3 使用的配置:1s 收缩 / 1s 放松 / 每组 2 次 / 2 组 / 1s 组间休息 / 1s 准备
const CFG = { contractSec: 1, relaxSec: 1, repsPerSet: 2, sets: 2, restSec: 1, prepareSec: 1 };

function stripName({ name, ...rest }) {
  return rest;
}

// 从 t=0 开始按 stepMs 步进 tick 到 endMs,返回 { state, transitions, samples }
function runStepwise(config, endMs, stepMs) {
  let state = start(createSession(config), 0);
  const transitions = [[state.phase, 0]];
  const samples = [[0, state.phase]];
  for (let t = stepMs; t <= endMs; t += stepMs) {
    const next = tick(state, t);
    if (next.phase !== state.phase) transitions.push([next.phase, t]);
    state = next;
    samples.push([t, state.phase]);
  }
  return { state, transitions, samples };
}

test('§6.1 四个 PRESETS 均通过 validateConfig 且值不变', () => {
  for (const [key, preset] of Object.entries(PRESETS)) {
    assert.deepEqual(validateConfig(preset), stripName(preset), `preset ${key} 被改动`);
  }
  assert.deepEqual(Object.keys(PRESETS), ['beginner', 'standard', 'advanced', 'quick']);
});

test('§6.2 validateConfig:超范围夹取', () => {
  assert.deepEqual(
    validateConfig({ contractSec: 999, holdSec: 999, relaxSec: 999, repsPerSet: 999, sets: 999, restSec: 999, prepareSec: 999 }),
    { contractSec: 30, holdSec: 60, relaxSec: 30, repsPerSet: 50, sets: 10, restSec: 180, prepareSec: 10 },
  );
  assert.deepEqual(
    validateConfig({ contractSec: -5, holdSec: -1, relaxSec: 0, repsPerSet: 0, sets: -1, restSec: -10, prepareSec: -3 }),
    { contractSec: 1, holdSec: 0, relaxSec: 1, repsPerSet: 1, sets: 1, restSec: 0, prepareSec: 0 },
  );
});

test('§6.2 validateConfig:小数取整', () => {
  const out = validateConfig({ contractSec: 3.4, holdSec: 6.5, relaxSec: 3.6, repsPerSet: 10.5, sets: 2.2, restSec: 20.7, prepareSec: 3.5 });
  assert.deepEqual(out, { contractSec: 3, holdSec: 7, relaxSec: 4, repsPerSet: 11, sets: 2, restSec: 21, prepareSec: 4 });
  for (const v of Object.values(out)) assert.ok(Number.isInteger(v));
});

test('§6.2 validateConfig:缺失/非数字回落 standard 默认', () => {
  const std = stripName(PRESETS.standard);
  assert.deepEqual(validateConfig({}), std);
  assert.deepEqual(validateConfig(undefined), std);
  assert.deepEqual(validateConfig(null), std);
  assert.deepEqual(validateConfig('nonsense'), std);
  assert.deepEqual(
    validateConfig({ contractSec: NaN, relaxSec: 'abc', repsPerSet: null, sets: Infinity, restSec: {}, prepareSec: undefined }),
    std,
  );
  // 部分字段合法时只回落非法字段
  assert.deepEqual(validateConfig({ contractSec: 8, sets: 'x' }), { ...std, contractSec: 8 });
  // 返回新对象,不含 name,且不与入参共享引用
  const raw = { ...std };
  const out = validateConfig(raw);
  assert.notEqual(out, raw);
  assert.equal('name' in validateConfig(PRESETS.standard), false);
});

test('§6.3 完整流程:阶段序列 / 总时长 / 结束态', () => {
  assert.equal(totalDurationSec(CFG), 8); // 1 + 2*2*1 + 2*1*1 + 1*1

  const { state, transitions, samples } = runStepwise(CFG, 8000, 500);
  assert.deepEqual(transitions, [
    ['prepare', 0],
    ['contract', 1000],
    ['relax', 2000],
    ['contract', 3000],
    ['rest', 4000],
    ['contract', 5000],
    ['relax', 6000],
    ['contract', 7000],
    ['done', 8000],
  ]);
  // 每个 500ms 采样点的阶段
  assert.deepEqual(samples, [
    [0, 'prepare'], [500, 'prepare'],
    [1000, 'contract'], [1500, 'contract'],
    [2000, 'relax'], [2500, 'relax'],
    [3000, 'contract'], [3500, 'contract'],
    [4000, 'rest'], [4500, 'rest'],
    [5000, 'contract'], [5500, 'contract'],
    [6000, 'relax'], [6500, 'relax'],
    [7000, 'contract'], [7500, 'contract'],
    [8000, 'done'],
  ]);

  assert.equal(state.phase, 'done');
  assert.equal(state.completedReps, 4);
  assert.equal(state.finishedAt, 8000);
  assert.equal(state.phaseEndsAt, null);
  assert.equal(state.startedAt, 0);
});

test('§6.3 索引在流程中始终指向当前/即将进行的组与次', () => {
  let s = start(createSession(CFG), 0);
  assert.deepEqual([s.setIndex, s.repIndex], [0, 0]); // prepare
  s = tick(s, 1000); // contract 1/2 of set 1
  assert.deepEqual([s.phase, s.setIndex, s.repIndex, s.completedReps], ['contract', 0, 0, 0]);
  s = tick(s, 2000); // relax,索引指向下一次收缩
  assert.deepEqual([s.phase, s.setIndex, s.repIndex, s.completedReps], ['relax', 0, 1, 1]);
  s = tick(s, 3000);
  assert.deepEqual([s.phase, s.setIndex, s.repIndex, s.completedReps], ['contract', 0, 1, 1]);
  s = tick(s, 4000); // rest,索引指向下一组
  assert.deepEqual([s.phase, s.setIndex, s.repIndex, s.completedReps], ['rest', 1, 0, 2]);
  s = tick(s, 5000);
  assert.deepEqual([s.phase, s.setIndex, s.repIndex, s.completedReps], ['contract', 1, 0, 2]);
});

test('§6.3 phaseEndsAt 由边界累加,不随 tick 时刻漂移', () => {
  let s = start(createSession(CFG), 0);
  assert.equal(s.phaseEndsAt, 1000);
  s = tick(s, 1499); // 迟到 499ms 才 tick
  assert.equal(s.phase, 'contract');
  assert.equal(s.phaseEndsAt, 2000); // 仍以 1000 边界累加,而不是 1499+1000
  s = tick(s, 2999);
  assert.equal(s.phase, 'relax');
  assert.equal(s.phaseEndsAt, 3000);
});

test('§6.4 大步长 tick 一次跨多个阶段,结果与逐步 tick 一致', () => {
  for (const target of [1000, 2500, 4000, 5500, 7999, 8000, 12000]) {
    const stepwise = runStepwise(CFG, target, 100).state;
    const oneShot = tick(start(createSession(CFG), 0), target);
    assert.deepEqual(oneShot, stepwise, `大步长 tick 到 ${target} 与逐步结果不一致`);
  }
  // 一步直接跨到结束
  const done = tick(start(createSession(CFG), 0), 999999);
  assert.equal(done.phase, 'done');
  assert.equal(done.completedReps, 4);
  assert.equal(done.finishedAt, 8000); // 完成时刻是边界时间戳,不是 nowMs
});

test('§6.5 pause/resume:暂停时 tick 不推进,恢复后剩余时长保持', () => {
  const s0 = start(createSession(CFG), 0);
  const paused = pause(s0, 400);
  assert.equal(paused.paused, true);
  assert.equal(paused.pausedRemainingMs, 600);
  assert.equal(paused.phaseEndsAt, null);
  assert.equal(remainingInPhaseMs(paused, 999999), 600); // 与 nowMs 无关

  // 暂停期间 tick 原样返回同一引用
  assert.equal(tick(paused, 5000), paused);
  assert.equal(tick(paused, 999999), paused);

  const resumed = resume(paused, 10000);
  assert.equal(resumed.paused, false);
  assert.equal(resumed.pausedRemainingMs, null);
  assert.equal(resumed.phaseEndsAt, 10600);
  assert.equal(remainingInPhaseMs(resumed, 10000), 600);
  assert.equal(tick(resumed, 10500), resumed); // 未到边界
  const afterPrepare = tick(resumed, 10600);
  assert.equal(afterPrepare.phase, 'contract');
  assert.equal(afterPrepare.phaseEndsAt, 11600);

  // 暂停不改变阶段/进度语义:恢复后总剩余与暂停时刻一致
  assert.equal(remainingTotalSec(paused, 999999), remainingTotalSec(resumed, 10000));

  // 边界情形:idle / done / 已暂停 → 原样返回
  const idle = createSession(CFG);
  assert.equal(pause(idle, 100), idle);
  assert.equal(resume(idle, 100), idle);
  assert.equal(pause(paused, 500), paused);
  const done = tick(s0, 99999);
  assert.equal(pause(done, 99999), done);
  // 超时暂停不产生负剩余
  assert.equal(pause(s0, 5000).pausedRemainingMs, 0);
});

test('§6.6 idle/done 态 tick 返回原引用', () => {
  const idle = createSession(CFG);
  assert.equal(tick(idle, 0), idle);
  assert.equal(tick(idle, 999999), idle);

  const done = tick(start(createSession(CFG), 0), 999999);
  assert.equal(done.phase, 'done');
  assert.equal(tick(done, 999999), done);
  assert.equal(tick(done, 1e12), done);

  // 未到边界时同样返回原引用
  const running = start(createSession(CFG), 0);
  assert.equal(tick(running, 999), running);
});

test('§6.6 start 仅 idle 可调;reset 回到同配置 idle 态', () => {
  const idle = createSession(CFG);
  const running = start(idle, 0);
  assert.equal(start(running, 5000), running); // 运行中再 start 无效
  const done = tick(running, 999999);
  assert.equal(start(done, 5000), done);

  const back = reset(done);
  assert.deepEqual(back, createSession(CFG));
  assert.equal(back.phase, 'idle');
  assert.equal(back.completedReps, 0);
  assert.equal(back.startedAt, null);
  assert.equal(back.finishedAt, null);
  assert.deepEqual(back.config, validateConfig(CFG));
});

test('§6.7 restSec=0 跨组直接 contract→contract', () => {
  const cfg = { contractSec: 1, relaxSec: 1, repsPerSet: 2, sets: 2, restSec: 0, prepareSec: 1 };
  assert.equal(totalDurationSec(cfg), 7); // 1 + 4 + 2 + 0
  const { transitions, state } = runStepwise(cfg, 7000, 500);
  assert.deepEqual(transitions, [
    ['prepare', 0],
    ['contract', 1000],
    ['relax', 2000],
    ['contract', 3000],
    // 4000 边界:contract→contract(跨组无 rest),phase 不变故无 transition 记录
    ['relax', 5000],
    ['contract', 6000],
    ['done', 7000],
  ]);
  // 4000 边界确实换组了
  let s = start(createSession(cfg), 0);
  s = tick(s, 4000);
  assert.deepEqual([s.phase, s.setIndex, s.repIndex, s.completedReps], ['contract', 1, 0, 2]);
  assert.equal(s.phaseEndsAt, 5000);
  assert.equal(state.completedReps, 4);
  assert.equal(state.finishedAt, 7000);
});

test('§6.7 prepareSec=0 时 start 直接进 contract', () => {
  const cfg = { contractSec: 2, relaxSec: 1, repsPerSet: 2, sets: 1, restSec: 0, prepareSec: 0 };
  const s = start(createSession(cfg), 1000);
  assert.equal(s.phase, 'contract');
  assert.equal(s.startedAt, 1000);
  assert.equal(s.phaseEndsAt, 3000);
  assert.equal(totalDurationSec(cfg), 5); // 0 + 4 + 1 + 0
  const end = tick(s, 1000 + 5000);
  assert.equal(end.phase, 'done');
  assert.equal(end.finishedAt, 6000);
  assert.equal(end.completedReps, 2);
});

test('§6.8 remainingTotalSec 单调不增,overallProgress 从 0 到 1', () => {
  const total = totalDurationSec(CFG);
  const idle = createSession(CFG);
  assert.equal(remainingTotalSec(idle, 0), total);
  assert.equal(overallProgress(idle, 0), 0);

  let state = start(idle, 0);
  assert.equal(remainingTotalSec(state, 0), total);
  assert.equal(overallProgress(state, 0), 0);

  let prevRemaining = Infinity;
  let prevProgress = -Infinity;
  for (let t = 0; t <= 9000; t += 250) {
    state = tick(state, t);
    const remaining = remainingTotalSec(state, t);
    const progress = overallProgress(state, t);
    assert.ok(remaining <= prevRemaining + 1e-9, `t=${t} 剩余时长增加了:${prevRemaining} → ${remaining}`);
    assert.ok(progress >= prevProgress - 1e-9, `t=${t} 进度回退了:${prevProgress} → ${progress}`);
    assert.ok(progress >= 0 && progress <= 1, `t=${t} 进度越界:${progress}`);
    assert.ok(Math.abs((1 - remaining / total) - progress) < 1e-9 || state.phase === 'done');
    prevRemaining = remaining;
    prevProgress = progress;
  }
  assert.equal(state.phase, 'done');
  assert.equal(remainingTotalSec(state, 9000), 0);
  assert.equal(overallProgress(state, 9000), 1);

  // 阶段边界处剩余总时长连续(相邻阶段无跳变)
  for (const t of [1000, 2000, 3000, 4000, 5000, 6000, 7000]) {
    const before = tick(start(createSession(CFG), 0), t - 1);
    const after = tick(start(createSession(CFG), 0), t);
    assert.ok(Math.abs(remainingTotalSec(before, t) - remainingTotalSec(after, t)) < 1e-9, `边界 ${t} 剩余时长跳变`);
  }
});

test('§6.8 remainingInPhaseMs 与 phaseDurationSec', () => {
  assert.equal(phaseDurationSec(CFG, 'prepare'), 1);
  assert.equal(phaseDurationSec(CFG, 'contract'), 1);
  assert.equal(phaseDurationSec(CFG, 'relax'), 1);
  assert.equal(phaseDurationSec(CFG, 'rest'), 1);
  assert.equal(phaseDurationSec(CFG, 'idle'), 0);
  assert.equal(phaseDurationSec(CFG, 'done'), 0);
  const std = validateConfig(PRESETS.standard);
  assert.equal(phaseDurationSec(std, 'contract'), 5);
  assert.equal(phaseDurationSec(std, 'rest'), 30);
  // standard 总时长 = 3 + 3*12*5 + 3*11*5 + 2*30 = 3+180+165+60 = 408
  assert.equal(totalDurationSec(std), 408);

  const idle = createSession(CFG);
  assert.equal(remainingInPhaseMs(idle, 0), 0);
  const s = start(idle, 0);
  assert.equal(remainingInPhaseMs(s, 0), 1000);
  assert.equal(remainingInPhaseMs(s, 400), 600);
  assert.equal(remainingInPhaseMs(s, 5000), 0); // 不为负
  const done = tick(s, 999999);
  assert.equal(remainingInPhaseMs(done, 999999), 0);
});

test('§6.9 不可变性:所有转移都不修改入参', () => {
  const idle = createSession(CFG);
  const idleSnapshot = structuredClone(idle);
  const running = start(idle, 0);
  assert.deepEqual(idle, idleSnapshot);
  assert.notEqual(running, idle);
  assert.deepEqual(running.config, validateConfig(CFG)); // config 透传(全程只读,不被修改)

  // tick 跨边界
  const before = tick(running, 1500);
  const beforeSnapshot = structuredClone(before);
  const after = tick(before, 4200);
  assert.deepEqual(before, beforeSnapshot, 'tick 修改了入参');
  assert.notEqual(after, before);
  assert.notEqual(after.phase, before.phase);

  // pause / resume / reset
  const pausedSnapshot = structuredClone(after);
  const paused = pause(after, 4300);
  assert.deepEqual(after, pausedSnapshot, 'pause 修改了入参');
  const pausedCopy = structuredClone(paused);
  const resumed = resume(paused, 9000);
  assert.deepEqual(paused, pausedCopy, 'resume 修改了入参');
  const resumedCopy = structuredClone(resumed);
  reset(resumed);
  assert.deepEqual(resumed, resumedCopy, 'reset 修改了入参');

  // config 不被后续操作共享篡改
  const raw = { contractSec: 3, relaxSec: 3, repsPerSet: 10, sets: 2, restSec: 20, prepareSec: 3 };
  const sess = createSession(raw);
  sess.config.contractSec = 99;
  assert.equal(raw.contractSec, 3);

  // 状态可 JSON 序列化
  const roundTrip = JSON.parse(JSON.stringify(resumed));
  assert.deepEqual(roundTrip, resumed);
});

/* ================================================================== *
 * §6.10 维持(hold)阶段 —— holdSec>0 时每次循环变成 收紧→维持→放松
 * ================================================================== */

// 1s 收紧 / 2s 维持 / 1s 放松 / 每组 2 次 / 2 组 / 1s 组间休息 / 1s 准备
const CFG_HOLD = { contractSec: 1, holdSec: 2, relaxSec: 1, repsPerSet: 2, sets: 2, restSec: 1, prepareSec: 1 };

test('§6.10 三段式完整流程:阶段序列 / 总时长 / 结束态', () => {
  // 1 + 2组*2次*(1收紧+2维持) + 2组*1次*1放松 + 1组间休息 = 1+12+2+1 = 16
  assert.equal(totalDurationSec(CFG_HOLD), 16);

  const { state, transitions } = runStepwise(CFG_HOLD, 16000, 500);
  assert.deepEqual(transitions, [
    ['prepare', 0],
    ['contract', 1000],
    ['hold', 2000],
    ['relax', 4000],
    ['contract', 5000],
    ['hold', 6000],
    ['rest', 8000],
    ['contract', 9000],
    ['hold', 10000],
    ['relax', 12000],
    ['contract', 13000],
    ['hold', 14000],
    ['done', 16000],
  ]);

  assert.equal(state.phase, 'done');
  assert.equal(state.completedReps, 4);
  assert.equal(state.finishedAt, 16000);
  assert.equal(state.phaseEndsAt, null);
});

test('§6.10 收缩计数在维持结束才 +1(收紧段不算完成)', () => {
  let s = start(createSession(CFG_HOLD), 0);
  s = tick(s, 1500);                       // contract 中
  assert.equal(s.phase, 'contract');
  assert.equal(s.completedReps, 0);
  s = tick(s, 2500);                       // hold 中,本次仍未完成
  assert.equal(s.phase, 'hold');
  assert.equal(s.completedReps, 0);
  assert.equal(s.repIndex, 0, 'hold 期间索引仍指向当前这次');
  s = tick(s, 4500);                       // hold 结束 → relax,第 1 次完成
  assert.equal(s.phase, 'relax');
  assert.equal(s.completedReps, 1);
  assert.equal(s.repIndex, 1, 'relax 期间索引指向下一次');
});

test('§6.10 holdSec=0 / 缺失 holdSec 键都退化成 v1 两段式', () => {
  const legacy = { contractSec: 1, relaxSec: 1, repsPerSet: 2, sets: 2, restSec: 1, prepareSec: 1 }; // 无 holdSec
  const explicitZero = { ...legacy, holdSec: 0 };

  // 与 §6.3 的 CFG 完全一致的阶段序列
  const expected = runStepwise(CFG, 8000, 500).transitions;
  assert.deepEqual(runStepwise(legacy, 8000, 500).transitions, expected);
  assert.deepEqual(runStepwise(explicitZero, 8000, 500).transitions, expected);

  // 纯函数在裸 config(无 holdSec 键)上也不能算出 NaN
  assert.equal(totalDurationSec(legacy), 8);
  assert.equal(phaseDurationSec(legacy, 'hold'), 0);
  assert.equal(validateConfig(legacy).holdSec, 0, '缺失 holdSec 回落为 0 而非 standard 值');
});

test('§6.10 大步长 tick 跨多个阶段与逐步 tick 一致', () => {
  const stepwise = runStepwise(CFG_HOLD, 16000, 250).state;
  const oneShot = tick(start(createSession(CFG_HOLD), 0), 16000);
  assert.deepEqual(oneShot, stepwise);

  // 一次 tick 直接从 prepare 跨到第二组的 hold
  const jump = tick(start(createSession(CFG_HOLD), 0), 10500);
  assert.equal(jump.phase, 'hold');
  assert.equal(jump.setIndex, 1);
  assert.equal(jump.repIndex, 0);
  assert.equal(jump.completedReps, 2);
});

test('§6.10 三段式下 remainingTotalSec 单调不增、边界不跳变', () => {
  const total = totalDurationSec(CFG_HOLD);
  let state = start(createSession(CFG_HOLD), 0);
  assert.equal(remainingTotalSec(state, 0), total);

  let prevRemaining = Infinity;
  let prevProgress = -Infinity;
  for (let t = 0; t <= 17000; t += 250) {
    state = tick(state, t);
    const remaining = remainingTotalSec(state, t);
    const progress = overallProgress(state, t);
    assert.ok(remaining <= prevRemaining + 1e-9, `t=${t} 剩余时长增加了:${prevRemaining} → ${remaining}`);
    assert.ok(progress >= prevProgress - 1e-9, `t=${t} 进度回退了:${prevProgress} → ${progress}`);
    prevRemaining = remaining;
    prevProgress = progress;
  }
  assert.equal(state.phase, 'done');
  assert.equal(overallProgress(state, 17000), 1);

  for (const t of [1000, 2000, 4000, 5000, 6000, 8000, 9000, 10000, 12000, 13000, 14000]) {
    const before = tick(start(createSession(CFG_HOLD), 0), t - 1);
    const after = tick(start(createSession(CFG_HOLD), 0), t);
    assert.ok(
      Math.abs(remainingTotalSec(before, t) - remainingTotalSec(after, t)) < 1e-9,
      `边界 ${t} 剩余时长跳变`,
    );
  }
});

test('§6.10 维持段可暂停/恢复', () => {
  let s = start(createSession(CFG_HOLD), 0);
  s = tick(s, 2500);
  assert.equal(s.phase, 'hold');
  s = pause(s, 2500);
  assert.equal(s.pausedRemainingMs, 1500);
  assert.equal(tick(s, 9999), s, '暂停期间 tick 不推进');
  s = resume(s, 100000);
  assert.equal(remainingInPhaseMs(s, 100000), 1500);
  s = tick(s, 101500);
  assert.equal(s.phase, 'relax');
  assert.equal(s.completedReps, 1);
});

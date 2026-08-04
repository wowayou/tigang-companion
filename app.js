/**
 * 提肛陪伴 — UI 胶水层
 * 只负责 DOM / 计时器 / 音效 / 存储调度;所有训练逻辑与统计计算来自 core/。
 */
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
  overallProgress,
} from './core/engine.js';
import { localDateStr, makeRecord, computeStreak, totals, lastNDays } from './core/stats.js';
import { evaluate, unlockedIds, newlyUnlocked, dailyGoal } from './core/achievements.js';
import { load, save, clearAll, exportJSON, parseBackup, mergeRecords } from './core/storage.js';

/* ------------------------------------------------------------------ *
 * DOM 引用
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const el = {
  btnSettings: $('btn-settings'),
  streakChip: $('streak-chip'),
  streakChipNum: $('streak-chip-num'),
  stDoing: $('st-doing'),
  stVisits: $('st-visits'),

  tabTrain: $('tab-train'),
  tabStats: $('tab-stats'),
  tabKnowledge: $('tab-knowledge'),
  panelTrain: $('panel-train'),
  panelStats: $('panel-stats'),
  panelKnowledge: $('panel-knowledge'),

  planToggle: $('plan-toggle'),
  planBody: $('plan-body'),
  planName: $('plan-name'),
  planSummary: $('plan-summary'),
  customPanel: $('custom-panel'),
  cfgContract: $('cfg-contract'),
  cfgRelax: $('cfg-relax'),
  cfgReps: $('cfg-reps'),
  cfgSets: $('cfg-sets'),
  cfgRest: $('cfg-rest'),
  optHoldEnabled: $('opt-hold-enabled'),
  holdSecWrap: $('hold-sec-wrap'),
  cfgHold: $('cfg-hold'),

  coachCircle: $('coach-circle'),
  phaseLabel: $('phase-label'),
  countdown: $('countdown'),
  setProgress: $('set-progress'),
  overallBar: $('overall-bar'),

  btnStart: $('btn-start'),
  btnPause: $('btn-pause'),
  btnStop: $('btn-stop'),

  donePanel: $('done-panel'),
  doneReps: $('done-reps'),
  doneDuration: $('done-duration'),
  doneStreakNum: $('done-streak-num'),
  doneNextBar: $('done-next-bar'),
  doneNext: $('done-next'),
  doneUnlocked: $('done-unlocked'),
  doneBadges: $('done-badges'),

  streakNum: $('streak-num'),
  todayGoal: $('today-goal'),
  badgeWall: $('badge-wall'),
  badgeCount: $('badge-count'),
  nextBadge: $('next-badge'),
  statDays: $('stat-days'),
  statSessions: $('stat-sessions'),
  statReps: $('stat-reps'),
  statDuration: $('stat-duration'),
  heatmap: $('heatmap'),
  btnExport: $('btn-export'),
  btnImport: $('btn-import'),
  fileImport: $('file-import'),
  btnClear: $('btn-clear'),
  dlgImport: $('dlg-import'),
  importSummary: $('import-summary'),
  importMerge: $('import-merge'),
  importReplace: $('import-replace'),
  importCancel: $('import-cancel'),

  dlgSettings: $('dlg-settings'),
  optSound: $('opt-sound'),
  optVoice: $('opt-voice'),
  optVibration: $('opt-vibration'),
  optReminderEnabled: $('opt-reminder-enabled'),
  optReminderTime: $('opt-reminder-time'),
};

const presetRadios = Array.from(document.querySelectorAll('input[name="preset"]'));
const customInputs = [el.cfgContract, el.cfgRelax, el.cfgReps, el.cfgSets, el.cfgRest];

const PHASE_LABEL = {
  idle: '待开始',
  prepare: '准备',
  contract: '收紧',
  hold: '维持',
  relax: '放松',
  rest: '休息',
  done: '完成',
};

/** 语音播报文本;刻意用短词,免得念不完就换阶段了。 */
const PHASE_SPEECH = {
  prepare: '准备',
  contract: '收紧',
  hold: '保持',
  relax: '放松',
  rest: '休息',
  done: '完成',
};

const METRIC_UNIT = {
  bestStreak: '天',
  activeDays: '天',
  totalReps: '次收缩',
  finishedSessions: '次训练',
};

const TICK_MS = 100;
const HEATMAP_DAYS = 35;
const DEFAULT_HOLD_SEC = 5;

/* ------------------------------------------------------------------ *
 * 运行时状态
 * ------------------------------------------------------------------ */

let data = load();
let session = createSession(resolveConfig());
let timerId = null;
let audioCtx = null;
let wakeLock = null;
let reminderTimer = null;
let voicePrimed = false;
// 关掉「维持」开关时记住上次的秒数,再打开时不用重新输
let lastHoldSec = data.settings.holdSec > 0 ? data.settings.holdSec : DEFAULT_HOLD_SEC;
// 空闲态那行提示里要显示连续天数,但 renderTrain 每 100ms 跑一次,不能每次都去算统计
let idleHintText = '';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/**
 * 当前生效的训练配置。
 * holdSec 是全局设置,叠加在任何方案(含 custom)之上 —— 只有一个地方能改「维持」。
 */
function resolveConfig() {
  const key = data.settings.presetKey;
  const holdSec = data.settings.holdSec;
  if (key === 'custom') return { ...data.settings.custom, holdSec };
  const preset = PRESETS[key] || PRESETS.standard;
  return {
    contractSec: preset.contractSec,
    holdSec,
    relaxSec: preset.relaxSec,
    repsPerSet: preset.repsPerSet,
    sets: preset.sets,
    restSec: preset.restSec,
    prepareSec: preset.prepareSec,
  };
}

function formatDuration(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function isRunning(state) {
  return state.phase !== 'idle' && state.phase !== 'done';
}

function persist() {
  save(data);
}

/* ------------------------------------------------------------------ *
 * 提示音 / 震动 / 屏幕常亮
 * ------------------------------------------------------------------ */

/** 必须在用户手势(开始按钮点击)中调用,规避自动播放限制。 */
function ensureAudioContext() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beep(freq, ms = 150, delaySec = 0) {
  if (!audioCtx || !data.settings.sound) return;
  try {
    const t0 = audioCtx.currentTime + delaySec;
    const dur = ms / 1000;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  } catch {
    /* 音频不可用时静默忽略 */
  }
}

function vibrate(pattern) {
  if (!data.settings.vibration) return;
  if (typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* 忽略 */
  }
}

/**
 * 提示音刻意做成有「方向」的:上行=提起来,下行=放下去,平音=稳住,低长音=歇着。
 * 这样即使关掉语音(公共场合),不看屏幕也分得出该干什么。
 */
const TONES = {
  prepare:  () => { beep(587, 130); },
  contract: () => { beep(660, 110); beep(990, 160, 0.10); },   // 上行
  hold:     () => { beep(784, 90);  beep(784, 90, 0.15); },    // 两声平音
  relax:    () => { beep(784, 110); beep(523, 180, 0.10); },   // 下行
  rest:     () => { beep(392, 240); },                          // 低长音
  done:     () => { beep(523, 150); beep(659, 150, 0.18); beep(880, 220, 0.36); },
};

const VIBRATIONS = {
  contract: [90],
  hold: [40, 70, 40],
  relax: [50],
  rest: [30, 60, 30],
  done: [80, 60, 80],
};

/**
 * iOS 要求 speechSynthesis 的第一次 speak 发生在用户手势里,否则之后的播报会被静默丢弃。
 * 用一句静音的空白话在开始按钮里「开锁」。
 */
function primeVoice() {
  if (voicePrimed || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.lang = 'zh-CN';
    window.speechSynthesis.speak(u);
    voicePrimed = true;
  } catch {
    voicePrimed = false;
  }
}

function speak(phase) {
  if (!data.settings.voice) return;
  if (!('speechSynthesis' in window)) return;
  const text = PHASE_SPEECH[phase];
  if (!text) return;
  try {
    const synth = window.speechSynthesis;
    // 上一句还没念完就换阶段时立刻让位,免得播报落后于画面
    if (synth.speaking || synth.pending) synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 1.05;
    u.volume = 0.9;
    // cancel() 之后同步 speak() 在部分引擎上会把播报队列卡死,退一个宏任务再说
    setTimeout(() => {
      try {
        synth.speak(u);
      } catch {
        /* 忽略 */
      }
    }, 0);
  } catch {
    /* 语音不可用时静默忽略,提示音仍在 */
  }
}

function stopSpeaking() {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* 忽略 */
  }
}

function cueFor(phase) {
  const tone = TONES[phase];
  if (tone) tone();
  const pattern = VIBRATIONS[phase];
  if (pattern) vibrate(pattern);
  speak(phase);
}

async function requestWakeLock() {
  try {
    if (navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  try {
    if (wakeLock && typeof wakeLock.release === 'function') wakeLock.release();
  } catch {
    /* 忽略 */
  }
  wakeLock = null;
}

/* ------------------------------------------------------------------ *
 * 引导圆动画
 * ------------------------------------------------------------------ */

/** 维持阶段停在收缩到位的尺寸上 —— 「已经提上去了,现在别松」。 */
function targetScale(phase) {
  return phase === 'contract' || phase === 'hold' ? 0.62 : 1;
}

/** 进入某阶段:transitionDuration = 该阶段(剩余)秒数,收紧/维持停在 0.62。 */
function animateCircle(phase, durationSec) {
  const circle = el.coachCircle;
  circle.dataset.phase = phase;
  // 维持期间圆不动,靠内圈高光的脉动表示「还在用力」
  circle.classList.toggle('is-pulsing', phase === 'hold');
  circle.classList.remove('is-paused');
  // 四个值依次对应 transform / background-color / color / box-shadow:
  // 只有缩放跟着阶段秒数走,配色一律用固定的 .55s 平滑跨过边界
  circle.style.transitionDuration = `${Math.max(0, durationSec)}s, .9s, .9s, .9s`;
  circle.style.transform = `scale(${targetScale(phase)})`;
  restartAnimation(el.phaseLabel);
}

/** 重放元素上的 CSS 动画(改文字时用来淡入,而不是硬闪)。 */
function restartAnimation(node) {
  node.style.animation = 'none';
  void node.offsetWidth; // 强制回流,否则浏览器会把去掉再加上合并成「没变」
  node.style.animation = '';
}

function enterPhaseVisual(state) {
  const { phase } = state;
  if (phase === 'idle' || phase === 'done') {
    animateCircle(phase, 0.4);
    return;
  }
  animateCircle(phase, phaseDurationSec(state.config, phase));
}

/** 暂停时把圆冻结在当前视觉位置,避免继续滑向终点。 */
function freezeCircle() {
  const circle = el.coachCircle;
  const current = window.getComputedStyle(circle).transform;
  circle.style.transitionDuration = '0s, .9s, .9s, .9s';
  circle.style.transform = current && current !== 'none' ? current : 'scale(1)';
  circle.classList.add('is-paused');
}

/** 恢复(或从后台切回)时,用剩余时长继续动画。 */
function syncCircleToRemaining(state) {
  if (!isRunning(state) || state.paused) return;
  animateCircle(state.phase, remainingInPhaseMs(state, Date.now()) / 1000);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function renderPlanSummary() {
  const c = session.config;
  const key = data.settings.presetKey;
  el.planName.textContent = key === 'custom' ? '自定义' : (PRESETS[key] || PRESETS.standard).name;
  // 开了维持才叫「收紧」(三段里的第一段),否则沿用「收缩」
  const first = c.holdSec > 0 ? `收紧 ${c.contractSec}s · 维持 ${c.holdSec}s` : `收缩 ${c.contractSec}s`;
  el.planSummary.textContent =
    `${first} · 放松 ${c.relaxSec}s · ${c.repsPerSet} 次 × ${c.sets} 组 · 约 ${formatDuration(totalDurationSec(c))}`;
}

function setPlanOpen(open) {
  el.planBody.hidden = !open;
  el.planToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** 空闲态那行文字:与其空着,不如告诉用户「今天练没练」。 */
function refreshIdleHint(today = localDateStr(new Date())) {
  const goal = dailyGoal(data.records, today);
  const streak = computeStreak(data.records, today);
  if (goal.met) {
    idleHintText = streak > 0 ? `今天已完成 · 连续 ${streak} 天` : '今天已完成';
  } else if (streak > 0) {
    idleHintText = `连续 ${streak} 天 · 今天还没练`;
  } else {
    idleHintText = '准备好就开始';
  }
}

function badgeEl(badge) {
  const node = document.createElement('div');
  node.className = 'badge';
  node.dataset.unlocked = badge.unlocked ? 'true' : 'false';
  node.title = badge.unlocked
    ? `${badge.name} · ${badge.desc} · 已解锁`
    : `${badge.name} · ${badge.desc} · 还差 ${badge.remaining}`;

  const icon = document.createElement('span');
  icon.className = 'badge-icon';
  icon.textContent = badge.icon;

  const name = document.createElement('span');
  name.className = 'badge-name';
  name.textContent = badge.name;

  node.append(icon, name);
  return node;
}

function renderTrain() {
  const now = Date.now();
  const s = session;
  const c = s.config;

  el.phaseLabel.textContent = PHASE_LABEL[s.phase] || '';

  if (s.phase === 'idle' || s.phase === 'done') {
    el.countdown.textContent = '—';
  } else {
    el.countdown.textContent = String(Math.max(0, Math.ceil(remainingInPhaseMs(s, now) / 1000)));
  }

  const running = isRunning(s);

  // 计数口径:收紧(+维持)结束即记完成,但索引要到放松结束才推进 ——
  // 所以放松期间 repIndex 指向的正是刚做完的那一次,报已完成数就用 repIndex+1。
  if (!running) {
    el.setProgress.textContent = idleHintText;
  } else if (s.phase === 'rest') {
    el.setProgress.textContent = `休息中 · 即将开始第 ${s.setIndex + 1} 组`;
  } else if (s.phase === 'prepare') {
    el.setProgress.textContent = `准备开始 · 共 ${c.sets} 组 × ${c.repsPerSet} 次`;
  } else if (s.phase === 'relax') {
    el.setProgress.textContent = `第 ${s.setIndex + 1}/${c.sets} 组 · 已完成 ${s.repIndex + 1}/${c.repsPerSet} 次`;
  } else {
    el.setProgress.textContent = `第 ${s.setIndex + 1}/${c.sets} 组 · 第 ${s.repIndex + 1}/${c.repsPerSet} 次`;
  }

  const pct = Math.min(100, Math.max(0, overallProgress(s, now) * 100));
  el.overallBar.style.width = `${pct.toFixed(2)}%`;

  el.btnStart.disabled = running;
  el.btnStart.textContent = s.phase === 'done' ? '再来一次' : '开始训练';
  el.btnPause.disabled = !running;
  el.btnPause.textContent = s.paused ? '继续' : '暂停';
  el.btnStop.disabled = !running;

  // 训练中锁住方案:改配置会重置会话,等于白练
  el.planToggle.disabled = running;
  if (running && !el.planBody.hidden) setPlanOpen(false);
  presetRadios.forEach((r) => { r.disabled = running; });
  customInputs.forEach((i) => { i.disabled = running; });
  el.optHoldEnabled.disabled = running;
  el.cfgHold.disabled = running;
}

function renderStats() {
  const today = localDateStr(new Date());
  const t = totals(data.records);
  const streak = computeStreak(data.records, today);

  el.streakNum.textContent = String(streak);

  // 顶栏火苗:0 天时不显示,免得空着反而像在提醒你失败了
  el.streakChip.hidden = streak <= 0;
  el.streakChipNum.textContent = String(streak);

  const goal = dailyGoal(data.records, today);
  el.todayGoal.dataset.met = String(goal.met);
  el.todayGoal.textContent = goal.met
    ? `今天已完成 ${goal.done} 次训练 ✓`
    : '今天还没练 · 完成 1 次就算打卡';

  renderBadges(today);
  refreshIdleHint(today);

  el.statDays.textContent = String(t.activeDays);
  el.statSessions.textContent = String(t.finishedSessions);
  el.statReps.textContent = String(t.totalReps);
  el.statDuration.textContent = String(Math.round(t.totalDurationSec / 60));

  const days = lastNDays(data.records, today, HEATMAP_DAYS);
  const frag = document.createDocumentFragment();
  days.forEach((d, i) => {
    const cell = document.createElement('div');
    cell.className = 'heat-cell';
    cell.dataset.level = String(Math.min(3, Math.max(0, d.finishedCount)));
    if (i === days.length - 1) cell.classList.add('is-today');
    cell.title = `${d.dateStr} · 完成 ${d.finishedCount} 次 · 收缩 ${d.reps} 次`;
    frag.appendChild(cell);
  });
  el.heatmap.textContent = '';
  el.heatmap.appendChild(frag);
}

function renderBadges(today) {
  const ev = evaluate(data.records, today);

  el.badgeCount.textContent = `${ev.unlockedCount} / ${ev.total}`;

  const frag = document.createDocumentFragment();
  for (const badge of ev.badges) frag.appendChild(badgeEl(badge));
  el.badgeWall.textContent = '';
  el.badgeWall.appendChild(frag);

  if (!ev.next) {
    el.nextBadge.textContent = '12 枚徽章全部解锁 —— 你已经把这件事变成习惯了。';
    return;
  }
  const unit = METRIC_UNIT[ev.next.metric] || '';
  el.nextBadge.textContent = '';
  el.nextBadge.append(
    `${ev.next.icon} 距「${ev.next.name}」还差 `,
    Object.assign(document.createElement('strong'), { textContent: `${ev.next.remaining} ${unit}` }),
  );
}

function renderSettingsForm() {
  el.optSound.checked = !!data.settings.sound;
  el.optVoice.checked = !!data.settings.voice;
  el.optVibration.checked = !!data.settings.vibration;
  el.optReminderEnabled.checked = !!data.settings.reminder.enabled;
  el.optReminderTime.value = data.settings.reminder.time || '21:00';
}

function renderPresetForm() {
  const key = data.settings.presetKey;
  presetRadios.forEach((r) => { r.checked = r.value === key; });
  el.customPanel.hidden = key !== 'custom';
  const custom = data.settings.custom;
  el.cfgContract.value = String(custom.contractSec);
  el.cfgRelax.value = String(custom.relaxSec);
  el.cfgReps.value = String(custom.repsPerSet);
  el.cfgSets.value = String(custom.sets);
  el.cfgRest.value = String(custom.restSec);

  const holdOn = data.settings.holdSec > 0;
  el.optHoldEnabled.checked = holdOn;
  el.holdSecWrap.hidden = !holdOn;
  el.cfgHold.value = String(holdOn ? data.settings.holdSec : lastHoldSec);
}

/* ------------------------------------------------------------------ *
 * 训练驱动
 * ------------------------------------------------------------------ */

function startLoop() {
  if (timerId !== null) return;
  timerId = setInterval(step, TICK_MS);
}

function stopLoop() {
  if (timerId === null) return;
  clearInterval(timerId);
  timerId = null;
}

function step() {
  const prev = session;
  const next = tick(prev, Date.now());

  if (next !== prev) {
    session = next;
    // 阶段推进的判定:phase 变了,或索引变了(restSec=0 时会出现 contract→contract)。
    const advanced =
      next.phase !== prev.phase ||
      next.setIndex !== prev.setIndex ||
      next.repIndex !== prev.repIndex;
    if (advanced) {
      cueFor(next.phase);
      enterPhaseVisual(next);
      if (next.phase === 'done') {
        stopLoop();
        finishSession();
      }
    }
  }

  renderTrain();
}

function writeRecord(state, finished) {
  const record = makeRecord({
    dateStr: localDateStr(new Date()),
    completedReps: state.completedReps,
    totalReps: state.config.sets * state.config.repsPerSet,
    durationSec: Math.round((Date.now() - state.startedAt) / 1000),
    finished,
  });
  data.records.push(record);
  persist();
  renderStats();
  return record;
}

function finishSession() {
  releaseWakeLock();
  const today = localDateStr(new Date());

  // 徽章解锁要在写入记录「前后」各取一次快照才比得出来
  const before = unlockedIds(data.records, today);
  const record = writeRecord(session, true);
  const gained = newlyUnlocked(before, unlockedIds(data.records, today));

  el.doneReps.textContent = String(record.completedReps);
  el.doneDuration.textContent = formatDuration(record.durationSec);

  const ev = evaluate(data.records, today);
  el.doneStreakNum.textContent = String(ev.metrics.streak);

  // 完成的这一刻最容易被「再来一天就解锁」推着走,所以把下一枚连续徽章摆在这里
  const nextStreak = ev.nextByMetric.bestStreak;
  if (nextStreak) {
    el.doneNextBar.style.width = `${(nextStreak.progress * 100).toFixed(1)}%`;
    el.doneNext.textContent = `再连续 ${nextStreak.remaining} 天解锁「${nextStreak.name}」`;
  } else {
    el.doneNextBar.style.width = '100%';
    el.doneNext.textContent = '连续打卡徽章已全部拿下。';
  }

  el.doneBadges.textContent = '';
  if (gained.length > 0) {
    for (const badge of gained) el.doneBadges.appendChild(badgeEl({ ...badge, unlocked: true }));
    el.doneUnlocked.hidden = false;
  } else {
    el.doneUnlocked.hidden = true;
  }

  el.donePanel.hidden = false;
  // 用 center 而不是 nearest:底部 tab 栏是固定层,贴底对齐会把新解锁的徽章压在它下面
  el.donePanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  syncTrainingFlag();
}

function resetSession() {
  stopLoop();
  releaseWakeLock();
  session = createSession(resolveConfig());
  el.donePanel.hidden = true;
  enterPhaseVisual(session);
  renderPlanSummary();
  renderTrain();
  syncTrainingFlag();
}

/* ------------------------------------------------------------------ *
 * 事件:训练控制
 * ------------------------------------------------------------------ */

el.planToggle.addEventListener('click', () => {
  if (el.planToggle.disabled) return;
  setPlanOpen(el.planBody.hidden);
});

el.btnStart.addEventListener('click', () => {
  // 自动播放限制:AudioContext 与 speechSynthesis 都必须在这个点击处理器里开锁。
  ensureAudioContext();
  primeVoice();
  setPlanOpen(false);

  if (session.phase === 'done') {
    session = reset(session);
    el.donePanel.hidden = true;
  }
  if (session.phase !== 'idle') return;

  const now = Date.now();
  session = start(session, now);
  cueFor(session.phase);
  enterPhaseVisual(session);
  requestWakeLock();
  startLoop();
  syncTrainingFlag();
  renderTrain();
});

el.btnPause.addEventListener('click', () => {
  const now = Date.now();
  if (session.paused) {
    session = resume(session, now);
    syncCircleToRemaining(session);
    startLoop();
  } else {
    session = pause(session, now);
    if (session.paused) {
      stopLoop();
      stopSpeaking();
      freezeCircle();
    }
  }
  syncTrainingFlag();
  renderTrain();
});

el.btnStop.addEventListener('click', () => {
  if (!isRunning(session)) return;
  if (!window.confirm('确定结束本次训练?')) return;
  stopLoop();
  stopSpeaking();
  if (session.completedReps > 0) writeRecord(session, false);
  resetSession();
});

/* ------------------------------------------------------------------ *
 * 事件:维持阶段
 * ------------------------------------------------------------------ */

function applyHoldSec(sec) {
  data.settings.holdSec = sec;
  persist();
  renderPresetForm();
  resetSession();
}

el.optHoldEnabled.addEventListener('change', () => {
  applyHoldSec(el.optHoldEnabled.checked ? lastHoldSec : 0);
});

el.cfgHold.addEventListener('change', () => {
  // 与 engine 的 holdSec 范围保持一致(1-60);留空/非法回落到上一次的值
  const raw = el.cfgHold.valueAsNumber;
  const sec = Number.isFinite(raw) ? Math.min(60, Math.max(1, Math.round(raw))) : lastHoldSec;
  lastHoldSec = sec;
  applyHoldSec(el.optHoldEnabled.checked ? sec : 0);
});

/* ------------------------------------------------------------------ *
 * 事件:方案选择
 * ------------------------------------------------------------------ */

presetRadios.forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    data.settings.presetKey = radio.value;
    persist();
    el.customPanel.hidden = radio.value !== 'custom';
    resetSession();
  });
});

customInputs.forEach((input) => {
  input.addEventListener('change', () => {
    // holdSec 是全局设置,不进 custom —— 否则同一个概念会有两份真相
    const { holdSec, ...custom } = validateConfig({
      contractSec: el.cfgContract.valueAsNumber,
      relaxSec: el.cfgRelax.valueAsNumber,
      repsPerSet: el.cfgReps.valueAsNumber,
      sets: el.cfgSets.valueAsNumber,
      restSec: el.cfgRest.valueAsNumber,
      prepareSec: data.settings.custom.prepareSec,
    });
    data.settings.custom = custom;
    persist();
    renderPresetForm();
    if (data.settings.presetKey === 'custom') resetSession();
  });
});

/* ------------------------------------------------------------------ *
 * 事件:tab 切换
 * ------------------------------------------------------------------ */

const TABS = [
  { btn: el.tabTrain, panel: el.panelTrain },
  { btn: el.tabStats, panel: el.panelStats },
  { btn: el.tabKnowledge, panel: el.panelKnowledge },
];

function showTab(index) {
  TABS.forEach((t, i) => {
    const active = i === index;
    t.panel.hidden = !active;
    t.btn.classList.toggle('is-active', active);
    t.btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (index === 1) renderStats();
  window.scrollTo(0, 0);
}

TABS.forEach((t, i) => {
  t.btn.addEventListener('click', () => showTab(i));
});

/* ------------------------------------------------------------------ *
 * 事件:设置
 * ------------------------------------------------------------------ */

el.btnSettings.addEventListener('click', () => {
  renderSettingsForm();
  if (typeof el.dlgSettings.showModal === 'function') el.dlgSettings.showModal();
  else el.dlgSettings.setAttribute('open', '');
});

el.optSound.addEventListener('change', () => {
  data.settings.sound = el.optSound.checked;
  persist();
});

el.optVoice.addEventListener('change', () => {
  data.settings.voice = el.optVoice.checked;
  persist();
  if (data.settings.voice) primeVoice();
  else stopSpeaking();
});

el.optVibration.addEventListener('change', () => {
  data.settings.vibration = el.optVibration.checked;
  persist();
});

async function ensureNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch {
    return false;
  }
}

el.optReminderEnabled.addEventListener('change', async () => {
  if (el.optReminderEnabled.checked) {
    const granted = await ensureNotificationPermission();
    if (!granted) {
      el.optReminderEnabled.checked = false;
      data.settings.reminder.enabled = false;
      persist();
      scheduleReminder();
      window.alert('浏览器未授予通知权限,提醒已关闭。');
      return;
    }
  }
  data.settings.reminder.enabled = el.optReminderEnabled.checked;
  persist();
  scheduleReminder();
});

el.optReminderTime.addEventListener('change', () => {
  data.settings.reminder.time = el.optReminderTime.value || '21:00';
  persist();
  scheduleReminder();
});

/* ------------------------------------------------------------------ *
 * 每日提醒(仅在页面保持打开时生效)
 * ------------------------------------------------------------------ */

function msUntilNext(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  const hour = m ? Math.min(23, Math.max(0, Number(m[1]))) : 21;
  const minute = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleReminder() {
  if (reminderTimer !== null) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
  const reminder = data.settings.reminder;
  if (!reminder || !reminder.enabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  reminderTimer = setTimeout(() => {
    try {
      new Notification('提肛时间到 💪', { body: '花两分钟完成今天的训练吧' });
    } catch {
      /* 忽略 */
    }
    scheduleReminder(); // 触发后自动排到明天
  }, msUntilNext(reminder.time));
}

/* ------------------------------------------------------------------ *
 * 事件:数据导出 / 清除
 * ------------------------------------------------------------------ */

function backupFileName() {
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `tigang-${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}.json`;
}

function isIOSDevice() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

el.btnExport.addEventListener('click', () => {
  const json = exportJSON(data);
  const fname = backupFileName();
  // iOS 主屏 PWA 的 a.download 经常只发请求却不真正落盘 → 走系统分享面板让用户选「存储到文件」
  let file = null;
  try {
    file = new File([json], fname, { type: 'application/json' });
  } catch {
    /* 旧浏览器无 File 构造器,走下面的 Blob 下载 */
  }
  if (file && isIOSDevice() && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: fname }).catch(() => {});
    return;
  }
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

el.btnClear.addEventListener('click', () => {
  if (!window.confirm('确定清除全部数据?打卡记录与设置都会被删除,且无法恢复。')) return;
  clearAll();
  data = load();
  lastHoldSec = DEFAULT_HOLD_SEC;
  renderPresetForm();
  renderSettingsForm();
  scheduleReminder();
  resetSession();
  renderStats();
});

/* ------------------------------------------------------------------ *
 * 事件:数据导入(合并 / 替换)
 * ------------------------------------------------------------------ */

let pendingImport = null;

el.btnImport.addEventListener('click', () => {
  if (el.fileImport) el.fileImport.click();
});

el.fileImport.addEventListener('change', async () => {
  const file = el.fileImport.files[0];
  el.fileImport.value = ''; // 允许连续选择同一个文件
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    window.alert('读取文件失败,请重试。');
    return;
  }
  const result = parseBackup(text);
  if (!result.ok) {
    window.alert(`导入失败:${result.error}`);
    return;
  }
  pendingImport = result.data;
  const recs = result.data.records;
  el.importSummary.textContent = recs.length
    ? `备份里有 ${recs.length} 条打卡记录(${recs[0].dateStr} ~ ${recs[recs.length - 1].dateStr}),当前本机已有 ${data.records.length} 条。`
    : `备份里没有打卡记录,只有设置。当前本机已有 ${data.records.length} 条记录。`;
  if (typeof el.dlgImport.showModal === 'function') el.dlgImport.showModal();
  else el.dlgImport.setAttribute('open', '');
});

el.dlgImport.addEventListener('close', () => {
  pendingImport = null;
});

el.importMerge.addEventListener('click', () => {
  const backup = pendingImport;
  if (!backup) return;
  const before = data.records.length;
  data.records = mergeRecords(data.records, backup.records);
  persist();
  el.dlgImport.close();
  afterDataImport();
  window.alert(`已合并 ${data.records.length - before} 条新记录。`);
});

el.importReplace.addEventListener('click', () => {
  const backup = pendingImport;
  if (!backup) return;
  data = { records: backup.records, settings: backup.settings };
  lastHoldSec = data.settings.holdSec > 0 ? data.settings.holdSec : DEFAULT_HOLD_SEC;
  persist();
  el.dlgImport.close();
  afterDataImport();
  window.alert(`已用备份替换本地数据(共 ${data.records.length} 条记录)。`);
});

el.importCancel.addEventListener('click', () => {
  el.dlgImport.close();
});

/** 导入后统一刷新:设置表单 / 提醒 / 训练 / 统计。 */
function afterDataImport() {
  renderPresetForm();
  renderSettingsForm();
  scheduleReminder();
  resetSession();
  renderStats();
}

/* ------------------------------------------------------------------ *
 * 键盘:空格 = 开始 / 暂停 / 继续
 * ------------------------------------------------------------------ */

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' && event.key !== ' ') return;
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (el.dlgSettings.open) return;

  // 输入框里空格就是空格;按钮/链接上空格是浏览器原生的「激活」,交给它,别按两次
  const t = event.target;
  if (t instanceof HTMLElement) {
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return;
    if (t.isContentEditable) return;
  }

  event.preventDefault(); // 空格默认会翻页
  if (isRunning(session)) el.btnPause.click();
  else el.btnStart.click();
});

/* ------------------------------------------------------------------ *
 * 页面可见性:切回前台时重新对齐动画与倒计时
 * ------------------------------------------------------------------ */

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!isRunning(session) || session.paused) return;
  syncCircleToRemaining(session);
  renderTrain();
});

/* ------------------------------------------------------------------ *
 * 全站计数:「此刻多少人在做」+「总访问」(自建 Cloudflare Worker)
 * 隐私:不引任何第三方统计;只把随机访客 ID 与访问计数发往自己的 worker。
 * ------------------------------------------------------------------ */

// 部署 worker 后把地址填这里(见 worker/README.md),例:'https://tigang-counter.xxx.workers.dev'。
// 留空 = 关闭全站计数(顶栏那行安静显示「–」);离线时同样降级为「–」,不影响任何现有功能。
const COUNTER_ORIGIN = '';
const COUNTER_HEARTBEAT_MS = 10000;

// 本地预览(localhost / 私网 / file://)不污染全站计数,但仍连 WS 看实时数
const LOCAL_HOST_RE =
  /^(localhost|0\.0\.0\.0|\[?::1\]?|(127|10)\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|.+\.(local|localhost))$/;
const IS_LOCAL = location.protocol === 'file:' || LOCAL_HOST_RE.test(location.hostname);
const COUNTER_VID_KEY = 'tigang_visitor_id';

const counter = {
  ws: null,
  retry: 0,
  training: false,
  visitSent: false,
  visitorId: '',
  heartbeatTimer: null,
  reconnectTimer: null,

  init() {
    if (!COUNTER_ORIGIN) return; // 未部署:直接关闭计数
    try {
      this.visitorId = localStorage.getItem(COUNTER_VID_KEY) || '';
      if (!this.visitorId) {
        this.visitorId = crypto.randomUUID
          ? crypto.randomUUID()
          : Date.now().toString(36) + Math.random().toString(36).slice(2);
        localStorage.setItem(COUNTER_VID_KEY, this.visitorId);
      }
    } catch {
      this.visitorId = ''; // 无痕模式等:仍可看数,只是不参与访客计数
    }

    if (!IS_LOCAL) this.reportVisit();
    this.fetchStats(); // 先拉一次初始值,WS 未通时也有数
    this.connect();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.closeWS(); // 后台不占连接
      else {
        this.fetchStats();
        this.connect();
      }
    });
    window.addEventListener('pagehide', () => this.closeWS());
    // bfcache 恢复回来时 visibilitychange 不触发,这里兜底重连
    window.addEventListener('pageshow', () => {
      if (!document.hidden) {
        this.fetchStats();
        this.connect();
      }
    });
  },

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        /* 忽略 */
      }
    }
  },

  async reportVisit() {
    if (this.visitSent) return;
    this.visitSent = true;
    try {
      await fetch(`${COUNTER_ORIGIN}/visit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: this.visitorId }),
        keepalive: true,
      });
    } catch {
      /* 离线 / 未部署 → 静默 */
    }
  },

  async fetchStats() {
    try {
      const res = await fetch(`${COUNTER_ORIGIN}/stats`);
      if (res.ok) renderCounter(await res.json());
    } catch {
      /* 静默 */
    }
  },

  connect() {
    if (document.hidden || this.ws) return;
    let sock;
    try {
      sock = new WebSocket(`${COUNTER_ORIGIN.replace(/^http/, 'ws')}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = sock;

    sock.addEventListener('open', () => {
      this.retry = 0;
      sock.send(JSON.stringify({ type: 'hello', visitorId: this.visitorId }));
      if (this.training) sock.send(JSON.stringify({ type: 'training', on: true }));
      this.startHeartbeat();
    });
    sock.addEventListener('message', (event) => {
      try {
        const m = JSON.parse(event.data);
        if (m.type === 'stats') renderCounter(m);
      } catch {
        /* 忽略坏帧 */
      }
    });
    sock.addEventListener('close', () => {
      this.ws = null;
      this.stopHeartbeat();
      if (!document.hidden) this.scheduleReconnect();
    });
    sock.addEventListener('error', () => {
      try {
        sock.close();
      } catch {
        /* 已关闭 */
      }
    });
  },

  closeWS() {
    this.stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* 忽略 */
      }
      this.ws = null;
    }
  },

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** this.retry));
    this.retry += 1;
  },

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ type: 'ping' }), COUNTER_HEARTBEAT_MS);
  },

  stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  },
};

/** 训练状态变化 → 上报「在做」标记(服务端据此统计此刻多少人真在练)。暂停不算在做。 */
function syncTrainingFlag() {
  const doing = isRunning(session) && !session.paused;
  if (doing === counter.training) return;
  counter.training = doing;
  counter.send({ type: 'training', on: doing });
}

function renderCounter(m) {
  if (el.stDoing && typeof m.doing === 'number') el.stDoing.textContent = m.doing.toLocaleString('zh-Hans-CN');
  if (el.stVisits && typeof m.visits === 'number') el.stVisits.textContent = m.visits.toLocaleString('zh-Hans-CN');
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

setPlanOpen(false);
renderPresetForm();
renderSettingsForm();
enterPhaseVisual(session);
renderPlanSummary();
renderStats();   // 先算统计:renderTrain 空闲态那行要用 idleHintText
renderTrain();
scheduleReminder();
counter.init();  // 全站计数:此刻在做人数 + 总访问

/* ------------------------------------------------------------------ *
 * Service Worker(http:// 或不支持时静默失败)
 * ------------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    } catch {
      /* 忽略 */
    }
  });
}

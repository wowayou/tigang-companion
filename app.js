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
import { encryptBlob, decryptBlob, mergeForSync, newUserId } from './core/sync.js';
import { syncPull, syncPush } from './sync/client.mjs';

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
  btnShare: $('btn-share'),
  dlgShare: $('dlg-share'),
  shareImg: $('share-img'),
  btnSaveShare: $('btn-save-share'),
  btnShareClose: $('btn-share-close'),

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
  optSoftCue: $('opt-soft-cue'),
  optVoice: $('opt-voice'),
  optVibration: $('opt-vibration'),
  optReminderEnabled: $('opt-reminder-enabled'),
  optReminderTime: $('opt-reminder-time'),
  optSyncEnabled: $('opt-sync-enabled'),
  optSyncMaster: $('opt-sync-master'),
  btnSyncNow: $('btn-sync-now'),
  syncLast: $('sync-last'),
  syncState: $('sync-state'),
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

// 多端同步后端地址(自建甲骨文,sync-server/)。与计数 Worker(COUNTER_ORIGIN)解耦:不同址不同服务。
// 换后端(未来若回 Worker / 本地开发)只改这一行,端到端加密不变。
const SYNC_ORIGIN = 'https://sync.eigentime.org';
const SYNC_USER_KEY = 'tigang_sync_user'; // userId 独立 key,明文可接受——泄露只意味着别人可覆盖密文,无主密码解不开,本地可重推恢复
const SYNC_PASS_KEY = 'tigang_sync_pass'; // 主密码会话级缓存(sessionStorage):tab 内刷新不丢,关 tab 丢;不进 localStorage(隐私基调,见 §6.z)
const SYNC_PUSH_DEBOUNCE_MS = 2000; // persist() 后防抖推
// 设置弹窗「同步」组容器(无新 id,class 选择):开关关时整组 hidden 收起
const syncSetupWrap = document.querySelector('.sync-setup');

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
// 最近一次完成的训练,供「分享今天的成果」画卡片用(reps / streak / 日期)
let shareData = null;
// 同步状态(单元 3):主密码只在内存 + sessionStorage(tab 内刷新不丢,关 tab / PWA 新会话丢=降级重输),绝不进 localStorage
let syncMasterPass = '';
let syncUserId = ''; // 首次启用时 newUserId() 生成,存 localStorage 独立 key(不进 settings/exportJSON)
let syncPushTimer = null;
let syncLastAt = null; // 上次成功同步的毫秒时间戳
let syncRemoteEmpty = false; // 远端返回过 'none'=首次/远端暂无数据,据此跳过 pull 直接推(见 syncNow)

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
  // 数据变了 → 防抖 2s 推一次同步(离线/未启用/无主密码时内部跳过)
  scheduleSyncPush();
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

function beep(freq, ms = 150, delaySec = 0, peak = 0.05) {
  if (!audioCtx || !data.settings.sound) return;
  try {
    const t0 = audioCtx.currentTime + delaySec;
    const dur = ms / 1000;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.012);
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
 * 阶段内的轻提示(R2/R3)。
 * 反馈:准备阶段只有进入时那一声、休息阶段全程静默 —— 根因都是 cueFor 只在阶段边界响一次,
 * 阶段内部没有任何声音通道。这里补上一条,音量刻意比阶段提示音轻一个数量级
 * (peak 0.012 vs 0.05),只当「秒针 / 呼吸拍」用,不跟提示音的方向性设计(见 TONES)抢辨识度。
 *
 * - `prepare`:每秒一声 587Hz(与 TONES.prepare 同族),听起来就是在倒数。
 * - `rest`:**不**每秒响 —— 30 秒休息响 30 下与「轻柔」相反。改成 4 秒吸 / 4 秒呼的呼吸节律,
 *   每个半周期开头一声(吸 392Hz、呼 330Hz);最后 3 秒切成 440Hz 每秒倒数,预告要开始了。
 * - contract/hold/relax 不加:用力阶段每秒响会盖掉「上行/平音/下行」的方向感,反而更吵。
 *
 * 回调签名 (secLeft, durationSec) → 是否发声由函数自己决定(返回值不用,静默即不响)。
 */
const BREATH_HALF_SEC = 4;   // 呼吸半周期:4 秒吸、4 秒呼
const REST_COUNTDOWN_SEC = 3; // 休息末段改成每秒倒数的秒数

const PHASE_TICKS = {
  prepare: () => { beep(587, 55, 0, 0.012); },
  rest: (secLeft, durationSec) => {
    if (secLeft <= REST_COUNTDOWN_SEC) {
      beep(440, 70, 0, 0.012);
      return;
    }
    // 用「已过秒数」定呼吸相位,休息时长长短都能对齐到进入休息那一刻
    const elapsed = Math.max(0, Math.round(durationSec - secLeft));
    const posInCycle = elapsed % (BREATH_HALF_SEC * 2);
    if (posInCycle === 0) beep(392, 240, 0, 0.012);              // 吸
    else if (posInCycle === BREATH_HALF_SEC) beep(330, 240, 0, 0.012); // 呼
  },
};

// 上一次播过节拍的「阶段内剩余整秒数」;null = 本阶段还没播过/不该播。
// 存剩余秒数而不是计数器,是为了让暂停、后台切回、阶段边界都能靠「值变了才响」自然收敛:
// 回前台时剩余秒数直接跳到新值,只响一声,不会把落后的拍子补齐成一串。
let lastTickSecLeft = null;

/** 阶段切换时重新播种:进入瞬间那声由 cueFor 负责,节拍从下一整秒才开始。 */
function seedPhaseTick(state) {
  if (!isRunning(state) || state.paused || !PHASE_TICKS[state.phase]) {
    lastTickSecLeft = null;
    return;
  }
  lastTickSecLeft = Math.ceil(remainingInPhaseMs(state, Date.now()) / 1000);
}

/**
 * 每个渲染帧调一次:阶段内剩余整秒数变化时播一声轻 tick。
 * 只在 sound 开 + 设置里开了节拍 + 当前阶段有节拍定义时发声。
 */
function maybePhaseTick(state) {
  const tickFn = PHASE_TICKS[state.phase];
  if (!tickFn || !isRunning(state) || state.paused || !data.settings.softCue) {
    lastTickSecLeft = null;
    return;
  }
  const secLeft = Math.ceil(remainingInPhaseMs(state, Date.now()) / 1000);
  if (secLeft === lastTickSecLeft) return;
  lastTickSecLeft = secLeft;
  // 剩 0 秒那声不响:紧接着就是阶段切换的提示音,两声叠在一起听着像重音
  if (secLeft <= 0) return;
  tickFn(secLeft, phaseDurationSec(state.config, state.phase));
}

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
  el.optSoftCue.checked = !!data.settings.softCue;
  // 轻提示是提示音的子集:总开关关了,这一项没有意义
  el.optSoftCue.disabled = !data.settings.sound;
  el.optVoice.checked = !!data.settings.voice;
  el.optVibration.checked = !!data.settings.vibration;
  el.optReminderEnabled.checked = !!data.settings.reminder.enabled;
  el.optReminderTime.value = data.settings.reminder.time || '21:00';
  // 同步:开关回填;主密码/按钮/状态组按开关 hidden 收起;主密码从会话级缓存回填(sessionStorage,见 §6.z)
  el.optSyncEnabled.checked = syncEnabled();
  if (syncSetupWrap) syncSetupWrap.hidden = !syncEnabled();
  if (el.optSyncMaster) el.optSyncMaster.value = syncMasterPass;
  updateSyncButtonLabel();
  if (el.syncLast) el.syncLast.textContent = syncLastAt ? formatSyncTime(syncLastAt) : '—';
  if (el.syncState && !el.syncState.textContent) {
    el.syncState.textContent = '—';
    el.syncState.classList.remove('sync-ok', 'sync-err', 'sync-busy');
  }
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
      // 进入瞬间那声归 cueFor;节拍从下一整秒起,免得两声叠在一起
      seedPhaseTick(next);
      enterPhaseVisual(next);
      if (next.phase === 'done') {
        stopLoop();
        finishSession();
      }
    }
  }

  maybePhaseTick(session);
  renderTrain();
}

function writeRecord(state, finished) {
  const record = makeRecord({
    dateStr: localDateStr(new Date()),
    completedReps: state.completedReps,
    totalReps: state.config.sets * state.config.repsPerSet,
    durationSec: Math.round((Date.now() - state.startedAt) / 1000),
    finished,
    ts: Date.now(), // 同步 LWW 用的写入时刻(只在胶水层注入,core 不调 Date.now)
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
  shareData = { reps: record.completedReps, streak: ev.metrics.streak, dateStr: today };

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
  lastTickSecLeft = null;
  el.donePanel.hidden = true;
  enterPhaseVisual(session);
  renderPlanSummary();
  renderTrain();
  syncTrainingFlag();
}

/* ------------------------------------------------------------------ *
 * 训练成果分享卡(N1:完成面板「分享」)
 * 纯内存 canvas 绘制,不引入任何新依赖;画完转 PNG 走系统分享或预览保存。
 * ------------------------------------------------------------------ */

const SHARE_CARD_W = 1080;
const SHARE_CARD_H = 1440;
const CARD_FONT =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

/** 画成果卡(1080×1440,品牌 teal 底 + 同心圆环 + 今日次数 + 连续天数)。 */
async function drawShareCard() {
  try {
    await document.fonts.ready; // 等系统字体就绪,数字用粗体才不会回退成默认
  } catch {
    /* 旧浏览器没有 document.fonts,用默认字体继续 */
  }
  const canvas = document.createElement('canvas');
  canvas.width = SHARE_CARD_W;
  canvas.height = SHARE_CARD_H;
  const ctx = canvas.getContext('2d');
  const cx = SHARE_CARD_W / 2;

  // 背景:品牌 teal 渐变
  const grad = ctx.createLinearGradient(0, 0, 0, SHARE_CARD_H);
  grad.addColorStop(0, '#0b7d73');
  grad.addColorStop(1, '#0f9b8e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);

  // 顶部同心圆环(呼应应用图标的三层收缩示意)
  ctx.strokeStyle = 'rgba(255,255,255,.30)';
  ctx.lineWidth = 8;
  for (const r of [58, 96, 134]) {
    ctx.beginPath();
    ctx.arc(cx, 200, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(cx, 200, 30, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = `600 54px ${CARD_FONT}`;
  ctx.fillText('提肛陪伴 · KegelMate', cx, 410);
  ctx.fillStyle = 'rgba(255,255,255,.58)';
  ctx.font = `400 32px ${CARD_FONT}`;
  ctx.fillText('每天两分钟,把盆底肌练成肌肉记忆', cx, 478);

  // 主数字:「今日收缩 X 次」,数字粗、单位小
  const reps = shareData ? shareData.reps : 0;
  const numStr = String(reps);
  const baseY = 940;
  ctx.textAlign = 'left';
  ctx.font = `800 300px ${CARD_FONT}`;
  const numW = ctx.measureText(numStr).width;
  ctx.font = `600 92px ${CARD_FONT}`;
  const unitW = ctx.measureText('次').width;
  const gap = 30;
  const totalW = numW + gap + unitW;
  const left = cx - totalW / 2;
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.font = `400 42px ${CARD_FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('今日收缩', cx, 660);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 300px ${CARD_FONT}`;
  ctx.fillText(numStr, left, baseY);
  ctx.font = `600 92px ${CARD_FONT}`;
  ctx.fillText('次', left + numW + gap, baseY);

  // 连续天数:全局唯一的暖调,和站内火苗一致
  const streak = shareData ? shareData.streak : 0;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd9a8';
  ctx.font = `700 64px ${CARD_FONT}`;
  ctx.fillText(`连续打卡 ${streak} 天`, cx, 1140);

  // 底部:诚实文案 + 日期
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.font = `500 36px ${CARD_FONT}`;
  ctx.fillText('免费 · 无广告 · 数据只在本地', cx, 1300);
  ctx.fillStyle = 'rgba(255,255,255,.45)';
  ctx.font = `400 30px ${CARD_FONT}`;
  ctx.fillText(shareData ? shareData.dateStr : '', cx, 1368);

  return canvas;
}

/** 分享按钮:能分享文件就走系统分享,否则弹预览(长按保存 / 下载)。 */
el.btnShare.addEventListener('click', async () => {
  if (!shareData) return;
  try {
    const blob = await new Promise((resolve, reject) => {
      drawShareCard().then((canvas) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), 'image/png');
      }, reject);
    });
    const file = new File([blob], 'kegel-card.png', { type: 'image/png' });
    // Android Chrome 等支持分享文件 → 直接调起系统分享(用户手势内,优先走这里)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: '提肛陪伴 · 今日成果',
          text: `今天我完成了 ${shareData.reps} 次凯格尔训练,连续第 ${shareData.streak} 天!`,
        });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // 用户取消,什么都不做
        // 其它失败(如没有可分享的应用)→ 落到下面的预览
      }
    }
    // 降级:iOS Safari 不支持分享文件 → 预览卡片,长按保存 / 「保存图片」下载
    el.shareImg.src = URL.createObjectURL(blob);
    if (typeof el.dlgShare.showModal === 'function') el.dlgShare.showModal();
  } catch {
    /* 静默:分享失败不影响训练本身 */
  }
});

el.btnSaveShare.addEventListener('click', () => {
  if (!el.shareImg.src) return;
  const a = document.createElement('a');
  a.href = el.shareImg.src;
  a.download = 'kegel-card.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

el.btnShareClose.addEventListener('click', () => {
  if (typeof el.dlgShare.close === 'function') el.dlgShare.close();
  if (el.shareImg.src) {
    URL.revokeObjectURL(el.shareImg.src);
    el.shareImg.src = '';
  }
});

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
  seedPhaseTick(session);
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
    seedPhaseTick(session);
    startLoop();
  } else {
    session = pause(session, now);
    if (session.paused) {
      stopLoop();
      stopSpeaking();
      lastTickSecLeft = null;
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
  // 主密码不落盘,但会话级缓存(sessionStorage)会回填到输入框;真正清空只发生在「关同步/主动清空」
  if (typeof el.dlgSettings.showModal === 'function') el.dlgSettings.showModal();
  else el.dlgSettings.setAttribute('open', '');
});

el.optSound.addEventListener('change', () => {
  data.settings.sound = el.optSound.checked;
  persist();
});

el.optSoftCue.addEventListener('change', () => {
  data.settings.softCue = el.optSoftCue.checked;
  persist();
  // 训练中改开关:重新播种,免得刚打开就立刻补一声
  seedPhaseTick(session);
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

/* 同步开关:只改 settings.sync.enabled(主密码/userId 都不进 settings)。开=展开主密码组并聚焦;关=清主密码(内存 + sessionStorage)。 */
el.optSyncEnabled.addEventListener('change', () => {
  data.settings.sync.enabled = el.optSyncEnabled.checked;
  if (el.optSyncEnabled.checked) {
    persist();
    renderSettingsForm();
    // 首次启用引导:主密码组已展开,直接聚焦等待输入
    el.optSyncMaster.focus();
  } else {
    // 关闭同步:主密码内存态 + sessionStorage 一并清空,状态复位,不再自动同步
    clearSyncPass();
    syncRemoteEmpty = false;
    syncNowState('—');
    persist();
    renderSettingsForm();
  }
});

/* 主密码:进内存 + sessionStorage(会话级缓存,输入即写;不进 localStorage/后端)。同步由「同步」按钮触发(避免输完自动同步又点按钮撞限流)。 */
el.optSyncMaster.addEventListener('input', () => {
  syncMasterPass = el.optSyncMaster.value;
  saveSyncPass(syncMasterPass);
  updateSyncButtonLabel();
});

el.optSyncMaster.addEventListener('change', () => {
  syncMasterPass = el.optSyncMaster.value;
  saveSyncPass(syncMasterPass);
  updateSyncButtonLabel();
  if (syncMasterPass) {
    syncNowState(syncEnabled() ? '主密码已记录,点「同步」按钮开始' : '已记录主密码,启用同步后生效');
  } else {
    syncNowState('请先输入主密码');
  }
});

el.btnSyncNow.addEventListener('click', () => {
  syncNow();
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
  // 后台期间秒数已经跳过好几拍,重新播种,免得切回来先补响一声不对位的 tick
  seedPhaseTick(session);
  renderTrain();
});

/* ------------------------------------------------------------------ *
 * 全站计数:「此刻多少人在做」+「总访问」(自建 Cloudflare Worker)
 * 隐私:不引任何第三方统计;只把随机访客 ID 与访问计数发往自己的 worker。
 * ------------------------------------------------------------------ */

// 全站计数服务地址(自建 Cloudflare Worker,见 worker/README.md)。
// 留空 = 关闭全站计数(顶栏那行安静显示「–」);离线时同样降级为「–」,不影响任何现有功能。
const COUNTER_ORIGIN = 'https://tigang-counter.eigentime.workers.dev';
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
 * 多端同步(可选 · 端到端加密,自建后端 sync-server/)
 * 主密码只进内存,不落盘;后端只见密文。任何一步失败都静默降级纯本地。
 * 「不同主密码 → 解密失败 → 本地不受影响」是端到端加密的正确表现,不是 bug。
 * ------------------------------------------------------------------ */

function syncEnabled() {
  return !!data.settings.sync && !!data.settings.sync.enabled;
}

/** 状态行:文案 + 状态色(sync-ok 成功绿 / sync-err 失败橙 / sync-busy 进行中灰)。 */
function syncNowState(text, cls) {
  if (!el.syncState) return;
  el.syncState.textContent = text || '—';
  el.syncState.classList.remove('sync-ok', 'sync-err', 'sync-busy');
  if (cls) el.syncState.classList.add(cls);
}

/* 主密码会话级缓存:sessionStorage(tab 内刷新不丢,关 tab / PWA 新会话丢=降级重输,不崩)。
 * 不进 localStorage、不进 settings/exportJSON —— 与 userId(localStorage 明文)同风险等级的诚实取舍,见 DEVELOPMENT.md D31。 */
function saveSyncPass(pass) {
  try {
    if (pass) sessionStorage.setItem(SYNC_PASS_KEY, pass);
    else sessionStorage.removeItem(SYNC_PASS_KEY);
  } catch {
    /* 隐私模式等不可用:静默,回到每会话输一次 */
  }
}

function restoreSyncPass() {
  try {
    syncMasterPass = sessionStorage.getItem(SYNC_PASS_KEY) || '';
  } catch {
    syncMasterPass = '';
  }
}

function clearSyncPass() {
  syncMasterPass = '';
  saveSyncPass('');
}

/** 首次启用引导:远端确认无数据(none)且主密码已输时,按钮文案改「首次同步(上传本机数据)」。 */
function updateSyncButtonLabel() {
  if (!el.btnSyncNow) return;
  const firstTime = syncEnabled() && !!el.optSyncMaster.value && syncRemoteEmpty;
  el.btnSyncNow.textContent = firstTime ? '首次同步(上传本机数据)' : '立即同步';
}

function formatSyncTime(t) {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function updateSyncLast() {
  syncLastAt = Date.now();
  if (el.syncLast) el.syncLast.textContent = formatSyncTime(syncLastAt);
}

/** userId 独立 key(不进 settings/exportJSON);首次启用时生成。 */
function ensureSyncUserId() {
  if (syncUserId) return;
  try {
    syncUserId = localStorage.getItem(SYNC_USER_KEY) || '';
    if (!syncUserId) {
      syncUserId = newUserId();
      localStorage.setItem(SYNC_USER_KEY, syncUserId);
    }
  } catch {
    syncUserId = ''; // 无痕等:同步不可用,静默
  }
}

/** 拉远端 → 解密 → 合并(只合记录,设置保留本机)→ save → renderStats。 */
async function doSyncPull() {
  if (!syncMasterPass) return;
  try {
    ensureSyncUserId();
    if (!syncUserId) return;
    const result = await syncPull(SYNC_ORIGIN, syncUserId);
    if (!result.ok) {
      if (result.error === 'none') {
        // 远端无数据=首次:记标志,后续 syncNow 据此跳过 pull 直接推
        syncRemoteEmpty = true;
        syncNowState('首次同步,等待推送');
        updateSyncLast();
        updateSyncButtonLabel();
        return;
      }
      if (result.error === 'network') syncNowState('连接失败,检查网络', 'sync-err');
      else syncNowState('拉取失败', 'sync-err');
      return;
    }
    syncRemoteEmpty = false;
    const decrypted = await decryptBlob(result.blob, syncMasterPass);
    if (!decrypted.ok) {
      // 主密码不对 / 密文损坏(可能被覆盖):静默降级,本地数据不丢,可重推恢复
      syncNowState('解密失败(主密码不符或远端数据损坏)', 'sync-err');
      return;
    }
    const remoteRecords = (decrypted.data && decrypted.data.records) || [];
    const { merged, conflicts } = mergeForSync(data.records, remoteRecords);
    data.records = merged;
    persist();
    renderStats();
    updateSyncLast();
    updateSyncButtonLabel();
    syncNowState(conflicts > 0 ? `已合并(冲突 ${conflicts} 条按最新覆盖)` : '已同步', 'sync-ok');
  } catch {
    syncNowState('同步失败', 'sync-err');
  }
}

/** 本地 → 加密 → 推远端。 */
async function doSyncPush() {
  if (!syncMasterPass) return;
  try {
    ensureSyncUserId();
    if (!syncUserId) return;
    const blob = await encryptBlob({ records: data.records, settings: data.settings }, syncMasterPass);
    const result = await syncPush(SYNC_ORIGIN, syncUserId, blob);
    if (result.ok) {
      const wasFirst = syncRemoteEmpty; // 首次推送(远端此前无数据)→ 成功时给引导反馈
      syncRemoteEmpty = false;
      updateSyncLast();
      updateSyncButtonLabel();
      if (wasFirst) syncNowState('已开启同步 · 本机数据已上传', 'sync-ok');
    } else if (result.error === 'rate') {
      syncNowState('推送过频,稍后再试', 'sync-err');
    } else if (result.error === 'too-big') {
      syncNowState('数据过大,无法同步', 'sync-err');
    } else {
      syncNowState('推送失败', 'sync-err');
    }
  } catch {
    syncNowState('推送失败', 'sync-err');
  }
}

/** persist() 后防抖 2s 推;离线 / 未启用 / 无主密码一律跳过。 */
function scheduleSyncPush() {
  if (!syncEnabled() || !syncMasterPass || !navigator.onLine) return;
  if (syncPushTimer !== null) clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    syncPushTimer = null;
    doSyncPush();
  }, SYNC_PUSH_DEBOUNCE_MS);
}

/** 「立即同步」:先拉后推(合并后把结果推回去);首次(远端确认过 none)跳过 pull 直接推。 */
async function syncNow() {
  if (!syncEnabled()) {
    syncNowState('未启用同步');
    return;
  }
  if (!syncMasterPass) {
    syncNowState('请先输入主密码');
    return;
  }
  if (!navigator.onLine) {
    syncNowState('离线,跳过');
    return;
  }
  if (syncPushTimer !== null) {
    clearTimeout(syncPushTimer);
    syncPushTimer = null;
  }
  syncNowState('同步中…', 'sync-busy');
  // 首次(远端返回过 none)→ 纯推,不 pull;否则先拉后推
  if (!syncRemoteEmpty) {
    await doSyncPull();
    // doSyncPull 内部 persist() 会再排一个 debounce 推;这里立即推,把那个定时器清掉,避免 10s 内二次 PUT 撞限流
    if (syncPushTimer !== null) {
      clearTimeout(syncPushTimer);
      syncPushTimer = null;
    }
  }
  await doSyncPush();
}

/** 打开应用时:若启用且主密码可用(本会话输入或 sessionStorage 回填)则后台拉一次。新会话无缓存=降级重输,不崩。 */
function syncOnOpen() {
  if (!syncEnabled() || !syncMasterPass || !navigator.onLine) return;
  doSyncPull();
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
restoreSyncPass(); // 主密码会话级缓存回填(tab 内刷新不丢;新会话丢=降级到设置里输一次)
syncOnOpen();    // 多端同步:启用且主密码可用(sessionStorage 回填)才拉

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

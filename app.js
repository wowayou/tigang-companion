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
import { load, save, clearAll, exportJSON } from './core/storage.js';

/* ------------------------------------------------------------------ *
 * DOM 引用
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const el = {
  btnSettings: $('btn-settings'),

  tabTrain: $('tab-train'),
  tabStats: $('tab-stats'),
  tabKnowledge: $('tab-knowledge'),
  panelTrain: $('panel-train'),
  panelStats: $('panel-stats'),
  panelKnowledge: $('panel-knowledge'),

  customPanel: $('custom-panel'),
  cfgContract: $('cfg-contract'),
  cfgRelax: $('cfg-relax'),
  cfgReps: $('cfg-reps'),
  cfgSets: $('cfg-sets'),
  cfgRest: $('cfg-rest'),
  planSummary: $('plan-summary'),

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
  doneStreak: $('done-streak'),

  streakNum: $('streak-num'),
  statDays: $('stat-days'),
  statSessions: $('stat-sessions'),
  statReps: $('stat-reps'),
  statDuration: $('stat-duration'),
  heatmap: $('heatmap'),
  btnExport: $('btn-export'),
  btnClear: $('btn-clear'),

  dlgSettings: $('dlg-settings'),
  optSound: $('opt-sound'),
  optVibration: $('opt-vibration'),
  optReminderEnabled: $('opt-reminder-enabled'),
  optReminderTime: $('opt-reminder-time'),
};

const presetRadios = Array.from(document.querySelectorAll('input[name="preset"]'));
const customInputs = [el.cfgContract, el.cfgRelax, el.cfgReps, el.cfgSets, el.cfgRest];

const PHASE_LABEL = {
  idle: '待开始',
  prepare: '准备',
  contract: '收缩',
  relax: '放松',
  rest: '休息',
  done: '完成',
};

const TICK_MS = 100;
const HEATMAP_DAYS = 35;

/* ------------------------------------------------------------------ *
 * 运行时状态
 * ------------------------------------------------------------------ */

let data = load();
let session = createSession(resolveConfig());
let timerId = null;
let audioCtx = null;
let wakeLock = null;
let reminderTimer = null;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function resolveConfig() {
  const key = data.settings.presetKey;
  if (key === 'custom') return { ...data.settings.custom };
  const preset = PRESETS[key] || PRESETS.standard;
  return {
    contractSec: preset.contractSec,
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

function cueFor(phase) {
  if (phase === 'contract') {
    beep(880, 150);
    vibrate([100]);
  } else if (phase === 'relax') {
    beep(523, 150);
    vibrate([50]);
  } else if (phase === 'rest') {
    beep(392, 150);
  } else if (phase === 'done') {
    beep(523, 150, 0);
    beep(659, 150, 0.18);
    beep(880, 220, 0.36);
    vibrate([80, 60, 80]);
  }
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

function targetScale(phase) {
  return phase === 'contract' ? 0.62 : 1;
}

/** 进入某阶段:transitionDuration = 该阶段(剩余)秒数,收缩缩到 0.62。 */
function animateCircle(phase, durationSec) {
  const circle = el.coachCircle;
  circle.dataset.phase = phase;
  circle.classList.toggle('is-pulsing', phase === 'prepare' || phase === 'rest');
  circle.classList.remove('is-paused');
  circle.style.transitionDuration = `${Math.max(0, durationSec)}s`;
  circle.style.transform = `scale(${targetScale(phase)})`;
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
  circle.style.transitionDuration = '0s';
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
  const total = totalDurationSec(c);
  el.planSummary.textContent =
    `收缩 ${c.contractSec}s · 放松 ${c.relaxSec}s · ${c.repsPerSet} 次 × ${c.sets} 组` +
    `${c.restSec > 0 ? ` · 组间休息 ${c.restSec}s` : ''} · 全程约 ${formatDuration(total)}`;
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

  el.setProgress.textContent =
    s.phase === 'rest'
      ? `休息中 · 即将开始第 ${s.setIndex + 1} 组`
      : `第 ${s.setIndex + 1}/${c.sets} 组 · 第 ${s.repIndex + 1}/${c.repsPerSet} 次`;

  const pct = Math.min(100, Math.max(0, overallProgress(s, now) * 100));
  el.overallBar.style.width = `${pct.toFixed(2)}%`;

  const running = isRunning(s);
  el.btnStart.disabled = running;
  el.btnStart.textContent = s.phase === 'done' ? '再来一次' : '开始训练';
  el.btnPause.disabled = !running;
  el.btnPause.textContent = s.paused ? '继续' : '暂停';
  el.btnStop.disabled = !running;

  presetRadios.forEach((r) => { r.disabled = running; });
  customInputs.forEach((i) => { i.disabled = running; });
}

function renderStats() {
  const today = localDateStr(new Date());
  const t = totals(data.records);

  el.streakNum.textContent = String(computeStreak(data.records, today));
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

function renderSettingsForm() {
  el.optSound.checked = !!data.settings.sound;
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
  const record = writeRecord(session, true);
  el.doneReps.textContent = String(record.completedReps);
  el.doneDuration.textContent = formatDuration(record.durationSec);
  el.doneStreak.textContent = String(computeStreak(data.records, localDateStr(new Date())));
  el.donePanel.hidden = false;
}

function resetSession() {
  stopLoop();
  releaseWakeLock();
  session = createSession(resolveConfig());
  el.donePanel.hidden = true;
  enterPhaseVisual(session);
  renderPlanSummary();
  renderTrain();
}

/* ------------------------------------------------------------------ *
 * 事件:训练控制
 * ------------------------------------------------------------------ */

el.btnStart.addEventListener('click', () => {
  // 自动播放限制:AudioContext 必须在这个点击处理器里创建/resume。
  ensureAudioContext();

  if (session.phase === 'done') {
    session = reset(session);
    el.donePanel.hidden = true;
  }
  if (session.phase !== 'idle') return;

  session = start(session, Date.now());
  cueFor(session.phase);
  enterPhaseVisual(session);
  requestWakeLock();
  startLoop();
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
      freezeCircle();
    }
  }
  renderTrain();
});

el.btnStop.addEventListener('click', () => {
  if (!isRunning(session)) return;
  if (!window.confirm('确定结束本次训练?')) return;
  stopLoop();
  if (session.completedReps > 0) writeRecord(session, false);
  resetSession();
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
    data.settings.custom = validateConfig({
      contractSec: el.cfgContract.valueAsNumber,
      relaxSec: el.cfgRelax.valueAsNumber,
      repsPerSet: el.cfgReps.valueAsNumber,
      sets: el.cfgSets.valueAsNumber,
      restSec: el.cfgRest.valueAsNumber,
      prepareSec: data.settings.custom.prepareSec,
    });
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

el.btnExport.addEventListener('click', () => {
  const blob = new Blob([exportJSON(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tigang-data.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

el.btnClear.addEventListener('click', () => {
  if (!window.confirm('确定清除全部数据?打卡记录与设置都会被删除,且无法恢复。')) return;
  clearAll();
  data = load();
  renderPresetForm();
  renderSettingsForm();
  scheduleReminder();
  resetSession();
  renderStats();
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
 * 初始化
 * ------------------------------------------------------------------ */

renderPresetForm();
renderSettingsForm();
enterPhaseVisual(session);
renderPlanSummary();
renderTrain();
renderStats();
scheduleReminder();

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

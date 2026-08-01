// core/storage.js — localStorage 读写
// 约束:不访问 DOM;storage 由参数传入(默认 globalThis.localStorage),便于测试注入 fake。

export const STORAGE_KEY = 'tigang-companion.v1';

export const DEFAULT_SETTINGS = {
  presetKey: 'standard', // 'beginner'|'standard'|'advanced'|'quick'|'custom'
  custom: { contractSec: 5, relaxSec: 5, repsPerSet: 12, sets: 3, restSec: 30, prepareSec: 3 },
  sound: true,
  vibration: true,
  reminder: { enabled: false, time: '21:00' },
};

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultData() {
  return { records: [], settings: deepCopy(DEFAULT_SETTINGS) };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 与 DEFAULT_SETTINGS 浅合并 + reminder/custom 二级合并(旧数据升级后不丢新默认键)。 */
function mergeSettings(raw) {
  const base = deepCopy(DEFAULT_SETTINGS);
  if (!isPlainObject(raw)) return base;
  const merged = { ...base, ...raw };
  merged.custom = { ...base.custom, ...(isPlainObject(raw.custom) ? raw.custom : {}) };
  merged.reminder = { ...base.reminder, ...(isPlainObject(raw.reminder) ? raw.reminder : {}) };
  return merged;
}

/** 读取;任何异常/损坏 JSON → 全新默认值 { records: [], settings: <DEFAULT_SETTINGS 深拷贝> }。 */
export function load(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return defaultData();
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      settings: mergeSettings(parsed.settings),
    };
  } catch {
    return defaultData();
  }
}

/** 写入;成功 true,异常(如超配额)返回 false。 */
export function save(data, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** 清除全部数据;成功 true,异常 false。 */
export function clearAll(storage = globalThis.localStorage) {
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 导出为可读 JSON 文本。 */
export function exportJSON(data) {
  return JSON.stringify({ app: 'tigang-companion', version: 1, ...data }, null, 2);
}

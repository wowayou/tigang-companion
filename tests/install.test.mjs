import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTALL_THRESHOLD, installHintDecision } from '../core/install.js';

// 达标基准:完成次数到了阈值、未安装、未关闭
const base = { finishedSessions: INSTALL_THRESHOLD, ios: false, android: false, canPrompt: false };

test('阈值:完成次数不足不显示,恰好达到才显示', () => {
  for (const n of [0, 1, INSTALL_THRESHOLD - 1]) {
    assert.deepEqual(installHintDecision({ ...base, finishedSessions: n }), { show: false });
  }
  const d = installHintDecision({ ...base, ios: true });
  assert.equal(d.show, true);
});

test('阈值:非法次数(undefined / NaN / 负数 / 字符串)一律不显示', () => {
  for (const bad of [undefined, NaN, -1, '3', null]) {
    assert.deepEqual(installHintDecision({ ...base, finishedSessions: bad }), { show: false });
  }
});

test('已安装:即使达标也不显示(独立窗口运行 = 目的已达成)', () => {
  assert.deepEqual(installHintDecision({ ...base, installed: true }), { show: false });
});

test('已关闭:永久不显示,不做「过阵子再问」', () => {
  assert.deepEqual(installHintDecision({ ...base, dismissed: true }), { show: false });
});

test('变体:捕获 beforeinstallprompt 时优先一键安装(prompt)', () => {
  const d = installHintDecision({ ...base, canPrompt: true });
  assert.deepEqual(d, { show: true, variant: 'prompt' });
});

test('变体:iOS 没有 beforeinstallprompt,给手动步骤', () => {
  const d = installHintDecision({ ...base, ios: true });
  assert.deepEqual(d, { show: true, variant: 'ios' });
});

test('变体:Android 无安装事件时给手动步骤', () => {
  const d = installHintDecision({ ...base, android: true });
  assert.deepEqual(d, { show: true, variant: 'android' });
});

test('变体:桌面且无 beforeinstallprompt(装不了)不显示,不骚扰', () => {
  assert.deepEqual(installHintDecision(base), { show: false });
});

test('变体优先级:canPrompt 压过 ios/android 的手动步骤', () => {
  const d = installHintDecision({ ...base, canPrompt: true, ios: true, android: true });
  assert.deepEqual(d, { show: true, variant: 'prompt' });
});

test('installed / dismissed 优先于一切变体(装了或关了就闭嘴)', () => {
  assert.deepEqual(installHintDecision({ ...base, canPrompt: true, installed: true }), { show: false });
  assert.deepEqual(installHintDecision({ ...base, ios: true, dismissed: true }), { show: false });
});

test('无参调用安全返回不显示', () => {
  assert.deepEqual(installHintDecision(), { show: false });
});

test('契约:阈值为 3(ROADMAP N4 口径),且导出为常量', () => {
  assert.equal(INSTALL_THRESHOLD, 3);
});

// core/install.js — N4 安装引导的纯决策(何时显示、用哪种变体)
// 约束:不访问 DOM / Date.now() / localStorage;全部输入由调用方注入,便于测试与平台探测解耦。
//
// 触发口径:累计**完成**训练次数 ≥ INSTALL_THRESHOLD(STATS totals().finishedSessions),
// 不用「打开次数」——完成才是用过的诚实信号,且不用新开计数器。
// 「已安装」由调用方每次启动现检(display-mode / navigator.standalone),不持久化;
// 「已关闭」的持久化在 app.js 的设备本地 key,不进 settings(见 DEVELOPMENT.md D39)。

/** 完成多少次训练后开始给安装引导。 */
export const INSTALL_THRESHOLD = 3;

/**
 * 安装引导决策。
 * @param {object} input
 *   installed        当前以独立窗口运行(已装到主屏)
 *   dismissed        用户点过「不再提示」(本会话或持久层)
 *   finishedSessions 累计完成训练次数(totals(records).finishedSessions)
 *   ios              iOS 设备(无 beforeinstallprompt,只能给手动步骤)
 *   android          Android 设备(部分浏览器无 beforeinstallprompt,给手动步骤)
 *   canPrompt        已捕获 beforeinstallprompt,可以一键调起安装
 * @returns {{show:false} | {show:true, variant:'prompt'|'ios'|'android'}}
 */
export function installHintDecision({
  installed = false,
  dismissed = false,
  finishedSessions = 0,
  ios = false,
  android = false,
  canPrompt = false,
} = {}) {
  // 已安装 / 用户已拒绝:任何情况下都不再出现(拒绝是永久的,不做「过阵子再问」)
  if (installed || dismissed) return { show: false };
  // 次数不达标(含非法输入)不显示
  if (!(finishedSessions >= INSTALL_THRESHOLD)) return { show: false };
  // 变体优先级:能一键安装 > iOS 手动步骤 > Android 手动步骤;桌面无安装能力不骚扰
  if (canPrompt) return { show: true, variant: 'prompt' };
  if (ios) return { show: true, variant: 'ios' };
  if (android) return { show: true, variant: 'android' };
  return { show: false };
}

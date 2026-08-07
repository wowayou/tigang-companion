# 同步功能优化 — 增量规格(在已实现的同步基础上打磨)

> **历史增量规格。首次纯 push、`doSyncPush()` 与 10s 限流描述已被 `sync/coordinator.mjs` 的完整 pull→merge→push 流水线和 3s 限流替代;当前准据看 `SPEC.md §6.z` / `DEVELOPMENT.md D34`。**

> 同步功能已实现(5 单元,commit ff25fa4..ae60216)。本文件是增量优化,优化点基于"操作繁琐"反馈。
> 决策/验收归主会话,执行按本文件。增量改动,**单独 commit**。

## 现状诊断(为什么觉得繁琐)

用户开同步当前流程:
1. 设置→勾「启用同步」→ 2. 输主密码 → 3. 点「立即同步」→ 4. **关应用重开→主密码丢→又要进设置重输才能同步**。

最痛点=第 4 步:主密码纯内存态,每次重开应用都要重输,否则 `syncOnOpen()` 直接 return。
次痛点:UI 无首次引导,勾选后不知下一步;状态反馈不直观。

## 优化目标

**默认仍可选(opt-in,默认关不变)。开起来后少摩擦。** 三件事:
1. 主密码会话级缓存(不每次重开应用都丢)。
2. 首次启用引导流(勾选→自动聚焦主密码→提示→首次推送)。
3. UI 简化与状态直观化。

## 改动 1:主密码 sessionStorage 缓存(核心优化)

**现状**:主密码存模块变量 `syncMasterPass`,页面刷新/关闭即丢。
**改**:主密码输入后,同时写入 `sessionStorage`(键 `tigang_sync_pass`)。**sessionStorage 生命周期=浏览器 tab/会话**——同一 tab 内刷新不丢,关 tab 才丢。比每次重开都丢好得多,且不强求持久化(仍比 localStorage 短命,符合隐私基调)。

- `syncOnOpen()` 与各同步调用前,优先从 sessionStorage 恢复 `syncMasterPass`。
- 应用初始化时(`syncOnOpen` 前)尝试 `sessionStorage.getItem('tigang_sync_pass')` 回填。
- 用户主动改主密码 / 关闭同步 → 清 sessionStorage。
- **不进 localStorage、不进 settings/exportJSON**(凭据隔离不变)。
- **诚实权衡写进 D31 补充**:sessionStorage 仍可被同源 XSS 读。与 userId(localStorage 明文)同风险等级。要再短命只能每次输——当前选"会话级缓存活"是便利/安全的折中。文档写明。

> 注意:PWA 从主屏图标启动有时算新会话(sessionStorage 可能丢),这属可接受降级——丢=回到"进设置输一次"的老流程,不崩。不要为保 PWA 会话去碰 localStorage(会破坏隐私权衡)。

## 改动 2:首次启用引导流

勾选「启用同步」时:
- 自动展开主密码输入框 + 聚焦,placeholder 改"设一个主密码(加密钥匙,忘记则远端数据不可恢复)"。
- 主密码输入框非空时,「立即同步」按钮文案改「首次同步(上传本机数据)」,点击→首次 push(远端尚无数据,直接推,不 pull)。
- 首次推送成功后,状态显示「已开启同步 · 本机数据已上传」,并提示「在其它设备用相同主密码开启同步即可拉取」。

实现:`syncNow()` 已含先拉后推;首次(`sync.userId` 存在但远端返回 `none`)走纯推。可在 `doSyncPull` 收到 `none` 时设标志,`syncNow` 据此跳过 pull 直接 push。或更简:首次启用引导里直接调 `doSyncPush()`。

## 改动 3:UI 简化

设置弹窗「同步」分组当前样式照搬其它 opt-row。优化:
- 「启用同步」开关下方主密码/按钮/状态行**用 `hidden` 收起**,开关关时隐藏(减少干扰),开关开时展开。
- 状态行(`<span id="sync-state">`)用颜色区分:成功绿、失败橙、进行中灰。加 CSS class `sync-ok/sync-err/sync-busy`。
- 主密码输入框加 `type="password"` 已有;补 `autocomplete="new-password"`(避免浏览器填错)。
- 文案精简:顶部 hint 改一句「端到端加密 · 数据只存自建服务器 · 不想用随时关掉」。去掉冗长技术解释(挪到知识页或 keep it minimal)。

## 不改的(守住)

- **默认关**(opt-in 不变)——这是"可选功能"的本质。
- **端到端加密不变**——主密码仍不进 localStorage(只 sessionStorage),不上后端。
- **userId 仍 localStorage 明文独立 key**——不变。
- **限流/后端/合并逻辑不动**——纯 UI + 会话级缓存改动。
- **不动 core/sync.js**(纯函数,零改)。

## 验收闸门

- `npm test` 全绿(90,无新增 core 改动);`node --check` 全过;DOM id 数不变(复用现有 id)。
- 浏览器:勾启用→输主密码→首次同步上传→关 tab 重开→**主密码仍在(sessionStorage)**→自动 pull 成功(验证会话级缓存活)。
- 关 PWA 重开(新会话,sessionStorage 丢)→ 进设置输一次主密码 → 同步恢复(验证降级不崩)。
- 关闭同步→sessionStorage 清空→不再自动同步。
- 状态颜色:成功绿/失败橙/进行中灰 各出现一次。
- `git commit -m "feat: 同步体验优化——主密码会话级缓存 + 首次引导 + UI 简化(仍默认可选)"`

## 同步契约同步

- `SPEC.md §6.z`:补"主密码 sessionStorage 会话级缓存(tab 内刷新不丢,关 tab 丢;PWA 新会话丢=降级重输)"。
- `DEVELOPMENT.md D31`:补"主密码缓存策略=sessionStorage,权衡与降级"。
- `sw.js`:升 CACHE_NAME(v13→v14,因 app.js 改动需让用户拿到)。

---

# 附:部署后端到端测试清单(给用户/验收方)

后端部署到甲骨文后(SYNC-SPEC.md 部署前提 + sync-server/README 6 步做完),必测:

## A. 基础连通
1. `https://sync.eigentime.org/health` → `{ok:true}`。
2. 浏览器 devtools console:
   ```js
   fetch('https://sync.eigentime.org/health').then(r=>r.json()).then(console.log)
   ```
   返回 `{ok:true}` 且无 CORS 报错 → CORS 通(灰云直连 + nginx 头正确)。

## B. 同主密码端到端(核心证明)
1. 设备 A / 浏览器 A:设置→启用同步→输主密码 `test123`→首次同步(上传)。
2. 设备 B / 浏览器 B(无痕窗口):启用同步→输**相同** `test123`→立即同步。
3. 预期:B 拉到 A 的记录,合并无重复,A 和 B 记录一致。
4. B 练一次→同步→A 重开/立即同步→A 看到 B 的新记录。

## C. 不同主密码(端到端加密正确性证明)
1. 设备 C:启用同步→输**不同**主密码 `wrong`→立即同步。
2. 预期:解密失败 → 状态显示「解密失败」→ **本地数据完好无损** → 不崩溃。
3. 这条测通=端到端加密真的生效(后端拿到的密文用错主密码解不开)。

## D. 降级
1. F12 断网 → 打开应用 → 不报错,纯本地可用,同步状态显示「离线」或静默。
2. 断网时点「立即同步」→ 显示「离线,跳过」或「连接失败」,不卡死。
3. 恢复网络 → 立即同步 → 恢复正常。

## E. 限流
1. 一次同步完成后立即再点,3s 内二次 PUT → 状态显示「推送过频,稍后将重新拉取并重试…」(429)。
2. 约 4.5s 后自动 GET→PUT 成功;不得只重放旧 PUT。

## F. 会话级缓存(优化后)
1. 输主密码 → 刷新 tab → 主密码仍在 → 自动 pull。
2. 关 tab 重开 → 主密码丢 → 进设置重输 → 恢复。

全部通 = 可上线。

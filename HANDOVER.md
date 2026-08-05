# 交接说明(2026-08-05)

接手 agent 请先读 **CLAUDE.md**(约定/命令)、**SPEC.md**(契约,DOM id 表 70 个)、**DEVELOPMENT.md**(决策记录 D1–D29,尤其 **D28** 计数 Worker 的 Hibernation 坑)。本文只补三件事:**现状快照**、**反馈 backlog**、**计数放置调研**。

## 1. 项目现状(已全部上线)

| 项 | 现状 |
|---|---|
| 产品 | 提肛陪伴(KegelMate)PWA。落地页 `https://kegel.eigentime.org/`,应用 `/app/` |
| 架构 | `core/` 纯函数层 + `app.js` 胶水层,零依赖、无构建;唯一后端 = 计数 Worker(`worker/`) |
| 最近完成 | ① 计数「0人」bug 修复(worker 改走 WebSocket Hibernation API,线上已验证 `doing:1`);② N1 训练完成分享卡(canvas 图卡→系统分享/预览保存);③ 落地页删「换了域名」迁移段 |
| git | `main` 全绿。`ffbadd9`(功能+修复)、`dd9a2de`(D28/D29 文档)之后工作区干净 |
| 计数 Worker | `tigang-counter.eigentime.workers.dev`;CI 有 `CLOUDFLARE_*` secrets,**每次 push 自动重部署** |

## 2. 反馈 backlog(产品群,2026-08-04/05)

按接手优先级排序,每条含上下文与建议。是否实现的决定权在下一个 agent / 用户。

| # | 反馈 | 类型 | 上下文 / 建议 | 撞红线? |
|---|---|---|---|---|
| 1 | **导入/导出更扎实,不同设备间记录处理好** | 功能增强 | 现有:导出备份(`tigang-YYYYMMDD-HHmmss.json`)+ 导入两档「合并/替换」(见 D27)。「不同设备」= 跨设备迁移体验:可加强**校验容错、去重、导入预览**,或提供**迁移引导文案**。**不要做云同步**(G2 gated,撞「数据只在本地」) | 无(保持本地) |
| 2 | ~~**开始前倒计时只有第一声,突兀**~~ ✅ 已完成(D30) | UX/音效 | `prepare` 进入那声保留,之后每秒一声 587Hz 轻 tick(peak 0.012)。设置里「轻提示」开关(`settings.softCue`,默认开) | 无 |
| 3 | ~~**休息时完全没有音效,不够优雅**~~ ✅ 已完成(D30) | UX/音效 | `rest` 做成 4 秒吸(392Hz)/ 4 秒呼(330Hz)呼吸节律,末 3 秒 440Hz 每秒倒数;短休息自动退化为纯倒数。同一个「轻提示」开关 | 无 |
| 4 | **排行榜 or 讨论区?** | 讨论/未决 | 撞 **G1**(排行榜需匿名参与者+后端+隐私口径;先例:time-logger R3——要么真数字要么不做)。**不建议近期做**,维持 gated | G1 |
| 5 | **计数固定 header 太侵入,调研替代方案** | 调研→改版 | 见下方 §3 调研结论 | 无 |

## 3. 计数放置调研(用户指定)

**现状**:header 第二行整宽小字 `此刻 X 人在做 · 总访问 Y`(`index.html` 的 `.site-stats`,`st-doing`/`st-visits`)。D26 当初移到 header 的理由是「陪伴感靠常驻可见」;现在的反馈是移动端窄屏上太占位、跟连续天数芯片抢注意力。

**候选方案(按「侵入性 vs 可见性」权衡):**

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **a. 空闲态显示 + 紧凑徽标**(推荐) | 只在空闲态显示为小圆片 `● X 人在练`;训练中隐藏 | 保留「开始前看看有多少人」的陪伴感;训练零打扰;改动小(状态驱动显示) | 训练中看不到实时数(合理,反正专注时不该看) |
| b. 收敛为紧凑徽标 | 整行文字收敛成一个小 pill,仅有人训练时显示数字 | 仍常驻、占位最小 | 总访问数字被藏起来 |
| c. 移入统计页 | 作为统计页一张卡片 | 最不侵入 | 失去常驻可见;实时性最强的数据放不常打开的页,价值打折 |
| d. 移入完成面板 | 完成后展示「此刻全网有 X 人在练」 | 呼应「一起练」,训练全程零打扰 | 只出现在完成时刻 |
| e. 落地页保留 + 应用内点按展开 | 默认隐藏,小图标点开看实时数 | 最安静 | 多一步交互 |

**推荐**:先做 **a**(空闲态显示 + 紧凑徽标)——改动小、保留陪伴感、训练零打扰;若仍想再减重,考虑 c+d 组合。实现注意:计数**协议不变**(`st-doing`/`st-visits` 由 `counter` 模块 + `renderCounter` 更新,worker 不碰),只改 DOM 结构/样式与显隐时机;改 DOM id 需同步 SPEC §8 DOM 表。

## 4. 接手须知

- **必读**:CLAUDE.md(约定/命令)→ SPEC.md(契约)→ DEVELOPMENT.md(D1–D29,重点 D28)。
- **命令**:`npm test`(core/ 改动必跑,裸 `node --test`);`node tools/build-site.mjs`(组装 dist);`git push`(CI 自动:测试→Pages→计数 Worker,Worker 需 `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets,已配置)。
- **红线**:零依赖(不加 npm 包/CDN);`core/` 禁 DOM / `Date.now()` / `localStorage`;计数 Worker 是「零后端」唯一例外;发版升 `sw.js` 的 `CACHE_NAME`;改接口(函数签名/状态字段/DOM id)同步 SPEC;「维持」`holdSec` 是全局键,`holdSec=0` 必须等价 v1 两段式。
- **计数 Worker 本地验证**:`cd worker && npx wrangler dev`(会生成 `worker/.wrangler/`,已 gitignore);协议 + Hibernation 坑见 `worker/worker.js` 顶部注释与 D28。改 WebSocket 逻辑前**先确认走类方法还是 addEventListener**。
- **建议接手顺序**:① ~~音效 2/3~~ ✅ 已完成(D30)→ ② 导入导出跨设备 1 → ③ 计数放置 5(已有调研,可立项)→ ④ 排行榜 4(维持 gated,不动)。

## 5. 交接时已验证

- 计数:训练会话存活期间线上 `/stats` 返回 `doing:1`(2026-08-05 实测)。
- 落地页:无「换了域名」段落;应用:`btn-share`/`dlg-share` 已上线;`sw.js` = `tigang-v12`(R2/R3 发版已升)。
- 测试:`npm test` 78 全绿;`node --check` 全过;构建正常;app.js 引用的 71 个 DOM id 全部存在于 index.html。
- R2/R3 轻提示:一次性脚本喂 `maybePhaseTick` 真实源码,确认 prepare 3 声倒数、rest 呼吸拍 392/330 交替 + 末 3 秒 440、后台跳变不补拍、暂停静音、开关关闭全静、用力阶段无声、短休息(1–8s)退化为纯倒数。

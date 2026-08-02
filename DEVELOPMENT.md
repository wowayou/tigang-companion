# DEVELOPMENT — 技术决策记录

日期:2026-08-01。规格与验收由主会话(Fable)完成,实现由两个 Opus 5 子 agent 按 SPEC.md 并行执行(A:core+tests,B:UI+PWA)。

## 决策记录

### D1 平台:PWA,而非微信小程序 / RN / Flutter
- **选择**:纯静态 PWA(HTML/CSS/JS),无后端。
- **理由**:零安装门槛、离线可用、数据纯本地(健康数据敏感,隐私最优);开发环境(WSL2)下可用 Node 直接验证核心逻辑;后续要上小程序/原生可复用 core/ 纯函数层,或用 Capacitor 打包。
- **代价**:网页通知受限(见 D8);iOS 上 PWA 能力弱于安卓。

### D2 零依赖、无构建
- **选择**:不用任何 npm 依赖、框架、打包器;测试用 node 内置 test runner。
- **理由**:项目规模小,框架收益低;零依赖 = 十年后 clone 下来还能跑;`node --test` 即完整可复跑测试,无 lockfile/供应链问题。
- **代价**:无 TypeScript 类型约束 → 用 SPEC.md 显式契约 + 单测覆盖补偿(两个 agent 并行开发时契约即接口)。

### D3 训练引擎 = 纯函数状态机,时间外部注入
- **选择**:core/ 不碰 DOM/`Date.now()`/localStorage;`tick(state, nowMs)` 不可变更新;阶段边界按"上一边界 + 阶段时长"累加。
- **理由**:可测性(测试传模拟时钟);浏览器后台 tab 会节流定时器,回前台后一次 tick 用 while 跨越多个阶段边界,状态依然精确、计时不漂移。

### D4 打卡(streak)规则
- 只有**完整做完**的训练(finished=true)算当天打卡;中途结束的记录保留次数统计但不算打卡。
- 连续天数锚点:今天有打卡从今天算,否则从昨天算(今天还没练不清零)——习惯类应用通行惯例,避免早上看到 streak 归零的挫败感。

### D5 日期存本地 `YYYY-MM-DD` 字符串
- 记录只存本地日期分量字符串,不存时间戳;日期算术用 `Date.UTC` 做。
- **理由**:打卡按"用户的当天"计,时间戳跨时区/夏令时换算是习惯类应用的经典 bug 源。

### D6 训练方案数值依据
- 新手 3s/3s×10×2 组(Mayo Clinic 起步方案:收缩 3s、每组 10-15 次、每日 2-3 组);进阶 10s 保持(NHS 慢速收缩目标);快速爆发 1s/1s(NHS fast squeezes);6-12 周见效、勿排尿时练习等文案同源。
- ⚠️ **本次会话的联网检索通道故障**(代理后端模型下线,WebSearch/WebFetch 均不可用),健康文案由主模型既有知识按上述来源共识撰写,**上线前建议人工比对 Mayo/NHS 原文复核一遍**。

### D7 执行委派方式(过程记录)
- SPEC.md 先行,锁死函数签名/状态字段/DOM id,两个 Opus agent 并行互不通信;集成正确性由契约 + 主会话验收(SPEC §9:全量单测、node --check、id 对照、预缓存对照、HTTP 200 巡检、人工复核状态机与 streak 边界)保障。
- 实际结果:两个 agent 均运行在 claude-opus-5;38/38 测试全绿;UI agent 自发做了跨模块集成冒烟并抓到 SPEC 的一处真实缺陷(restSec=0 时 contract→contract 漏提示音),验收采纳其修正;核心 agent 发现 Node 24 的 `--test` 目录参数坑(见 D9)。全部裁量已回写 SPEC §10 与本文件 D10。

### D9 Node 24 的 `node --test` 目录参数坑
- Node ≥ 24 把 `node --test` 的位置参数按文件/glob 处理,`node --test tests/` 报 `MODULE_NOT_FOUND` 且**伪装成 1 个测试失败**(极易误判为代码问题)。`npm test` 已定为裸 `node --test`;glob 形式 `node --test 'tests/*.test.mjs'` 亦可。

### D10 验收采纳的实现裁量(全录)
- 阶段推进判定 = phase/setIndex/repIndex 任一变化(非仅 phase);
- `validateConfig` 接受数值字符串('7'→7),NaN/空串/非数值回落 standard;取整用 `Math.round`;
- `totals` 的 totalReps/totalDurationSec 含 `finished:false` 的中途记录,finishedSessions/activeDays 仅计完成;`finished` 严格 `=== true`;
- `#countdown` 在 idle/done 显示 `—`;暂停时冻结圆动画于当前位置,恢复/回前台按剩余时长续播;
- 通知权限被拒 → 回滚提醒开关并 alert;prepare 阶段不发声;音频加 12ms 起音包络防爆音;
- sw.js 仅回写 `ok && type==='basic'` 响应,断网导航回退 index.html;
- custom 方案不暴露 prepareSec 输入(沿用默认 3);`remainingTotalSec` 返回小数秒。

### D11 发布与部署(2026-08-01)
- **独立公开仓库 `wowayou/tigang-companion`**:沿用 my-projects 下"每项目一仓"的既有惯例(根目录实测并非 git 仓库);公开是 GitHub Pages 免费版的要求,项目本身无秘密(纯前端、无密钥、数据全在用户本地)。
- **Pages 走 Actions 工作流**(Source = GitHub Actions)而非 branch 模式:① 测试全绿才部署(质量闸门);② 不经 Jekyll;③ 部署目标横向可扩——`test` 与 `deploy-*` 解耦,加平台 = 加并列 job,配方集中在 DEPLOY.md。
- **可移植性设计**:相对路径 + `start_url`/`scope` = "." → 根路径/子路径零改动通吃;发版升 `sw.js` CACHE_NAME 的约定写进 CLAUDE.md 与 DEPLOY.md。

### D12 维持阶段做成开关默认关,而非全面改三段式(2026-08-02)
- **选择**:engine.js 加一个可选的 `hold` 相位,`holdSec=0` 时完全退化成 v1 的两段式(收紧结束直接计数),只有用户主动开启才变成三段式。
- **理由**:老用户的训练节奏、总时长感知、打卡统计口径(completedReps 计数时机)一律不变——这是纯加法而非改造现有行为。三段式对新手更友好(收紧到位后先"保持"一下再放,肌肉记忆更清楚),但不该强加给已经习惯两段式节奏的用户。
- **实现要点**:`holdOf(config)` 把"缺失/非法当 0"做成硬保证,使得任何不带 `holdSec` 的旧 config(v1 存档、外部裸对象)都自然安全退化,不需要显式迁移逻辑。

### D13 成就系统用 bestStreak(历史最长)而非当前 streak(2026-08-02)
- **选择**:`achievements.js` 里所有连续类徽章(三日不辍/一周不断/双周坚持/月度不断)判定用 `stats.longestStreak`,不用 `computeStreak`。
- **理由**:徽章是"成就"语义——拿到就该是拿到了。如果用当前 streak 判定,某天没打卡时昨天刚解锁的徽章会当场消失,这种"努力被收回"的负反馈比不给徽章还伤积极性。`longestStreak` 单调不减,徽章墙只会越来越满,符合游戏化设计的基本预期。
- **代价**:`bestStreak` 与统计页顶部展示的当前 `streak` 是两个数字,文案上需要注意别混用(完成面板同时展示两者时已在设计上区分:`#done-streak-num` 显示当前连续天数,`#done-next` 的进度条基于 bestStreak 到下一枚徽章的距离)。

### D14 语音方案与 iOS 手势限制、提示音方向性设计(2026-08-02)
- **选择**:用浏览器原生 `speechSynthesis`(零依赖、免许可)播报阶段名;`primeVoice()` 在开始按钮点击处理器里先 speak 一句 `volume:0` 的空白话"开锁"。
- **理由**:iOS Safari 要求 `speechSynthesis.speak` 的首次调用必须发生在用户手势的同步调用栈里,否则该次及后续调用会被静默丢弃且没有报错——不预热的话训练开始后语音会"哑火"且难以定位原因。AudioContext 同理需要在同一个点击处理器里创建/resume。
- **提示音方向性**:即便关闭语音,不同阶段的提示音也做出方向区分——收紧上行(提起来)、维持两声平音(稳住)、放松下行(放下去)、休息低长音(歇着)——只开提示音也能靠耳朵分辨该干什么,不必总盯着屏幕。
- **默认关闭语音**(`DEFAULT_SETTINGS.voice = false`):语音只能走扬声器外放(`utterance.volume` 控制不了输出路由),而本应用的典型使用场景是办公室久坐、卫生间、床上,首次训练就外放"收紧"是实打实的尴尬风险。把"不看屏幕也知道该做什么"这个需求交给上面的方向性提示音兜底,语音留作用户主动开启的增强项——默认值的错误代价在这里是不对称的:默认开的翻车成本远高于默认关的少一个功能。

### D15 图标为什么手写 PNG 编码器(2026-08-02)
- **选择**:`tools/make-icons.mjs` 只用 Node 内置 `zlib`(deflate)+ `Buffer` 手写最小 PNG 编码器(CRC32/IHDR/IDAT/IEND chunk),自己做矢量光栅化和 4×4 超采样抗锯齿,不引入任何图像库。
- **理由**:项目零依赖是硬约束(见 D2),而 iOS 的 `apple-touch-icon` 不支持 SVG(见下),必须有 PNG;项目又没有构建步骤,不能指望部署时动态生成——只能把脚本和产物都当"源码"对待:脚本进 tools/,PNG 产物直接提交进仓库。
- **根因**:iOS Safari 只认位图格式的 `apple-touch-icon`,声明 SVG 会导致添加到主屏时图标退化成系统按标题生成的文字缩写(本项目实测退化成"提"字)。

### D16 界面单屏化(2026-08-02)
- **动机**:v1 的方案卡默认展开(5 个胶囊 + 摘要行)在常见手机视口下会把引导圆挤出首屏,用户一打开就得先滚动才能看到最重要的"开始训练"入口。
- **选择**:方案卡默认折叠成一行摘要,点击展开;布局改 `.app` flex 列 + `min-height: calc(100dvh - tabbar - safe-area)`,`.coach` 用 `flex:1` 吃掉剩余空间——高屏上引导圆能居中而不是整体堆顶部,矮屏则靠 `min-height` 兜底不整页滚动。实测 390×620(较矮的机型)与 390×760(常见机型)两种视口高度均单屏不滚动。

### D8 已知限制 / Backlog
- **提醒**:无后端 ⇒ 无 Web Push;通知仅在页面打开时由 setTimeout 触发。iOS 需 16.4+ 且安装到主屏才有通知能力。若要可靠提醒,后续加个极简 push 服务或打包原生。
- ~~图标仅 SVG~~:已解决(2026-08-02,见 D15)——补齐 180/192/512/512-maskable 四个 PNG,解决 iOS 主屏图标退化问题。
- 未做:深色模式、数据导入(只有导出)、多用户、云同步(有意不做,隐私优先)。

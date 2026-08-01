# 提肛陪伴 (tigang-companion) — 实现规格 v1

一个提肛(凯格尔/盆底肌)训练陪伴 PWA:引导节奏动画 + 打卡统计 + 健康知识。
零依赖、无构建步骤、无后端,数据全部存本地 localStorage。

本规格是实现的唯一依据,**函数签名、状态字段名、DOM id 必须与本文完全一致**(UI 与核心逻辑由不同 agent 并行实现,契约不一致会导致集成失败)。

## §1 文件清单(不得增减)

```
tigang-companion/
├── package.json          # 已存在,勿动
├── index.html            # 单页,三个 tab
├── styles.css
├── app.js                # UI 胶水层(ES module)
├── sw.js                 # Service Worker
├── manifest.webmanifest
├── icon.svg
├── core/
│   ├── engine.js         # 训练状态机(纯函数,零 DOM)
│   ├── stats.js          # 打卡/连续天数/热力图数据(纯函数)
│   └── storage.js        # localStorage 读写
└── tests/
    ├── engine.test.mjs
    ├── stats.test.mjs
    └── storage.test.mjs
```

约束(两个 agent 都必须遵守):
- 禁止任何 npm 依赖、CDN 引用、构建工具;只用浏览器/Node 原生能力。
- 所有 JS 是 ES module;项目根目录裸 `node --test` 必须全绿(Node ≥ 24 不再接受 `node --test tests/` 目录参数,会伪装成 1 个失败,见 §10)。
- 禁止 HTML 内联事件(`onclick=`);全部 `addEventListener`。
- core/ 三个模块不得访问 DOM、`Date.now()`、`localStorage`(时间与存储对象一律由调用方传入),保证可测。
- 中文 UI 文案以本规格给出的为准。

## §2 训练方案(产品依据)

参考 Mayo Clinic 与 NHS 盆底肌训练公开建议:

| preset key | 名称 | 收缩s | 放松s | 每组次数 | 组数 | 组间休息s |
|---|---|---|---|---|---|---|
| beginner | 新手入门 | 3 | 3 | 10 | 2 | 20 |
| standard | 标准训练 | 5 | 5 | 12 | 3 | 30 |
| advanced | 进阶耐力 | 10 | 10 | 10 | 3 | 30 |
| quick | 快速爆发 | 1 | 1 | 20 | 2 | 20 |

准备时间 prepareSec 统一默认 3。另支持 custom 自定义。

## §3 core/engine.js 契约

```js
export const PRESETS = {
  beginner: { name: '新手入门', contractSec: 3, relaxSec: 3, repsPerSet: 10, sets: 2, restSec: 20, prepareSec: 3 },
  standard: { name: '标准训练', contractSec: 5, relaxSec: 5, repsPerSet: 12, sets: 3, restSec: 30, prepareSec: 3 },
  advanced: { name: '进阶耐力', contractSec: 10, relaxSec: 10, repsPerSet: 10, sets: 3, restSec: 30, prepareSec: 3 },
  quick:    { name: '快速爆发', contractSec: 1, relaxSec: 1, repsPerSet: 20, sets: 2, restSec: 20, prepareSec: 3 },
};

// 校验并夹取范围;非法/缺失字段回落到 standard 的对应值,再夹到范围内并取整。
// 范围: contractSec 1-30, relaxSec 1-30, repsPerSet 1-50, sets 1-10, restSec 0-180, prepareSec 0-10
// 返回新对象 { contractSec, relaxSec, repsPerSet, sets, restSec, prepareSec }(不含 name)。
export function validateConfig(raw) {}

// 状态对象(纯数据,可 JSON 序列化):
// {
//   config,                 // validateConfig 后的配置
//   phase: 'idle'|'prepare'|'contract'|'relax'|'rest'|'done',
//   setIndex: 0,            // 0 起,始终指向当前/即将进行的组
//   repIndex: 0,            // 0 起,始终指向当前/即将进行的收缩
//   phaseEndsAt: null,      // 当前阶段结束的毫秒时间戳;idle/done/暂停时为 null
//   paused: false,
//   pausedRemainingMs: null,
//   completedReps: 0,       // 已完成的收缩总次数
//   startedAt: null,        // 毫秒时间戳
//   finishedAt: null,
// }
export function createSession(rawConfig) {}   // 内部调 validateConfig;返回 idle 态

export function start(state, nowMs) {}   // 仅 idle 可调;prepareSec>0 进 prepare,否则直接 contract
export function tick(state, nowMs) {}    // 见下方状态机;非运行态(idle/done/paused)原样返回同一引用
export function pause(state, nowMs) {}   // 运行中才生效;记 pausedRemainingMs = max(0, phaseEndsAt-nowMs)
export function resume(state, nowMs) {}  // paused 才生效;phaseEndsAt = nowMs + pausedRemainingMs
export function reset(state) {}          // 返回 createSession(state.config)

export function phaseDurationSec(config, phase) {}      // prepare/contract/relax/rest 对应秒数
export function totalDurationSec(config) {}
// = prepare + sets*reps*contract + sets*(reps-1)*relax + (sets-1)*rest
export function remainingInPhaseMs(state, nowMs) {}     // idle/done→0;paused→pausedRemainingMs
export function remainingTotalSec(state, nowMs) {}      // 当前阶段剩余 + 之后所有阶段时长
export function overallProgress(state, nowMs) {}        // 0..1;= 1 - remainingTotal/total;done→1, idle→0
```

状态机转移(tick 在 `nowMs >= phaseEndsAt` 时逐个跨越边界,**用 while 循环**,一次 tick 可跨多个阶段;新阶段的 phaseEndsAt = 旧 phaseEndsAt + 新阶段时长×1000,即以边界累加计时、不产生漂移):

- `prepare` → `contract`(索引不变)
- `contract` 结束 → `completedReps++`;然后:
  - 若 `repIndex < repsPerSet-1` → `relax`,同时 `repIndex++`(relax 期间索引指向下一次收缩)
  - 否则若 `setIndex < sets-1` → `setIndex++; repIndex=0`;`restSec>0` 进 `rest`,`restSec===0` 直接进下一组 `contract`
  - 否则 → `done`,`finishedAt` = 该边界时间戳,`phaseEndsAt=null`
- `relax` → `contract`(索引不变)
- `rest` → `contract`(索引不变)

所有函数**不可变更新**:返回新对象,绝不修改入参(tick 无变化时可返回原引用)。

## §4 core/stats.js 契约

打卡记录只存**本地日期字符串**,避免时区/跨天 bug。

```js
export function localDateStr(date) {}        // Date 对象 → 'YYYY-MM-DD',用 getFullYear/getMonth/getDate 本地分量,补零
export function addDays(dateStr, delta) {}   // 用 Date.UTC 做日期算术,返回 'YYYY-MM-DD'
export function makeRecord({ dateStr, completedReps, totalReps, durationSec, finished }) {}
                                             // 返回含这 5 个字段的新对象;数值取整、finished 转 boolean

// 连续打卡天数:只有 finished===true 的记录算"完成当天打卡"。
// 锚点:今天有完成记录则从今天起算,否则从昨天起算;锚点无记录 → 0;向前逐日累计。
export function computeStreak(records, todayStr) {}

// { sessions, finishedSessions, totalReps, totalDurationSec, activeDays }
// activeDays = 有 ≥1 条 finished 记录的不同日期数
export function totals(records) {}

// 长度恰为 n 的数组,旧→新,最后一项是 todayStr:
// [{ dateStr, finishedCount, reps }]  reps 为当天所有记录 completedReps 之和
export function lastNDays(records, todayStr, n) {}
```

## §5 core/storage.js 契约

```js
export const STORAGE_KEY = 'tigang-companion.v1';
export const DEFAULT_SETTINGS = {
  presetKey: 'standard',            // 'beginner'|'standard'|'advanced'|'quick'|'custom'
  custom: { contractSec: 5, relaxSec: 5, repsPerSet: 12, sets: 3, restSec: 30, prepareSec: 3 },
  sound: true,
  vibration: true,
  reminder: { enabled: false, time: '21:00' },
};

// storage 参数默认 globalThis.localStorage,测试传 fake {getItem,setItem,removeItem}。
// 任何异常/损坏 JSON → 返回全新默认值 { records: [], settings: <DEFAULT_SETTINGS 深拷贝> }。
// settings 与 DEFAULT_SETTINGS 做浅合并 + reminder/custom 二级合并(旧版本数据升级后不丢新默认键)。
export function load(storage) {}
export function save(data, storage) {}       // 成功 true,异常(如超配额)捕获后返回 false
export function clearAll(storage) {}
export function exportJSON(data) {}          // 返回 JSON.stringify({ app:'tigang-companion', version:1, ...data }, null, 2)
```

## §6 测试要求(node --test,零依赖,实现 agent 必须跑到全绿)

engine.test.mjs 至少覆盖:
1. 四个 PRESETS 均通过 validateConfig 且值不变;
2. validateConfig:超范围夹取、小数取整、缺失/非数字回落 standard 默认;
3. 完整流程:config {1,1,2,2,rest:1,prepare:1} 从 t=0 start,以 500ms 步进 tick,断言阶段序列
   prepare@0 → contract@1000 → relax@2000 → contract@3000 → rest@4000 → contract@5000 → relax@6000 → contract@7000 → done@8000,
   totalDurationSec=8,结束时 completedReps=4、finishedAt=8000;
4. 大步长 tick(一次跨多个阶段)结果与逐步 tick 一致;
5. pause/resume:暂停时 tick 不推进,恢复后剩余时长保持;
6. idle/done 态 tick 返回原引用;
7. restSec=0 跨组直接 contract→contract;prepareSec=0 start 直接进 contract;
8. remainingTotalSec 随时间单调不增,overallProgress 从 0 到 1(done 恰为 1);
9. 不可变性:tick 前后旧 state 深比较不变。

stats.test.mjs 至少覆盖:补零格式、addDays 跨月/跨年、streak 的 6 种情形(空、仅今天、今昨连续、仅昨天、断档、finished=false 不计)、totals 聚合、lastNDays 长度/排序/空日补零。

storage.test.mjs 至少覆盖:空存储→默认值、损坏 JSON→默认值、save/load 往返、旧 settings 缺键时合并出新默认键、save 异常返回 false。

## §7 UI 规格(index.html + styles.css + app.js)

移动优先,内容区 max-width 480px 居中;配色:主色 `#0f9b8e`(teal),背景 `#f6f8f7`,文字 `#1c2b2a`。底部固定 3 个 tab:训练 / 统计 / 知识(切换即 display 切换,无路由)。页面 `<html lang="zh-CN">`,`<meta name="viewport" content="width=device-width, initial-scale=1">`,`<meta name="theme-color" content="#0f9b8e">`。

### 训练 tab(默认)
- 方案选择:5 个 radio(name="preset",value 为 beginner/standard/advanced/quick/custom)渲染成胶囊按钮;选 custom 时显示自定义面板(number 输入:`#cfg-contract` `#cfg-relax` `#cfg-reps` `#cfg-sets` `#cfg-rest`,范围与 §3 一致)。方案变更即持久化到 settings 并 reset 会话;训练进行中禁用方案切换。
- 引导圆 `#coach-circle`:直径约 220px 的圆,内部上方 `#phase-label`(准备/收缩/放松/休息/完成/待开始),中间大号 `#countdown`(当前阶段剩余秒,`Math.ceil(remainingInPhaseMs/1000)`;idle/done 态显示 `—`)。
  动画:collapse/expand 用 CSS `transform: scale()` + `transition`,JS 在进入阶段时把 `transitionDuration` 设为该阶段秒数、contract 缩到 0.62、relax/rest/prepare 回到 1;prepare 与 rest 附加轻微呼吸脉动 class。
- 进度:`#set-progress` 文案 `第 {setIndex+1}/{sets} 组 · 第 {repIndex+1}/{repsPerSet} 次`(rest 阶段显示 `休息中 · 即将开始第 {setIndex+1} 组`);总进度条 `#overall-bar`(宽度=overallProgress)。
- 按钮:`#btn-start`(开始训练)、`#btn-pause`(暂停/继续,文案随态切换)、`#btn-stop`(结束)。驱动:`setInterval` 100ms,`next = tick(state, Date.now())`;**阶段推进**(phase 或 setIndex/repIndex 任一变化——`restSec=0` 时跨组是 contract→contract,仅比较 phase 会漏一拍)时触发提示音/震动;done 时写入记录并展示完成面板 `#done-panel`(本次完成 N 次收缩、用时、当前连续 X 天)。
- `#btn-stop` 训练中点击 → `confirm('确定结束本次训练?')`;若 `completedReps>0` 以 `finished:false` 记录后 reset。
- 记录写入:`makeRecord({ dateStr: localDateStr(new Date()), completedReps, totalReps: config.sets*config.repsPerSet, durationSec: Math.round((Date.now()-startedAt)/1000), finished })`,append 到 records 后 save。
- 提示音:懒创建 AudioContext(**必须在 start 按钮的点击处理器里创建/resume**,规避自动播放限制);sine 波、gain 0.05:contract 880Hz 150ms、relax 523Hz 150ms、rest 392Hz、done 三连音 523/659/880。settings.sound 为 false 则跳过。
- 震动:`navigator.vibrate` 存在且 settings.vibration 时,contract [100]、relax [50]、done [80,60,80]。
- 屏幕常亮:start 时 `navigator.wakeLock?.request('screen')` try/catch,done/stop 时 release。
- 右上角 `#btn-settings`(齿轮)打开 `<dialog id="dlg-settings">`:`#opt-sound`、`#opt-vibration`(checkbox),提醒 `#opt-reminder-enabled` + `<input type="time" id="opt-reminder-time">`,下方小字说明:`网页版提醒仅在应用保持打开时生效;安装到桌面后体验更佳`。开启提醒时请求 Notification 权限;app.js 里用 setTimeout 排到下一次 HH:MM 触发 `new Notification('提肛时间到 💪', { body: '花两分钟完成今天的训练吧' })`,触发后自动排到明天。

### 统计 tab
- 顶部大数字 `#streak-num`(当前连续天数)+ 文案 `连续打卡`;
- 四格指标:`#stat-days` 累计打卡天数(activeDays)、`#stat-sessions` 完成训练次数(finishedSessions)、`#stat-reps` 累计收缩次数、`#stat-duration` 累计时长(分钟,四舍五入);
- `#heatmap`:`lastNDays(records, today, 35)` 渲染 7列×5行 grid,旧→新,按 finishedCount 0/1/2/≥3 四档由浅到深上色,最后一格(今天)加描边;
- `#btn-export` 导出:`exportJSON` 生成 Blob 下载,文件名 `tigang-data.json`;`#btn-clear` 清除全部数据(confirm 二次确认)。

### 知识 tab(静态内容,文案照抄,允许微调排版)

> **为什么值得练**
> - 促进肛周静脉回流,预防和缓解痔疮、肛裂等问题,久坐人群尤其受益
> - 增强盆底肌:改善漏尿、预防盆腔脏器脱垂;是产后盆底修复的基础训练
> - 男性前列腺术后尿控恢复的常用辅助训练;对性功能也有一定改善
> - 传统养生称"撮谷道",相传乾隆皇帝常年坚持
>
> **怎么练才对**
> - 找对肌肉:像"忍住排便/中断排尿"那样收紧肛门及会阴部,可以用中断排尿的感觉来定位肌肉,但**不要经常在排尿时练习**(可能导致排尿不尽、增加尿路感染风险)
> - 收紧时正常呼吸、不要憋气;腹部、大腿、臀部保持放松,只用盆底发力
> - 坐、站、躺都能练,初学建议先躺或坐
> - 循序渐进:从收缩 3 秒起步,逐步延长到 10 秒;慢速练耐力,快速练反应
> - 通常坚持 6-12 周会有明显改善,贵在每天坚持
>
> **注意与禁忌**
> - 急性痔疮发作期、肛周感染/脓肿、肛肠手术恢复期:请先咨询医生
> - 盆底肌过度紧张者(如慢性盆腔痛、排便困难伴痉挛)不适合此类收缩训练,应先就医评估
> - 练习中出现疼痛请立即停止并就医;孕期练习前建议咨询产科医生
> - 不要过度训练,按推荐组数即可,肌肉疲劳反而可能暂时加重症状
>
> *训练方案参考 Mayo Clinic 与 NHS 的盆底肌训练公开建议。本应用仅供健康锻炼参考,不构成医疗建议。*

页脚(所有 tab 可见区域底部、tab 栏上方):`仅供锻炼参考,不构成医疗建议`。

## §8 PWA(sw.js + manifest.webmanifest + icon.svg)

- manifest:`name/short_name` 提肛陪伴,`start_url: "."`,`scope: "."`,`display: "standalone"`,`background_color: "#f6f8f7"`,`theme_color: "#0f9b8e"`,icons 单项 `{ src:"icon.svg", sizes:"any", type:"image/svg+xml", purpose:"any" }`。
- icon.svg:teal 圆底 + 白色三层同心收缩圆环示意(简洁即可,不要文字)。
- sw.js:`CACHE_NAME='tigang-v1'`;install → `addAll` 预缓存全部 9 个静态文件(相对路径 `./` 开头)+ `skipWaiting`;activate → 清旧 cache + `clients.claim`;fetch → 仅处理同源 GET,cache-first 回退 network。
- app.js 末尾:`if ('serviceWorker' in navigator)` load 后 `register('./sw.js')`,try/catch 静默失败(http 下无 SW 属正常)。

## §9 验收清单(由主会话执行)

1. `node --test tests/` 全绿;
2. 所有 JS 通过 `node --check`;manifest 可被 JSON.parse;
3. app.js 引用的每个 DOM id 都存在于 index.html;sw.js 预缓存清单与磁盘文件一一对应;
4. `python3 -m http.server` 下所有资源 200;
5. 引擎状态机、streak 边界、自动播放/免打扰逻辑人工复核。

## §10 v1 实现修订(验收后回写,规格已同步)

- **测试命令**:Node 24 把 `node --test` 的位置参数当文件处理,`tests/` 目录参数报 `MODULE_NOT_FOUND` 并伪装成 1 个测试失败;`npm test` 已改为裸 `node --test`(递归发现 `tests/*.test.mjs`)。
- **阶段推进判定**放宽为 phase/setIndex/repIndex 任一变化(修复 `restSec=0` 时 contract→contract 漏提示音,§7 已更新)。
- 其余实现裁量(validateConfig 接受数值字符串、totals 的次数/时长包含未完成记录、`#countdown` 空态显示 `—`、暂停冻结圆动画等)见 DEVELOPMENT.md D10。

# 提肛陪伴 (tigang-companion) — 实现规格

一个提肛(凯格尔/盆底肌)训练陪伴 PWA:引导节奏动画 + 打卡统计 + 健康知识。
零依赖、无构建步骤、无后端,数据全部存本地 localStorage。

本规格是实现的唯一依据,**函数签名、状态字段名、DOM id 必须与本文完全一致**(UI 与核心逻辑由不同 agent 并行实现,契约不一致会导致集成失败)。

## §1 文件清单

```
tigang-companion/
├── package.json          # 已存在,勿动
├── index.html            # 单页,三个 tab
├── styles.css
├── app.js                # UI 胶水层(ES module)
├── sw.js                 # Service Worker
├── manifest.webmanifest
├── icon.svg
├── icon-180.png          # apple-touch-icon(方形满铺,iOS 会自己切圆角)
├── icon-192.png
├── icon-512.png
├── icon-maskable-512.png # 内容仅占中心 60% 安全区
├── core/
│   ├── engine.js         # 训练状态机(纯函数,零 DOM)
│   ├── stats.js          # 打卡/连续天数/热力图数据(纯函数)
│   ├── storage.js        # localStorage 读写
│   ├── achievements.js   # 成就徽章 / 今日目标(纯函数)
│   └── sync.js           # 多端同步纯函数:端到端加密 + LWW 合并(可迁移到 time-logger)
├── ROADMAP.md            # 增长机制路线图(产品向,不落代码;N 系列为准)
├── site/                 # 落地页(部署到站点根路径;不是 PWA 的一部分,不进 sw.js 预缓存)
│   ├── index.html
│   └── styles.css
├── sync/
│   └── client.mjs        # 同步浏览器客户端(零依赖,origin 参数化,可复用/可迁移)
├── sync-server/          # 自建同步后端(端到端加密,只存密文;部署/端点/限流见 sync-server/README.md)
│   ├── server.mjs        # Node 单文件:node:http + node:sqlite,零 npm
│   ├── nginx.conf.example
│   └── sync.service      # systemd unit 示例
├── tools/
│   ├── make-icons.mjs    # 零依赖 PNG 图标生成脚本(一次性运行,产物提交进仓库)
│   └── build-site.mjs    # 组装部署目录:根=site/,/app/=sw.js 预缓存清单(单一真源);CI 调用
├── worker/               # 全站计数服务(Cloudflare Worker + Durable Object)
│   ├── worker.js         # 部署源,不是被 PWA fetch 的静态资源 → 不加进 sw.js 预缓存
│   ├── wrangler.toml
│   └── README.md         # 部署步骤(一次性;部署后把地址填进 app.js 的 COUNTER_ORIGIN)
└── tests/
    ├── engine.test.mjs
    ├── stats.test.mjs
    ├── storage.test.mjs
    ├── achievements.test.mjs
    └── sync.test.mjs
```

新增文件须同步本清单 + sw.js 预缓存清单 + 升级 `CACHE_NAME`,否则用户拿不到更新。

约束:
- 禁止任何 npm 依赖、CDN 引用、构建工具;只用浏览器/Node 原生能力。
- 所有 JS 是 ES module;项目根目录裸 `node --test` 必须全绿(Node ≥ 24 不再接受 `node --test tests/` 目录参数,会伪装成 1 个失败,见 §11)。
- 禁止 HTML 内联事件(`onclick=`);全部 `addEventListener`。
- core/ 四个模块不得访问 DOM、`Date.now()`、`localStorage`(时间与存储对象一律由调用方传入),保证可测。
- 中文 UI 文案以本规格给出的为准。

## §2 训练方案(产品依据)

参考 Mayo Clinic 与 NHS 盆底肌训练公开建议:

| preset key | 名称 | 收缩s | 维持s | 放松s | 每组次数 | 组数 | 组间休息s |
|---|---|---|---|---|---|---|---|
| beginner | 新手入门 | 3 | 0 | 3 | 10 | 2 | 20 |
| standard | 标准训练 | 5 | 0 | 5 | 12 | 3 | 30 |
| advanced | 进阶耐力 | 10 | 0 | 10 | 10 | 3 | 30 |
| quick | 快速爆发 | 1 | 0 | 1 | 20 | 2 | 20 |

**一次 = 收紧(+维持)+ 放松**,放松时长与收缩相当,且每次收缩都配一次放松。依据:Cleveland Clinic「收紧 3 秒,然后放松 3 秒,**这就是一次凯格尔**」;Harvard Health「每次保持 3-5 秒,间隔相同秒数休息……每次重复之间要有意识地放松,放松时长与收缩相同」。组间休息是在此之上的额外恢复,不能替代放松。

四个预设的 `holdSec` 都固化为 0(默认关闭「维持」阶段,老用户行为不变)。`holdSec` 是**全局设置**(见 §5),不是预设/custom 各自的字段——同一时刻只有一份「维持时长」,叠加在任意方案之上。准备时间 prepareSec 统一默认 3。另支持 custom 自定义。

## §3 core/engine.js 契约

```js
// holdSec = 0 表示不启用「维持」阶段(收紧→放松两段式,v1 行为);
// > 0 则每次循环变成 收紧 → 维持 → 放松 三段式。
export const PRESETS = {
  beginner: { name: '新手入门', contractSec: 3, holdSec: 0, relaxSec: 3, repsPerSet: 10, sets: 2, restSec: 20, prepareSec: 3 },
  standard: { name: '标准训练', contractSec: 5, holdSec: 0, relaxSec: 5, repsPerSet: 12, sets: 3, restSec: 30, prepareSec: 3 },
  advanced: { name: '进阶耐力', contractSec: 10, holdSec: 0, relaxSec: 10, repsPerSet: 10, sets: 3, restSec: 30, prepareSec: 3 },
  quick:    { name: '快速爆发', contractSec: 1, holdSec: 0, relaxSec: 1, repsPerSet: 20, sets: 2, restSec: 20, prepareSec: 3 },
};

// 校验并夹取范围;非法/缺失字段回落到 standard 的对应值,再夹到范围内并取整。
// 范围: contractSec 1-30, holdSec 0-60, relaxSec 1-30, repsPerSet 1-50, sets 1-10, restSec 0-180, prepareSec 0-10
// 返回新对象,键顺序固定为:
// { contractSec, holdSec, relaxSec, repsPerSet, sets, restSec, prepareSec }(不含 name)。
export function validateConfig(raw) {}

// 状态对象(纯数据,可 JSON 序列化):
// {
//   config,                 // validateConfig 后的配置
//   phase: 'idle'|'prepare'|'contract'|'hold'|'relax'|'rest'|'done',
//   setIndex: 0,            // 0 起,始终指向当前/即将进行的组
//   repIndex: 0,            // 0 起;收紧/维持期间指向进行中的这次,放松期间指向刚做完的这次
//                           // (索引推进发生在放松结束,见下方状态机)
//   phaseEndsAt: null,      // 当前阶段结束的毫秒时间戳;idle/done/暂停时为 null
//   paused: false,
//   pausedRemainingMs: null,
//   completedReps: 0,       // 已完成的收缩总次数(hold 结束才计数,见下方状态机)
//   startedAt: null,        // 毫秒时间戳
//   finishedAt: null,
// }
export function createSession(rawConfig) {}   // 内部调 validateConfig;返回 idle 态

export function start(state, nowMs) {}   // 仅 idle 可调;prepareSec>0 进 prepare,否则直接 contract
export function tick(state, nowMs) {}    // 见下方状态机;非运行态(idle/done/paused)原样返回同一引用
export function pause(state, nowMs) {}   // 运行中才生效;记 pausedRemainingMs = max(0, phaseEndsAt-nowMs)
export function resume(state, nowMs) {}  // paused 才生效;phaseEndsAt = nowMs + pausedRemainingMs
export function reset(state) {}          // 返回 createSession(state.config)

export function phaseDurationSec(config, phase) {}      // prepare/contract/hold/relax/rest 对应秒数
export function totalDurationSec(config) {}
// = prepare + sets*reps*(contract+hold+relax) + (sets-1)*rest
// 注意放松是 sets*reps 而非 sets*(reps-1):每次收缩都自带放松,包括每组最后一次。
export function remainingInPhaseMs(state, nowMs) {}     // idle/done→0;paused→pausedRemainingMs
export function remainingTotalSec(state, nowMs) {}      // 当前阶段剩余 + 之后所有阶段时长
export function overallProgress(state, nowMs) {}        // 0..1;= 1 - remainingTotal/total;done→1, idle→0
```

**holdSec 兼容性保证**:内部辅助函数 `holdOf(config)` 读取 `config.holdSec`,缺失或非法(非数字、≤0)一律当 0 处理。v1 存档、以及任何不带 `holdSec` 键的裸 config 传入 `phaseDurationSec`/`totalDurationSec`/状态机,都会自然退化成两段式(等价于 v1 行为),不会算出 `NaN` 或抛异常。这是升级路径的核心保证,任何改动都不得破坏它。

状态机转移(tick 在 `nowMs >= phaseEndsAt` 时逐个跨越边界,**用 while 循环**,一次 tick 可跨多个阶段;新阶段的 phaseEndsAt = 旧 phaseEndsAt + 新阶段时长×1000,即以边界累加计时、不产生漂移):

- `prepare` → `contract`(索引不变)
- `contract` 结束:
  - 若 `holdSec > 0` → 进入 `hold`(**本次收缩此时尚未计数**,`completedReps` 不变)
  - 若 `holdSec === 0`(两段式)→ 视同下面「一次收缩完成」
- `hold` 结束(或两段式的 `contract` 结束)→ 一次收缩完成:`completedReps++`,**一律进入 `relax`**,索引不动
- `relax` 结束 → 一次收缩到此才算走完,索引在这里推进:
  - 若 `repIndex < repsPerSet-1` → `repIndex++`,进 `contract`
  - 否则若 `setIndex < sets-1` → `setIndex++; repIndex=0`;`restSec>0` 进 `rest`,`restSec===0` 直接进下一组 `contract`
  - 否则 → `done`,`finishedAt` = 该边界时间戳,`phaseEndsAt=null`
- `rest` → `contract`(索引不变)

**放松属于「一次」而不是「两次之间的间隔」**(硬约束):每组最后一次、以及全程最后一次收缩之后同样要放松,不能被 `rest`/`done` 吞掉。依据见 §2;曾经的 `sets*(reps-1)*relax` 模型是错的(理由见 DEVELOPMENT.md D25)。这也意味着**不存在 phase 相同的相邻阶段**了(旧模型在 `restSec=0` 跨组时会出现 `contract→contract`)。

所有函数**不可变更新**:返回新对象,绝不修改入参(tick 无变化时可返回原引用)。

## §4 core/stats.js 契约

打卡记录只存**本地日期字符串**,避免时区/跨天 bug。

```js
export function localDateStr(date) {}        // Date 对象 → 'YYYY-MM-DD',用 getFullYear/getMonth/getDate 本地分量,补零
export function addDays(dateStr, delta) {}   // 用 Date.UTC 做日期算术,返回 'YYYY-MM-DD'
export function makeRecord({ dateStr, completedReps, totalReps, durationSec, finished, ts }) {}
                                             // 返回含这 5 个字段的新对象;数值取整、finished 转 boolean
                                             // 可选 ts(同步 LWW 用,毫秒时间戳):数值有效则写入,缺失/非法则不写该键(旧记录向后兼容)

// 连续打卡天数:只有 finished===true 的记录算"完成当天打卡"。
// 锚点:今天有完成记录则从今天起算,否则从昨天起算;锚点无记录 → 0;向前逐日累计。
export function computeStreak(records, todayStr) {}

// 历史最长连续打卡天数,与"今天"无关,只看记录本身(排序后找最长连续段)。
// 用于成就系统:断档后已解锁的连续类徽章不该被收回,见 §6.1 设计理由。
export function longestStreak(records) {}

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
  holdSec: 0,                       // 「维持」阶段秒数,0=关闭;全局值,叠加在任何方案(含 custom)之上
  sound: true,
  voice: false,                     // 语音播报阶段名;默认关(会外放,使用场景多在公共/半公共环境)
  softCue: true,                    // 阶段内轻提示:准备倒数每秒轻响 + 休息期呼吸引导;受 sound 总开关约束
  vibration: true,
  reminder: { enabled: false, time: '21:00' },
  sync: { enabled: false },         // 多端同步开关(可选 · 端到端加密);只存开关——主密码/userId 都不进 settings
};

// storage 参数默认 globalThis.localStorage,测试传 fake {getItem,setItem,removeItem}。
// 任何异常/损坏 JSON → 返回全新默认值 { records: [], settings: <DEFAULT_SETTINGS 深拷贝> }。
// settings 与 DEFAULT_SETTINGS 做浅合并 + reminder/custom/sync 二级合并(旧版本数据升级后不丢新默认键)。
export function load(storage) {}
export function save(data, storage) {}       // 成功 true,异常(如超配额)捕获后返回 false
export function clearAll(storage) {}

// 导入备份(纯函数,不碰 DOM/存储):
// 解析校验备份 JSON。成功 { ok:true, data:{ records, settings } };失败 { ok:false, error }。
// records 逐条净化:dateStr 必须 YYYY-MM-DD,数值取非负整数;settings 走 mergeSettings 补新默认键。
export function parseBackup(text) {}
// 合并记录:保留 existing,只追加 imported 中指纹(dateStr+三个数值+finished)全新的记录,返回新数组。
export function mergeRecords(existing, imported) {}
export function exportJSON(data) {}          // 返回 JSON.stringify({ app:'tigang-companion', version:1, ...data }, null, 2)
```

## §6 core/achievements.js 契约

成就徽章 / 今日目标,纯函数,同样不得访问 DOM/`Date.now()`/`localStorage`;今天的日期由调用方以 `todayStr` 传入。

```js
// 12 枚徽章定义,顺序即徽章墙(4×3)展示顺序,按解锁难度递增。
// metric ∈ 'finishedSessions'|'bestStreak'|'activeDays'|'totalReps'
export const ACHIEVEMENTS = [/* { id, icon, name, desc, metric, threshold } × 12 */];

export const DEFAULT_DAILY_GOAL = 1;

// 徽章/目标要用到的全部指标。
export function computeMetrics(records, todayStr) {}
// → { streak, bestStreak, activeDays, finishedSessions, totalReps, totalDurationSec, todayFinished, todayReps }

// 徽章墙完整数据。
export function evaluate(records, todayStr) {}
// → { metrics, badges, unlockedCount, total, next, nextByMetric }
// badges: ACHIEVEMENTS 每项附加 { current, unlocked, remaining, progress(0..1) }
// next  : 未解锁徽章里 progress 最高的一枚(并列取定义顺序靠前的);全部解锁则 null
// nextByMetric: 每类指标各自的下一枚未解锁徽章,用于定向提示(如「再练 2 天解锁『一周不断』」)

// 当前已解锁的徽章 id 数组(定义顺序)。
export function unlockedIds(records, todayStr) {}

// 本次训练新解锁了哪些徽章:传入写入记录「前」的 id 数组与「后」的 id 数组。
export function newlyUnlocked(beforeIds, afterIds) {}   // → 徽章定义数组(定义顺序)

// 今日目标进度(默认每天完成 1 次训练算达标)。
export function dailyGoal(records, todayStr, goal = DEFAULT_DAILY_GOAL) {}
// → { done, goal, met, remaining, progress }
```

### §6.1 徽章表

| id | icon | 名称 | 条件 | metric | threshold |
|---|---|---|---|---|---|
| first-session | 🌱 | 迈出第一步 | 完成 1 次训练 | finishedSessions | 1 |
| streak-3 | 🔥 | 三日不辍 | 连续打卡 3 天 | bestStreak | 3 |
| reps-100 | 💯 | 百次收缩 | 累计 100 次收缩 | totalReps | 100 |
| streak-7 | ⚡ | 一周不断 | 连续打卡 7 天 | bestStreak | 7 |
| days-10 | 📗 | 十日之功 | 累计打卡 10 天 | activeDays | 10 |
| reps-500 | 🌊 | 五百次 | 累计 500 次收缩 | totalReps | 500 |
| streak-14 | 🏅 | 双周坚持 | 连续打卡 14 天 | bestStreak | 14 |
| days-30 | 📅 | 满月打卡 | 累计打卡 30 天 | activeDays | 30 |
| reps-2000 | 🗻 | 两千次 | 累计 2000 次收缩 | totalReps | 2000 |
| streak-30 | 👑 | 月度不断 | 连续打卡 30 天 | bestStreak | 30 |
| days-100 | 🎯 | 百日打卡 | 累计打卡 100 天 | activeDays | 100 |
| reps-10000 | 🏆 | 万次收缩 | 累计 10000 次收缩 | totalReps | 10000 |

**设计理由(bestStreak 而非当前 streak)**:连续类徽章看 `stats.longestStreak`(历史最长)而不是 `computeStreak`(当前连续)。原因是断档后已经拿到的徽章不该被收回——用当前 streak 判定会导致用户某天没打卡,昨天还挂着的「一周不断」徽章瞬间消失,这是负向体验;历史最长值只增不减,徽章墙因而具备正确的「成就」语义(拿到就是拿到了)。

### §6.z 多端同步(可选 · 端到端加密,自建后端)

实现约束:**端到端加密不可妥协**——后端只存密文,主密码绝不离开设备,后端不解密不解析 blob。

- **后端地址**(app.js 顶部,与 `COUNTER_ORIGIN` 并列,**与计数 Worker 解耦**,不同址不同服务):
  ```js
  const SYNC_ORIGIN = 'https://sync.eigentime.org'; // 自建甲骨文后端;换后端(未来回 Worker / 本地开发)改这一行
  ```
- **后端契约**:见 `sync-server/README.md`(不进 SPEC 主体——SPEC 是前端契约)。端点 `PUT/GET /sync?key=<userId>`、`GET /health`;只存取密文字符串,last-write-wins 覆盖;**userId 必须为 UUID v4 格式**(前后端双向校验,预防手填时误入非 UUID 建垃圾桶);限流 同 userId PUT ≥ 1次/3s → 429 + 同 IP 20次/分 → 429(多设备共用同一 userId 时共享这个额度,客户端撞 429 会**自动延后重试一次**)。
- **纯函数层**(`core/sync.js`,可迁移到 time-logger):
  - `encryptBlob(plaintextObj, passphrase, crypto=globalThis.crypto)` → `{v:1,salt,iv,ct,iter}`(PBKDF2-SHA256 200000 轮 + AES-GCM-256)。
  - `decryptBlob(blob, passphrase, crypto)` → `{ok:true,data} | {ok:false,error}`;错误主密码 / 损坏密文 → `{ok:false}` **不抛**(调用方静默降级纯本地)。
  - `mergeForSync(local, remote)` → `{merged, conflicts}`:同指纹(`dateStr|completedReps|totalReps|durationSec|finished`)去重不计冲突;同 dateStr 不同指纹 LWW(有 ts 取大,平 ts / 都无 ts 留 remote),conflicts 按被淘汰记录数计;其余全保留;输出按 dateStr 升序,**顺序无关**。
  - `newUserId(crypto)` → UUID v4。
  - `normalizeUserId(raw)` → `{ok:true, userId} | {ok:false, error}`——校验并规范化手填的同步 ID;去首尾空白、统一小写,**只接受 UUID v4**(后端也做同样校验,最终防线)。
  - crypto 一律参数注入(默认 `globalThis.crypto`);core 不碰 DOM / `Date.now()` / `localStorage`。
- **记录 schema**:record 可带可选 `ts`(毫秒时间戳,`app.js writeRecord` 注入 `Date.now()`);旧记录无 ts 视为 0,向后兼容。
- **浏览器客户端**(`sync/client.mjs`):`syncPull/syncPush/syncProbe`,origin 参数化,AbortController 10s 超时,任何失败 `{ok:false,error}` 不抛;CORS 失败与断网统一 `'network'`。
- **userId 独立 key + 多设备链接(手填,非自动派生)**:`newUserId()` 生成随机 UUID v4,存 localStorage 独立 key `tigang_sync_user`(不进 settings/exportJSON)。**为什么不从主密码自动派生**(审计结论,2026-08-07):派生方案下两个不同用户用相同主密码(如 `1234`)会算出一模一样的 userId → 撞型同一个桶 → 互相覆盖密文、云端数据反复被摧毁、受害者持续看到「解密失败」→ 比"不同设备同步不到一起"更严重。因此**多设备指向同一个桶靠用户手工操作**:设备 A 的同步 ID 显示在 `#opt-sync-user`(只读),点「复制」按钮(`#btn-sync-copy`)复制 → 设备 B 粘贴到 `#opt-sync-link` 里点「应用」(`#btn-sync-link`)→ `normalizeUserId` 校验 UUID 格式 → 写入本机 localStorage 覆盖 `tigang_sync_user` → 两设备同一 userId → 同一个后端桶。复制降级:clipboard API 失败→选中文本让用户手动 Ctrl+C 并提示。userId 不是密码,但 UI 诚实注明"别公开(别人拿到能覆盖你的密文,虽然解不开)"。
- **解密失败 → 锁死一切推送**(审计发现 1,2026-08-07):`syncDecryptFailed` 模块标志,`doSyncPull` 解密失败→置 true→**禁止 doSyncPush(含 syncNow 和自动推 scheduleSyncPush)**——否则本机会用错误主密码加密的密文覆盖云端那份额正确加密的有效数据,两边都坏。主密码变更(input)→清除该标志(允许重试)。正确主密码再次 pull → 解密成功 → 置 false(恢复推送)。
- **主密码缓存策略(会话级,2026-08-05 优化)**:主密码不进 localStorage / settings / exportJSON,只进内存 + `sessionStorage`(键 `tigang_sync_pass`,输入即写)。**sessionStorage 生命周期=tab 会话**:同一 tab 内刷新不丢,关 tab 丢;PWA 从主屏图标启动有时算新会话也丢——属可接受降级,丢=回到「进设置输一次」的老流程,不崩。**用户主动改主密码→覆盖写新值;关闭同步→清空**。忘了主密码=远端密文不可恢复,**本地数据不丢**,重输=重新开始同步。权衡(同源 XSS 可读,与 userId 明文同风险等级)见 DEVELOPMENT.md D31。
- **同步时机**(无新定时器):
  - 打开应用:若 `sync.enabled && 主密码可用(本会话输入或 sessionStorage 回填)` → 后台 pull → decrypt → merge(只合记录,设置保留本机)→ save → renderStats;任一步失败静默降级纯本地。
  - 首次启用引导:勾「启用同步」自动展开主密码组并聚焦;`doSyncPull` 收到远端 `none`(无数据)记 `syncRemoteEmpty` 标志,`syncNow` 据此**跳过 pull 直接推**(首次纯 push);首次推送成功状态显示「已开启同步 · 本机数据已上传」。
  - `persist()` 后:debounce 2s,若启用且有主密码且在线 → encrypt → push;失败静默,下次打开重试。
  - 离线(`!navigator.onLine`)跳过。
- **UI**(设置弹窗一组,新增/更新 DOM id 见 §8.x,`sync-ok/sync-err/sync-busy` 为状态色 class 非 id):`#opt-sync-enabled` `#opt-sync-master` `#opt-sync-user`(本机同步 ID,只读) `#btn-sync-copy`(复制同步 ID) `#opt-sync-link`(粘贴另一台设备的同步 ID) `#btn-sync-link`(应用链接 ID) `#btn-sync-now` `#sync-last` `#sync-state`;`.input-with-copy` 行(输入框 flex:1 + 按钮固定不换行);主密码/按钮/状态行包在无 id 的 `.sync-setup` 容器内,**开关关时 `hidden` 收起整组**;状态行按 `sync-ok`(成功绿)/`sync-err`(失败橙)/`sync-busy`(进行中灰)着色。
- **正确性说明**:**不同主密码 → 解密失败 → 静默降级本地、UI 显示「解密失败」** 是端到端加密的正确表现,不是 bug;离线打开纯本地不报错。

## §7 测试要求(node --test,零依赖,实现 agent 必须跑到全绿)

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

engine.test.mjs 另需覆盖(v2,维持阶段):
10. holdSec=0 时行为与 v1 完全一致(两段式回归防线);
11. holdSec>0 时 contract 结束进 hold、completedReps 此时不变,hold 结束才 completedReps++;
12. 不带 holdSec 键的裸 config 传入 phaseDurationSec/totalDurationSec/tick 不产生 NaN,自然退化为两段式;
13. totalDurationSec 含 hold 项的公式正确性。

stats.test.mjs 至少覆盖:补零格式、addDays 跨月/跨年、streak 的 6 种情形(空、仅今天、今昨连续、仅昨天、断档、finished=false 不计)、totals 聚合、lastNDays 长度/排序/空日补零、longestStreak(空/单天/连续/断档取最长/同日多条不重复计数/跨月跨年/顺序无关/与 computeStreak 的区别)。

storage.test.mjs 至少覆盖:空存储→默认值、损坏 JSON→默认值、save/load 往返、旧 settings 缺键时合并出新默认键(含 v1 存档升级后拿到 holdSec/voice/softCue 新默认键且不改变已有取值)、save 异常返回 false。

achievements.test.mjs 至少覆盖:computeMetrics 各字段正确性、evaluate 的 badges/next/nextByMetric、unlockedIds、newlyUnlocked(前后快照对比)、dailyGoal 达标/未达标、bestStreak 断档后徽章不被收回。

sync.test.mjs 至少覆盖:encryptBlob/decryptBlob 往返、错误主密码 → {ok:false} 不抛、损坏 blob(ct 改一字节)→ {ok:false} 不抛、非法/垃圾 blob → {ok:false}、旧记录无 ts + 新记录有 ts 混合不丢、同 dateStr 不同指纹 → LWW + conflicts 正确、同 dateStr 都无 ts / 平 ts → 留 remote、同指纹 → 不叠加 conflicts=0、合并稳定(打乱顺序 merged 一致)、null/非法入参不抛、newUserId 合法 UUID v4 格式。

## §8 UI 规格(index.html + styles.css + app.js)

移动优先,内容区 max-width 480px 居中;配色:主色 `#0f9b8e`(teal),背景 `#f6f8f7`,文字 `#1c2b2a`。底部固定 3 个 tab:训练 / 统计 / 知识(切换即 display 切换,无路由)。页面 `<html lang="zh-CN">`,`<meta name="viewport" content="width=device-width, initial-scale=1">`,`<meta name="theme-color" content="#0f9b8e">`。

顶栏 `header.app-header`:标题 + 常驻连续天数芯片 `#streak-chip`(内含 `#streak-chip-num`,streak≤0 时 `hidden`,不显示比空着更糟的"0天")+ 右上角 `#btn-settings`。顶栏为不透明背景(v1 半透明渐变滚动时卡片文字会从标题后透出,v2 改不透明 + 下缘一层淡出伪元素)。

页面整体布局:`.app` 为 flex 列容器,`min-height: calc(100dvh - tabbar高 - safe-area-inset-bottom)`;`.coach`(引导圆所在容器)`flex: 1 1 auto` 吃掉剩余空间——高屏上圆能居中而不是整体堆在顶部,矮屏则靠 `.app` 的 `min-height` 兜底不出现整页滚动(实测 390×620 与 390×760 两种视口高度均单屏不滚动)。

### 训练 tab(默认)

**方案卡**默认折叠成一行 `#plan-toggle`(点击展开/收起 `#plan-body`),内含当前方案名 `#plan-name` 与摘要 `#plan-summary`(如 `收紧 5s · 维持 3s · 放松 5s · 12 次 × 3 组 · 约 5 分 24 秒`,未开维持则为 `收缩 5s · …`)。折叠的原因:v1 展开的 5 个方案胶囊 + 摘要会把引导圆挤出手机首屏。训练进行中 `#plan-toggle` 禁用且强制收起。

展开后 `#plan-body` 内:
- 方案选择:5 个 radio(name="preset",value 为 beginner/standard/advanced/quick/custom)渲染成胶囊按钮;选 custom 时显示自定义面板(number 输入:`#cfg-contract` `#cfg-relax` `#cfg-reps` `#cfg-sets` `#cfg-rest`,范围与 §3 一致,不含 prepareSec/holdSec 输入)。方案变更即持久化到 settings 并 reset 会话;训练进行中禁用方案切换。
- **维持开关**:`#opt-hold-enabled`(iOS 风格开关,见下方 `.switch` 说明)控制全局 `settings.holdSec` 是否 >0;展开秒数输入 `#hold-sec-wrap`(内含 `#cfg-hold`,范围 1-60,与 §3 一致)。关闭开关时记住上一次输入的秒数,重新打开不必再输一遍。holdSec 是**全局设置**而非 custom 的字段(见 §5)——四个预设与自定义方案共用同一个「维持」开关。

**引导圆 `#coach-circle`**:- 进度:`#set-progress`。运行中文案 `第 {setIndex+1}/{sets} 组 · 第 {repIndex+1}/{repsPerSet} 次`(rest 阶段显示 `休息中 · 即将开始第 {setIndex+1} 组`);**空闲态**改为显示今日打卡状态而非空着,如 `连续 5 天 · 今天还没练` / `今天已完成 · 连续 5 天` / `今天已完成` / `准备好就开始`(取决于当日 `dailyGoal` 是否达标与当前 `streak`)。总进度条 `#overall-bar`(宽度=overallProgress)。

- 按钮:`#btn-start`(开始训练,done 态文案变为"再来一次")、`#btn-pause`(暂停/继续,文案随态切换)、`#btn-stop`(结束)。驱动:`setInterval` 100ms,`next = tick(state, Date.now())`;**阶段推进**(phase 或 setIndex/repIndex 任一变化——`restSec=0` 时跨组是 contract→contract,仅比较 phase 会漏一拍)时触发提示音/语音/震动 + 圆与环重新进入动画;done 时写入记录并展示完成面板 `#done-panel`。
- `#btn-stop` 训练中点击 → `confirm('确定结束本次训练?')`;若 `completedReps>0` 以 `finished:false` 记录后 reset。
- 记录写入:`makeRecord({ dateStr: localDateStr(new Date()), completedReps, totalReps: config.sets*config.repsPerSet, durationSec: Math.round((Date.now()-startedAt)/1000), finished })`,append 到 records 后 save。

**完成面板 `#done-panel`**(重做):
- `#done-reps` 本次完成收缩次数、`#done-duration` 用时;
- `#done-streak-num` 当前连续天数(**v1 的 `#done-streak` 已改名为 `#done-streak-num`**);
- `#done-next-bar` 进度条(宽度 = 下一枚连续类徽章的 progress)+ `#done-next` 文案(如 `再连续 2 天解锁「一周不断」`;连续类徽章已全部解锁则显示对应完结文案);
- `#done-unlocked`(本次新解锁徽章的外层容器,无解锁时 `hidden`)+ `#done-badges`(徽章行,新解锁徽章带弹出动画)。新解锁的判定:写入记录前后各取一次 `unlockedIds` 快照,`newlyUnlocked(before, after)` 求差集。
- `#btn-share` 分享按钮(ROADMAP N1):`finishSession` 把 `{ reps, streak, dateStr }` 存进模块级 `shareData`;点击后 `drawShareCard()` 在内存 canvas 画 1080×1440 成果卡(品牌 teal 渐变 + 同心圆环 + 今日收缩次数 + 连续天数 + 免责),转 PNG Blob → `navigator.canShare({files})` 支持就直接系统分享(Android Chrome),否则弹 `#dlg-share` 预览(iOS 长按保存 / `#btn-save-share` 下载)。零新依赖,canvas 不占任何 DOM id。

**提示音**(方向性设计,关闭语音也能靠耳朵分辨该干什么):懒创建 AudioContext(**必须在 start 按钮的点击处理器里创建/resume**,规避自动播放限制);sine 波、gain 0.05:
  - `prepare` 单音 587Hz;
  - `contract` 上行 660→990Hz(提起来);
  - `hold` 两声平音 784×2(稳住);
  - `relax` 下行 784→523Hz(放下去);
  - `rest` 低长音 392Hz(歇着);
  - `done` 三连音 523/659/880Hz。
  `settings.sound` 为 false 则跳过。

**阶段内轻提示**(`settings.softCue`,默认**开**;`sound` 是总开关,关掉提示音则一并静音):上面的 TONES 只在**阶段边界**响一次,所以 v2 之前「准备」只有进入时那一声、「休息」全程静默。轻提示补的是阶段**内部**的声音通道,峰值 gain 刻意压到 `0.012`(阶段提示音是 `0.05`),只当秒针/呼吸拍用,不与提示音的方向性设计抢辨识度:
  - `prepare`:每秒一声 587Hz(与 `TONES.prepare` 同族),听起来是在倒数;
  - `rest`:**不**每秒响(30 秒休息响 30 下与「轻柔」相反)——4 秒吸 / 4 秒呼的呼吸节律,每个半周期开头一声(吸 392Hz、呼 330Hz,各 240ms);最后 3 秒切成 440Hz 每秒倒数,预告下一组要开始;
  - `contract` / `hold` / `relax` 不加:用力阶段每秒响会盖掉「上行/平音/下行」的方向感。

  实现:`PHASE_TICKS[phase](secLeft, durationSec)` + 模块级 `lastTickSecLeft`,由 `step()` 的 100ms 循环驱动(**不新开定时器**)。判据是「阶段内剩余整秒数变了才响」——暂停、后台切回、阶段边界都靠这条自然收敛:回前台时剩余秒数直接跳到新值,只响一声,不会把落后的拍子补齐成一串。`seedPhaseTick(state)` 在阶段推进 / 开始 / 恢复 / 切回前台时重新播种,`secLeft <= 0` 那声不响(紧接着就是阶段切换的提示音,叠在一起像重音)。

**语音播报**:Web Speech API `speechSynthesis`,zh-CN,按阶段播报"准备/收紧/保持/放松/休息/完成"。`settings.voice` 控制开关,**默认关**——语音走扬声器外放,而本应用的典型使用场景(办公室、卫生间)多为公共/半公共环境;提示音本身已按方向可分辨,不开语音也能不看屏幕。**iOS 要求首次 `speak` 发生在用户手势里**,否则之后的播报被静默丢弃——`primeVoice()` 在开始按钮的点击处理器里跑一次 `volume:0` 的空白话来"开锁"。切阶段时先 `speechSynthesis.cancel()` 让位,避免播报堆积、落后于画面。

**震动**:`navigator.vibrate` 存在且 `settings.vibration` 时,按阶段各不同的 pattern(contract/hold/relax/rest/done)。

- 屏幕常亮:start 时 `navigator.wakeLock?.request('screen')` try/catch,done/stop 时 release。
- 右上角 `#btn-settings`(齿轮)打开 `<dialog id="dlg-settings">`:`#opt-sound`、`#opt-soft-cue`、`#opt-voice`、`#opt-vibration`(均为 `.switch`),提醒 `#opt-reminder-enabled` + `<input type="time" id="opt-reminder-time">`,下方小字说明不开语音也能靠音高方向分辨阶段、以及语音开启后会外放需留意公共场合,和"网页版提醒仅在应用保持打开时生效;安装到桌面后体验更佳"。`#opt-soft-cue`(轻提示)独立于 `#opt-sound`,但受其约束——总开关关掉后轻提示也不响。开启提醒时请求 Notification 权限;app.js 里用 setTimeout 排到下一次 HH:MM 触发 `new Notification('提肛时间到 💪', { body: '花两分钟完成今天的训练吧' })`,触发后自动排到明天。
- `.switch`:v1 是原生 checkbox(iOS 上渲染成带蓝色聚焦框的方块勾,与整体视觉不搭);v2 改成 `appearance: none` 自绘的 iOS 风格开关(胶囊轨道 + 圆形滑块,`:checked` 切换位置与背景色)。

### 统计 tab
- 顶部大数字 `#streak-num`(当前连续天数)+ 文案 `连续打卡` + `#today-goal`(今日目标达成状态,如 `今天已完成 1 次训练 ✓` / `今天还没练 · 完成 1 次就算打卡`);
- **徽章墙**:卡片标题旁 `#badge-count`(`{unlockedCount} / {total}`,即 `x / 12`),`#badge-wall`(4 列 × 3 行网格,每枚徽章显示图标+名称,未解锁降低透明度,title 属性显示描述与差距),下方 `#next-badge`(离下一枚还差多少,如 `⚡ 距「一周不断」还差 2 天`;全部解锁则显示完结文案);
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

### §8.y 训练中的教练层、计数口径、键盘与过渡

**计数口径(`#set-progress` 的文案分支)**:一次收缩在「收紧(或维持)结束」的那一刻计入 `completedReps`,但 `repIndex` 要到**放松结束**才推进。所以放松期间 `repIndex` 指向的正是刚做完的那一次。文案按阶段分支:

| 阶段 | 文案 |
|---|---|
| idle / done | 今日状态(如 `连续 5 天 · 今天还没练`) |
| prepare | `准备开始 · 共 {sets} 组 × {reps} 次` |
| contract / hold | `第 {setIndex+1}/{sets} 组 · 第 {repIndex+1}/{repsPerSet} 次` |
| relax | `第 {setIndex+1}/{sets} 组 · 已完成 {repIndex+1}/{repsPerSet} 次` |
| rest | `休息中 · 即将开始第 {setIndex+1} 组` |

每组有 `repsPerSet` 次放松(每次收缩各配一次,含最后一次),对应 `totalDurationSec` 里的 `sets*reps*relax`。

**键盘**:空格 = 开始 / 暂停 / 继续。设置弹窗打开时、或焦点在 `input/textarea/select/button/a`、可编辑元素上时不拦截(按钮上的空格是浏览器原生的「激活」,拦了会触发两次);其余情况 `preventDefault` 掉默认的翻页。

**阶段过渡**:原则是**边界上只让一样东西在动**。

- 唯一保留的过渡是圆的底色:改用可过渡的 `background-color`(立体感交给一层固定不变的叠加渐变);v1 每阶段各写一条 `linear-gradient`,而渐变之间无法补间,才是最初「硬切」的来源。`transition-property: transform, background-color, color, box-shadow`,JS 只改第一项的时长(阶段秒数),配色固定 `.9s`——正因为它是边界上唯一还在动的东西,得慢一点才能把前后两个阶段连起来(`.5s` 试过,阶段之间显得各自独立)。各阶段同属青色系,插值干净。
- 阶段名 `#phase-label` 换字时只做 `.16s`、从 `opacity:.4` 起的提亮,**不做位移、不从 0 起**:它是当前最要紧的指令,淡入 300ms 等于在最该看清的时刻看不清。靠 `restartAnimation()` 重放(置 `animation:none` → 强制回流 → 复原)。

### §8.x DOM id 总表(app.js 实际引用的全部 81 个)

本表即 UI 与胶水层的接口面,改动任何一项都必须同步 index.html + app.js + 本表。
校验方法(§10.3):把 app.js 里 `$('…')` 的参数逐个对照 index.html 的 `id="…"`,并反查本表有无遗漏。

| 分区 | id |
|---|---|
| 顶栏 | `btn-settings` `streak-chip` `streak-chip-num` `site-stats` `st-doing` `st-visits` |
| tab 与面板 | `tab-train` `tab-stats` `tab-knowledge` `panel-train` `panel-stats` `panel-knowledge` |
| 方案卡 | `plan-toggle` `plan-body` `plan-name` `plan-summary` `custom-panel` `cfg-contract` `cfg-relax` `cfg-reps` `cfg-sets` `cfg-rest` `opt-hold-enabled` `hold-sec-wrap` `cfg-hold` |
| 引导圆与进度 | `coach-circle` `phase-label` `countdown` `set-progress` `overall-bar` |
| 控制按钮 | `btn-start` `btn-pause` `btn-stop` |
| 完成面板 | `done-panel` `done-reps` `done-duration` `done-streak-num` `done-next-bar` `done-next` `done-unlocked` `done-badges` `btn-share` |
| 分享弹窗 | `dlg-share` `share-img` `btn-save-share` `btn-share-close` |
| 统计页 | `streak-num` `today-goal` `badge-wall` `badge-count` `next-badge` `stat-days` `stat-sessions` `stat-reps` `stat-duration` `heatmap` `btn-export` `btn-import` `file-import` `btn-clear` |
| 设置弹窗 | `dlg-settings` `opt-sound` `opt-soft-cue` `opt-voice` `opt-vibration` `opt-reminder-enabled` `opt-reminder-time` `opt-sync-enabled` `opt-sync-master` `opt-sync-user` `btn-sync-copy` `opt-sync-link` `btn-sync-link` `btn-sync-now` `sync-last` `sync-state` |
| 导入弹窗 | `dlg-import` `import-summary` `import-merge` `import-replace` `import-cancel` |

### §8.z 全站计数(空闲态紧凑徽标:此刻在做人数 + 总访问)

`#site-stats` 是**紧凑徽标**(R5 方案 a):`● <b id="st-doing">–</b> 人在练 · 总访问 <b id="st-visits">–</b>`。**只在空闲态显示(陪伴感),训练中隐藏(零打扰)**——显隐由 `renderTrain()` 里的 `el.siteStats.hidden = isRunning(session)` 驱动,每 100ms 渲染帧同步;完成/重置后重渲染回空闲态,徽标自动回来。初始/离线显示 `–`,不阻塞任何现有功能。

数据源是**自建 Cloudflare Worker + Durable Object**(`worker/`,部署见 `worker/README.md`),不引任何第三方统计服务(不用不蒜子等:那些会把访客 IP / 页面 URL 发给第三方,违反本项目的隐私基调)。

- 客户端逻辑全部在 **app.js**(胶水层),不进 core/:随机 `visitorId` 存 localStorage(键 `tigang_visitor_id`,仅在无痕模式时静默降级);本地预览(`file://`/localhost/私网)不 POST `/visit` 污染全站计数,但仍连 WS 看实时数。
- 状态上报:「在做」= `isRunning(session) && !session.paused`;在 `btnStart`/`btnPause`/`resetSession`/`finishSession` 四处调用 `syncTrainingFlag()` 做差量上报。
- 网络:WS 心跳每 10s(`ping`),重连指数退避封顶 30s;`document.hidden` 时断开连接、回前台 `fetchStats()` + 重连;`pagehide` 关闭。
- Worker 端点:`GET /stats` → `{ online, doing, visits }`;`POST /visit`(body `{ visitorId }`)→ `{ visits }`;`WS /ws` 双向协议见 `worker/worker.js` 顶部注释。CORS 全开。
- `worker/` 三个文件是**部署源,不是被 PWA fetch 的静态资源**,不得加进 sw.js 预缓存清单(sw.js 只预缓存应用自身文件)。

## §9 PWA(sw.js + manifest.webmanifest + icon.svg + icon-*.png)

- manifest:`name/short_name` 提肛陪伴,`start_url: "."`,`scope: "."`,`display: "standalone"`,`background_color: "#f6f8f7"`,`theme_color: "#0f9b8e"`,icons 扩为 4 项:`icon.svg`(`sizes:"any"`,`purpose:"any"`)、`icon-192.png`、`icon-512.png`(均 `purpose:"any"`)、`icon-maskable-512.png`(`purpose:"maskable"`)。
- icon.svg:teal 圆底 + 白色三层同心收缩圆环示意(简洁即可,不要文字)。**根因(为什么还要额外做 PNG)**:iOS Safari 不支持 SVG 格式的 `apple-touch-icon`,只声明 icon.svg 会导致 iOS 添加到主屏时图标退化成系统生成的文字缩写(本项目退化成"提"字)。
- icon-180.png / icon-192.png / icon-512.png / icon-maskable-512.png:`tools/make-icons.mjs` 生成,零依赖(只用 Node 内置 `zlib` + `Buffer`,手写 PNG 编码器:CRC32/IHDR/IDAT/IEND + 自行光栅化 + 4×4 超采样抗锯齿),产物 PNG **直接提交进仓库**(项目无构建步骤,不能指望部署时现生成)。`icon-180.png` 是 iOS `apple-touch-icon`,方形满铺不留透明角(iOS 会自己裁成圆角,留透明角会露黑底);`icon-maskable-512.png` 内容仅占中心 60% 区域(maskable 安全区,避免被系统蒙版裁掉视觉元素)。改图标设计需重跑 `node tools/make-icons.mjs` 并提交新 PNG。
- index.html:`<link rel="apple-touch-icon" href="icon-180.png" sizes="180x180">`(而非 icon.svg)。
- sw.js:`CACHE_NAME='tigang-v11'`(发版递增);install → `addAll` 预缓存 `PRECACHE_URLS`(index.html/styles.css/app.js/manifest/sw.js + core/ 四个模块 + 4 个 icon PNG,相对路径 `./` 开头)+ `skipWaiting`;activate → 清旧 cache + `clients.claim`;fetch → 仅处理同源 GET,cache-first 回退 network。**`PRECACHE_URLS` 同时是 `tools/build-site.mjs` 的运行时清单单一真源**,改预缓存清单要两侧同步。
- app.js 末尾:`if ('serviceWorker' in navigator)` load 后 `register('./sw.js')`,try/catch 静默失败(http 下无 SW 属正常)。

## §10 验收清单(由主会话执行)

1. `npm test`(裸 `node --test`)全绿;
2. 所有 JS 通过 `node --check`;manifest 可被 JSON.parse;
3. app.js 引用的每个 DOM id 都存在于 index.html;sw.js 预缓存清单与磁盘文件一一对应;
4. `python3 -m http.server` 下所有资源 200;
5. 引擎状态机、streak 边界、自动播放/免打扰逻辑人工复核。

## §11 v1 实现修订(验收后回写,规格已同步)

- **测试命令**:Node 24 把 `node --test` 的位置参数当文件处理,`tests/` 目录参数报 `MODULE_NOT_FOUND` 并伪装成 1 个测试失败;`npm test` 已改为裸 `node --test`(递归发现 `tests/*.test.mjs`)。
- **阶段推进判定**放宽为 phase/setIndex/repIndex 任一变化(修复 `restSec=0` 时 contract→contract 漏提示音,§8 已更新)。
- 其余实现裁量(validateConfig 接受数值字符串、totals 的次数/时长包含未完成记录、`#countdown` 空态显示 `—`、暂停冻结圆动画等)见 DEVELOPMENT.md D10。

## §12 v2 变更概述

在 v1(SPEC v1,DEVELOPMENT D1-D11)基础上的一轮功能增量,代码先落地、本节为事后回写:

1. **维持(hold)阶段**:engine.js 新增可选的三段式(收紧→维持→放松),`holdSec=0` 默认关闭、完全等价于 v1 两段式;`holdSec` 是全局设置(storage.js),不进 custom,叠加在任意方案之上。
2. **成就系统**:新增 `core/achievements.js`——12 枚徽章 + 今日目标,纯函数,连续类徽章看历史最长连续(`bestStreak`)而非当前连续,断档不收回徽章。`core/stats.js` 新增 `longestStreak`。
3. **语音播报**与**方向性提示音**:`speechSynthesis` 播报阶段名,**默认关**(外放,顾及公共场合);提示音按阶段做出上行/下行/平音/长音的区分,所以不开语音也能靠耳朵分辨该干什么。均需在用户手势(开始按钮点击)中完成首次初始化(iOS 限制)。
4. **UI 单屏化与重做**:方案卡默认折叠;新增相位环 `#coach-ring`;顶栏常驻连续天数芯片;统计页新增徽章墙;完成面板重做(`#done-streak` 改名 `#done-streak-num`);设置开关从原生 checkbox 换成自绘 `.switch`;布局改 flex + `min-height: calc(100dvh - …)` 保证单屏不滚动。
5. **应用图标**:新增 `tools/make-icons.mjs` 零依赖手写 PNG 编码器,生成 4 个尺寸的图标并提交进仓库,解决 iOS 主屏图标退化成文字缩写的问题。
6. **sw.js**:`CACHE_NAME` 升到 `tigang-v2`,预缓存清单加 `core/achievements.js` 与 4 个图标 PNG。

紧随其后的一轮修订(`CACHE_NAME` → `tigang-v3`):

7. **训练中的教练层**:新增要领提示 `#coach-cue` 与呼吸节拍 `#breath`(各自一个设置开关,默认开)——解决「维持时间一长就不知道怎么用劲、开始憋气」。见 §8.y。
8. **计数口径修正**:放松期间不再报「第 N 次」(那时 `repIndex` 已指向下一次,读着像下一次已开始),改报「已完成 N 次」;prepare 阶段也给了独立文案。见 §8.y。
9. **空格键** = 开始 / 暂停 / 继续。
10. **阶段过渡平滑**:圆的底色改 `background-color` 以支持补间,相位环三个自定义属性用 `@property` 注册后才能补间——此前颜色与环都是硬切,即「衔接生硬」的来源。见 §8.y。

再一轮修订(`CACHE_NAME` → `tigang-v6`):

11. **撤销相位环与教练层**(第 4、7 条中的对应部分,以及第 10 条里环的补间):经实际使用后判定为噪音,已整体移除 —— `#coach-ring`、`#coach-cue`、`#breath` 三组元素与 `settings.coachCue`/`settings.breath` 两个设置项全部删除。**上面第 4、7、10 条中关于相位环与教练层的描述均已失效,仅作历史记录保留**;当前正文(§8)才是准据。训练页现在回到:引导圆(缩放 + 配色)+ 倒计时 + 组次进度 + 总进度条。阶段剩余时间只由圆内的倒计时数字表达。

再一轮修订(`CACHE_NAME` → `tigang-v8`):

12. **全站计数**:顶栏第二行新增「此刻 X 人在做 · 总访问 Y」——「在做」= 正在训练中的实时人数(WebSocket + 心跳,自建 Cloudflare Worker + Durable Object,`worker/`),「总访问」= 累计页面访问(DO storage)。隐私上不引任何第三方统计;客户端随机 visitorId 只发往自己的 worker。实现见 §8.z,部署见 `worker/README.md`。

再一轮修订(`CACHE_NAME` → `tigang-v9`):

13. **数据导入 + 导出优化**:新增「导入备份」(合并 / 替换两档,`core/storage.js` 新增纯函数 `parseBackup` / `mergeRecords`);导出文件名带时间戳 `tigang-YYYYMMDD-HHmmss.json`,iOS 主屏 PWA 走 `navigator.share` 落盘(Blob + a.download 在 iOS 常不落盘)。
14. **部署形态改为 落地页 + /app/**:新增 `site/` 落地页(根路径,品牌 KegelMate · 提肛陪伴)与 `tools/build-site.mjs` 组装脚本(根=site/,`/app/`=sw.js 预缓存清单,单一真源);GitHub Pages 部署 `dist/`,Workflow 新增 `deploy-worker` 自动部署计数 Worker(secrets 未配时优雅跳过)。自定义域名形态参考 time-logger:`https://…/app/` 放应用、根放落地页(见 DEPLOY.md)。
15. **ROADMAP.md**:增长机制路线图(分享卡 / 第 N 位使用者 / 安装引导 / Web Push 等,分 Next/Mid/Gated),见 `ROADMAP.md`。

再一轮修订(`CACHE_NAME` → `tigang-v13`):

16. **多端同步(可选 · 端到端加密,自建后端)**:新增 `core/sync.js`(encryptBlob/decryptBlob/mergeForSync/newUserId,纯函数可迁移 time-logger)、`sync/client.mjs`(origin 参数化的浏览器客户端,零依赖)、`sync-server/`(自建 Node 后端,只存密文,部署见 `sync-server/README.md`)。设置弹窗新增同步组(`#opt-sync-enabled`/`#opt-sync-master`/`#btn-sync-now`/`#sync-last`/`#sync-state`);`DEFAULT_SETTINGS` 加 `sync:{enabled:false}`;record 加可选 `ts`。主密码只进内存不落盘(重开应用重输),userId 走独立 key `tigang_sync_user`。契约见 §6.z。

再一轮修订(`CACHE_NAME` → `tigang-v14`):

17. **同步体验优化(主密码会话级缓存 + 首次引导 + UI 简化,默认仍可选取舍不变)**:主密码从「纯内存态」改为「内存 + `sessionStorage`(键 `tigang_sync_pass`,输入即写)」——tab 内刷新不丢、关 tab 丢,PWA 新会话丢=降级重输不崩;不进 localStorage/settings/exportJSON。首次启用引导:勾选自动展开主密码组并聚焦,远端确认无数据(`none`)后 `syncNow` 跳过 pull 直接推,首次推送成功提示「已开启同步 · 本机数据已上传」。UI:主密码/按钮/状态行包进 `.sync-setup`(无新 id)开关关时 `hidden` 收起;状态行按 `sync-ok`(绿)/`sync-err`(橙)/`sync-busy`(灰)着色。**core/sync.js 零改、后端/限流/合并逻辑零动**。契约见 §6.z,权衡见 DEVELOPMENT.md D31。

18. **同步安全审计修复(审计发现 1-3,2026-08-07,commit 见 D33)**:审计发现三项——① 🔴**解密失败后无条件推送会覆盖云端正确密文**(`syncNow` 先 pull 后 push,解密失败时 doSyncPull return 但 doSyncPush 照样执行)→加 `syncDecryptFailed` 门闸锁死一切 push,主密码变更清除,正确密码重新拉成功恢复;② userId 随机生成→两台设备不同桶永远同步不到一起→改为**手填同步 ID**(`normalizeUserId` 纯函数 + `#opt-sync-user`/`#btn-sync-copy`/`#opt-sync-link`/`#btn-sync-link` UI + 后端 UUID 格式校验),不选从主密码派生(两个用户用相同弱密码会撞桶互相摧毁云端数据);③ 后端限流间隔 10s→3s + 客户端 `rate` 时自动延后重试一次(多设备共用同一 userId 共享额度);后端加 UUID_RE 双向校验预防手填误入。**core/sync.js 加 `normalizeUserId`,其余全在 app.js / server.mjs / UI。** 完整审计与撞桶论证见 DEVELOPMENT.md D33。

详见 §2/§3/§5/§6/§8/§9 各节正文;设计取舍见 DEVELOPMENT.md D12 起(移除的理由见 D24)。

# 多端同步 — 执行规格(路线 C:自建甲骨文后端 + 端到端加密)

> **历史规格,已完成且部分实现被替代。当前准据是 `SPEC.md §6.z` 与 `DEVELOPMENT.md D34`;尤其禁止照本文件的“直接 push/10s 限流/nginx 负责 CORS”旧描述实现。**

> 本文件是给执行 agent(如 deepseek-v4-flash)的派活依据。在本仓库目录内执行后端,在甲骨文凤凰城实例部署。
> **路线 C(用户拍板 2026-08-05)**:自建 Node 单文件后端跑在甲骨文 always-free 实例,
> nginx 反代 TLS+CORS,SQLite 存**端到端加密**密文 blob。CORS 自主可控、零 Cloudflare 计费干扰、KV 写限额问题消失。
> 隐私口径与路线 B 一致:**后端只见密文,项目方读不到明文**。用户主密码不离开设备。
> 不做账号体系(opt-in,用户觉得不安全就不开同步)。决策/调研/验收由人做,执行按本文件走。
> **每个单元独立 commit,验收通过再派下一单元。**

## 路线决策记录(为什么是 C,不是 B/Worker 付费/Worker 免费限流)

调研过的三条路线,结论:

| 维度 | C 自建甲骨文(选定) | B Worker 付费 $5/月 | Worker 免费+限流 |
|---|---|---|---|
| 花费 | **0**(always-free 永久,已在用) | $5/月持续(年 $60) | 0 |
| CORS | **自主**(nginx 三行头) | Worker 自带 | Worker 自带 |
| 写入额度 | **无限**(SQLite 文件) | 100万/天 | **1000/天 ⚠️ 多用户会断** |
| 挤占其他服务 | **不碰 Cloudflare** | 全账号进付费(可能惠及/可能亏) | 与计数 Worker 共用免费 KV 配额 |
| 可演进(time-logger/Web Push/未来后端) | **一台机器吃下所有** | 每需求单评估 | 同 Worker |
| 运维 | 在自己(nginx/进程/备份) | 最少(Cloudflare 托管) | 最少 |
| 可用性 | 单机房凤凰城(同步够用,非实时) | 全球边缘 | 全球边缘 |
| 国内延迟 | 150-250ms(可接受) | 类似或略好 | 同 |

**选 C 的核心理由**:① 用户已有甲骨文 always-free 实例,沉没成本;② 用户 Cloudflare KV 多服务共用,担心"总有付费一天",C 不碰这条计费路径;③ 一台机器解决所有未来后端需求;④ CORS 自主,告别 WebDAV/Worker 的 CORS 纠结。代价=运维在自己,但用户已在维护该机,边际成本接近零;且"觉得维护麻烦再回 Worker"是可逆决策,不锁死。

## 安全评估(对用户数据能否负责 —— 诚实结论)

**机密性(✅ 站得住)**:AES-GCM 256 + PBKDF2-SHA256(200000 轮)。主密码不离开设备,后端只存 `{salt,iv,ct,iter}` 密文。GCM 自带完整性校验,密文被篡改→解密失败,不会解出半截乱码。已调研实死:iOS Safari 7+ 全支持,zero-dep。后端(自建与 Worker 同理)只见密文,项目方读不到明文。**唯一机密性限制**:主密码强度靠用户自己——弱主密码仍可被离线爆破(PBKDF2 200000 轮/次抬高成本但不杜绝)。D31 必须写明。

**完整性(✅)**:由 AES-GCM 的认证标签保证。后端不解析内容,无法引入数据损坏(除了整体覆盖)。

**可用性/凭据泄露(⚠️ 无账号模型的权衡)**:userId 是 122 位熵的读写寻址凭据,远程枚举不可行,但一旦泄露,攻击者可 GET 密文、离线猜弱主密码并 PUT 覆盖。因此 ID 与主密码都要保密并分开传递;本地数据是恢复底线,不能把泄露后果描述成“只覆盖且绝对解不开”。

**权限/账号(不做账号是对的)**:账号体系撞隐私基调(「连邮箱都不要」是卖点)、引入复杂度(登录态/找回/删除合规)。最小防线两层(都不是账号):① userId 不公开、不进 exportJSON;② 写入限流(后端侧,见单元 0)。这两层防不住 determined 攻击者用大量 userId 慢刷,但那种攻击动机为零(密文无价值),且后端单机本身的可观测性(nginx 日志)足以发现异常。**判断:对个人健康陪伴工具量级和场景,这个无账号+端到端加密模型是负责任的**。用户 opt-out("觉得不安全就不开")是最终安全阀。

## 花费评估

- **现阶段 = 0**:甲骨文 always-free 永久免费(4核24GB + 10TB 出站/月)。域名 eigentime.org 已有,子域名 `sync.eigentime.org` 解析过去即可。
- **未来 = 0 或迁移成本**:always-free 不转付费(只要不超 ARM 配额且实例活跃,不收钱)。若某天甲骨文政策变/维护嫌烦→回 Worker 路线,代码层客户端 `client.mjs` 抽象了后端地址,换 origin 即可,不破坏端到端加密。
- **无意外账单**:自建无按量计费;不像 KV 超额虽不扣钱但会断服务。
- **诚实限制**:① 单机房无 SLA,机器挂=同步断(降级本地不丢);② 国内延迟 150-250ms(同步非实时,可接受);③ 运维时间成本(补丁/备份)归用户,不归用户付费。

## 红线(违反即 reject)

1. `core/` 禁止访问 DOM / `Date.now()` / `localStorage`。新增 `core/sync.js` 遵守:`crypto` 作参数注入(默认 `globalThis.crypto`)。
2. 前端零依赖:加密只用 `globalThis.crypto.subtle`。**后端独立目录 `sync-server/`,不受前端零依赖红线约束**(可用 `node:sqlite` 内置模块),但保持零 npm 依赖以与气质一致。
3. **端到端加密不可妥协**:后端上**只存密文**。任何后端代码解密/解析 blob 内容、或把主密码收上来 = 立即 reject。主密码**绝不离开设备**。
4. 改接口(函数签名/状态字段/DOM id)必须同步 `SPEC.md` + 两侧 + 测试。每单元 `npm test` 全绿、`node --check` 全过。
5. **不动 `mergeRecords`**(D27 防线)——同步合并是新函数 `mergeForSync`。
6. **不动计数 Worker**(`worker/`)——同步走自建后端,与计数 Cloudflare Worker 完全解耦。

## 部署前提(用户在甲骨文实例上做,非代码单元)

用户需在甲骨文凤凰城实例完成(执行 agent 写代码,用户部署):
1. 子域名 `sync.eigentime.org` A 记录指向甲骨文实例的**现有 IPv4 公网 IP**(与现有跑代理服务的域名**同一个 IP**)。
   - **灰云(DNS only)**:不走 Cloudflare 代理,直连甲骨文。原因:同步场景需 nginx 精准掌控 CORS/OPTIONS/限流,Cloudflare 代理对自定义响应头有潜在干扰;且与现有 `kegel`/`time` 子域名的灰云直连模式一致。
   - **不解绑任何现有域名**:操作是 DNS 层面"新增一条 A 记录",不动现有任何记录、不动甲骨文机器上现有 nginx server 块。一个 IP 可挂任意多个域名,nginx 靠 `server_name` 虚拟主机分流。
   - 用 A 记录(与现有服务同款),不用 AAAA。
2. 安全组:80(certbot 申请/续期)+ 443(HTTPS)对外通。复用现有 nginx 的 443 端口(按 server_name 分流,**不需新开端口**),通常已满足,确认 80/443 对外开放即可。
3. nginx + Let's Encrypt:在**同一个现有 nginx** 里**新增**一个 `server { server_name sync.eigentime.org; ... }` 块(单元 0 提供示例配置),`certbot --nginx -d sync.eigentime.org` 单独签证书(自动续期,**不碰现有域名证书**)。
4. Node 22+ 安装(nvm 或发行版包;`node:sqlite` 在 22+ 可用,24+ 更稳)。

---

## 单元 0 — 后端单文件 + nginx 配置(核心后端)

**目标**:新建 `sync-server/server.mjs`,Node 单文件,`node:sqlite` 存密文,零 npm 依赖。附 nginx 示例配置。

### 后端契约

SQLite 文件 `sync-server/data/sync.db`,单表:
```sql
CREATE TABLE IF NOT EXISTS blobs(
  user_id TEXT PRIMARY KEY,
  blob TEXT NOT NULL,           -- 客户端 PUT 上来的密文字符串原样存,后端不解析
  updated_at INTEGER NOT NULL,
  put_count INTEGER NOT NULL DEFAULT 0  -- 限流计数辅助
);
```

端点(端口如 127.0.0.1:8787,nginx 反代 443→8787):

| 方法 路径 | 作用 | 说明 |
|---|---|---|
| `OPTIONS *` | preflight | nginx 或后端短路返回 204 + CORS 头 |
| `GET /sync?key=<userId>` | 拉密文 | `{ok:true, blob}` 或 `{ok:false, error:'none'}`(无数据)。blob 原样返回,不解密 |
| `PUT /sync?key=<userId>` body `{blob}` | 推密文 | 覆盖存储,返回 `{ok:true}`。**不验证 blob 内容**,只做 ≤1MB 防御 |
| `GET /health` | 探活 | `{ok:true}`(供 nginx/监控) |

**冲突处理**:后端**不处理**,只 last-write-wins 覆盖。合并客户端做(拉→解密→mergeForSync→加密→推)。

**限流(防滥用,必做)**:
- 同 userId PUT > 1次/10秒 → 429 `{ok:false,error:'rate'}`(用 `updated_at` 判,SQLite 内存够,无需 KV)。
- per-IP 全局:同一 IP > 20次/分钟(所有端点合计)→ 429。用内存 Map + 时间窗(进程重启清零,可接受;单机够用)。**这是防大规模刷额度的关键,nod 计数 Worker 没这条是因为计数 fire-and-forget,同步是持久存储必须防**。
- nginx 层可再加 `limit_req` 兜底(示例配置含)。

**CORS 头**(后端每响应都带,OPTIONS 短路 204):
```
Access-Control-Allow-Origin: *  (应用无 cookie/凭据,用 * 最简)
Access-Control-Allow-Methods: GET,PUT,OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
```

### 实现要点(零 npm,纯 Node)

- `node:http` 起服务(不用框架,单文件)。
- `node:sqlite`(Node 22+ 内置,需 `--experimental-sqlite` flag 在 22;24 仍可能需 flag,执行 agent 实测确认;若 flag 麻烦,降级用 `node:fs` 写 JSON 文件 per-user——更简但并发差,二选一,选能在 Node 24 跑通的)。**首选 `node:sqlite`**。
- 进程保活:附 `sync-server/sync.service`(systemd unit 示例),`ExecStart=/usr/bin/node --experimental-sqlite server.mjs`,`Restart=always`。
- 日志:console.log 到 stdout(systemd journal 接)。
- 端口仅监听 127.0.0.1(nginx 反代,不直接暴露)。

### 附 nginx 示例 `sync-server/nginx.conf.example`

```nginx
server {
  listen 443 ssl http2;
  server_name sync.eigentime.org;
  ssl_certificate /etc/letsencrypt/live/sync.eigentime.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sync.eigentime.org/privkey.pem;

  # CORS 全在 nginx 加,后端逻辑更干净
  add_header Access-Control-Allow-Origin "*" always;
  add_header Access-Control-Allow-Methods "GET,PUT,OPTIONS" always;
  add_header Access-Control-Allow-Headers "Content-Type" always;

  if ($request_method = OPTIONS) { return 204; }

  location / {
    limit_req zone=sync burst=20 nodelay;  # 见下方 limit_req_zone 定义
    proxy_pass http://127.0.0.1:8787;
  }
}
# http 块内:limit_req_zone $binary_remote_addr zone=sync:10m rate=20r/m;
```

### 验收闸门

- 本地 `node --experimental-sqlite sync-server/server.mjs`,curl 走 PUT/GET 往返:PUT `{blob:"test"}` → GET 回 `"test"` → 覆盖 → 回新值。OPTIONS 204+CORS。
- 1MB 上限拒。同 key 3s 内第二次 PUT → 429。同 IP 21次/分钟 → 429。
- 部署到甲骨文后,`https://sync.eigentime.org/health` 返回 `{ok:true}`,浏览器 devtools fetch PUT/GET 通(关键验 CORS)。
- `node --check sync-server/server.mjs` 过。
- 计数 Worker(`worker/`)**零改动**,回归正常。
- `git commit -m "feat(sync-server): 自建后端单文件(node:sqlite 存密文)+nginx CORS 示例"`

---

## 单元 1 — core/sync.js 纯函数(核心,与路线 B 同)

**目标**:新建 `core/sync.js`,纯函数可测,可迁移到 time-logger。**加密 + 合并在这一层**。与路线 B 单元 1 完全一致(后端换了,客户端纯函数不变)。

### 导出签名(固定)

```js
export function encryptBlob(plaintextObj, passphrase, crypto = globalThis.crypto)
// plaintextObj:{records, settings} → {v:1, salt:b64, iv:b64, ct:b64, iter:200000}
// JSON.stringify → UTF8 → AES-GCM。salt/iv 随机生成。

export function decryptBlob(blob, passphrase, crypto = globalThis.crypto)
// → {ok:true, data} | {ok:false, error}。错误主密码/损坏 → {ok:false} 不抛。

export function mergeForSync(local, remote)
// local/remote: records[];record 可选 ts:number(无视为 0)
// 返回 { merged, conflicts }
// 规则:1) 同 recordKey(dateStr|completedReps|totalReps|durationSec|finished)去重(不计 conflict)
//       2) 同 dateStr 不同指纹 → LWW(有 ts 取大;都无 ts 留 remote),conflicts++
//       3) 其余全保留。结果稳定(顺序无关)。

export function newUserId(crypto = globalThis.crypto) // → UUID
```

### 记录 schema 兼容(新旧版本)

- `core/storage.js` `sanitizeRecords`:接受可选 `ts`(`Math.trunc(Number)`,非法/无→不写;mergeForSync 内按缺失=0)。
- `core/stats.js` `makeRecord`:透传可选 `ts`。
- `app.js` `writeRecord`:注入 `ts: Date.now()`(Date.now 只在 app.js)。
- `tests/storage.test.mjs`:现有用例加 `ts` 断言。**旧记录不强制升级**。

### 验收闸门

新建 `tests/sync.test.mjs`,覆盖:
1. encryptBlob/decryptBlob roundtrip(对象含 records+settings)。
2. 错误主密码 → `{ok:false}`。
3. 损坏 blob(改 ct 一字节)→ `{ok:false}` 不抛。
4. 旧记录(无 ts)+ 新记录(有 ts)混合,不丢。
5. 同 dateStr 不同内容 → LWW + conflicts 正确。
6. 相同指纹 → 不叠加,conflicts=0。
7. 合并稳定(打乱顺序,merged 一致)。
8. newUserId 合法 UUID 格式。

- `npm test` 全绿。`node --check core/sync.js` 过。
- `git commit -m "feat(core): sync.js 纯函数——端到端加密 + LWW 合并 + ts schema"`

---

## 单元 2 — sync/client.mjs 浏览器客户端(可复用)

**目标**:新建 `sync/client.mjs`,ES module,浏览器 fetch,**不依赖 app.js**(可复用到 time-logger)。

### 导出

```js
export async function syncPull(origin, userId)
// GET <origin>/sync?key=<userId> → {ok, blob} | {ok:false, error:'none'|'network'}
// blob=null 表示远端无数据(首次)。

export async function syncPush(origin, userId, blob)
// PUT <origin>/sync?key=<userId> body {blob} → {ok:true} | {ok:false, error:'rate'|'network'|'too-big'}

export async function syncProbe(origin) // GET /health 探活
```

- 超时 10s(`AbortController`)。
- 错误降级:try/catch → `{ok:false,error}`,**不抛**。
- CORS/network 失败均 `TypeError: Failed to fetch` → 合并 `'network'`(无法精确区分,UX 写「连接失败,检查网络」)。
- `origin` 参数化(不硬编码,便于切甲骨文/未来换 Worker/本地开发)。

### 验收闸门

- 甲骨文后端起着,浏览器 devtools import 本模块跑 pull/push 往返(密文字符串)。
- 429/超时/断网各返回正确 error。
- `node --check sync/client.mjs` 过。
- `git commit -m "feat(sync): client.mjs 浏览器客户端(可复用,零依赖,后端地址参数化)"`

---

## 单元 3 — app.js 接线 + UI

**目标**:接进现有生命周期 + 设置弹窗 UI。**主密码不存盘,内存态**。

### 同步后端地址常量(app.js 顶部,与 COUNTER_ORIGIN 并列)

```js
const SYNC_ORIGIN = 'https://sync.eigentime.org'; // 自建甲骨文后端;换后端改这一行
```
注释写明:与计数 Worker(COUNTER_ORIGIN)解耦,不同址不同服务。

### 同步时机(无新定时器)

- 打开应用:`load()` 后,若 `sync.enabled && 主密码已输入` → 后台 `syncPull` → `decryptBlob` → `mergeForSync(local, remote)` → `save()` → `renderStats()`。任一步失败静默降级纯本地。
- `persist()` 后:debounce 2s,若启用 → `encryptBlob(data, 主密码)` → `syncPush`。失败静默,下次打开重试。
- 离线(`!navigator.onLine`)跳过。
- 首次启用:`newUserId()` 存 localStorage 独立 key `tigang_sync_user`。userId 是高熵读写凭据,泄露者可读取/覆盖密文并对弱主密码离线猜解,不得公开。

### UI(index.html 设置弹窗加一组,新增 DOM id)

```
同步(可选 · 端到端加密,数据加密后存自建服务器,项目方读不到明文)
  [ ] 启用同步              #opt-sync-enabled
  主密码(加密钥匙,不离开本机) #opt-sync-master
  [立即同步]                 #btn-sync-now
  上次同步:—                #sync-last
  同步状态:—                #sync-state
```

- 主密码**不存 localStorage**。每次开应用输主密码才能同步(诚实 UX:忘了主密码=远端密文不可恢复,本地数据不丢,重输主密码=重新开始同步)。
- 输主密码后内存 `deriveKey` 出 `CryptoKey` 用完即弃,弹窗关闭/页面关闭即丢。
- `DEFAULT_SETTINGS` 加 `sync:{enabled:false}`(只开关)。userId 走独立 key 不进 settings/exportJSON。

### 契约同步清单(本单元必做)

- `SPEC.md` §5(`DEFAULT_SETTINGS.sync`)、§8(新 DOM id,数量更新)、新增 §6.z(sync 客户端 + 时机 + 端到端加密 + 主密码内存态 + SYNC_ORIGIN 自建后端)。
- `SPEC.md` record 形态加可选 `ts`。
- `SPEC.md` 后端契约段(指向 `sync-server/server.mjs`,不进 SPEC 主体——SPEC 是前端契约;后端文档在 `sync-server/README.md`)。
- `sw.js` 升 `CACHE_NAME`(v13→)。PRECACHE 不变(无新静态文件)。
- `DEVELOPMENT.md` D31 补「app.js 接线 + 主密码内存态 + 离线跳过 + userId 独立 key + SYNC_ORIGIN」。

### 验收闸门

- 浏览器:启用+输主密码 → 关闭重开 → 输主密码 → 数据拉回。
- 第二设备同主密码 → 各练一次 → 重开两端记录都在,无叠加,冲突 LWW。
- **不同主密码** → 解密失败 → 静默降级,本地不受影响,UI 显示「解密失败」。**这是端到端加密正确表现,非 bug**。
- 离线(F12 断网)打开 → 不报错,纯本地。
- `npm test` 全绿;`node --check` 全过;DOM id 全在 index.html。
- `git commit -m "feat: 同步接线 + 设置 UI(端到端加密,主密码内存态,自建后端)"`

---

## 单元 4 — 文档 + ROADMAP 解 gate(最后)

- `sync-server/README.md`:部署步骤(子域名 DNS only / 安全组 / nginx+certbot / systemd / Node 版本),端点表,限流规则,SQLite 文件位置与备份建议。
- `DEVELOPMENT.md` D31 定稿:
  - 为什么自建甲骨文(路线对比表:C/B/Worker免费;C 的核心理由:已有 always-free、不碰 Cloudflare KV 共用配额、CORS 自主、一台机器吃下所有未来后端)。
  - 端到端加密(PBKDF2 200000 + AES-GCM,主密码不离开设备,后端只见密文)。
  - **安全诚实评估三段**:机密性(✅,主密码强度自责)、完整性(✅ GCM)、可用性(⚠️ 无账号权衡:覆盖攻击最坏=解密失败一次/本地不丢/重推恢复,这是韧性非缺陷)。
  - 花费(0,always-free;无意外账单;单机房无 SLA 的诚实限制)。
  - ts schema 向后兼容(旧记录无 ts=0)。
  - 时区(dateStr 本地 + ts 辅助 LWW)。
  - 已知限制:① PWA 不后台同步(打开才同步);② 同 dateStr 同内容(撞指纹)去重;③ 主密码丢失=远端密文不可恢复(本地不丢);④ 限流 1次/3s per userId + 20次/分 per IP;⑤ 单机房凤凰城,机器挂=同步断(降级本地不丢);⑥ 迁移性:client.mjs 抽象了 origin,未来可换 Worker 后端,端到端加密不变。
  - **仓库演进计划**:后端暂放本仓库 `sync-server/` 子目录(前后端契约同 PR、一眼对齐、首版落地最快)。`client.mjs` 强制不依赖 app.js + `origin` 参数化,为将来拆独立仓库留口子。**拆仓触发条件**:time-logger 要同步时,把 `sync-server/` 整体迁出成独立仓库(拟名 `eigentime-sync`),tigang-companion 与 time-logger 通过 git submodule 或 npm link 引用;客户端代码零改动,只是后端服务换仓库地址。遵循 ROADMAP「先验证再投入」原则——单仓库够用时不提前拆。
- `ROADMAP.md`:G2 从 Gated 移到 Next,注明「opt-in + 端到端加密 + 自建后端只见密文」。
- `SPEC.md`:全部契约落齐。
- `git commit -m "docs: D31 自建同步(端到端加密)+ G2 解 gate;sync-server/README 部署"`

---

## 给执行 agent 的提醒

- **每个单元结束 commit 一次**,不攒。验收不过不 commit。
- **不要改 `mergeRecords`**——同步合并是新函数 `mergeForSync`。
- **不要在 core 调 `Date.now()`**——ts 注入只在 app.js `writeRecord`。
- **主密码绝不上后端**——后端只有密文。任何后端代码解密/解析 blob = reject。
- **不动计数 Worker**(`worker/`)——同步走自建 `sync-server/`,完全解耦。
- **后端零 npm 依赖**——用 `node:http` + `node:sqlite`(Node 22+ 内置)。若 `node:sqlite` flag 麻烦,降级 per-user JSON 文件,选能跑通的。
- **CORS 全在 nginx 加**(示例配置已给),后端逻辑更干净。
- **DNS only(灰云)**:sync.eigentime.org 走 Cloudflare DNS 时设为不代理,直连甲骨文。
- 遇到不确定的契约/红线冲突,**停下问**,不要自创字段名。
- 单元 0 本地 `node` 起服务+curl 实测;部署到甲骨文后浏览器验 CORS(关键)。

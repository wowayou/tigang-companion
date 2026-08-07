# sync-server — 提肛陪伴多端同步后端(自建 · 端到端加密)

只存取**密文**的极小 Node 服务:零 npm 依赖(`node:http` + `node:sqlite`),
PUT/GET 覆盖式存储加密 blob,后端**永不解密、不解析内容、不收主密码**。
主密码只存在于用户设备的浏览器内存/sessionStorage 会话中,绝不离开设备。

- 前端契约见 `SPEC.md §6.z`;端到端加密 + 合并纯函数在 `core/sync.js`(可迁移 time-logger)。
- 实际部署目标:甲骨文凤凰城 always-free ARM 实例 + 1Panel 的 Docker OpenResty;完整步骤以 `DEPLOY-SYNC.md` 为准。

## 端点

| 方法 路径 | 作用 | 说明 |
|---|---|---|
| `OPTIONS *` | preflight | 短路 204 + CORS 头 |
| `GET /sync?key=<userId>` | 拉密文 | userId 必须为 UUID v4(服务端统一小写);返回 `{ok:true, blob}` 或 `{ok:false, error:'none'}`(无数据)。blob 原样返回,不解密 |
| `PUT /sync?key=<userId>` body `{blob}` | 推密文 | 覆盖存储(last-write-wins),返回 `{ok:true}`。**不验证 blob 内容**,只做 ≤1MB 防御 |
| `GET /health` | 探活 | `{ok:true}` |

冲突处理:后端**不处理**,只 last-write-wins 覆盖;合并由客户端做(拉→解密→`mergeForSync`→加密→推)。

## 限流(防滥用)

- 同 userId PUT > 1 次/3 秒 → `429 {ok:false, error:'rate'}`(用 `updated_at` 判,成功写入才刷新窗口)。
- 单 IP 全部端点 > 20 次/分 → `429`(内存 Map + 时间窗,进程重启清零;单机够用)。
- nginx 层另有 `limit_req zone=sync burst=20 nodelay` 兜底。

## SQLite 文件

- 默认 `sync-server/data/sync.db`(可由环境变量 `DB_PATH` 覆盖),单表 `blobs(user_id, blob, updated_at, put_count)`。
- **备份(必做)**:文件损坏/误删 = 全部用户远端密文丢失(端到端加密保住本地数据不丢,但全员同步状态被重置)。
- **本项目实际部署的甲骨文机已有 DRBS/restic → R2 增量加密备份**,备份路径含 `/opt`,`/opt/sync-server/data` 会被覆盖;按运维仓库规矩在 `drbs_restic_backup_paths` 显式加 `/opt/sync-server/data` 即可,**不需要下面的 cron**(见 `DEPLOY-SYNC.md` 阶段 2)。
- 下面这套 cron 热备是给**没有备份体系的裸 VPS**准备的兜底方案。SQLite 单文件,但**不要直接 cp 活文件**(可能截到半写状态),用 `.backup` 在线热备:
  ```bash
  # /etc/cron.daily/sync-backup  (chmod +x)
  DB=/opt/sync-server/data/sync.db
  BK=/opt/sync-server/data/backup
  mkdir -p "$BK"
  # .backup 是 SQLite 在线热备,不停服、不锁写(比直接 cp 更安全,cp 可能截到半写状态)
  sqlite3 "$DB" ".backup '$BK/sync-$(date +\%F).db'"
  # 删 7 天前的
  find "$BK" -name 'sync-*.db' -mtime +7 -delete
  ```
  注:需机器上有 `sqlite3` CLI;若用 `node:sqlite` 在线后备,可写个一行 node 脚本调 `db.backup()`(Node 22+ 支持)替代 `sqlite3` 命令。直接 `cp` 在写入瞬间拷贝**有风险**(SQLite 官方不建议 cp 活文件),优先用 `.backup`/`db.backup()`。
- 恢复 = 把备份文件放回 `DB_PATH` 重启 `sync` 服务。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 程序安全默认值;本项目的 `sync.service` 显式覆盖为 `172.17.0.1` 供 Docker OpenResty 访问 |
| `PORT` | `8787` | nginx `proxy_pass` 指向它 |
| `DB_PATH` | 本文件同目录 `data/sync.db` | SQLite 文件位置 |

## 部署入口

- **本项目实际 1Panel 机器**:严格按 `DEPLOY-SYNC.md`。`sync.service` 监听宿主 docker0 网关 `172.17.0.1:8787`,1Panel OpenResty 反代到同一地址;部署前必须用 `ip -4 addr show docker0` 核实网关。
- **原生 nginx 的通用 VPS**:可用 `nginx.conf.example`,但要把 systemd 的 `Environment=HOST` 改回 `127.0.0.1`,再让宿主 nginx 反代 `127.0.0.1:8787`。
- 两种形态都只应对公网开放 80/443,**不要开放 8787**。后端响应已自带 CORS 与 `Cache-Control:no-store`,反代层无需重复添加。

## 回归/卸载

- 本后端与计数 Worker(`worker/`)完全解耦:不动 `worker/` 一行。
- 要停用:`systemctl disable --now sync`,删除 DNS 记录与对应反代网站即可;用户端 `SYNC_ORIGIN` 改空或换地址即可,端到端加密不变。

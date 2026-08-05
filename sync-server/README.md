# sync-server — 提肛陪伴多端同步后端(自建 · 端到端加密)

只存取**密文**的极小 Node 服务:零 npm 依赖(`node:http` + `node:sqlite`),
PUT/GET 覆盖式存储加密 blob,后端**永不解密、不解析内容、不收主密码**。
主密码只存在于用户设备的浏览器内存里,绝不离开设备。

- 前端契约见 `SPEC.md §6.z`;端到端加密 + 合并纯函数在 `core/sync.js`(可迁移 time-logger)。
- 部署目标:甲骨文凤凰城 always-free ARM 实例,复用其现有 nginx(443 按 server_name 分流)。

## 端点

| 方法 路径 | 作用 | 说明 |
|---|---|---|
| `OPTIONS *` | preflight | 短路 204 + CORS 头 |
| `GET /sync?key=<userId>` | 拉密文 | `{ok:true, blob}` 或 `{ok:false, error:'none'}`(无数据)。blob 原样返回,不解密 |
| `PUT /sync?key=<userId>` body `{blob}` | 推密文 | 覆盖存储(last-write-wins),返回 `{ok:true}`。**不验证 blob 内容**,只做 ≤1MB 防御 |
| `GET /health` | 探活 | `{ok:true}` |

冲突处理:后端**不处理**,只 last-write-wins 覆盖;合并由客户端做(拉→解密→`mergeForSync`→加密→推)。

## 限流(防滥用)

- 同 userId PUT > 1 次/10 秒 → `429 {ok:false, error:'rate'}`(用 `updated_at` 判,成功写入才刷新窗口)。
- 单 IP 全部端点 > 20 次/分 → `429`(内存 Map + 时间窗,进程重启清零;单机够用)。
- nginx 层另有 `limit_req zone=sync burst=20 nodelay` 兜底。

## SQLite 文件

- 默认 `sync-server/data/sync.db`(可由环境变量 `DB_PATH` 覆盖),单表 `blobs(user_id, blob, updated_at, put_count)`。
- **备份(必做)**:文件损坏/误删 = 全部用户远端密文丢失(端到端加密保住本地数据不丢,但全员同步状态被重置)。SQLite 单文件,拷贝即备份。最低限度配一个 cron,每天一次热备 + 滚动保留 7 份:
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
| `HOST` | `127.0.0.1` | 只监听回环,nginx 反代,不直接暴露 |
| `PORT` | `8787` | nginx `proxy_pass` 指向它 |
| `DB_PATH` | 本文件同目录 `data/sync.db` | SQLite 文件位置 |

## 部署步骤(甲骨文实例,一次性)

1. **DNS(灰云,DNS only)**:在 Cloudflare 给 `sync.eigentime.org` 加一条 **A 记录 → 甲骨文实例的现有公网 IPv4**(与现有跑代理服务的域名同一个 IP),**不走 Cloudflare 代理**(灰云直连)。只新增记录,**不解绑任何现有域名**。用 A 记录(与现有服务同款),不用 AAAA。
2. **安全组**:确认实例安全组 80(certbot 申请/续期)+ 443 对外开放。443 复用现有 nginx(**不需新开端口**)。
3. **Node 22+**:`node:sqlite` 在 22 需 `--experimental-sqlite`,24 起无需 flag(24 实测 OK)。用 nvm 或发行版包。
4. **部署代码**:
   ```bash
   sudo mkdir -p /opt/sync-server
   sudo cp sync-server/server.mjs /opt/sync-server/
   sudo cp sync-server/sync.service /etc/systemd/system/
   # 按机器实际调整 sync.service 里的 User/Node 路径(如 nvm 装在别处)
   sudo systemctl daemon-reload && sudo systemctl enable --now sync
   journalctl -u sync -f        # 看日志
   curl -s http://127.0.0.1:8787/health   # 应返回 {"ok":true}
   ```
5. **nginx + certbot**(在**现有 nginx** 里加一个 server 块,不碰其它块):
   - 把 `nginx.conf.example` 里的 server 块加进 nginx 配置;`http { }` 顶层加 `limit_req_zone` 那一行。
   - `certbot --nginx -d sync.eigentime.org`(单独签证书,自动续期,**不碰现有域名证书**)。
   - `nginx -t && systemctl reload nginx`。
6. **验证**(关键:CORS):
   - `https://sync.eigentime.org/health` → `{ok:true}`。
   - 浏览器 devtools 跑一次 `fetch PUT` 再 `fetch GET`,确认跨域通(CORS 全在 nginx 层已带)。

## 回归/卸载

- 本后端与计数 Worker(`worker/`)完全解耦:不动 `worker/` 一行。
- 要停用:`systemctl disable --now sync`,删除 DNS 记录与 nginx server 块即可;用户端 `SYNC_ORIGIN` 改空或换地址即可,端到端加密不变。

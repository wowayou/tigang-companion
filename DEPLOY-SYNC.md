# 同步后端部署 + 端到端验收清单

> 首次部署与现有服务升级手册。首次部署需要甲骨文实例 + Cloudflare DNS/1Panel;现有服务增加容量保护时按下面的「快速升级」执行。
> 当前代码基线:后端 `sync-server/`、安全同步编排器 `sync/coordinator.mjs`、sw v21;发版前以 `main` 最新 CI 为准。
> 相关文档:`sync-server/README.md`(后端细节)、`SYNC-SPEC.md`(设计)、`SYNC-OPTIMIZE.md`(前端体验)。

---

## 现有服务器快速升级:增加容量保护(2026-08-10)

适用条件:同步服务已经在 `/opt/sync-server` 运行,现在只升级后端容量保护和前端错误提示。此次升级**不改 DNS、不改 1Panel/OpenResty、不迁移或替换 `sync.db`**。重启同步服务时会有几秒不可用,客户端会保留本地数据并在下次同步重试。

本次发布涉及以下文件:

```text
# 服务器后端
sync-server/server.mjs
sync-server/sync.service

# 前端静态站点(CI 随 main 发布)
app.js
sync/client.mjs
sync/coordinator.mjs
sw.js                       # CACHE_NAME=tigang-v21

# 运维仓库
ansible/group_vars/all.yml  # 本地真实配置,手工补 /opt/sync-server/data
```

### 1. WSL 本地:检查并发布代码

在 `tigang-companion` 仓库执行:

```bash
cd /home/forbackup/Dev/my-projects/tigang-companion
npm test
git diff --check
git status --short
```

检查修改内容无误后,按正常 Git 流程提交并推送 `main`。现有 CI 会发布前端;发布完成后浏览器会收到 `tigang-v21` Service Worker 更新提示。不要只上传 `app.js`:四个前端文件必须一起发布,否则旧缓存可能继续运行。

本次改动可用显式文件列表提交,不会把其它工作区改动带进去:

```bash
git add DEPLOY-SYNC.md app.js sw.js \
  sync-server/README.md sync-server/server.mjs sync-server/sync.service \
  sync/client.mjs sync/coordinator.mjs tests/sync-client.test.mjs
git commit -m "sync: add storage quota protection"
git push origin main
```

### 2. 甲骨文服务器:更新后端两个文件

SSH 登录后执行。以下命令假定服务器上代码仓库在 `~/tigang-companion`;若实际路径不同,只替换这个源路径,目标路径不要改。

```bash
cd ~/tigang-companion
git pull --ff-only

# 部署前检查 Node 24 和新代码语法
/opt/node24/bin/node --version
/opt/node24/bin/node --check sync-server/server.mjs

# 给旧程序和 unit 留一份可回滚副本;不碰 sync.db
sudo cp /opt/sync-server/server.mjs /opt/sync-server/server.mjs.pre-quota-20260810
sudo cp /etc/systemd/system/sync.service /etc/systemd/system/sync.service.pre-quota-20260810

# 安装新后端与 systemd unit
sudo install -o drbsops -g drbsops -m 0644 \
  sync-server/server.mjs /opt/sync-server/server.mjs
sudo install -o root -g root -m 0644 \
  sync-server/sync.service /etc/systemd/system/sync.service

sudo chown -R drbsops:drbsops /opt/sync-server/data
sudo systemctl daemon-reload
sudo systemctl restart sync
```

新 unit 默认启用:

```text
MAX_BUCKETS=10000
MAX_DB_BYTES=10737418240    # 10 GiB
```

### 3. 服务器验收

```bash
systemctl status sync --no-pager
journalctl -u sync -n 30 --no-pager
systemctl show sync -p Environment
curl -fsS http://172.17.0.1:8787/health
curl -fsS https://sync.eigentime.org/health
ss -ltnp | grep ':8787'
```

验收标准:

- `sync.service` 是 `active (running)`。
- 两个 health 请求都返回 `{"ok":true}`。
- Environment 中存在 `MAX_BUCKETS=10000` 与 `MAX_DB_BYTES=10737418240`。
- 8787 只监听 `172.17.0.1`,不是 `0.0.0.0`。
- `journalctl` 没有 `ERR_UNKNOWN_BUILTIN_MODULE`、权限错误或反复重启。

### 4. WSL 运维仓库:显式纳入 DRBS

`server-ops-oracle-always-free/ansible/group_vars/all.yml` 是被 Git 忽略的真实配置,不会被示例文件自动替换。在它的 `drbs_restic_backup_paths` 下手工加入:

```yaml
  - /opt/sync-server/data
```

然后在运维仓库根目录执行:

```bash
./drbs.sh check --ci
./drbs.sh bootstrap-check
./drbs.sh bootstrap
./drbs.sh backup-scope
./drbs.sh path-audit
./drbs.sh backup-start
./drbs.sh backup-watch
```

`backup-scope` 应列出 `/opt/sync-server/data`,`path-audit` 不应把它标成 `MISSING`。当前 profile 已有 `/opt` 兜底,所以漏做这一步不会立刻丢备份,但显式路径便于审计和恢复。

> **2026-08-10 现场状态**:生产同步后端已升级并验活;本地 `all.yml` 已加同步目录,但 Ansible
> `bootstrap-check/bootstrap` 因 sudo privilege-escalation prompt 超时而失败。服务器部署清单仍是 21 条旧路径,
> 没有独立 `/opt/sync-server/data`;旧清单中的 `/opt` 理论上覆盖数据库。决定等待 2026-08-11 定时备份,
> 以 `Result/ExecMainStatus`、新 summary/snapshot、journal 和 `restic ls latest` 实际出现 `sync.db` 四项共同验收。
> 即使 snapshot 成功,也只能证明 `/opt` 兜底有效;显式路径和 Ansible sudo 仍待修。完整判据见运维仓库
> `DRBS_RUNBOOK.zh-CN.md`「定时备份成功/失败判定」。

### 5. 前端验收

CI 发布结束后打开应用,接受更新提示并刷新。确认浏览器 DevTools/Application 中当前 Service Worker/Cache 是 `tigang-v21`,再执行一次「立即同步」。正常使用时不应看到容量错误;只有服务端达到桶数或数据库上限才显示「同步服务存储已达上限,本地数据不受影响」。

### 回滚(仅在新服务无法启动时)

```bash
sudo cp /opt/sync-server/server.mjs.pre-quota-20260810 /opt/sync-server/server.mjs
sudo cp /etc/systemd/system/sync.service.pre-quota-20260810 /etc/systemd/system/sync.service
sudo chown drbsops:drbsops /opt/sync-server/server.mjs
sudo systemctl daemon-reload
sudo systemctl restart sync
curl -fsS http://172.17.0.1:8787/health
```

回滚同样不需要碰 `/opt/sync-server/data/sync.db`。若旧副本不存在,不要猜路径或删除数据库,先查看 `journalctl -u sync -n 100 --no-pager`。

---

## 本机实际形态(2026-08-05 核实,与通用 VPS 不同)

这台甲骨文实例不是"裸装 nginx 的 VPS",而是 **1Panel 面板机**:

| 项 | 实际情况 |
|---|---|
| 反向代理 | **Docker 里的 OpenResty**(配置在 `/opt/1panel/apps/openresty/openresty/conf`),**没有原生 nginx**(`nginx -v` 报 command not found) |
| 服务托管 | 1Panel 应用走 Docker;系统级服务走 systemd(如 `hysteria-server.service`) |
| 证书 | 1Panel 面板内置「证书」功能(自动申请/续期),**不用 certbot** |
| 备份 | DRBS/restic 增量加密 → Cloudflare R2,真实配置在 `server-ops-oracle-always-free/ansible/group_vars/all.yml`。**已含 `/opt`,故 `/opt/sync-server/data` 会被兜底备份**——但按该仓库规矩仍应显式声明 |
| 登录用户 | `drbsops`(**不是 `ubuntu`**——`sync.service` 里的 User/Group 要改成 drbsops) |
| 运维红线 | 该仓库 AGENTS.md:不改 OpenResty/1Panel 配置、不新增监听端口须谨慎、live 操作由操作者本人在面板执行 |

**因此反代方案 = systemd 把后端绑定在宿主 docker0 网关 `172.17.0.1:8787` + 1Panel 面板反代同一地址。**
容器访问宿主机**不能用 `127.0.0.1`**(那是容器自己);`sync.service` 已显式设置 `HOST=172.17.0.1`,若实机网关不同必须同步修改。

## 阶段 0:确认前置

- [ ] 甲骨文凤凰城 always-free 实例已开机,SSH 能进(用户 `drbsops`)。
- [ ] 1Panel 面板能登录(反代与证书都在面板里做)。
- [ ] Node ≥ 22:`node --version`。⚠️ **本机系统 node 是 v20.20.2(NodeSource),没有 `node:sqlite`**——那是 Node 22 才加的内置模块(带 flag)、24 才稳定。v20 上启动会 `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`,**加 `--experimental-sqlite` 也救不了**。
  解法(2026-08-07 实测通过):**装一份隔离的 Node 24 专供同步服务**,不动系统 node(这台机器有 9 个 Docker 内的 node 进程:yarn/nodepassdash/RSSHub 等,升级系统 node 有连带风险):
  ```bash
  uname -m                      # 甲骨文 A1 = aarch64
  cd /tmp
  curl -fsSLO https://nodejs.org/dist/v24.10.0/node-v24.10.0-linux-arm64.tar.xz
  sudo mkdir -p /opt/node24
  sudo tar -xJf node-v24.10.0-linux-arm64.tar.xz -C /opt/node24 --strip-components=1
  /opt/node24/bin/node --version          # v24.10.0
  # 让 sync.service 指向它
  sudo sed -i 's|ExecStart=/usr/bin/node|ExecStart=/opt/node24/bin/node|' /etc/systemd/system/sync.service
  ```
  代价:这份 runtime 的安全更新要自己管(单一小众后端,可接受)。启动日志会有 `ExperimentalWarning: SQLite is an experimental feature`——**正常,不影响功能**。
- [ ] 手头能登录 Cloudflare DNS 控制台(eigentime.org 域名)。
- [ ] 确认 docker0 网关地址:`ip -4 addr show docker0`(通常 `172.17.0.1`)。

---

## 阶段 1:DNS(Cloudflare 控制台,约 2 分钟)

1. 找到实例的**公网 IPv4 地址**(甲骨文控制台 → 实例 → 公共 IP)。
   - 就是现有跑代理服务那个域名 A 记录指向的 IP,`dig <现有域名>` 能看到。
2. Cloudflare → eigentime.org → DNS → 添加记录:
   - 类型 **A**,名称 `sync`,IPv4 填上面那个 IP,**代理状态选「仅 DNS」(灰云,不走 Cloudflare 代理)**。
3. 等 30 秒 ~ 1 分钟,`dig sync.eigentime.org` 应返回该 IP(灰云不回 Cloudflare IP)。
4. **不要动**任何现有 DNS 记录(DNS 表里那些 MX/TXT/kegel/time/www)。

> 为什么灰云:同步要精准掌控 CORS/OPTIONS,Cloudflare 代理可能干扰自定义响应头;且现有 kegel/time 子域都是灰云直连模式,保持一致。
> **注意**:1Panel 申请证书(HTTP-01)时需要 80 端口能被 Let's Encrypt 访问,灰云直连正好满足;若用橙云代理会挡住验证。

---

## 阶段 2:部署后端到宿主机 systemd(约 10 分钟)

```bash
# 1. 建目录 + 拷代码(注意:先 mkdir 再 cp,否则 cp 报 "Not a directory")
sudo mkdir -p /opt/sync-server/data
sudo cp ~/tigang-companion/sync-server/server.mjs /opt/sync-server/

# 2. 装 systemd unit(装到 /etc/systemd/system/,不是 /opt/sync-server/)
sudo cp ~/tigang-companion/sync-server/sync.service /etc/systemd/system/

# 3. 改 unit:User/Group 要与实际用户一致(本机 drbsops),node 路径用 which node 确认
which node                                   # 记下绝对路径
sudo nano /etc/systemd/system/sync.service    # 改 User=drbsops / Group=drbsops / ExecStart 的 node 路径
cat /etc/systemd/system/sync.service          # ← 查看已装的 unit 就是这个路径

# 4. data/ 属主给运行用户(SQLite 要可写)
sudo chown -R drbsops:drbsops /opt/sync-server

# 5. 起服务
sudo systemctl daemon-reload
sudo systemctl enable --now sync
systemctl status sync --no-pager              # 应 active (running)
journalctl -u sync -n 30 --no-pager           # 看有无报错
curl -s http://172.17.0.1:8787/health         # 应返回 {"ok":true}
ss -ltnp | grep ':8787'                       # 应监听 172.17.0.1:8787,不是 0.0.0.0:8787
```

> **踩过的坑**:`cp x /opt/sync-server/` 在目录不存在时报 `cannot create regular file ... Not a directory` —— 先 `mkdir -p`。
> `sync.service` 装的位置是 `/etc/systemd/system/sync.service`,**不在** `/opt/sync-server/` 下。

### 备份:靠现有 DRBS/restic,不再单独配 cron

这台机器已有 DRBS(restic 增量加密 → Cloudflare R2),备份路径含 `/opt`,所以 `/opt/sync-server/data/sync.db` **会被兜底备份**。按 `server-ops-oracle-always-free` 仓库的规矩(新服务应声明精确路径),在该仓库补一行:

```yaml
# ansible/group_vars/all.yml → drbs_restic_backup_paths 下加:
  - /opt/sync-server/data
```
然后在 WSL 控制端 `./drbs.sh bootstrap` 同步配置、`./drbs.sh backup-start` 验证一次。

> 原 `sync-server/README.md` 里那套 `cron.daily` + `sqlite3 .backup` 方案是给"裸 VPS 无备份体系"写的,**这台机器不需要**(restic 已覆盖)。若想要额外的一致性快照再另说。

---

## 阶段 3:1Panel 反向代理 + 证书(面板操作,约 5 分钟)

这台机器**没有原生 nginx**,反代是 Docker 里的 OpenResty,全部在 1Panel 面板做。`sync-server/nginx.conf.example` **仅作参考,本机不用**。

1. **确认 docker0 网关**(容器访问宿主机的地址):
   ```bash
   ip addr show docker0 | grep 'inet '     # 通常 172.17.0.1
   ```
2. **1Panel → 网站 → 创建网站 → 反向代理**:
   - 主域名:`sync.eigentime.org`
   - 代理地址:`http://172.17.0.1:8787`(**不能填 `127.0.0.1`**——那是 OpenResty 容器自己)
3. **证书**:1Panel → 网站 → 该站点 → HTTPS → 申请证书(Let's Encrypt,面板自动续期)。**不用 certbot**。
4. **CORS/缓存头**:后端 `server.mjs` 已单一负责 CORS、OPTIONS 与 `Cache-Control:no-store`,**面板侧不要重复加 `Access-Control-Allow-*`**(重复头可能被浏览器判为无效)。
5. **验证**:
   ```bash
   curl -s https://sync.eigentime.org/health     # 应返回 {"ok":true}
   ```

---

## 阶段 4:端到端验收(浏览器,关键)

用**两个浏览器**(或浏览器 + 无痕窗口)测。全程手机/桌面浏览器都可。

### A. 基础连通
- [ ] `https://sync.eigentime.org/health` → `{ok:true}`。
- [ ] 浏览器 devtools console 跑:
  ```js
  fetch('https://sync.eigentime.org/health').then(r=>r.json()).then(console.log)
  ```
  返回 `{ok:true}` 且**无 CORS 报错** → CORS 通。

### B. 同主密码端到端(核心)
- [ ] 设备 A:开应用 → 设置 → 勾「启用同步」→ **同步 ID 应立即出现,无需先同步/重开弹窗** → 输主密码 `test-sync-2026` → 点「立即同步」→ 状态「已同步 / 首次同步已上传」。
- [ ] 设备 A 点「复制」按钮复制同步 ID,粘贴到设备 B 的「用其它设备的同步 ID」输入框,点「应用」。
- [ ] 设备 B(无痕):勾启用 → 输**相同**主密码 `test-sync-2026` → 点「立即同步」。
- [ ] B 拉到 A 的记录,无重复,A/B 记录一致。
- [ ] B 练一次 → 同步 → A 重开/立即同步 → A 看到 B 的新记录。

### C. 不同主密码(端到端加密证明)
- [ ] 设备 C:勾启用 → 输**不同**主密码 `wrong` → 立即同步。
- [ ] 预期:状态「主密码不符,未上传(避免覆盖远端数据)」→ **本地数据完好** → 不崩。
- [ ] DevTools Network 确认该轮只有 GET,**解密失败后没有 PUT**。
- [ ] 改回正确主密码后再次同步 → 重新 GET/解密/合并后才 PUT。

### D. 离线降级
- [ ] F12 断网 → 打开应用 → 不报错,纯本地可用。
- [ ] 断网点「立即同步」→「离线,跳过」,不卡死。
- [ ] 恢复网络 → 立即同步 → 正常。

### E. 限流
- [ ] 一次同步刚完成后立即再点,3s 窗口内二次 PUT → 「推送过频,稍后将重新拉取并重试…」。
- [ ] 约 4.5s 后自动恢复为「已同步」;Network 顺序必须是重试 GET → PUT,**不能只重放旧 PUT**。

### F. 会话级缓存(优化项)
- [ ] 输主密码 → **刷新 tab** → 主密码仍在 → 自动 pull(sessionStorage 保活)。
- [ ] **关 tab 重开** → 主密码丢(per-tab 正常)→ 进设置重输 → 恢复。
- [ ] 关闭同步开关 → sessionStorage 清空 → 不再自动同步。

---

## 阶段 5:发版收尾

- [ ] 前端 sw.js 已是 `tigang-v21`,且预缓存同时包含 `sync/client.mjs` 与 `sync/coordinator.mjs`。push 后 CI 自动部署 + 跑测试。
- [ ] 应用发布后,真机(尤其 iPhone Safari)过一遍 B/C 两条(端到端 + 解密失败降级)——iOS 是这功能最该确认的平台。

---

## 已知限制(测的时候心里有数,不是 bug)

- 同步只在**打开应用时**发生(PWA 无后台同步)。设备 B 得打开一次 app 才拉到 A 的数据。
- 同一天两次不同内容的训练,合并后**只留最新一条**(LWW,按日粒度,见 D31 限制③)。
- 主密码忘了 = 远端密文不可恢复(本地数据不丢,重输新主密码重新同步)。
- 单机房凤凰城,机器挂 = 同步断(本地降级不丢),由现有 DRBS/restic → R2 备份兜底恢复。

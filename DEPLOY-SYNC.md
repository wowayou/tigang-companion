# 同步后端部署 + 端到端验收清单

> 一次性操作。做完同步就上线。所有动作都在甲骨文凤凰城实例 + Cloudflare DNS 控制台上,不需要改代码。
> 代码已全部就绪并验收通过(commit ff25fa4..3b49ac6,后端 `sync-server/`、前端已接线、sw v14)。
> 相关文档:`sync-server/README.md`(后端细节)、`SYNC-SPEC.md`(设计)、`SYNC-OPTIMIZE.md`(前端体验)。

---

## 阶段 0:确认前置

- [ ] 甲骨文凤凰城 always-free 实例已开机,SSH 能进。
- [ ] 实例上已有 nginx 在跑(现有代理服务),`nginx -v` 有输出。
- [ ] Node ≥ 22(`node --version`),`node:sqlite` 可用(24 无需 flag,22 需 `--experimental-sqlite`)。
- [ ] 手头能登录 Cloudflare DNS 控制台(eigentime.org 域名)。

---

## 阶段 1:DNS(Cloudflare 控制台,约 2 分钟)

1. 找到实例的**公网 IPv4 地址**(甲骨文控制台 → 实例 → 公共 IP)。
   - 就是现有跑代理服务那个域名 A 记录指向的 IP,`dig <现有域名>` 能看到。
2. Cloudflare → eigentime.org → DNS → 添加记录:
   - 类型 **A**,名称 `sync`,IPv4 填上面那个 IP,**代理状态选「仅 DNS」(灰云,不走 Cloudflare 代理)**。
3. 等 30 秒 ~ 1 分钟,`dig sync.eigentime.org` 应返回该 IP(灰云不回 Cloudflare IP)。
4. **不要动**任何现有 DNS 记录(DNS 表里那些 MX/TXT/kegel/time/www)。

> 为什么灰云:同步需要 nginx 精准掌控 CORS/OPTIONS,Cloudflare 代理可能干扰自定义响应头;且现有 kegel/time 子域都是灰云直连模式,保持一致。

---

## 阶段 2:部署代码(甲骨文,约 10 分钟)

```bash
# 从你本机把 sync-server 推到甲骨文(或用 scp/git clone 同步仓库)
sudo mkdir -p /opt/sync-server/data

# 方式 A:如果你在甲骨文上 git clone 了项目仓库
sudo cp <repo>/sync-server/server.mjs /opt/sync-server/
sudo cp <repo>/sync-server/sync.service /etc/systemd/system/

# 方式 B:scp 单文件
scp sync-server/server.mjs user@<IP>:/tmp/
sudo mv /tmp/server.mjs /opt/sync-server/
```

### 3. 配置 systemd(看 sync.service 是否需要调整)

```bash
cat /opt/sync-server/sync.service   # 检查 User / ExecStart 的 node 路径
# 若 node 装在一个特殊路径(如 nvm),改 ExecStart 指向绝对路径,例如:
# ExecStart=/root/.nvm/versions/node/v24.x.x/bin/node /opt/sync-server/server.mjs
sudo systemctl daemon-reload
sudo systemctl enable --now sync
journalctl -u sync -f          # 看日志,应无报错
curl -s http://127.0.0.1:8787/health   # 应返回 {"ok":true}
```

### 4. 配置 SQLite 备份(必做,见 sync-server/README)

```bash
# /etc/cron.daily/sync-backup,chmod +x
DB=/opt/sync-server/data/sync.db
BK=/opt/sync-server/data/backup
mkdir -p "$BK"
sqlite3 "$DB" ".backup '$BK/sync-$(date +\%F).db'"
find "$BK" -name 'sync-*.db' -mtime +7 -delete
```

---

## 阶段 3:nginx + 证书(甲骨文,约 5 分钟)

1. 把 `sync-server/nginx.conf.example` 里的 **server 块**加进现有 nginx 配置(不动其它 server 块)。
2. 在 `http { }` 顶层加 `limit_req_zone $binary_remote_addr zone=sync:10m rate=20r/m;`。
3. 签证书(给新域名单独签,不碰现有):
   ```bash
   sudo certbot --nginx -d sync.eigentime.org
   ```
   certbot 会自动改 nginx 配置指到新证书。若已装过 certbot,直接这条即可。
4. 测试 + 重载:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
5. 验证:
   ```bash
   curl -s https://sync.eigentime.org/health   # 应返回 {"ok":true}
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
- [ ] 设备 A:开应用 → 设置 → 勾「启用同步」→ 输主密码 `test123` → 点「立即同步」→ 状态「已同步 / 首次同步已上传」。
- [ ] 设备 B(无痕):同样配,输**相同** `test123` → 立即同步。
- [ ] B 拉到 A 的记录,无重复,A/B 记录一致。
- [ ] B 练一次 → 同步 → A 重开/立即同步 → A 看到 B 的新记录。

### C. 不同主密码(端到端加密证明)
- [ ] 设备 C:勾启用 → 输**不同**主密码 `wrong` → 立即同步。
- [ ] 预期:解密失败 → 状态「解密失败(主密码不符或远端数据损坏)」→ **本地数据完好** → 不崩。
- [ ] 这条通=后端密文用错主密码确实解不开。

### D. 离线降级
- [ ] F12 断网 → 打开应用 → 不报错,纯本地可用。
- [ ] 断网点「立即同步」→「离线,跳过」,不卡死。
- [ ] 恢复网络 → 立即同步 → 正常。

### E. 限流
- [ ] 连点「立即同步」触发 10s 内二次 PUT → 「推送过频,稍后再试」(429)。
- [ ] 等 10s → 再点 → 成功。

### F. 会话级缓存(优化项)
- [ ] 输主密码 → **刷新 tab** → 主密码仍在 → 自动 pull(sessionStorage 保活)。
- [ ] **关 tab 重开** → 主密码丢(per-tab 正常)→ 进设置重输 → 恢复。
- [ ] 关闭同步开关 → sessionStorage 清空 → 不再自动同步。

---

## 阶段 5:发版收尾

- [ ] 前端 sw.js 已是 `tigang-v14`(优化 commit 升的)。push 后 CI 自动部署 + 跑测试。
- [ ] 应用发布后,真机(尤其 iPhone Safari)过一遍 B/C 两条(端到端 + 解密失败降级)——iOS 是这功能最该确认的平台。

---

## 已知限制(测的时候心里有数,不是 bug)

- 同步只在**打开应用时**发生(PWA 无后台同步)。设备 B 得打开一次 app 才拉到 A 的数据。
- 同一天两次不同内容的训练,合并后**只留最新一条**(LWW,按日粒度,见 D31 限制③)。
- 主密码忘了 = 远端密文不可恢复(本地数据不丢,重输新主密码重新同步)。
- 单机房凤凰城,机器挂 = 同步断(本地降级不丢),备份 cron 兜底恢复。

# KegelMate · 提肛陪伴 (tigang-companion)

一个提肛(凯格尔/盆底肌)训练陪伴应用:跟着动画节奏收缩/放松,自动打卡、统计连续天数,内置科学训练知识。零依赖 PWA,可安装到手机主屏,完全离线可用,数据只存在你自己的设备上。英文名 **KegelMate**(只改 `site/index.html` 与 manifest 各一行即可换)。

**在线体验**:<https://kegel.eigentime.org/app/>(手机浏览器打开 → 菜单 → 添加到主屏幕,即可当 App 用)。产品落地页在 <https://kegel.eigentime.org/>。

## 功能

- **节奏引导**:圆圈随"收紧/维持/放松"缩放,配倒计时、方向性提示音(可关)、语音播报(可关)、震动(可关)
- **四档方案 + 自定义**:新手入门 3s/3s、标准 5s/5s、进阶耐力 10s/10s、快速爆发 1s/1s,参考 Mayo Clinic / NHS 盆底肌训练建议;收缩时长、次数、组数均可自定义
- **维持阶段**:可选开启"收紧→维持→放松"三段式,维持时长可调,对所有方案生效
- **语音播报**:可在设置里开启(**默认关**,因为会外放),开启后报出"准备/收紧/保持/放松/休息/完成";不开也不用盯屏幕——提示音按阶段分了方向:收紧上行、维持双平音、放松下行、休息低长音
- **键盘**:空格键 = 开始 / 暂停 / 继续
- **成就徽章**:12 枚徽章(首次训练、连续打卡、累计次数/天数等阶梯解锁),完成训练时提示新解锁
- **今日目标**:默认每天完成 1 次训练即算达标,顶栏常驻连续天数
- **打卡统计**:连续天数、累计天数/次数/时长、最近 35 天热力图
- **全站计数**:顶栏「此刻多少人在做 · 总访问」——自建 Cloudflare Worker 实时统计正在训练的人数与累计访问;只上报随机 ID,不引任何第三方统计
- **健康知识**:好处、正确做法、注意与禁忌
- **每日提醒**:设定时间弹通知(网页限制:仅应用打开时生效)
- **数据自主**:localStorage 本地存储;导出备份(文件名带时间戳,iOS 走系统分享落盘)/ 导入备份(合并 / 替换两档,按指纹去重)/ 清除
- **可安装**:支持 iOS/Android 添加到主屏幕,自带应用图标,离线可用

## 运行

```bash
npm run serve        # 即 python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

任意静态服务器均可(纯静态文件,无构建步骤)。部署到 HTTPS 环境后,手机浏览器"添加到主屏幕"即可当 App 使用(离线可用)。想要完整站点形态(落地页 + /app/)可 `node tools/build-site.mjs --out dist` 后 `python3 -m http.server -d dist`。

## 测试

```bash
npm test             # 即裸 node --test  (需 Node ≥ 20;Node 24 起不要用 node --test tests/ 目录参数)
```

78 个用例全绿,覆盖训练状态机(阶段转移含维持段、暂停恢复、跨阶段追帧、不可变性)、打卡统计(连续天数边界、跨月日期算术、历史最长连续)、成就徽章(解锁判定、今日目标)、存储(损坏数据回退、设置合并、旧存档升级、备份解析净化、合并去重)。

## 目录

```
site/                 落地页(部署在站点根路径;不是 PWA 的一部分)
worker/               全站计数服务(Cloudflare Worker + Durable Object,CI 自动部署)
core/engine.js        训练状态机(纯函数,时间外部注入)
core/stats.js         打卡/连续天数/热力图数据
core/storage.js       localStorage 读写 + 备份解析/合并
core/achievements.js  成就徽章 / 今日目标(纯函数)
app.js                UI 胶水层
tools/build-site.mjs  组装部署目录(根=site/,/app/=sw.js 预缓存清单)
tools/make-icons.mjs  零依赖 PNG 图标生成脚本
index.html / styles.css / sw.js / manifest.webmanifest / icon.svg / icon-*.png
tests/                node --test 单元测试
SPEC.md               实现规格(契约文档)
DEVELOPMENT.md        技术决策记录
ROADMAP.md            增长机制路线图
```

## 部署

push 到 `main` 自动:跑测试 → `tools/build-site.mjs` 组装(落地页在根路径,应用到 `/app/`)→ 部署 GitHub Pages;同时用 wrangler 自动部署计数 Worker(需在仓库配 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`,未配置则跳过)。线上地址:`https://kegel.eigentime.org/`(落地页)与 `https://kegel.eigentime.org/app/`(应用)。移植到 Cloudflare Pages / Netlify / Vercel / 自建服务器及自定义域名说明见 [DEPLOY.md](DEPLOY.md)。

## 免责声明

本应用仅供健康锻炼参考,不构成医疗建议。急性痔疮发作期、肛周感染、肛肠术后、盆底肌过度紧张(慢性盆腔痛)人群请先咨询医生;练习中出现疼痛请立即停止并就医。

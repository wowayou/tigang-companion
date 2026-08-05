# CLAUDE.md

提肛(凯格尔)训练陪伴 PWA。零依赖、无构建,数据全在 localStorage,核心无后端。
唯二例外(均 opt-in,不引任何第三方):① 顶栏「此刻多少人在做 · 总访问」全站计数,走自建 Cloudflare Worker + Durable Object(`worker/`);② 多端同步(可选 · 端到端加密),走自建甲骨文后端 `sync-server/`(只存密文,主密码不离开设备)。客户端逻辑全在 app.js,core/ 依旧纯函数。

## 命令

```bash
npm test               # 裸 node --test(勿用 node --test tests/:Node 24 起目录参数会伪装成测试失败)— 改动 core/ 后必须跑
npm run serve          # python3 -m http.server 8080
node tools/build-site.mjs   # 组装部署目录 dist/(根=site/ 落地页,/app/=PWA);CI 会自动跑,本地预览可 -d dist
git push               # push main → Actions 自动 npm test + 组装部署 + 自动部署计数 Worker;发版要升 sw.js 的 CACHE_NAME(见 DEPLOY.md)
```

## 架构

- `core/` 纯函数层,四个模块:engine.js(训练状态机)、stats.js(打卡统计)、storage.js(存取+备份解析/合并)、achievements.js(成就徽章/今日目标)。**禁止**在 core/ 里访问 DOM、`Date.now()`、`localStorage`——时间与 storage 一律参数注入,这是可测性的根基。
- `app.js` 唯一的胶水层:DOM、定时器、音频/语音/震动/通知、计数客户端、导入导出都只在这里。
- 契约(函数签名、状态字段、DOM id)以 `SPEC.md` 为准;改接口必须同步改 SPEC + 两侧调用 + 测试。
- 部署形态:根路径 = `site/` 落地页(不是 PWA 的一部分),`/app/` = PWA(由 `tools/build-site.mjs` 组装,运行时清单单一真源 = sw.js 的 `PRECACHE_URLS`)。改预缓存清单要同时注意组装脚本。

## 约定

- 状态更新一律不可变(返回新对象);`tick` 内阶段边界按"上一边界+时长"累加,不用 nowMs 起算(防漂移,勿"简化")。
- 打卡日期用本地 `YYYY-MM-DD` 字符串,不用时间戳(时区 bug 防线,见 DEVELOPMENT.md D5)。
- 零依赖是硬约束:不加 npm 包、不引 CDN。
- 新增静态文件要同步进 sw.js 预缓存清单,并升级 `CACHE_NAME` 版本号,否则用户拿不到更新。
- 健康/医疗文案改动需保留免责声明,依据与复核提示见 DEVELOPMENT.md D6。
- 「维持」阶段(engine.js 的 `holdSec`):`holdSec=0` 必须永远等价于 v1 的两段式行为(收紧直接计数、无维持段)——这是回归防线,改状态机时先确认这条没破。
- `holdSec` 是 storage.js `DEFAULT_SETTINGS` 里的**全局键**,不是 custom 方案的字段——一个概念只允许一份真相,四个预设和自定义方案都共用同一个"维持"开关。
- 语音(`speechSynthesis`)与 AudioContext 的首次调用必须发生在用户手势(点击事件处理器)内,否则 iOS 会静默丢弃后续调用。
- `icon-*.png` 是生成产物(`tools/make-icons.mjs`,零依赖手写 PNG 编码器),项目无构建步骤,改图标设计要重跑该脚本并把新 PNG 一起提交。

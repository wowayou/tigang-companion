# CLAUDE.md

提肛(凯格尔)训练陪伴 PWA。零依赖、无构建、无后端,数据全在 localStorage。

## 命令

```bash
npm test          # 裸 node --test(勿用 node --test tests/:Node 24 起目录参数会伪装成测试失败)— 改动 core/ 后必须跑
npm run serve     # python3 -m http.server 8080
git push          # push main → Actions 自动 npm test + 部署 GitHub Pages;发版要升 sw.js 的 CACHE_NAME(见 DEPLOY.md)
```

## 架构

- `core/` 纯函数层:engine.js(训练状态机)、stats.js(打卡统计)、storage.js(存取)。**禁止**在 core/ 里访问 DOM、`Date.now()`、`localStorage`——时间与 storage 一律参数注入,这是可测性的根基。
- `app.js` 唯一的胶水层:DOM、定时器、音频/震动/通知都只在这里。
- 契约(函数签名、状态字段、DOM id)以 `SPEC.md` 为准;改接口必须同步改 SPEC + 两侧调用 + 测试。

## 约定

- 状态更新一律不可变(返回新对象);`tick` 内阶段边界按"上一边界+时长"累加,不用 nowMs 起算(防漂移,勿"简化")。
- 打卡日期用本地 `YYYY-MM-DD` 字符串,不用时间戳(时区 bug 防线,见 DEVELOPMENT.md D5)。
- 零依赖是硬约束:不加 npm 包、不引 CDN。
- 新增静态文件要同步进 sw.js 预缓存清单,并升级 `CACHE_NAME` 版本号,否则用户拿不到更新。
- 健康/医疗文案改动需保留免责声明,依据与复核提示见 DEVELOPMENT.md D6。

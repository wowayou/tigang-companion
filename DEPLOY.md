# DEPLOY — 部署手册

**产物 = 仓库根目录的静态文件本身**(无构建步骤、无环境变量、无后端)。任何能伺服静态文件且提供 HTTPS 的平台都能部署,零代码改动。

## 当前:GitHub Pages(已自动化)

- push 到 `main` → `.github/workflows/deploy.yml`:先 `npm test`,**测试全绿才部署**。
- 首次运行由 `actions/configure-pages` 自动启用 Pages;⚠️ 若报 `Resource not accessible by integration`(GITHUB_TOKEN 无权**创建** Pages 站点,2026-08 实测踩坑),本地执行一次
  `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow` 再重跑工作流即可,站点存在后该步骤永久幂等。
- 线上地址:<https://wowayou.github.io/tigang-companion/>
- 手动重发:仓库 Actions → Test & Deploy → Run workflow。

## 之后加其他平台

在工作流里追加与 `deploy-github-pages` 并列的 job(`needs: test`)即可,互不影响:

| 平台 | 做法 |
|---|---|
| Cloudflare Pages | 控制台连接仓库:构建命令留空、输出目录 `/`;或 job 内用 `cloudflare/wrangler-action` 执行 `pages deploy .` |
| Netlify | 连接仓库后 `netlify.toml` 写 `[build] publish = "."`(无 command);或直接拖拽目录 |
| Vercel | 导入仓库,Framework 选 Other,无构建命令,输出目录 `.` |
| 自建服务器 | `rsync -av --exclude .git ./ server:/var/www/tigang/`,nginx 指向该目录;**必须 HTTPS**;确保 `.webmanifest` 的 MIME 为 `application/manifest+json` |

## 移植注意(为什么到处都能跑)

- 全部资源引用相对路径(`./`),manifest 的 `start_url`/`scope` 均为 `.` → 根路径和子路径(如 `/tigang-companion/`)通吃。
- 发新版记得升 `sw.js` 的 `CACHE_NAME`(`tigang-v1` → `v2`),否则老用户会一直命中旧缓存。
- HTTPS 是硬要求:Service Worker、安装到主屏、通知权限都依赖它(localhost 除外)。
- 当前部署会连 SPEC.md、tests/ 一起发上去(纯文档,无隐私问题);要精简,可在 upload 前把白名单文件拷到 `dist/` 再上传,产物清单见 `sw.js` 的 `PRECACHE_URLS`。

# DEPLOY — 部署手册

**产物 = `tools/build-site.mjs` 组装的 `dist/` 目录**(零依赖确定性复制,无构建):
根路径放 `site/` 落地页,`/app/` 放 PWA(运行时清单单一真源 = `sw.js` 的 `PRECACHE_URLS`)。
任何能伺服静态文件且提供 HTTPS 的平台都能部署,零代码改动。

## 当前:GitHub Pages(已自动化)

- push 到 `main` → `.github/workflows/deploy.yml`:
  1. `test`:`npm test`,**测试全绿才继续**;
  2. `deploy-github-pages`:`node tools/build-site.mjs --out dist` → 上传 `dist`(落地页在根,应用在 `/app/`);
  3. `deploy-worker`:wrangler 自动部署全站计数 Worker(需先配 secrets,见下)。
- 首次运行由 `actions/configure-pages` 自动启用 Pages;⚠️ 若报 `Resource not accessible by integration`(GITHUB_TOKEN 无权**创建** Pages 站点,2026-08 实测踩坑),本地执行一次
  `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow` 再重跑工作流即可,站点存在后该步骤永久幂等。
- 当前地址(github.io,无域名时兜底):
  - 落地页:https://wowayou.github.io/tigang-companion/
  - 应用:https://wowayou.github.io/tigang-companion/app/
- 手动重发:仓库 Actions → Test & Deploy → Run workflow。

## 自定义域名(已启用:kegel.eigentime.org/app)

目标形态:**落地页在根路径,应用在 `/app/`**,与应用内相对路径天然兼容(manifest `start_url:"."`、sw.js 注册、资源引用全部相对)。

- **域名**:`kegel.eigentime.org` —— `site/CNAME` 已提交,`dist/CNAME` 随每次部署生成;GitHub Pages 按发布产物根目录的 CNAME 伺服该域名。
- **DNS**:已在 Cloudflare 为 `kegel` 子域加 CNAME → `wowayou.github.io`;仓库 Settings → Pages 的 Custom domain 也已填该域名。
- **重定向由 GitHub 自动完成**:配置自定义域名后,旧地址 `wowayou.github.io/tigang-companion/` 会 **301 → `https://kegel.eigentime.org/`**,项目无需自己写重定向;落地页对 standalone 模式(老安装的 PWA)会直接跳进 `/app/`。
- **注意(跨域名数据)**:浏览器按域名隔离 localStorage,旧地址(wowayou.github.io)的记录**不会**自动跟到新域名,且旧地址已被 301、无法再在旧地址导出 —— 有重要数据靠先前导出的备份文件在应用内「导入备份」恢复。
- **别踩的坑**:不要用 `gh api -X PUT /pages` 带 `source` 字段改部署源 —— 会从「Actions 部署」切成「分支部署」,破坏现有工作流;本项目一直走 `site/CNAME` 文件即可。
- **验收**:`https://kegel.eigentime.org/`(落地页)与 `https://kegel.eigentime.org/app/`(应用)均 200、TLS 无警告;确认 Pages 里勾选了 Enforce HTTPS。

## 全站计数 Worker(Cloudflare Worker + Durable Object)

顶栏的「此刻多少人在做 · 总访问」走 `worker/`。**不部署也不影响任何功能**(那行显示 `–`)。

### 自动部署(推荐)

1. Cloudflare Dashboard → 我的个人资料 → **API 令牌** → 创建令牌,模板选 **Edit Cloudflare Workers**(含 Durable Objects 权限);
2. 把令牌加进仓库 Settings → **Secrets and variables → Actions**:
   - `CLOUDFLARE_API_TOKEN` = 上面生成的令牌
   - `CLOUDFLARE_ACCOUNT_ID` = Cloudflare Dashboard 右侧栏的 Account ID
3. 之后每次 push 到 main,`deploy-worker` job 自动 `wrangler deploy`。**token 未配置时该 job 优雅跳过**,不会让部署失败。

### 手动部署(一次性也可)

```bash
cd worker
npm i -D wrangler     # 仅部署工具;应用本体零依赖不变
npx wrangler login
npx wrangler deploy   # 首次会创建 Durable Object
```

无论哪种方式,部署完把打印的 `https://…workers.dev` 地址填进 `app.js` 的 `COUNTER_ORIGIN`,再发一版。详见 `worker/README.md`。
当前已配置:`https://tigang-counter.eigentime.workers.dev`(已填入 app.js)。

## 之后加其他平台

在工作流里追加与 `deploy-github-pages` 并列的 job(`needs: test`)即可,互不影响:

| 平台 | 做法 |
|---|---|
| Cloudflare Pages | 控制台连接仓库:构建命令 `node tools/build-site.mjs --out dist`、输出目录 `dist`;自定义域名直接在 CF Pages 里配 |
| Netlify | 连接仓库后 `netlify.toml` 写 `[build] command = "node tools/build-site.mjs --out dist"`、`publish = "dist"` |
| Vercel | 导入仓库,Framework 选 Other,构建命令同上,输出目录 `dist` |
| 自建服务器 | `rsync -av --exclude .git ./dist/ server:/var/www/tigang/`,nginx 指向该目录;**必须 HTTPS**;确保 `.webmanifest` 的 MIME 为 `application/manifest+json` |

## 移植注意(为什么到处都能跑)

- 全部资源引用相对路径(`./`),manifest 的 `start_url`/`scope` 均为 `.` → 根路径和子路径(如 `/tigang-companion/app/`)通吃。
- 发新版记得升 `sw.js` 的 `CACHE_NAME`(`tigang-vN` 递增),否则老用户会一直命中旧缓存。
- HTTPS 是硬要求:Service Worker、安装到主屏、通知权限都依赖它(localhost 除外)。
- `dist/` 是组装产物,已被 `.gitignore` 排除;本地预览 `python3 -m http.server -d dist` 即可看到完整站点。

# 计数服务(Cloudflare Worker + Durable Object)

给 PWA 提供两个全局数字:**此刻多少人在做** + **总访问量**。
数据只经 Cloudflare,不经过任何第三方统计服务(对比:不蒜子会把访客 IP / 页面 URL 发给第三方)。

## 为什么需要它

纯前端 + localStorage 无法统计"别人现在在做"——那需要一台所有访客都能连上的服务器。
这里用 Cloudflare 免费计划的一个 Worker + Durable Object 当那台"服务器":

- 每个打开应用的人会保持一条 WebSocket 连接(心跳保活);
- 开始 / 结束训练时上报一次状态,Worker 据此广播「正在做的人数」;
- 每次页面加载上报一次访问,累计为「总访问」,存进 Durable Object 的持久化 storage(重启不丢)。

## 部署步骤(一次性,约 5 分钟)

```bash
cd worker
npm i -D wrangler        # 仅部署工具;应用本体依然零依赖
npx wrangler login       # 打开浏览器授权 Cloudflare 账号
npx wrangler deploy      # 首次部署会创建 Durable Object
```

部署完成后会打印类似 `https://tigang-counter.<你的子域>.workers.dev` 的地址。
把它填到应用根目录 `app.js` 里的 `COUNTER_ORIGIN`,再按 DEPLOY.md 发一版即可。

> 只要不把部署后的地址提交到仓库,这个地址只有你自己知道;当然它是纯计数字段,泄露也无隐私影响。

## 接口与协议

| 端点 | 说明 |
|---|---|
| `GET /stats` | `{ online, doing, visits }`,客户端用来拿初始值 / 离线兜底 |
| `POST /visit` | body `{ visitorId }`,计入一次访问,返回 `{ visits }` |
| `WS /ws` | 长连接;客户端发 `hello` / `training` / `ping`,服务端推 `stats` |

协议细节见 `worker.js` 顶部注释。

## 免费额度

免费计划对个人站绰绰有余(DO 有每月请求量与存储配额,WebSocket 连接不额外计费)。
若将来流量变大,这个 Worker 不依赖任何付费组件,直接就是生产形态。

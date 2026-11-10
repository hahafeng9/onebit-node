# onebit-node

单文件代理节点应用，部署在 OneBit Deploy（Node.js PaaS）上。一个 Node 进程拉起三件套（全部子进程守护、失败自动重启、缺配置就跳过，互不拖垮主服务）：

- **xray-core**：VLESS+WS 入站，只监听 `127.0.0.1:18001`，对外靠 Cloudflare 固定隧道进来。
- **cloudflared**：固定隧道，强制 `--protocol http2`。
- **哪吒 agent v2.4.0**：接舰队面板（`disable_command_execute: true`，只监控不开后门）。

主 HTTP 服务只监听平台注入的 `PORT`（`0.0.0.0`），只提供两个路径：

- `GET /health` → 200 JSON（存活探针）
- `GET /<SUB_PATH>` → 节点订阅（VLESS 链接的 base64），`SUB_PATH` 默认 `sub`

所有 UUID、密钥、token 只从环境变量读，代码里没有任何真实值。

## 部署步骤（OneBit Deploy）

1. 把本目录推到一个 GitHub 仓库（私有仓即可；不要把任何 `.env` 或真实参数提交进去）。
2. OneBit 控制台 → **Add app** → 连接 GitHub → 选该仓库导入。
3. 构建设置：
   - Runtime：Node.js（≥18）
   - Build command：留空或 `npm install`（本应用零依赖，装了也是空转）
   - Start command：`npm start`（即 `node index.js`）
   - 应用必须监听平台注入的 `PORT` 环境变量——代码已按此实现，不要在平台侧写死端口。
4. 在应用的 **Environment** 页逐个设置下面清单里的环境变量，保存后重新 Deploy 一次使之生效。
5. Cloudflare 固定隧道 ingress 配置（在 CF 侧建好隧道后）：
   - 节点域名 → `http://localhost:18001`（xray）
   - 订阅域名 → `http://localhost:<应用PORT>`（主 HTTP 的 `/<SUB_PATH>`；PORT 以应用日志里 `listening on 0.0.0.0:<PORT>` 一行为准）
6. 验证：访问应用公网地址的 `/health` 应返回 200；订阅地址应返回 base64，解码后是 `vless://<UUID>@<NODE_ADDR>:443?...` 的链接。

## 环境变量清单

| 变量 | 必需 | 说明 |
|---|---|---|
| `PORT` | 平台注入 | HTTP 监听端口，不用手动设 |
| `UUID` | ✅ | 节点 UUID（VLESS 入站与订阅链接共用） |
| `WS_PATH` | ✅ | WebSocket 路径，如 `/onebit-xxxxxxxx`（随机后缀） |
| `NODE_DOMAIN` | ✅ | 隧道节点域名（订阅链接的 sni/host） |
| `NODE_ADDR` | 可选 | 订阅链接的连接地址；走 CF 优选域名时填优选域名，默认 = `NODE_DOMAIN` |
| `SUB_PATH` | 可选 | 订阅路径，默认 `sub` |
| `CF_TUNNEL_TOKEN` | ✅ | Cloudflare 固定隧道 token（缺了就不起 cloudflared） |
| `NZ_SERVER` | ✅ | 哪吒面板地址 `host:port` |
| `NZ_CLIENT_SECRET` | ✅ | 哪吒客户端密钥（缺了就不起哪吒） |
| `NZ_UUID` | ✅ | 哪吒 agent 的固定 UUID |
| `XRAY_VERSION` / `CF_VERSION` / `NZ_VERSION` | 可选 | 二进制版本覆盖，默认已钉好已验证版本 |

## 注意事项

- 免费档闲置 15 分钟休眠、来请求才唤醒：休眠期间隧道与节点会断，靠外部保活巡检定时打 `/health` 唤醒（保活由外部处理，不在本应用内）。
- 免费档 1GB 内存 / 5GB 存储：运行时二进制与日志放在系统临时目录，重启后会重新下载，属正常现象。
- 订阅链接只有一条 VLESS+WS；客户端连接地址套优选域名时，把 `NODE_ADDR` 设为优选域名即可，`NODE_DOMAIN` 保持隧道域名不变。

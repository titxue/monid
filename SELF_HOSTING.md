# 自托管 Monid 工具网关

本 fork 在上游连接器与执行引擎之上增加单用户 HTTP API、MCP 服务、浏览器
控制台和运行记录。调用使用你自己的供应商账户，不需要 Monid 账户或钱包。

## 快速启动

需要 Docker 与 Docker Compose。

```bash
git clone https://github.com/titxue/monid.git
cd monid
git switch feat/self-hosted-gateway
cp .env.example .env
openssl rand -hex 32
```

将生成的随机字符串写入 `.env` 的 `GATEWAY_API_KEY`。按需在同一文件加入供应商
密钥，例如 `EXA_CREDENTIALS_API_KEY` 或 `APIFY_CREDENTIALS_API_KEY`。

```bash
docker compose up -d --build
docker compose ps
```

打开 <http://127.0.0.1:8787>，输入网关 API Key。即使尚未配置供应商，也可以
搜索工具、查看参数和预估用量；执行前必须配置对应供应商密钥。 更改 `.env` 后运行
`docker compose up -d --force-recreate`。

默认端口只绑定本机。如果要通过远程客户端访问，可以使用 SSH 端口转发：

```bash
ssh -L 8787:127.0.0.1:8787 user@your-server
```

也可以通过保留 Host 头的 HTTPS 反向代理访问。HTTP API 和 MCP 始终需要 Bearer
认证。不要把供应商密钥填进浏览器或 MCP 客户端；客户端只持有网关密钥。

## 本地 Deno 启动

使用 Deno 2.9.7 或兼容的 Deno 2.x，先完成上述 `.env` 配置：

```bash
deno task gateway
```

启动时使用现有编译器生成/读取整个连接器目录。默认监听 `127.0.0.1:8787`。

## 环境变量

| 变量                        | 默认值            | 用途                                     |
| --------------------------- | ----------------- | ---------------------------------------- |
| `GATEWAY_API_KEY`           | 必填              | HTTP/MCP 的统一 Bearer 密钥              |
| `GATEWAY_PORT`              | `8787`            | 本地监听端口 / Compose 宿主机端口        |
| `GATEWAY_HOST`              | `127.0.0.1`       | 本地监听地址；容器内部固定为 `0.0.0.0`   |
| `GATEWAY_DATA_DIR`          | `.output/gateway` | 运行记录目录                             |
| `GATEWAY_ALLOWED_PROVIDERS` | 全部              | 逗号分隔的供应商白名单，例如 `exa,apify` |
| `GATEWAY_CATALOG_PATH`      | 自动编译          | 可选的预编译 catalog JSON 路径           |

供应商沿用上游变量命名：`<PROVIDER>_CREDENTIALS_<FIELD>`。 单密钥供应商也接受
`<PROVIDER>_API_KEY`；`inspect` 返回准确的变量名称。
`.env`、生成的目录与运行数据均不提交到 Git，也不进入 Docker 构建上下文。

## MCP

Streamable HTTP 地址：`http://127.0.0.1:8787/mcp`。

支持自定义 HTTP Header 的 MCP 客户端可以使用以下配置：

```json
{
    "mcpServers": {
        "monid-local": {
            "url": "http://127.0.0.1:8787/mcp",
            "headers": { "Authorization": "Bearer <你的网关 API Key>" }
        }
    }
}
```

客户端的具体配置结构可能不同。服务没有 OAuth 登录流程，需要客户端支持 Bearer
Header。

提供 `discover`、`inspect`、`estimate`、`run`、`get_run`、`list_runs`、
`stop_run` 七个工具。推荐流程：发现 → 查看参数 → 预估 → 执行 → 查询结果。

## HTTP API

除 `/` 和 `/healthz` 外，所有路由都需要
`Authorization: Bearer <GATEWAY_API_KEY>`。

| 方法 | 路径                         | 用途                                   |
| ---- | ---------------------------- | -------------------------------------- |
| GET  | `/v1/providers`              | 供应商与配置状态                       |
| POST | `/v1/discover`               | 本地关键词搜索、供应商/分类筛选        |
| POST | `/v1/inspect`                | 输入/输出结构、用量模型、配置要求      |
| POST | `/v1/estimate`               | 校验参数并预估供应商用量，不请求供应商 |
| POST | `/v1/run`                    | 提交任务，始终返回 202 和 runId        |
| GET  | `/v1/runs?limit=20&cursor=…` | 最近运行摘要，cursor 分页              |
| GET  | `/v1/runs/:runId`            | 状态、输出、用量和供应商错误分类       |
| POST | `/v1/runs/:runId/stop`       | 请求停止支持停止的任务                 |

`inspect`、`estimate`、`run` 接受 `{ "id": "exa#search" }`，也接受
`{ "provider": "exa", "endpoint": "/search" }` 来选择端点。

执行参数沿用上游的 `RunInput`：

```json
{
    "id": "exa#search",
    "input": {
        "body": { "query": "self-hosted agent tools", "numResults": 3 }
    }
}
```

其他接口可能需要 `input.queryParams` 或 `input.pathParams`，请先 inspect。
这是本地引擎接口，不能将托管 Monid 文档中的价格和所有请求例子直接照搬。

例如，在终端手动设置网关密钥后：

```bash
export GATEWAY_API_KEY='<你的网关 API Key>'
curl http://127.0.0.1:8787/v1/discover \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"twitter","limit":5}'
```

## 运行状态与费用

状态包括 `STARTING`、`RUNNING`、`STOPPING`、`COMPLETED`、`FAILED`、
`STOPPED`、`TIMED_OUT`、`UNRESOLVED`。

- `COMPLETED` 仅表示执行流程结束。检查 `isProviderError` 和
  `providerResponse.httpStatus`，供应商限流或错误也可能是 COMPLETED。
- `estimatedUsage` / `usage` 是供应商原有的信用点或其他计量单位，**不是统一
  美元报价或账单**。实际扣费由供应商账户及你的套餐决定。
- 停止请求返回 `STOPPING`，需继续查询最终状态。`UNRESOLVED` 表示引擎未能
  确认上游结算/停止结果，需在供应商侧核对。
- 网关/引擎将供应商错误计为零用量，不代表供应商必然不会收费。
- 异步运行状态在轮询之间持久化。重启后恢复已知上游任务，不重复 start。 start
  中途崩溃且没有持久化上游句柄时，记录为 FAILED；重新提交前核对供应商。
- 停机时保留异步任务供重启恢复；`docker compose down` 不会自动停止上游任务。
  若要停止任务，应先调用 stop API 并确认最终状态。

## 首版边界

搜索采用本地关键词匹配（包含少量中文关键词映射），没有依赖 LLM 的语义路由。
账号是单用户、共享供应商密钥，没有钱包、统一定价、OAuth 或多租户隔离。
手机号、邮箱等需要资源生命周期管理的端点显示为不支持，并在执行前拒绝。
同步端点不支持中途停止；异步停止需要连接器本身声明 stop。 运行数据是本机 JSON
文件，Compose 使用 `gateway-data` volume。只运行一个网关
实例；备份和保留策略由部署者管理。不同 catalog hash 的未完成任务不自动恢复。

## 验证

```bash
deno task check
deno task test
deno task gateway:test
docker compose up -d --build
```

网关集成测试使用真实编译器/执行引擎和模拟供应商响应，验证认证、密钥注入、
参数校验、同步/异步执行、停止、超时、持久化、重启恢复，以及官方 MCP 客户端。
模拟响应不证明真实供应商可用性。配置自己的密钥后，再对所需工具做小样本验证。

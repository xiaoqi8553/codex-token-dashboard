# Codex Token 用量

本地优先的 Codex token 用量看板，也支持部署成 Netlify 静态公开站。核心原则：真实数据默认留在你的电脑或浏览器里，不上传。

## 快速开始

本地自动扫描模式：

```bat
start-dashboard.bat
```

或：

```bash
npm start
```

默认地址：

```text
http://127.0.0.1:8787
```

如果端口被占用，会自动尝试 `8788`、`8789`。

## 两种使用模式

### 本地 Node 模式

- 读取本机 `~/.codex/sessions`。
- 支持增量生成 `data/usage-index.json`。
- 支持导入中转站 CSV。
- 适合自己长期看真实用量。

### Netlify 静态模式

- 只托管 `index.html` 和 sample-data。
- 不存在服务器扫描能力，也不能自动读取访问者电脑。
- 用户必须手动选择 `sessions` 文件夹、`usage-index.json`、快照 JSON 或中转站 CSV/JSON。
- 解析在浏览器本地完成，不上传文件。
- 默认隐藏完整路径、完整 session id 和原始对话内容。

## npm scripts

```bash
npm start      # 启动本地看板
npm run dev    # 启动本地看板
npm run scan   # 只扫描并更新 data/usage-index.json
npm run build  # Netlify 静态构建检查
```

## Netlify 部署

1. 把项目推到 GitHub。
2. 在 Netlify 导入仓库。
3. Build command 使用：

```bash
npm run build
```

4. Publish directory 使用：

```text
dist
```

构建脚本只会把 `index.html`、`sample-data/` 和必要静态文件复制到 `dist/`，不会发布 `server.js`、`data/`、`config.json` 或真实日志。部署后，页面会因为没有 `/api/usage` 自动进入“公开静态演示版”，并默认加载 `sample-data/demo-usage-index.json`。访问者可以直接查看完整看板，也可以手动导入自己的本地数据。

## 配置

复制示例配置：

```bash
copy config.example.json config.json
```

主要配置：

```json
{
  "sessionsDir": "",
  "port": 8787,
  "host": "127.0.0.1",
  "autoOpenBrowser": false,
  "defaultDateRange": "7d",
  "allowPublicAccess": false,
  "publicAccessToken": "",
  "dashboardPassword": "",
  "anonymizeData": false
}
```

环境变量也可覆盖：

```text
PUBLIC_ACCESS=false
DASHBOARD_PASSWORD=
ACCESS_TOKEN=
ANONYMIZE_DATA=true
HOST=127.0.0.1
PORT=8787
CODEX_SESSIONS_DIR=
```

如果 `PUBLIC_ACCESS=true` 但没有 `DASHBOARD_PASSWORD` 或 `ACCESS_TOKEN`，服务会拒绝启动。

## 导入数据

页面支持：

- `.codex/sessions` 文件夹：浏览器本地解析 JSON/JSONL/log/txt。
- `data/usage-index.json`：直接读取本地索引。
- 中转站 CSV/JSON：按 `relay` 来源统计。
- 脱敏快照 JSON：只读展示。

常见中转站字段：

```text
timestamp / time / date / created_at
session_id / sessionId / conversation_id / request_id / id
model / model_name
input_tokens / prompt_tokens / input
cached_input_tokens / cached_tokens / cached
output_tokens / completion_tokens / output
total_tokens / total / tokens
```

## 数据字段和口径

核心字段：

```text
source: official_plus / relay / unknown
inputTokens
cachedInputTokens
outputTokens
totalTokens
activeTokens = max(inputTokens - cachedInputTokens, 0) + outputTokens
cache_hit_rate = cachedInputTokens / inputTokens
estimated
```

真实统计来自明确 usage 字段，例如：

```text
input_tokens
cached_input_tokens
output_tokens
total_tokens
last_token_usage
total_token_usage
```

如果没有 usage 字段，会按文本长度估算，并标记：

```json
"estimated": true
```

页面会显示“含估算”或“估算”，不会把估算数据伪装成真实数据。

## 脱敏快照

可以导出：

- `codex-token-snapshot-YYYY-MM-DD.json`
- `codex-token-snapshot-YYYY-MM-DD.html`

快照包含聚合统计和脱敏 records，不包含：

- 原始对话内容
- 完整本机路径
- 完整 session id
- `detailText`

## 开源安全

`.gitignore` 已排除：

- `data/usage-index.json`
- `data/imports/`
- `config.json`
- `.env`
- `logs/`
- 真实 `.codex/sessions` 日志

`sample-data/` 只能放模拟数据。

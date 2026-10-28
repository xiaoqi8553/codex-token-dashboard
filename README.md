# Codex Token 用量看板

本地优先的 Codex Token 工程级用量工作台。支持官方 Plus、中转站导入、缓存命中率、任务复盘、明细审计和脱敏快照，并可部署到 OpenAI Sites、Netlify 与 GitHub Pages。

> 核心原则：真实数据默认留在你的电脑或浏览器里，不上传。

![Codex Token Dashboard cover](screenshots/project-cover.svg)

[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.2-17202e.svg)](CHANGELOG.md)
[![OpenAI Sites](https://img.shields.io/badge/deploy-OpenAI%20Sites-275dcc.svg)](https://codex-token-dashboard.hazel-saepemx.chatgpt.site)
[![Netlify Demo](https://img.shields.io/badge/demo-codetoken.netlify.app-2f6fed.svg)](https://codetoken.netlify.app/)
[![GitHub Pages](https://img.shields.io/badge/pages-github.io-111827.svg)](https://xiaoqi8553.github.io/codex-token-dashboard/)

## 在线演示

- OpenAI Sites: https://codex-token-dashboard.hazel-saepemx.chatgpt.site
- Netlify Demo: https://codetoken.netlify.app/
- GitHub Pages Demo: https://xiaoqi8553.github.io/codex-token-dashboard/
- GitHub: https://github.com/xiaoqi8553/codex-token-dashboard

Notion 中可嵌入看板并持续显示本机数据。Windows 首次运行 `setup-notion-sync.bat` 后，本机服务会随 Windows 登录自动启动；Notion 桌面版直接连接本机只读接口，Chrome 网页版仍可使用扩展，连接后每 5 秒刷新，不需要反复启动或手动同步。会话数据不会经过 Notion，也不会上传。扩展安装步骤见 extension/README.md。

OpenAI Sites 生产站与仓库中已经推送的版本保持同步；默认采用仅所有者可访问的私有发布方式。

公开演示站默认加载模拟数据，不会读取访问者电脑。用户可以通过顶部“导入数据”菜单选择自己的 `usage-index.json`、脱敏快照、中转站 CSV/JSON，也可以选择 `.codex` 根目录，同时统计 `sessions` 和 `archived_sessions`。所有解析都发生在浏览器本地，解析结果会保存在当前浏览器的 IndexedDB 中，重新打开同一网址时自动恢复。

## 界面预览

![Dashboard preview](screenshots/dashboard-preview.svg)

## 主要功能

- 自动扫描本地 `.codex/sessions` 与 `archived_sessions`，支持 JSON / JSONL / log / txt 和 `.jsonl.zst` 压缩历史。网页推荐选择 `.codex` 根目录以包含归档，解压与统计均在本机完成。
- 识别 `usage`、`token_usage`、`last_token_usage`、`total_token_usage` 等 token 字段。
- 支持官方 Plus、中转站、unknown 来源分开统计。
- 缺少精确 usage 时按文本长度估算，并明确标记 `estimated: true`。
- 支持中转站 CSV / JSON 导入。
- 支持总览卡片、今日状态卡、每日趋势、输入/输出/缓存占比、缓存命中率趋势、Top 会话、按模型统计。
- “用量与输出速度”支持完成回合的 Token/s、加权平均速度、首 Token 等待和模型对比；使用日志提供的回合耗时（含思考与工具等待），不将其称为纯流式生成速度，缺少有效计时的记录不参与计算。
- 支持 AI 使用日历，用热力图查看每日 Token、active tokens、输出、缓存命中率和记录数。
- 支持任务复盘，用本地规则识别写代码、调试、前端 UI、文档、部署、数据分析、重构、项目规划等任务类型。
- 今日状态卡支持手动授权定位后查询 Open-Meteo 天气；不会自动读取位置。
- 明细表支持搜索、筛选、排序、分页、多选、选中导出 CSV / JSON。
- 支持脱敏快照 JSON / HTML，适合公开分享。
- 支持本地 Node 模式、浏览器导入模式、Netlify 静态演示版。

## 快速开始

### Windows 双击启动

```bat
start-dashboard.bat
```

默认打开：

```text
http://127.0.0.1:8787
```

如果 `8787` 被占用，会自动尝试 `8788`、`8789`。

### npm 启动

### Windows 桌面应用

桌面端有两条独立的数据通路，互不依赖：

**一、托盘用量速览（主入口，零服务依赖）**

点击托盘图标弹出 CodexBar 风格的用量面板，直接显示：

- **会话额度**（5 小时窗口）与 **每周额度**（7 天窗口）的已用百分比、重置倒计时
- **pace 提示**：把已用百分比和窗口已流逝时间做对比，判断「会不会提前用尽」
- **今日用量**：tokens、请求数、输出量、缓存命中率，右侧带近 14 天迷你柱图
- **累计与明细**：展开看输入/缓存/输出/推理拆分、会话数与请求数

这些数据由 `desktop/data/codex-store.cjs` 直接读取 `~/.codex/sessions` 下的 JSONL 会话日志得到，**不启动 HTTP 服务、不加载网页看板**。读取条 `rate_limits` 字段拿到配额，按文件 size/mtime 做增量解析，索引缓存在用户数据目录，所以首次全量扫描（本机约 5 秒）之后每次打开都是毫秒级响应。

面板收起态约 556px 高，展开明细会自动长高。左键托盘切换面板，右键仍是原生菜单（同步、开机启动、退出），双击直接开完整看板。

**二、完整看板（独立窗口，不走网页）**

点面板里的「打开完整看板」会打开 `desktop/dashboard.html`——一个独立的原生窗口，由 `dashboard-preload.cjs` 从同一个 `CodexStore` 取数，**不启动 HTTP 服务、不加载 `index.html`**。

看板内容：

- **额度卡片**：5 小时窗口 / 7 天窗口的已用百分比、重置倒计时、pace 判断；今日用量带「昨日同期」对比
- **用量趋势**：按天堆叠柱图（缓存命中 / 输入 / 输出），支持 7 / 14 / 30 天与全部区间，悬停看当日明细
- **模型分布 / 项目分布**：按区间重算占比，模型来自 `turn_context.model`，项目来自 `session_meta.cwd`
- **活跃时段**：24 小时聚合的工作节奏
- **会话记录**：按 `session_id` 合并续跑产生的多个 rollout 文件，展示项目、模型、用量、请求数、时长

明细扫描与弹窗的轻量索引相互独立：`CodexStore.buildDetail()` 流式读取全部会话日志（分块，不整块进内存），结果按文件 size/mtime 增量缓存在 `data/codex-detail-cache.json`，所以第二次打开是几十毫秒。

**三、旧版网页看板（可选）**

托盘右键 → 「打开旧版网页看板」才会拉起 `server.js` + `index.html`，提供 Token 日历、来源归因、任务与项目复盘、输出速度、明细审计、导入导出、账号快照及 Notion 本机同步。不打开时这些服务完全不运行，端口 8787–8789 不占用。

**关于用量口径（重要）**

日志里有两套数字，含义不同，混用就会算出离谱的总量：

| 口径 | 算法 | 本机实测 | 用途 |
|---|---|---|---|
| **累计**（界面显示） | 磁盘日志 ∪ 旧版索引，**按天取大者**后再求和 | **5.73B** / 41,161 条 / 135 天 | 「累计 tokens」 |
| 仅磁盘日志 | 每条 `token_count` 的 `last_token_usage` 逐轮累加 | 约 2.4B | **不完整**，早期 rollout 已被清理 |
| ~~跨文件求和~~ | 把每个 rollout 文件的最后一个 `total` 直接相加 | 3.78B | 错误，续跑会重复计算 |
| ~~线程累计相加~~ | 每个 `session_id` 取 `total_token_usage.total_tokens` 最大值再相加 | 约 6.1B | 错误，续跑会把旧累计算两遍 |

两个易踩的坑，方向正好相反：

1. **续跑（resume）会让同一会话生成多个 rollout 文件**，新文件的 `total_token_usage` 带着此前的累计值。直接把各文件 `total` 相加会重复计入，所以累计必须用逐轮 `last_token_usage` 累加，而不是各会话 `total` 相加。
2. **Codex 会清理/压缩早期 rollout**，磁盘上往往只剩最近几十天。本机 `~/.codex/sessions` 现在只有 33 个文件、覆盖 53 天，而实际用了 135 天——只扫磁盘会少算一多半，这正是「明明用了 5.7B，看板只显示 2.4B」的原因。

因此桌面端启动时会读取旧版网页看板留下的 `data/usage-index.json`（里面保存了历史上扫到过的每一条请求），用 `desktop/data/history-baseline.cjs` 把它压成按天聚合的 `history-baseline.json`（本机 279KB），再和磁盘扫描结果**按天取大者**合并：同一天两边只会重叠、不会互补，取大者既补回被清理的历史，又不会把同一天算两遍。

自检：

```bash
node scripts/dev-audit-usage.cjs     # 逐条对比四种口径
node scripts/verify-usage-merge.cjs  # 校验合并后总量与索引原始总量是否一致
```

一个可以自查的合理性约束：单次请求的输入不可能超过模型上下文窗口（本机日志里是 258,400）。5.73B ÷ 41,161 次请求 ≈ 139K/次，落在窗口以内；如果算出来每轮上百万，说明分母（请求数）取错了。

#### 运行与打包

```bash
npm install
npm run start:desktop
```

生成 Windows 安装程序：

```bash
npm run desktop:build
```

安装包位于 `release/desktop/`。用户运行安装包后无需另外安装 Node.js；应用默认读取 `~/.codex/sessions`，本地索引、导入文件、设置和日志存放在 Windows 用户数据目录。首次启动会迁移仓库 `data/` 和 `config.json`（若存在），卸载应用默认保留这些数据。桌面版与浏览器版可共用本机 8787–8789 服务。

启动异常时可查看用户数据目录下的 `logs/desktop.log`（启动阶段与数据初始化记录）和 `logs/desktop-backend.log`（完整看板服务输出）。

`npm run desktop:dir` 可生成免安装目录，适合本机验证。构建应用需要联网获取 Electron / Windows 安装包工具。未签名安装包可能显示 Windows SmartScreen 提示。

免安装目录生成后，可在桌面创建快捷方式：

```bash
npm run desktop:shortcut
```

默认指向 `release/desktop/win-unpacked/Codex Token.exe`；如需指向其他位置，追加 `-- --target "D:\path\Codex Token.exe"`。该脚本走 Electron 原生 `shell.writeShortcutLink`，不依赖 WScript.Shell COM，因此在受限环境下同样可用。

```bash
npm start
```

常用脚本：

```bash
npm start      # 启动本地看板
npm run dev    # 启动本地看板
npm run scan   # 只扫描并更新 data/usage-index.json
npm run build  # 构建 OpenAI Sites / Netlify / GitHub Pages 发布目录
npm run visual:shot  # 生成 UI 验收截图
npm run visual:test  # 生成截图并自动检查明显视觉问题
```

## 三种使用模式

### 1. 本地 Node 模式

适合自己长期查看真实用量。

```text
.codex/sessions -> server.js -> data/usage-index.json -> /api/usage -> index.html
```

特点：

- 自动读取本机 `~/.codex/sessions`。
- 支持增量扫描，未变化文件会复用旧解析结果。
- 可以导入中转站 CSV / JSON。
- 默认只监听 `127.0.0.1`，不公开到公网。

#### 在 Notion 中使用

Notion 中的持续同步首次运行 `setup-notion-sync.bat` 后即可自动工作。它为当前用户配置登录时启动本机服务；Notion 桌面版直接读取 127.0.0.1 的只读用量接口，Chrome 网页版可通过扩展读取同一接口。首次连接若出现“允许访问本地网络”，选择允许即可。目录扫描、索引和会话数据均由原有本机 Node 服务处理。完整安装和故障排查见 extension/README.md。

### 2. 浏览器导入模式

适合不启动 Node 服务，直接在网页里本地解析。

支持导入：

- `.codex/sessions` 文件夹
- `data/usage-index.json`
- 脱敏快照 JSON
- 中转站 CSV / JSON

文件通过浏览器 File API 在本地解析，不会自动上传。

在 Chrome / Edge 等支持 File System Access API 的浏览器里，普通标签页打开托管站点后，点击顶部“导入数据” -> “连接并持续同步 .codex 文件夹”，推荐选择 `.codex` 根目录以包含归档。页面会把完整解析结果和文件夹授权句柄保存在浏览器 IndexedDB 中。下次打开同一个网址时会直接恢复上次数据；如果文件夹权限仍有效，页面会立即自动同步最新日志，回到前台也会检查更新，无需每次点击。Notion 嵌入页可通过本机 Chrome 扩展复用本地 Node 扫描。

Notion 桌面版不需要 Chrome 扩展即可持续读取本机数据；Chrome 网页版会优先使用扩展。若本机服务未启动，页面会保留已有缓存并提示重新连接。

## 页面模块

0.7.2 使用左侧工程工作区导航和容器响应式数据组件，按以下页面组织：

- **运行总览**：核心指标、今日状态、每日 Token 柱状趋势、Token 构成、使用趋势、来源和模型统计。
- **AI 使用日历**：类似 GitHub contribution graph 的热力图，可切换总 Token、active tokens、输出 Token、缓存命中率、记录数。点击日期会自动筛选明细表到当天。
- **任务复盘**：基于本地规则识别任务类型，并统计各类任务消耗。识别结果仅供参考，用户可以在页面里手动修正，修正结果只保存在浏览器 `localStorage`。
- **用量明细**：逐条 usage 记录，支持排序、搜索、筛选、分页、多选和导出。
- **系统设置**：展示当前模式、数据来源、隐私边界、定位、版本和部署方式。

今日状态卡中的定位必须由用户主动点击授权才会读取。授权后，页面会用粗略经纬度请求 OpenStreetMap 反查城市名，并请求 Open-Meteo 获取天气；这些请求只在用户点击授权后发生，不会上传 sessions 或原始对话内容。

## UI 视觉验收

视觉标准和组件防错约束写在 [`docs/UI_ACCEPTANCE.md`](docs/UI_ACCEPTANCE.md)。其中明确要求关键数字不得裁切、同排 KPI 必须对齐、低密度柱图数值不得小于 12px，并同时验证浅色、深色和三种标准宽度。

每次改 UI 后执行：

```bash
npm run ui:shot
npm run ui:audit
npm run ui:report
npm run visual:test
```

### 手动保存 Codex 账号快照

切换账号并完成登录后，在“系统设置”点击“保存当前账号”即可。看板会从当前 Codex 登录信息自动识别邮箱，把 `~/.codex/auth.json` 和 `~/.codex/config.toml` 保存到现有的 `~/.codex/XQ_acc/<当前邮箱>/`，并为同名快照保留覆盖前的备份；识别不到邮箱时自动使用账号 ID。

也可以直接运行项目根目录的 `sync-codex-account.bat`：

```bat
sync-codex-account.bat 工作号
sync-codex-account.bat 工作号 --sync-ccswitch
```

“同步 CC Switch 当前官方配置”是显式勾选项。它只更新 CC Switch 数据库里的 Codex 官方配置，不会切换当前 provider；同步前会在 `~/.cc-switch/backups/` 留下数据库备份。若 CC Switch 正在写数据库，请先退出 CC Switch 再重试。账号快照不会上传到 Sites、GitHub 或 Token Dashboard。

GitHub Pages 版首次使用时运行一次项目目录中的 `install-account-button.bat`。它只在当前 Windows 用户下注册 `codex-token-dashboard://` 专用协议，不需要管理员权限。此后直接在网页点击“保存当前账号”，页面会生成一次性配对密钥和临时端口，自动唤起隐藏的本机组件；保存成功后组件立即关闭，不需要预先启动 BAT 或保持后台服务。

旧的 `start-account-bridge.bat` 继续作为兼容和诊断入口。协议配对信息不会写入浏览器存储，响应也不包含 auth/config、完整路径或 CC Switch 数据库路径；处理器只接受账号快照动作、8 位随机密钥和限定的本机端口。启动失败的诊断会写入 `%TEMP%\codex-account-protocol.log`。

Chrome 或 Edge 首次连接时可能询问是否允许网页访问本地网络，这是浏览器保护本机服务的正常权限提示。只能对 `https://xiaoqi8553.github.io` 允许访问；助手会拒绝其他网页来源。

脚本会启动本地页面，分别截取总览、AI 使用日历、任务复盘、明细表、设置 / 关于页面，并覆盖这些尺寸：

- `1920x1080`
- `1366x768`
- `390x844`

截图保存到：

```text
docs/screenshots/current/
```

这个目录默认被 `.gitignore` 排除，因为截图可能包含本地真实用量数据。

### 3. 托管静态版

适合通过 OpenAI Sites、Netlify 或 GitHub Pages 公开展示和开源体验。

- 只发布 `index.html`、`sample-data/` 和静态资源。
- 没有 Node 扫描能力，不能自动读取访问者电脑。
- 默认加载 `sample-data/demo-usage-index.json`。
- 用户可以手动导入自己的数据。

## 配置

复制配置模板：

```bash
copy config.example.json config.json
```

配置示例：

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
  "anonymizeData": false,
  "sourceAttributionMode": "custom-fast"
}
```

环境变量也可以覆盖配置：

```text
PUBLIC_ACCESS=false
DASHBOARD_PASSWORD=
ACCESS_TOKEN=
ANONYMIZE_DATA=true
HOST=127.0.0.1
PORT=8787
CODEX_SESSIONS_DIR=
SOURCE_ATTRIBUTION_MODE=custom-fast
```

安全规则：

- 默认 `HOST=127.0.0.1`，只允许本机访问。
- 如果 `PUBLIC_ACCESS=true`，必须设置 `DASHBOARD_PASSWORD` 或 `ACCESS_TOKEN`。
- 如果监听公网地址但没有开启公开访问保护，服务会拒绝启动。

## OpenAI Sites 部署

仓库已包含 `.openai/hosting.json` 和 Cloudflare Worker 兼容入口。Codex 的 Sites 功能会执行以下发布链路：

```text
build -> push commit -> 保存 Sites 版本 -> 生产部署
```

生产发布使用已经推送到 Git 的同一 commit，不会部署未同步的本地文件。

## Netlify 部署

1. Fork 或 clone 本仓库。
2. 在 Netlify 导入 GitHub 仓库。
3. Build command:

```bash
npm run build
```

4. Publish directory:

```text
dist
```

`scripts/build-static.js` 只会复制公开安全文件到 `dist/`，不会发布：

- `server.js`
- `data/usage-index.json`
- `data/imports/`
- `config.json`
- `.env`
- 真实 `.codex/sessions`

## 数据字段和统计口径

核心字段：

```text
inputTokens              输入 token
cachedInputTokens        命中缓存的输入 token
uncachedInputTokens      max(inputTokens - cachedInputTokens, 0)
outputTokens             输出 token
totalTokens              优先使用 total_tokens，否则 inputTokens + outputTokens
activeTokens             uncachedInputTokens + outputTokens
cacheHitRate             cachedInputTokens / inputTokens
estimated                是否为估算数据
source                   official_plus / relay / unknown
model                    模型名
sessionId                会话 ID
timestamp                记录时间
taskType                 前端规则识别或示例数据提供的任务类型
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
{
  "estimated": true
}
```

页面会显示“含估算”或“估算”，不会把估算数据伪装成真实统计。

任务复盘的 `taskType` 不参与 token 数值计算，只用于前端分析和分组展示。公开示例数据会提供模拟 `taskType`，真实数据则优先通过本地规则从标题、路径、模型等字段识别；用户手动修正后只保存在当前浏览器。

## 中转站导入字段

CSV / JSON 常见字段会自动兼容：

```text
timestamp / time / date / created_at
session_id / sessionId / conversation_id / request_id / id
model / model_name
input_tokens / prompt_tokens / input
cached_input_tokens / cached_tokens / cached
output_tokens / completion_tokens / output
total_tokens / total / tokens
```

中转站导入的数据统一标记为：

```text
source = relay
```

## 脱敏快照

支持导出：

- `codex-token-snapshot-YYYY-MM-DD.json`
- `codex-token-snapshot-YYYY-MM-DD.html`

快照会隐藏：

- 原始对话内容
- 完整本机路径
- 完整 session id
- `detailText`
- 完整 `sessionTitle`

快照适合公开分享，但不能反推出原始 sessions 内容。

## 项目结构

```text
.
├── index.html                    # 前端页面，包含 UI、图表、导入、导出逻辑
├── server.js                     # 本地 Node 服务，扫描 sessions 并提供 API
├── sites-worker.js               # OpenAI Sites / Cloudflare Worker 静态入口
├── start-dashboard.bat           # Windows 双击启动脚本
├── package.json                  # npm scripts
├── config.example.json           # 配置模板
├── netlify.toml                  # Netlify 部署配置
├── .openai/
│   └── hosting.json              # OpenAI Sites 项目标识与资源声明
├── scripts/
│   ├── build-static.js           # 构建多平台 dist/ 发布目录
│   ├── ui-review.js              # UI 截图、审计与报告
│   ├── visual-check.js           # 交互和响应式视觉冒烟测试
│   └── generate-demo-data.js     # 生成模拟 demo 数据
├── sample-data/
│   ├── demo-usage-index.json     # 公开演示数据
│   └── usage-index.sample.json   # 示例索引
├── data/
│   ├── usage-index.json          # 本地生成的真实索引，已被 .gitignore 排除
│   └── imports/                  # 中转站导入文件，已被 .gitignore 排除
└── screenshots/
    ├── project-cover.svg         # GitHub 项目介绍图
    └── dashboard-preview.svg     # README 预览图
```

## GitHub Topics 建议

建议给仓库添加这些 Topics，方便别人搜索：

```text
codex
token-dashboard
token-usage
openai
openai-sites
ai-tools
usage-analytics
local-first
privacy-first
netlify
javascript
```

GitHub 设置路径：

```text
Repository -> About -> Settings gear -> Topics
```

## GitHub 项目介绍图

仓库介绍图已经放在：

```text
screenshots/project-cover.svg
```

如果要设置 GitHub Social Preview：

```text
Repository -> Settings -> Social preview -> Upload an image
```

README 预览图在：

```text
screenshots/dashboard-preview.svg
```

## 开源安全

`.gitignore` 已排除：

- `data/usage-index.json`
- `data/imports/`
- `config.json`
- `.env`
- `logs/`
- 真实 `.codex/sessions` 日志
- `dist/`
- zip 打包文件

`sample-data/` 只能放模拟数据，不要提交真实 Codex 日志。

## 常见问题

### 托管静态版为什么不能自动读取我的 `.codex/sessions`？

浏览器网页没有权限自动读取你电脑上的任意文件夹。公开版必须由用户手动选择文件，解析也只在浏览器本地发生。

### 公开网址能记住我选择过的 sessions 文件夹吗？

可以。第一次选择文件夹并解析完成后，页面会把解析结果保存在浏览器 IndexedDB 中，下次打开同一个网址会直接恢复，不必再次导入。Chrome / Edge 还会保存文件夹句柄；权限仍有效时会在启动和回到前台时自动读取最新日志，也可点击“同步数据”手动更新。如果浏览器拒绝文件夹权限，已缓存的数据仍可查看，只是更新时需要重新授权。

### 官方 Plus Token 一定精确吗？

不一定。Codex 日志中如果有明确 usage 字段，会按真实 usage 统计；如果没有，只能按文本长度估算，并标记为 `estimated: true`。

### 为什么要看 active tokens？

`activeTokens = 未缓存输入 + 输出`。它比总 Token 更能反映“这次真正新增处理了多少内容”，因为 cached input 代表复用上下文。

### 可以公开分享自己的数据吗？

建议只分享脱敏快照，不要分享原始 `sessions` 或本地生成的 `data/usage-index.json`。

## License

MIT

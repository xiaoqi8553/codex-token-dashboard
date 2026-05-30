# Release Notes

## v0.3.0 - Public Static Demo + Local-First Imports

Codex Token 用量看板 0.3.0 把项目从“本地统计工具”升级为“本地版 + Netlify 静态公开版”的双模式产品。

### Highlights

- 新增 Netlify 静态演示版，公开网址打开后默认加载模拟数据。
- 新增浏览器本地导入，支持 `.codex/sessions` 文件夹、`usage-index.json`、脱敏快照、CSV/JSON。
- 新增脱敏快照 JSON / HTML 导出，适合公开分享用量结果。
- 修复主题三态切换，支持系统 / 浅色 / 深色。
- 优化暗色模式下总 Token 卡片、badge、图表、表格的可读性。
- 优化公开版空状态、欢迎引导、模式提示和隐私说明。
- 优化明细表交互：搜索、筛选、排序、分页、多选、选中导出。

### Data and Privacy

- 公开静态版不会自动读取访问者电脑。
- 浏览器导入模式使用 File API 本地解析，不上传文件。
- 脱敏快照默认隐藏完整路径、完整 session id、原始对话内容和 `detailText`。
- 本地 Node 模式默认只监听 `127.0.0.1`。
- `PUBLIC_ACCESS=true` 时必须设置 `DASHBOARD_PASSWORD` 或 `ACCESS_TOKEN`。

### Deployment

Netlify settings:

```text
Build command: npm run build
Publish directory: dist
```

The static build only publishes public-safe files:

- `index.html`
- `sample-data/`
- `LICENSE`
- `_headers`

It does not publish local runtime data, real sessions, imports, `.env`, or `config.json`.

### Recommended GitHub Topics

```text
codex
token-dashboard
token-usage
openai
ai-tools
usage-analytics
local-first
privacy-first
netlify
javascript
```

### Upgrade Notes

- If you already use local mode, no migration is required.
- Existing `data/usage-index.json` remains local and ignored by git.
- If you deploy to Netlify, run `npm run build` and publish `dist/`.
- If you share screenshots or examples, use `sample-data/` or a脱敏快照，不要使用真实 sessions。

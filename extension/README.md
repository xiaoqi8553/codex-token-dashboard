# Chrome 本机同步扩展

这个扩展让 Notion 中的 GitHub Pages 仪表盘读取同一台电脑上的本地 Node 服务。用量请求只访问 http://127.0.0.1:8787 至 8789 的只读 /api/usage 接口；会话内容不经过 Notion，也不会上传到其他服务。

## 一次设置，之后自动同步

1. 从项目 GitHub 页面下载并解压仓库 ZIP。
2. 双击项目根目录的 `setup-notion-sync.bat`。它会为当前 Windows 用户配置登录时自动启动本机服务，并打开 Chrome 扩展页和 `extension` 文件夹。
3. Chrome 需要用户确认首次安装：开启“开发者模式”，点击“加载已解压的扩展程序”，选择打开的 `extension` 文件夹。
4. 重新打开一次 Notion 看板。之后登录 Windows 会自动启动后台服务，Notion 看板自动连接本机统计，每 5 秒刷新；不必再启动 BAT 或点击“同步数据”。

Windows 和 Chrome 不允许网页静默安装扩展，因此扩展加载是唯一需要手动确认的一次性步骤。服务使用当前用户权限运行，不需要管理员权限。

如果 Chrome 询问扩展访问本机网络的权限，请允许。扩展只匹配 xiaoqi8553.github.io/codex-token-dashboard 看板页面，只能向本机三个候选端口发送用量 GET 请求。

## 常见问题

- 显示“未检测到本机同步扩展”：确认扩展已启用，然后重新打开 Notion 页面。
- 显示无法连接本机服务：重新运行 `setup-notion-sync.bat`；后台启动日志位于 `%LOCALAPPDATA%\CodexTokenDashboard\logs`。
- 修改扩展代码后：在 chrome://extensions 点击扩展卡片的刷新按钮，然后重新加载 Notion。
- 独立打开看板同样会自动使用本机服务；停用扩展不影响原有本地 Node、浏览器导入和公开静态模式。

扩展没有读取或修改 Notion 页面内容的权限，也不提供目录浏览权限。文件扫描仍由项目原有的本机 Node 服务完成。

# Chrome 本机同步扩展

这个扩展让 Notion 中的 GitHub Pages 仪表盘读取同一台电脑上的本地 Node 服务。用量请求只访问 http://127.0.0.1:8787 至 8789 的只读 /api/usage 接口；会话内容不经过 Notion，也不会上传到其他服务。

## 安装与启动

1. 从项目 GitHub 页面下载并解压仓库 ZIP。
2. 在 Chrome 地址栏打开 chrome://extensions，开启“开发者模式”，点击“加载已解压的扩展程序”，选择解压目录中的 extension 文件夹。
3. 双击项目根目录的 start-dashboard.bat，保持本机服务运行。服务默认使用 8787 端口；被占用时会尝试 8788 和 8789。
4. 重新加载 Notion 页面。Notion 中的 Token 看板会自动读取本机统计，并每 5 秒刷新；切换回页面时也会立即刷新。

如果 Chrome 询问扩展访问本机网络的权限，请允许。扩展只匹配 xiaoqi8553.github.io/codex-token-dashboard 看板页面，只能向本机三个候选端口发送用量 GET 请求。

## 常见问题

- 显示“未检测到本机同步扩展”：确认扩展已启用，Notion 页面已重新加载。
- 显示无法连接本机服务：运行 start-dashboard.bat 并确认终端仍在运行。
- 修改扩展代码后：在 chrome://extensions 点击扩展卡片的刷新按钮，然后重新加载 Notion。
- 独立打开看板同样会自动使用本机服务；停用扩展不影响原有本地 Node、浏览器导入和公开静态模式。

扩展没有读取或修改 Notion 页面内容的权限，也不提供目录浏览权限。文件扫描仍由项目原有的本机 Node 服务完成。

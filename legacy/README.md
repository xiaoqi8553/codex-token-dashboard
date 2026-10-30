# legacy：旧版网页看板

2026 年 10 月之前的形态。Node 服务 + 单页 HTML + Chrome 扩展 + Notion 同步，和桌面看板是两套独立代码。

现在只保留一个入口：托盘右键 →「打开旧版网页看板」。日常用桌面看板就够，这里不需要启动任何东西。

## 单独跑

```bash
npm run legacy:start          # 等价于 node legacy/server.js
```

默认 `http://127.0.0.1:8787`，被占用会试 8788、8789。

## 里面有什么

| 文件 | 作用 |
|---|---|
| `index.html` | 单页看板：日历热力图、任务复盘、来源归因、明细审计、导入导出 |
| `server.js` | 本机只读服务，顺带提供 Notion 嵌入接口 |
| `extension/` | Chrome 扩展，给网页版 Notion 做本机桥接 |
| `vendor/fzstd` | 解 `.jsonl.zst` 压缩历史 |
| `scripts/` | 旧的构建、账号桥接、视觉审计脚本 |
| `tests/` | 旧版测试，`npm run legacy:test` 跑 |

数据仍然是本地的，不上传。桌面看板不依赖这里的任何文件，删掉 `legacy/` 只会让托盘里那个菜单项失效。

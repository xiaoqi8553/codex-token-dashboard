# TokenBar

Windows 托盘里的 token 用量看板。Codex 和 WorkBuddy 用了多少、折多少钱、跑得多快，点一下图标就能看到。

只读本地日志，不联网、不登录、不上传。

## 为什么做这个

- CodexBar 只有 macOS。Windows 上没有对等的东西。
- 官方只给百分比。这个窗口到底用掉多少 token、折多少钱，它不说。
- Codex 会清理旧 rollout。本机磁盘上只剩 53 天日志，实际用了 135 天 —— 只扫磁盘会少算一多半。

## 看什么

**托盘弹窗**（左键点图标）

- 5 小时 / 7 天额度窗口：已用百分比、剩余、重置时刻，进度条上标着「时间走到哪了」，花得比时间快还是慢一眼能看出来
- 今日用量、请求数、缓存命中率，右边一条 14 天迷你柱图
- WorkBuddy 今日 / 累计 / 积分
- 等价花费（Codex + WorkBuddy 合计）

**完整看板**（双击图标）

- 5 张指标卡：额度窗口、今日用量、等价花费、输出速度、缓存命中
- 用量趋势：按天曲线，可切 7 / 14 / 30 天 / 全部，下面一行给出区间用量、区间花费、日均、单日峰值、环比
- 模型 / 项目分布：跟着区间重算，行尾带金额
- 活跃时段：24 小时 × 用量，或切到 tok/s 看每个整点的输出速度
- 会话表：项目、模型、用量、请求数、速度、花费

数据源在顶栏切换 `Codex` / `WorkBuddy`，两套复用同一套图表。

## 数据从哪来

| 来源 | 路径 |
|---|---|
| Codex 会话日志 | `~/.codex/sessions/**/*.jsonl` |
| Codex 历史索引 | `%APPDATA%/TokenBar/data/usage-index.json`（旧版网页看板留下） |
| WorkBuddy 国际版 | `~/.workbuddy-ai/projects/**/*.jsonl` |
| WorkBuddy 国内版 | `~/.workbuddy/projects/**/*.jsonl` |

WorkBuddy 两套安装的目录经常是同一批会话（国际版首次启动会把旧目录整份搬过去）。扫描时按会话 id 去重，同名只留体积更大的那份，不会重复计。

## 口径

### 累计

日志里有两套数字，混用会算出离谱的总量。累计 = 磁盘日志 ∪ 历史索引，**按天取大者**后再求和。

| 算法 | 本机结果 | 说明 |
|---|---|---|
| 磁盘日志 ∪ 索引，按天取大者 | **5.8B** / 135 天（截至 10-28） | 界面显示的就是这个 |
| 只扫磁盘日志 | 2.4B | 早期 rollout 已被清理，缺一大半 |
| 各文件最后一个 `total` 直接相加 | 3.78B | 错。续跑会重复计 |
| 每个会话取 `total_token_usage` 最大值再相加 | 6.1B | 错。续跑会把旧累计算两遍 |

两个坑方向相反：续跑（resume）会让同一会话生成多个 rollout 文件，各文件都带着之前的累计值；而 Codex 又会清理早期 rollout，磁盘上只剩最近一段。所以既要按轮累加、又要用旧索引把被清掉的历史补回来。

按天取大者只对「同一天两边都覆盖」的情况生效：重叠的天取大的，缺失的天由索引补。不是相加，所以不会重复。

### 花费

看板上的金额是**按 API 刊例价折算的等价金额**，不是订阅实扣。Plus / Max 是包月，这些 token 并没有逐笔付钱；这个数字回答的是「如果走 API 要花多少」。

```text
cost = 新增输入 / 1e6 × 输入价
     + 缓存命中 / 1e6 × 缓存价
     + 输出     / 1e6 × 输出价

新增输入 = inputTokens - cachedInputTokens
```

三个容易算错的地方：

- **输入价不能直接乘 `inputTokens`**。两家的 `inputTokens` 都含缓存命中，命中常占 95% 以上，直接乘会把成本放大几倍。
- **思考 token 不单列**。各家都把 reasoning 计入 `output_tokens`，再乘一遍就是重复计费。
- **美元项要折成人民币**。`currency: "USD"` 的模型先按 `usdCny`（默认 7.2）折算，再合计，这样 Codex 和 WorkBuddy 的钱能直接相加。

模型名用最长前缀匹配：`glm-5.3-flashx` 优先命中自己，其次 `glm-5.3-flash`，最后 `glm-5.3`。表里没有的型号按兜底价估算并标「估算」——宁可估，不记 0。

价格表在 `%APPDATA%/TokenBar/data/pricing.json`，底栏「价格表」按钮直接打开，改完重开看板生效。

### WorkBuddy

每条模型调用在 `providerData` 里带一份 usage：`inputTokens`（含缓存）、`outputTokens`、`cached_tokens`、`reasoning_tokens`、`rawUsage.credit`。

- **不能按 `conversationRequestId` 去重**。一次会话请求会拆成十几个 step，每个 step 都是一次独立调用、各带一份 usage。按请求 ID 去重会把 985 次压成 27 次。去重键用 `traceId|stepSeq`。
- **输入含缓存**。`新增输入 = input - cached`。本机缓存命中率 98%，讨论用量时两档要分开看。
- **WorkBuddy 没有 tok/s**。`providerData` 里没有轮次耗时，所以这一列的「速度」换成「积分」。

## 安装

Windows 免安装版：

```text
release/desktop/win-unpacked/TokenBar.exe
```

双击就跑，托盘常驻，关窗口不退。安装包用 NSIS：

```bash
npm install
npm run desktop:build      # 输出 release/desktop/TokenBar-Setup-<version>.exe
npm run desktop:dir        # 只出免安装目录，调试用
```

桌面快捷方式：

```bash
npm run desktop:shortcut
```

## 开发

```bash
npm install
npm start                  # 开发模式直接起 Electron
npm test                   # 桌面端 16 个测试
npm run legacy:test        # 旧网页看板 67 个测试
npm run usage:audit        # 逐条对比几种累计口径
npm run usage:verify       # 校验合并后总量与索引原始总量是否一致
npm run desktop:smoke      # 冒烟：启动、托盘、窗口生命周期
```

目录：

```text
desktop/
  main.cjs              主进程：托盘、弹窗、看板窗口、IPC
  popover.html          托盘弹窗
  dashboard.html        完整看板（单文件，无构建）
  data/codex-store.cjs  Codex 数据层：扫描、按天合并、速度、花费
  data/workbuddy-store.cjs
  data/history-baseline.cjs   旧索引 → 按天摘要（含每小时分布）
  data/pricing.cjs      刊例价表与折算
tests/                  数据层与界面断言
legacy/                 旧版网页看板，见 legacy/README.md
```

数据层的缓存都在 `%APPDATA%/TokenBar/data/`，删掉只会重扫，不影响正确性。

## 旧版网页看板

2026 年 10 月之前的版本是一个网页看板（Node 服务 + 单页 HTML + Chrome 扩展 + Notion 同步）。现在整体移到 `legacy/`，只保留托盘菜单里的「打开旧版网页看板」这一个入口。新功能都在桌面端。

## License

MIT

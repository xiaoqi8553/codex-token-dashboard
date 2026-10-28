// Dev 工具：离屏渲染 desktop/popover.html 并保存 PNG，
// 方便把版式和 CodexBar 参考设计逐项比对。
//
// 用法：
//   npx electron scripts/dev-popover-shot.cjs          # 用内置样例数据
//   POPOVER_SHOT_REAL=1 npx electron scripts/dev-popover-shot.cjs   # 用本机真实日志
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUTPUT = path.join(ROOT, "docs", "popover-preview.png");
const SNAPSHOT_FILE = path.join(ROOT, "docs", "popover-snapshot.json");
const THEME = process.env.POPOVER_SHOT_THEME === "dark" ? "dark" : "light";
const USE_REAL = process.env.POPOVER_SHOT_REAL === "1";

const WIDTH = 396;
const DESKTOP_BG = THEME === "dark" ? "#1b1c22" : "#dfe3ee";

app.disableHardwareAcceleration();
nativeTheme.themeSource = THEME;

async function writeRealSnapshot() {
  if (!USE_REAL) return;
  try {
    const { CodexStore } = require(path.join(ROOT, "desktop", "data", "codex-store.cjs"));
    const { buildBaseline, baselineIsFresh, loadBaseline, saveBaseline } = require(path.join(ROOT, "desktop", "data", "history-baseline.cjs"));
    const os = require("node:os");
    // 截图必须和真机口径一致：带上历史基线，否则累计会少一大半。
    // 注意 `electron <script>` 直接跑脚本时 app.getPath("userData") 会退回 Electron 默认目录，
    // 这里按应用名显式拼，才能读到真机上旧版看板留下的索引。
    const dataDir = path.join(app.getPath("appData"), "codex-token-dashboard", "data");
    const indexPath = path.join(dataDir, "usage-index.json");
    const baselinePath = path.join(dataDir, "history-baseline.json");
    let baseline = null;
    if (fs.existsSync(indexPath)) {
      baseline = loadBaseline(baselinePath);
      if (!baseline || !baselineIsFresh(baseline, indexPath)) {
        baseline = buildBaseline(indexPath);
        saveBaseline(baselinePath, baseline);
      }
    }
    const store = new CodexStore({
      sessionsDir: path.join(os.homedir(), ".codex", "sessions"),
      cacheFile: path.join(app.getPath("temp"), "codex-popover-shot-cache.json"),
      baseline
    });
    store.loadCache();
    // 截图要反映完整版式，近 14 天曲线需要全量索引
    await store.buildFull();
    const snapshot = store.snapshot();
    // 弹窗现在也显示 WorkBuddy 用量：这里补一份摘要，截图才反映真实版式
    try {
      const { WorkBuddyStore } = require(path.join(ROOT, "desktop", "data", "workbuddy-store.cjs"));
      const wb = new WorkBuddyStore({ cacheFile: path.join(app.getPath("temp"), "workbuddy-popover-cache.json") });
      wb.loadCache();
      await wb.build();
      snapshot.workbuddy = wb.summary();
    } catch (error) {
      process.stdout.write(`workbuddy 摘要失败：${error.message}\n`);
    }
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), "utf8");
    process.stdout.write(`snapshot: 累计 ${(snapshot.totals.totalTokens / 1e9).toFixed(2)}B · 今日 ${snapshot.today.totalTokens} · 会话 ${snapshot.quota?.session?.usedPercent}%\n`);
  } catch (error) {
    process.stdout.write(`snapshot 生成失败，回退样例数据：${error.message}\n`);
  }
}

app.whenReady().then(async () => {
  await writeRealSnapshot();

  const window = new BrowserWindow({
    width: WIDTH,
    height: 900,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: DESKTOP_BG,
    webPreferences: {
      preload: path.join(__dirname, "dev-popover-mock-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.webContents.on("console-message", (_event, _level, message) => {
    process.stdout.write(`[renderer] ${message}\n`);
  });

  await window.loadFile(path.join(ROOT, "desktop", "popover.html"));
  await new Promise(resolve => setTimeout(resolve, 900));

  async function measure() {
    return window.webContents.executeJavaScript(
      'Math.ceil(document.getElementById("panel").getBoundingClientRect().height)'
    );
  }

  async function shot(height, file) {
    window.setBounds({ x: 0, y: 0, width: WIDTH, height: Math.max(200, height) });
    await new Promise(resolve => setTimeout(resolve, 600));
    const image = await window.webContents.capturePage();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, image.toPNG());
    process.stdout.write(`saved ${path.relative(ROOT, file)} (${height}px)\n`);
  }

  const collapsed = await measure();
  await shot(collapsed, OUTPUT);

  await window.webContents.executeJavaScript('document.getElementById("more").click()');
  await new Promise(resolve => setTimeout(resolve, 500));
  const expanded = await measure();
  await shot(expanded, OUTPUT.replace(/\.png$/, "-expanded.png"));

  app.quit();
});

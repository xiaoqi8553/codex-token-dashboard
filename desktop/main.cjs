const { app, BrowserWindow, Menu, Tray, shell, utilityProcess, ipcMain, screen, nativeImage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexStore } = require("./data/codex-store.cjs");
const { WorkBuddyStore } = require("./data/workbuddy-store.cjs");
const { loadTable, ensureTableFile } = require("./data/pricing.cjs");
const { buildBaseline, baselineIsFresh, loadBaseline, saveBaseline } = require("./data/history-baseline.cjs");

const PRODUCT_NAME = "Codex Token";
const PORTS = [8787, 8788, 8789];
const APP_ROOT = app.getAppPath();
const SERVER_PATH = path.join(APP_ROOT, "server.js");
const SMOKE = process.env.CODEX_TOKEN_DASHBOARD_SMOKE === "1";
const gotLock = SMOKE || app.requestSingleInstanceLock();

// 启动诊断：设置 CODEX_TOKEN_BOOT_MARK 可确认主进程脚本是否真的被执行
if (process.env.CODEX_TOKEN_BOOT_MARK) {
  try {
    fs.writeFileSync(process.env.CODEX_TOKEN_BOOT_MARK, `boot ${new Date().toISOString()} packaged=${app.isPackaged}\n`);
  } catch {
    /* 诊断失败不影响启动 */
  }
}

if (!gotLock) {
  app.quit();
} else {
  let mainWindow;
  let popover;
  let popoverReady = false;
  let trayMenu;
  let tray;
  /** 完整看板的后端；只有用户点「打开完整看板」时才会启动 */
  let backend;
  let backendExitCode;
  let backendOwned = false;
  let serviceUrl = "";
  let allowWindowClose = false;
  let quitting = false;
  let latestStatus = null;
  let startupError = "";
  let statusTimer;
  let smokeExitTimer;
  let preferences = { launchAtLogin: false, startMode: "popover", popoverOnly: true };
  /** @type {CodexStore|null} 独立数据层：直接读 ~/.codex/sessions，不经过本地 HTTP 服务 */
  let store = null;
  /** @type {WorkBuddyStore|null} WorkBuddy 用量：读 ~/.workbuddy/projects 下的会话日志 */
  let wbStore = null;
  /** 启动诊断日志的落盘位置，start() 阶段才确定 */
  let logFile = null;

  function log(message) {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      if (logFile) {
        fs.appendFileSync(logFile, line);
        return;
      }
    } catch {
      /* 落盘失败时退回到标准输出 */
    }
    try {
      process.stdout.write(line);
    } catch {
      /* 忽略 */
    }
  }

  app.setName(PRODUCT_NAME);
  if (process.platform === "win32") app.setAppUserModelId("com.xiaoqi.codex-token-dashboard");

  function userDataPaths() {
    const userData = app.getPath("userData");
    return {
      userData,
      data: path.join(userData, "data"),
      imports: path.join(userData, "data", "imports"),
      logs: path.join(userData, "logs"),
      config: path.join(userData, "config.json"),
      preferences: path.join(userData, "preferences.json"),
      usageCache: path.join(userData, "data", "codex-usage-cache.json"),
      detailCache: path.join(userData, "data", "codex-detail-cache.json"),
      legacyIndex: path.join(userData, "data", "usage-index.json"),
      baseline: path.join(userData, "data", "history-baseline.json"),
      workbuddyCache: path.join(userData, "data", "workbuddy-detail-cache.json"),
      pricing: path.join(userData, "data", "pricing.json")
    };
  }

  function sessionsDir() {
    return process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, "sessions")
      : path.join(os.homedir(), ".codex", "sessions");
  }

  function migrateUserData(paths) {
    fs.mkdirSync(paths.data, { recursive: true });
    fs.mkdirSync(paths.imports, { recursive: true });
    fs.mkdirSync(paths.logs, { recursive: true });

    const legacyData = path.join(APP_ROOT, "data");
    const targetIndex = path.join(paths.data, "usage-index.json");
    if (!fs.existsSync(targetIndex) && fs.existsSync(path.join(legacyData, "usage-index.json"))) {
      fs.copyFileSync(path.join(legacyData, "usage-index.json"), targetIndex);
    }
    if (fs.existsSync(legacyData)) {
      const legacyImports = path.join(legacyData, "imports");
      if (fs.existsSync(legacyImports)) {
        for (const entry of fs.readdirSync(legacyImports, { withFileTypes: true }).filter(item => item.isFile())) {
          const target = path.join(paths.imports, entry.name);
          if (!fs.existsSync(target)) fs.copyFileSync(path.join(legacyImports, entry.name), target);
        }
      }
    }
    const legacyConfig = path.join(APP_ROOT, "config.json");
    if (!fs.existsSync(paths.config) && fs.existsSync(legacyConfig)) fs.copyFileSync(legacyConfig, paths.config);
  }

  function loadPreferences(paths) {
    try {
      preferences = { ...preferences, ...JSON.parse(fs.readFileSync(paths.preferences, "utf8")) };
    } catch {
      // First launch or an older preferences file.
    }
    if (process.platform === "win32") {
      app.setLoginItemSettings({ openAtLogin: Boolean(preferences.launchAtLogin), path: process.execPath });
    }
  }

  function savePreferences(paths) {
    fs.writeFileSync(paths.preferences, JSON.stringify(preferences, null, 2), "utf8");
  }

  // ---------------------------------------------------------------------
  // 完整看板的后端：不再随应用启动，只在需要时拉起
  // ---------------------------------------------------------------------

  async function readConfig(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(900) });
      const data = await response.json();
      return response.ok && data.ok === true;
    } catch {
      return false;
    }
  }

  async function hasDesktopStatus(port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/desktop/status`, { signal: AbortSignal.timeout(900) });
      return response.ok;
    } catch {
      return false;
    }
  }

  function writeBackendLog(paths, prefix, value) {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
    if (!text) return;
    fs.appendFile(path.join(paths.logs, "desktop-backend.log"), `[${new Date().toISOString()}] ${prefix} ${text}`, () => {});
  }

  async function findReusableService() {
    for (const port of PORTS) {
      if (await readConfig(port)) {
        if (await hasDesktopStatus(port)) return `http://127.0.0.1:${port}`;
      }
    }
    return "";
  }

  async function findFreePort() {
    for (const port of PORTS) {
      if (!await readConfig(port)) return port;
    }
    throw new Error("本机端口 8787–8789 均被占用；请关闭其他看板服务后重试。");
  }

  function startBackend(paths, port) {
    if (!fs.existsSync(SERVER_PATH)) throw new Error(`找不到看板服务文件：${SERVER_PATH}`);
    const child = utilityProcess.fork(SERVER_PATH, [], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        CODEX_TOKEN_DASHBOARD_PORT: String(port),
        CODEX_TOKEN_DASHBOARD_USER_DATA_DIR: paths.userData,
        CODEX_TOKEN_DASHBOARD_DATA_DIR: paths.data,
        DASHBOARD_AUTO_OPEN: "0",
        PUBLIC_ACCESS: "0"
      },
      stdio: "pipe",
      serviceName: "CodexTokenUsageIndex"
    });
    backend = child;
    backendOwned = true;
    backendExitCode = undefined;
    child.stdout?.on("data", chunk => writeBackendLog(paths, "OUT", chunk));
    child.stderr?.on("data", chunk => writeBackendLog(paths, "ERR", chunk));
    child.on("exit", code => {
      backendExitCode = code ?? -1;
      if (quitting || !backendOwned) return;
      startupError = `看板服务已退出（代码 ${code ?? "未知"}）。可查看 ${path.join(paths.logs, "desktop-backend.log")}`;
      updateTray();
    });
    return port;
  }

  async function waitForService(port) {
    const deadline = Date.now() + 5 * 60 * 1000;
    let lastError = "服务正在启动";
    while (Date.now() < deadline) {
      if (quitting) throw new Error("应用正在退出。");
      if (backendExitCode !== undefined) {
        throw new Error(startupError || `看板服务启动失败（代码 ${backendExitCode}）。`);
      }
      for (const candidate of PORTS) {
        try {
          const response = await fetch(`http://127.0.0.1:${candidate}/api/config`, { signal: AbortSignal.timeout(700) });
          const payload = await response.json();
          if (response.ok && payload.ok === true && await hasDesktopStatus(candidate)) return `http://127.0.0.1:${candidate}`;
          lastError = payload.error || `服务响应 ${response.status}`;
        } catch (error) {
          lastError = error.message || lastError;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error(`看板服务启动超时：${lastError}。日志：${path.join(userDataPaths().logs, "desktop-backend.log")}`);
  }

  async function ensureBackend() {
    if (serviceUrl) return serviceUrl;
    const paths = userDataPaths();
    const reusable = await findReusableService();
    if (reusable) {
      serviceUrl = reusable;
      return serviceUrl;
    }
    const port = await findFreePort();
    startBackend(paths, port);
    serviceUrl = await waitForService(port);
    return serviceUrl;
  }

  // ---------------------------------------------------------------------
  // 完整看板窗口
  // ---------------------------------------------------------------------

  function loadingPage(message = "正在载入完整看板…") {
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${PRODUCT_NAME}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f5f9;color:#172235;font:14px/1.6 "Segoe UI",sans-serif}.card{width:min(460px,calc(100vw - 40px));padding:32px;border:1px solid #d9e1eb;border-radius:18px;background:#fff;box-shadow:0 20px 70px #20395a18}.mark{width:44px;height:44px;display:grid;place-items:center;border-radius:13px;background:#172235;color:#fff;font-weight:700;font-size:19px}.title{margin:22px 0 4px;font-size:24px}.muted{color:#64748b}.bar{height:5px;margin-top:22px;border-radius:8px;background:linear-gradient(90deg,#2a61dd 0 38%,#e8edf5 38%);animation:move 1.4s ease-in-out infinite alternate}@keyframes move{to{background:linear-gradient(90deg,#e8edf5 0 40%,#2a61dd 40% 76%,#e8edf5 76%)}}</style><section class="card"><div class="mark">&gt;_</div><h1 class="title">Codex Token</h1><div class="muted">${message}</div><div class="bar"></div></section>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }

  /**
   * 完整看板窗口：直接加载本地 dashboard.html，由 preload 从 CodexStore 取数，
   * 不经过 server.js / index.html。
   */
  function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

    mainWindow = new BrowserWindow({
      width: 1180,
      height: 860,
      minWidth: 820,
      minHeight: 620,
      show: false,
      title: `${PRODUCT_NAME} · 用量看板`,
      backgroundColor: "#f3f4f7",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "dashboard-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });

    mainWindow.loadFile(path.join(__dirname, "dashboard.html"));
    mainWindow.once("ready-to-show", () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    });
    mainWindow.on("close", event => {
      if (allowWindowClose || quitting) return;
      event.preventDefault();
      mainWindow.hide();
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    return mainWindow;
  }

  /** 旧版网页看板：按需拉起本地服务，作为可选的历史分析工作台 */
  let legacyWindow = null;

  async function openLegacyDashboard() {
    if (!legacyWindow || legacyWindow.isDestroyed()) {
      legacyWindow = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 960,
        minHeight: 640,
        show: false,
        title: `${PRODUCT_NAME} · 旧版网页看板`,
        backgroundColor: "#f2f5f9",
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true
        }
      });
      legacyWindow.loadURL(loadingPage());
      legacyWindow.once("ready-to-show", () => legacyWindow?.show());
      legacyWindow.on("closed", () => { legacyWindow = null; });
      legacyWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//i.test(url)) shell.openExternal(url);
        return { action: "deny" };
      });
    } else {
      if (legacyWindow.isMinimized()) legacyWindow.restore();
      legacyWindow.show();
    }

    try {
      const url = await ensureBackend();
      await legacyWindow.loadURL(`${url}/?desktop=1`);
    } catch (error) {
      await legacyWindow.loadURL(loadingPage(`旧版看板启动失败：${error.message}`));
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // 托盘弹窗：不依赖本地服务，数据直接来自 CodexStore
  // ---------------------------------------------------------------------
  const POPOVER_WIDTH = 396;
  const POPOVER_HEIGHT = 640;

  function createPopover() {
    popover = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      hasShadow: true,
      backgroundColor: "#00000000",
      roundedCorners: true,
      title: PRODUCT_NAME,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });

    popover.loadFile(path.join(__dirname, "popover.html"));
    popover.webContents.once("did-finish-load", () => {
      popoverReady = true;
      pushStatusToPopover();
    });
    popover.on("blur", () => {
      if (popover && !popover.isDestroyed() && popover.isVisible()) hidePopover();
    });
    popover.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
  }

  function popoverPosition(height = POPOVER_HEIGHT) {
    const trayBounds = tray && typeof tray.getBounds === "function" ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
    const anchor = trayBounds.width || trayBounds.height
      ? { x: Math.round(trayBounds.x + trayBounds.width / 2), y: Math.round(trayBounds.y + trayBounds.height / 2) }
      : { x: screen.getPrimaryDisplay().workArea.x + screen.getPrimaryDisplay().workArea.width, y: screen.getPrimaryDisplay().workArea.y + screen.getPrimaryDisplay().workArea.height };
    const area = screen.getDisplayNearestPoint(anchor).workArea;

    let x = Math.round(anchor.x - POPOVER_WIDTH / 2);
    let y;
    if (trayBounds.width && trayBounds.y > area.y + area.height / 2) {
      y = Math.round(trayBounds.y - height - 6);
    } else if (trayBounds.width) {
      y = Math.round(trayBounds.y + trayBounds.height + 6);
    } else {
      y = area.y + area.height - height - 10;
      x = area.x + area.width - POPOVER_WIDTH - 10;
    }

    x = Math.min(Math.max(x, area.x + 8), area.x + area.width - POPOVER_WIDTH - 8);
    y = Math.min(Math.max(y, area.y + 8), area.y + area.height - height - 8);
    return { x, y, width: POPOVER_WIDTH, height };
  }

  function showPopover() {
    if (!popover || popover.isDestroyed()) return;
    const bounds = popover.getBounds();
    popover.setBounds(popoverPosition(bounds.height));
    popover.showInactive();
    popover.focus();
    pushStatusToPopover();
    refreshTrayStatus().catch(() => {});
  }

  function hidePopover() {
    if (!popover || popover.isDestroyed()) return;
    if (popover.isVisible()) popover.hide();
  }

  function togglePopover() {
    if (!popover || popover.isDestroyed()) return;
    if (popover.isVisible()) hidePopover();
    else showPopover();
  }

  function pushStatusToPopover() {
    if (!popover || popover.isDestroyed() || !popoverReady) return;
    popover.webContents.send("popover:status", latestStatus || { ok: false, phase: store ? store.phase : "idle" });
  }

  function registerPopoverHandlers() {
    ipcMain.handle("popover:refresh", async () => {
      await refreshTrayStatus(true);
      return latestStatus;
    });
    ipcMain.handle("popover:open-dashboard", async () => {
      hidePopover();
      await showWindow();
      return true;
    });
    ipcMain.handle("popover:close", () => {
      hidePopover();
      return true;
    });
    ipcMain.handle("popover:quit", () => {
      app.quit();
      return true;
    });
    ipcMain.handle("popover:open-status-page", () => {
      shell.openExternal("https://status.openai.com/");
      return true;
    });
    ipcMain.handle("popover:prefs", () => ({
      launchAtLogin: Boolean(preferences.launchAtLogin),
      startMode: preferences.startMode
    }));
    ipcMain.on("popover:set-height", (_event, requested) => {
      if (!popover || popover.isDestroyed()) return;
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const maxHeight = Math.max(320, area.height - 32);
      const nextHeight = Math.min(Math.max(Math.round(requested), 320), maxHeight);
      const bounds = popover.getBounds();
      if (!nextHeight || Math.abs(bounds.height - nextHeight) < 2) return;
      // Keep the panel bottom-anchored above the tray icon while it grows.
      const nextY = Math.min(
        Math.max(bounds.y + bounds.height - nextHeight, area.y + 8),
        area.y + area.height - nextHeight - 8
      );
      popover.setBounds({ x: bounds.x, y: nextY, width: bounds.width, height: nextHeight });
    });
    ipcMain.handle("popover:set-launch-at-login", (_event, enabled) => {
      preferences.launchAtLogin = Boolean(enabled);
      savePreferences(userDataPaths());
      if (process.platform === "win32") app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath });
      updateTray();
      return { launchAtLogin: preferences.launchAtLogin };
    });
  }

  // ---------------------------------------------------------------------
  // 完整看板（本地数据，无 HTTP 服务）
  // ---------------------------------------------------------------------

  function pushDetailProgress(progress) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("dashboard:progress", progress);
  }

  /** 把 WorkBuddy 的当日/累计摘要挂到最新快照上，弹窗与托盘共用 */
  function attachWorkBuddySummary() {
    if (!wbStore || !latestStatus) return;
    try {
      latestStatus.workbuddy = wbStore.summary();
    } catch {
      return;
    }
    updateTray();
    pushStatusToPopover();
  }

  function registerDashboardHandlers() {
    ipcMain.handle("dashboard:status", () => latestStatus || (store ? store.snapshot() : null));

    ipcMain.handle("dashboard:get-detail", async () => {
      if (!store) throw new Error("用量数据层尚未初始化，请稍候重试");
      const detail = await store.buildDetail({ onProgress: pushDetailProgress });
      latestStatus = store.snapshot();
      // 新快照是干净的：WorkBuddy 摘要要重新挂上，弹窗那一行才不会变回「—」
      attachWorkBuddySummary();
      updateTray();
      pushStatusToPopover();
      return detail;
    });

    ipcMain.handle("dashboard:refresh", async () => {
      if (!store) throw new Error("用量数据层尚未初始化，请稍候重试");
      await store.refresh({ full: true });
      const detail = await store.buildDetail({ onProgress: pushDetailProgress });
      latestStatus = store.snapshot();
      attachWorkBuddySummary();
      updateTray();
      pushStatusToPopover();
      return detail;
    });

    // WorkBuddy 用量：与 Codex 完全独立的第二个数据源，切到该标签时按需构建
    ipcMain.handle("dashboard:workbuddy-detail", async () => {
      if (!wbStore) return null;
      const detail = await wbStore.build({ onProgress: pushDetailProgress });
      attachWorkBuddySummary();
      return detail;
    });

    ipcMain.handle("dashboard:workbuddy-refresh", async () => {
      if (!wbStore) return null;
      const detail = await wbStore.build({ onProgress: pushDetailProgress, force: true });
      attachWorkBuddySummary();
      return detail;
    });

    ipcMain.handle("dashboard:meta", () => ({
      name: PRODUCT_NAME,
      version: app.getVersion(),
      repo: "https://github.com/xiaoqi8553/codex-token-dashboard",
      packaged: app.isPackaged
    }));

    ipcMain.handle("dashboard:open-legacy", () => openLegacyDashboard());
    ipcMain.handle("dashboard:open-sessions", () => shell.openPath(sessionsDir()));
    ipcMain.handle("dashboard:open-workbuddy", () => shell.openPath(path.join(os.homedir(), ".workbuddy", "projects")));
    // 价格表就在 userData 里，点开就能改单价
    ipcMain.handle("dashboard:open-pricing", () => {
      const file = userDataPaths().pricing;
      ensureTableFile(file);
      return shell.openPath(file);
    });
    ipcMain.handle("dashboard:open-external", (_event, url) => {
      if (typeof url === "string" && /^https:\/\//i.test(url)) shell.openExternal(url);
      return true;
    });
  }

  function formatTokens(value) {
    const number = Number(value) || 0;
    if (number >= 1e9) return `${(number / 1e9).toFixed(number >= 1e10 ? 1 : 2).replace(/0+$/, "").replace(/\.$/, "")}B`;
    if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e8 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (number >= 1e3) return `${(number / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
    return String(number);
  }

  function updateTray() {
    if (!tray) return;
    const data = latestStatus;
    const quota = data && data.quota;
    const tooltip = data
      ? `Codex Token · 会话 ${quota && quota.session ? Math.round(quota.session.usedPercent) + "%" : "—"} · 今日 ${formatTokens(data.today?.totalTokens)}`
      : startupError || "Codex Token · 正在读取用量";
    tray.setToolTip(tooltip.slice(0, 127));
    trayMenu = Menu.buildFromTemplate([
      { label: "打开用量速览", click: showPopover },
      { label: "打开完整看板", click: () => { showWindow(); } },
      { label: "打开旧版网页看板", click: () => { openLegacyDashboard().catch(() => {}); } },
      { type: "separator" },
      { label: quota && quota.session ? `会话额度：${Math.round(quota.session.usedPercent)}% 已用` : "会话额度：暂无数据", enabled: false },
      { label: quota && quota.weekly ? `每周额度：${Math.round(quota.weekly.usedPercent)}% 已用` : "每周额度：暂无数据", enabled: false },
      { label: `今日用量：${formatTokens(data?.today?.totalTokens)} tokens`, enabled: false },
      { label: `累计用量：${formatTokens(data?.totals?.totalTokens)} tokens`, enabled: false },
      { label: `WorkBuddy 今日：${formatTokens(data?.workbuddy?.today?.totalTokens)} tokens`, enabled: false },
      { type: "separator" },
      { label: "立即同步数据", click: () => { refreshTrayStatus(true); } },
      {
        label: "登录 Windows 时启动",
        type: "checkbox",
        checked: Boolean(preferences.launchAtLogin),
        click: item => {
          preferences.launchAtLogin = item.checked;
          savePreferences(userDataPaths());
          if (process.platform === "win32") app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
          updateTray();
        }
      },
      {
        label: "启动时打开完整看板",
        type: "checkbox",
        checked: preferences.startMode === "dashboard",
        click: item => {
          preferences.startMode = item.checked ? "dashboard" : "popover";
          savePreferences(userDataPaths());
          updateTray();
        }
      },
      { type: "separator" },
      { label: "退出 Codex Token", click: () => app.quit() }
    ]);
    tray.setContextMenu(null);
  }

  async function refreshTrayStatus(force = false) {
    if (!store) return;
    try {
      latestStatus = await store.refresh({ full: false });
      startupError = "";
    } catch (error) {
      startupError = `读取用量失败：${error.message}`;
    }
    // 快照是全新的对象，WorkBuddy 摘要要重新挂上
    if (latestStatus && wbStore) {
      try {
        latestStatus.workbuddy = wbStore.summary();
      } catch {
        /* 摘要失败不影响主数据 */
      }
    }
    updateTray();
    pushStatusToPopover();
  }

  async function showWindow() {
    // 窗口是惰性创建的：默认启动模式不建看板窗口，
    // 早先这里直接 return，导致「打开完整看板」看起来毫无反应。
    const win = createWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function createTray() {
    const image = nativeImage.createFromPath(path.join(APP_ROOT, "desktop", "icon.png")).resize({ width: 32, height: 32 });
    tray = new Tray(image);
    tray.setToolTip(`${PRODUCT_NAME} · 点击查看用量速览`);
    tray.on("click", togglePopover);
    tray.on("double-click", () => { showWindow(); });
    tray.on("right-click", () => {
      if (trayMenu) tray.popUpContextMenu(trayMenu);
    });
    updateTray();
  }

  /**
   * 历史基线：旧版网页看板把历史上扫到的每条请求都存进了 usage-index.json，
   * 里面包含 Codex 已经清理掉的早期日志。没有它，累计会少算一大半。
   */
  function resolveBaseline(paths) {
    const indexPath = paths.legacyIndex;
    if (!fs.existsSync(indexPath)) return null;
    const cached = loadBaseline(paths.baseline);
    if (cached && baselineIsFresh(cached, indexPath)) return cached;
    try {
      const started = Date.now();
      const baseline = buildBaseline(indexPath);
      saveBaseline(paths.baseline, baseline);
      log(`history baseline: ${baseline.records} records, ${(baseline.totalTokens / 1e9).toFixed(2)}B, ${Object.keys(baseline.days).length} days, ${Date.now() - started}ms`);
      return baseline;
    } catch (error) {
      log(`history baseline failed: ${error.message}`);
      return cached || null;
    }
  }

  async function initStore(paths, baseline) {
    // 价格表：首次运行把内置表写到 userData，之后用户改文件即可更新价格
    ensureTableFile(paths.pricing);
    const pricing = loadTable(paths.pricing);
    log(`pricing: ${pricing.entries.length} models, USD→CNY ${pricing.usdCny}`);

    store = new CodexStore({
      sessionsDir: sessionsDir(),
      cacheFile: paths.usageCache,
      detailCacheFile: paths.detailCache,
      baseline,
      pricing
    });
    // 明细缓存先读盘：看板第二次打开可以秒出
    store.loadDetailCache();

    wbStore = new WorkBuddyStore({ cacheFile: paths.workbuddyCache, pricing });
    wbStore.loadCache();
    // WorkBuddy 日志量小（本机 25MB / 千条请求），并行构建，几十毫秒
    wbStore.build()
      .then(() => {
        log(`workbuddy: ${wbStore.files.size} files, ${(wbStore.summary().totals.totalTokens / 1e6).toFixed(1)}M tokens`);
        attachWorkBuddySummary();
      })
      .catch(error => log(`workbuddy scan failed: ${error.message}`));

    const snapshot = await store.init({ full: false });
    latestStatus = snapshot;
    updateTray();
    pushStatusToPopover();
    // 后台补齐历史：先让弹窗秒开，再静默把全量索引跑完并推一次更新
    store.buildFull()
      .then(fullSnapshot => {
        latestStatus = fullSnapshot;
        updateTray();
        pushStatusToPopover();
        // 再补一次明细：拿到「线程累计」口径（含被清理的早期历史），
        // 弹窗与看板才能显示同一个总量
        return store.buildDetail().then(() => {
          latestStatus = store.snapshot();
          updateTray();
          pushStatusToPopover();
        });
      })
      .catch(error => {
        startupError = `历史索引构建失败：${error.message}`;
        updateTray();
      });
  }

  async function start() {
    const paths = userDataPaths();
    migrateUserData(paths);
    // 目录就绪后再挂日志，否则首次启动会写不进去
    logFile = path.join(paths.logs, "desktop.log");
    log(`start v${app.getVersion()} | smoke=${SMOKE} | packaged=${app.isPackaged} | execPath=${process.execPath}`);
    loadPreferences(paths);
    registerPopoverHandlers();
    registerDashboardHandlers();
    log("creating popover");
    createPopover();
    log("creating tray");
    createTray();
    // 完整看板窗口延后创建：弹窗是主入口，不需要先起一个大窗口
    if (preferences.startMode === "dashboard" && !SMOKE) createWindow();

    initStore(paths, resolveBaseline(paths)).catch(error => {
      log(`initStore failed: ${error.stack || error.message}`);
      startupError = `用量数据初始化失败：${error.message}`;
      updateTray();
      pushStatusToPopover();
    });

    if (preferences.startMode === "dashboard" && !SMOKE) {
      showWindow().catch(() => {});
    } else {
      showPopover();
    }

    statusTimer = setInterval(() => { refreshTrayStatus().catch(() => {}); }, 30_000);

    // Dev 诊断：把真实弹窗内容截成 PNG，用于验证 preload 与真实数据链路
    if (process.env.CODEX_TOKEN_POPOVER_SHOT) {
      setTimeout(async () => {
        try {
          if (!popover || popover.isDestroyed()) return;
          const image = await popover.webContents.capturePage();
          fs.writeFileSync(process.env.CODEX_TOKEN_POPOVER_SHOT, image.toPNG());
          process.stdout.write(`popover shot saved: ${process.env.CODEX_TOKEN_POPOVER_SHOT}\n`);
        } catch (error) {
          process.stdout.write(`popover shot failed: ${error.message}\n`);
        }
      }, 3000);
    }

    // Dev 诊断：把真实看板内容截成 PNG，用于验证 preload 与真实数据链路
    if (process.env.CODEX_TOKEN_DASHBOARD_SHOT) {
      setTimeout(async () => {
        try {
          await showWindow();
          // 等首次明细扫描 + 渲染完成
          await new Promise(resolve => setTimeout(resolve, Number(process.env.CODEX_TOKEN_DASHBOARD_SHOT_DELAY) || 14000));
          if (!mainWindow || mainWindow.isDestroyed()) return;
          // 排查用：先切到指定数据源（codex / workbuddy）再截图
          if (process.env.CODEX_TOKEN_DASHBOARD_SHOT_SOURCE) {
            const source = String(process.env.CODEX_TOKEN_DASHBOARD_SHOT_SOURCE).replace(/[^a-z]/gi, "");
            await mainWindow.webContents.executeJavaScript(
              `(() => { const el = document.querySelector('#source button[data-source="${source}"]'); if (el) el.click(); return !!el; })()`
            );
            await new Promise(resolve => setTimeout(resolve, 2200));
          }
          const shotPath = process.env.CODEX_TOKEN_DASHBOARD_SHOT;
          // 明确先回到顶部，避免捕获到上一次滚动位置
          await mainWindow.webContents.executeJavaScript('(() => { const el = document.querySelector("main"); if (el) el.scrollTop = 0; return true; })()');
          await new Promise(resolve => setTimeout(resolve, 350));
          const info = await mainWindow.webContents.executeJavaScript(
            '({scrollTop: (document.querySelector("main")||{}).scrollTop, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, scrollHeight: (document.querySelector("main")||{}).scrollHeight})'
          );
          process.stdout.write(`dashboard layout: ${JSON.stringify(info)}\n`);
          const shoot = async () => {
            let lastError;
            for (let attempt = 0; attempt < 4; attempt += 1) {
              try {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
                await new Promise(resolve => setTimeout(resolve, 400));
                return await mainWindow.webContents.capturePage();
              } catch (error) {
                lastError = error;
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }
            throw lastError;
          };
          const image = await shoot();
          fs.writeFileSync(shotPath, image.toPNG());
          process.stdout.write(`dashboard shot saved: ${shotPath}\n`);
          if (process.env.CODEX_TOKEN_DASHBOARD_SHOT_SCROLL) {
            await mainWindow.webContents.executeJavaScript('(() => { const el = document.querySelector("main"); if (el) el.scrollTop = el.scrollHeight; return el ? el.scrollTop : -1; })()');
            await new Promise(resolve => setTimeout(resolve, 700));
            const bottom = await shoot();
            const bottomPath = shotPath.replace(/\.png$/i, "-bottom.png");
            fs.writeFileSync(bottomPath, bottom.toPNG());
            process.stdout.write(`dashboard shot saved: ${bottomPath}\n`);
          }
          // 排查用：切到指定时段指标后再截一张（tokens / speed）
          if (process.env.CODEX_TOKEN_DASHBOARD_SHOT_HOUR) {
            const metric = String(process.env.CODEX_TOKEN_DASHBOARD_SHOT_HOUR).replace(/[^a-z]/gi, "");
            await mainWindow.webContents.executeJavaScript(
              `(() => { const el = document.querySelector('#hour-tabs button[data-metric="${metric}"]'); if (el) el.click(); return !!el; })()`
            );
            await mainWindow.webContents.executeJavaScript('(() => { const el = document.querySelector("main"); if (el) el.scrollTop = el.scrollHeight; return el ? el.scrollTop : -1; })()');
            await new Promise(resolve => setTimeout(resolve, 700));
            const hourShot = await shoot();
            const hourPath = shotPath.replace(/\.png$/i, "-" + metric + ".png");
            fs.writeFileSync(hourPath, hourShot.toPNG());
            process.stdout.write(`dashboard shot saved: ${hourPath}\n`);
          }
        } catch (error) {
          process.stdout.write(`dashboard shot failed: ${error.message}\n`);
        }
      }, 1500);
    }

    if (SMOKE) {
      smokeExitTimer = setTimeout(() => {
        process.stdout.write("Desktop smoke lifecycle check complete; quitting.\n");
        app.quit();
      }, process.env.CODEX_TOKEN_DASHBOARD_SHOT ? 40_000 : 8_000);
    }
  }

  app.on("second-instance", () => { showWindow(); });
  app.on("window-all-closed", event => {
    // 托盘常驻，不因窗口全部关闭而退出
    if (event && typeof event.preventDefault === "function") event.preventDefault();
  });
  app.on("before-quit", () => {
    quitting = true;
    allowWindowClose = true;
    if (statusTimer) clearInterval(statusTimer);
    if (smokeExitTimer) clearTimeout(smokeExitTimer);
    if (backendOwned && backend) backend.kill();
    if (store) store.saveCache();
  });
  app.whenReady().then(start).catch(error => {
    log(`fatal: ${error.stack || error.message}`);
    startupError = error.message;
    updateTray();
  });
}

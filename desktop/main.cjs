const { app, BrowserWindow, Menu, Tray, shell, utilityProcess } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const PRODUCT_NAME = "Codex Token";
const PORTS = [8787, 8788, 8789];
const APP_ROOT = app.getAppPath();
const SERVER_PATH = path.join(APP_ROOT, "server.js");
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let mainWindow;
  let tray;
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
  let preferences = { launchAtLogin: false };

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
      preferences: path.join(userData, "preferences.json")
    };
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
    if (!fs.existsSync(SERVER_PATH)) throw new Error(`找不到本机服务文件：${SERVER_PATH}`);
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
        startupError = `本机数据服务已退出（代码 ${code ?? "未知"}）。可查看 ${path.join(paths.logs, "desktop-backend.log")}`;
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
        throw new Error(startupError || `本机服务启动失败（代码 ${backendExitCode}）。`);
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
    throw new Error(`本机服务启动超时：${lastError}。日志：${path.join(userDataPaths().logs, "desktop-backend.log")}`);
  }

  function loadingPage(message = "正在连接本机用量服务…") {
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${PRODUCT_NAME}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f5f9;color:#172235;font:14px/1.6 "Segoe UI",sans-serif}.card{width:min(460px,calc(100vw - 40px));padding:32px;border:1px solid #d9e1eb;border-radius:18px;background:#fff;box-shadow:0 20px 70px #20395a18}.mark{width:44px;height:44px;display:grid;place-items:center;border-radius:13px;background:#172235;color:#fff;font-weight:700;font-size:19px}.title{margin:22px 0 4px;font-size:24px}.muted{color:#64748b}.bar{height:5px;margin-top:22px;border-radius:8px;background:linear-gradient(90deg,#2a61dd 0 38%,#e8edf5 38%);animation:move 1.4s ease-in-out infinite alternate}@keyframes move{to{background:linear-gradient(90deg,#e8edf5 0 40%,#2a61dd 40% 76%,#e8edf5 76%)}}</style><section class="card"><div class="mark">&gt;_</div><h1 class="title">Codex Token</h1><div class="muted">${message}</div><div class="bar"></div></section>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: PRODUCT_NAME,
      backgroundColor: "#f2f5f9",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });

    mainWindow.loadURL(loadingPage());
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    mainWindow.on("close", event => {
      if (allowWindowClose || quitting) return;
      event.preventDefault();
      mainWindow.hide();
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith("data:text/html,")) return;
      if (!serviceUrl || new URL(url).origin !== new URL(serviceUrl).origin) {
        event.preventDefault();
        if (/^https:\/\//i.test(url)) shell.openExternal(url);
      }
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
    const tooltip = data
      ? `Codex Token · 今日 ${formatTokens(data.today?.totalTokens)} · 累计 ${formatTokens(data.totals?.totalTokens)}`
      : startupError || "Codex Token · 正在等待用量数据";
    tray.setToolTip(tooltip.slice(0, 127));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 Codex Token", click: showWindow },
      { type: "separator" },
      { label: `今日用量：${formatTokens(data?.today?.totalTokens)} tokens`, enabled: false },
      { label: `累计用量：${formatTokens(data?.totals?.totalTokens)} tokens`, enabled: false },
      { label: `今日输出：${formatTokens(data?.today?.outputTokens)} tokens`, enabled: false },
      { label: data?.updatedAt ? `数据更新：${new Date(data.updatedAt).toLocaleString()}` : "数据更新：等待服务", enabled: false },
      { type: "separator" },
      { label: "立即同步数据", click: () => refreshTrayStatus(true) },
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
      { type: "separator" },
      { label: "退出 Codex Token", click: () => app.quit() }
    ]));
  }

  async function refreshTrayStatus(force = false) {
    if (!serviceUrl) return;
    try {
      const response = await fetch(`${serviceUrl}/api/desktop/status${force ? "?force=1" : ""}`, { signal: AbortSignal.timeout(5 * 60 * 1000) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || `服务响应 ${response.status}`);
      latestStatus = payload;
      startupError = "";
    } catch (error) {
      startupError = `托盘同步失败：${error.message}`;
    }
    updateTray();
  }

  function showWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function createTray() {
    const image = require("electron").nativeImage.createFromPath(path.join(APP_ROOT, "desktop", "icon.png")).resize({ width: 32, height: 32 });
    tray = new Tray(image);
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
    updateTray();
  }

  async function start() {
    const paths = userDataPaths();
    migrateUserData(paths);
    loadPreferences(paths);
    createWindow();
    createTray();

    try {
      const smokeMode = process.env.CODEX_TOKEN_DASHBOARD_SMOKE === "1";
      serviceUrl = smokeMode ? "" : await findReusableService();
      if (!serviceUrl) {
        const port = await findFreePort();
        startBackend(paths, port);
        serviceUrl = await waitForService(port);
      }
      if (!mainWindow || mainWindow.isDestroyed()) return;
      await mainWindow.loadURL(`${serviceUrl}/?desktop=1`);
      mainWindow.show();
      await refreshTrayStatus();
      statusTimer = setInterval(() => refreshTrayStatus(), 30_000);
      if (smokeMode) {
        smokeExitTimer = setTimeout(() => {
          process.stdout.write("Desktop smoke lifecycle check complete; quitting.\n");
          app.quit();
        }, 8_000);
      }
    } catch (error) {
      startupError = error.message;
      updateTray();
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(loadingPage(`启动失败：${error.message}`));
        mainWindow.show();
      }
    }
  }

  app.on("second-instance", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
    allowWindowClose = true;
    if (statusTimer) clearInterval(statusTimer);
    if (smokeExitTimer) clearTimeout(smokeExitTimer);
    if (backendOwned && backend) backend.kill();
  });
  app.whenReady().then(start).catch(error => {
    startupError = error.message;
    updateTray();
  });
}

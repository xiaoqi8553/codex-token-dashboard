const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const extensionPath = path.join(root, "extension");
const dashboardOrigin = "https://xiaoqi8553.github.io";
const dashboardUrl = dashboardOrigin + "/codex-token-dashboard/";
const chromeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);
const executablePath = chromeCandidates.find(candidate => fs.existsSync(candidate));

function localAsset(url) {
  const pathname = decodeURIComponent(url.pathname).replace(/^\/codex-token-dashboard\/?/, "");
  const candidates = [path.join(root, pathname || "index.html")];
  const asset = candidates.find(candidate => candidate.startsWith(root) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!asset) return null;
  const extension = path.extname(asset).toLowerCase();
  const contentType = extension === ".js" ? "text/javascript" :
    extension === ".json" ? "application/json" :
    extension === ".css" ? "text/css" : "text/html";
  return { body: fs.readFileSync(asset), contentType };
}

async function registerDashboardRoutes(context) {
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "notion.test") {
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<!doctype html><iframe title="dashboard" src="' + dashboardUrl + '" style="width:100%;height:100vh;border:0"></iframe>'
      });
    }
    if (url.origin === dashboardOrigin) {
      const asset = localAsset(url);
      if (asset) return route.fulfill({ status: 200, contentType: asset.contentType, body: asset.body });
      return route.fulfill({ status: 404, body: "Not found" });
    }
    return route.continue();
  });
}

async function main() {
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  let context;
  let apiServer;
  let profilePath;
  try {
    context = await browser.newContext();
    await registerDashboardRoutes(context);
    const fixturePage = await context.newPage();
    await fixturePage.goto(dashboardUrl);
    await fixturePage.waitForFunction(() => state.initialized);
    const fixturePayload = await fixturePage.evaluate(() => {
      const date = new Date().toISOString().slice(0, 10);
      const records = (state.staticPayload?.records || []).slice(0, 8).map((record, index) => ({
        ...record,
        id: "extension-smoke-" + index,
        date,
        timestamp: new Date().toISOString()
      }));
      return {
        ...state.staticPayload,
        ok: true,
        updatedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        scanMs: 1,
        config: { accountSyncAvailable: false },
        records,
        calendarRecords: records,
        models: Array.from(new Set(records.map(record => record.model))),
        summary: state.staticPayload.summary
      };
    });
    if (!fixturePayload.records.length) throw new Error("Unable to create API fixture records.");
    const port = await startMockApi(fixturePayload, server => { apiServer = server; });

    profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "ctd-extension-profile-"));
    const delayedExtensionPath = path.join(profilePath, "extension");
    fs.cpSync(extensionPath, delayedExtensionPath, { recursive: true });
    const delayedWorkerPath = path.join(delayedExtensionPath, "background.js");
    const delayedWorkerSource = fs.readFileSync(delayedWorkerPath, "utf8");
    const probeHandler = 'if (message.type === "probe") {';
    if (!delayedWorkerSource.includes(probeHandler)) throw new Error("Unable to configure delayed extension probe fixture.");
    fs.writeFileSync(delayedWorkerPath, delayedWorkerSource.replace(probeHandler, `${probeHandler}\n    globalThis.extensionProbeCount = (globalThis.extensionProbeCount || 0) + 1;\n    if (globalThis.extensionProbeCount === 1) { sendResponse({ ok: false }); return false; }`));
    const args = [
      "--disable-extensions-except=" + delayedExtensionPath,
      "--load-extension=" + delayedExtensionPath,
      "--no-first-run",
      "--no-default-browser-check"
    ];
    const extensionContext = await chromium.launchPersistentContext(profilePath, {
      channel: "chromium",
      args
    });
    try {
      await registerDashboardRoutes(extensionContext);
      const page = await extensionContext.newPage();
      await page.setViewportSize({ width: 1366, height: 900 });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      extensionContext.on("serviceworker", worker => worker.on("console", message => errors.push("SW: " + message.text())));
      page.on("requestfailed", request => errors.push("Request failed: " + request.url() + " " + request.failure()?.errorText));
      await page.goto("https://notion.test/");
      const dashboardFrame = extensionContext.pages().flatMap(item => item.frames()).find(frame => frame.url().startsWith(dashboardUrl));
      if (!dashboardFrame) throw new Error("Notion dashboard iframe was not created.");
      try {
        await dashboardFrame.waitForFunction(expectedRecords => state.initialized && state.dataMode === "extension" && state.extensionBridgeStatus === true && state.records.length === expectedRecords && !document.querySelector("#statusNotice")?.classList.contains("show"), fixturePayload.records.length, { timeout: 20000 });
      } catch (error) {
        const debug = await dashboardFrame.evaluate(() => ({ href: location.href, initialized: state.initialized, mode: state.dataMode,
          bridge: state.extensionBridgeStatus, count: state.records.length, status: document.querySelector("#statusNotice")?.textContent }));
        throw new Error(error.message + " Dashboard state: " + JSON.stringify(debug) + " Service workers: " +
          extensionContext.serviceWorkers().map(worker => worker.url()).join(",") + " Browser errors: " + JSON.stringify(errors));
      }
      const first = await dashboardFrame.evaluate(() => ({ mode: state.dataMode, count: state.records.length, status: document.querySelector("#statusNotice")?.textContent }));
      await dashboardFrame.locator("#importBtn").click();
      const screenshotPath = path.join(os.tmpdir(), "codex-token-notion-extension-smoke.png");
      await dashboardFrame.locator("body").screenshot({ path: screenshotPath });
      await dashboardFrame.locator("#importBtn").click();
      const refreshDeadline = Date.now() + 12000;
      while (apiServer.requests < 2 && Date.now() < refreshDeadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (apiServer.requests < 2) throw new Error("Extension did not repeat the local API request for automatic refresh.");
      if (errors.length) throw new Error("Dashboard page errors: " + errors.join("; "));
      if (first.mode !== "extension" || first.count === 0) throw new Error("Extension did not populate the dashboard.");
      const userAgent = await dashboardFrame.evaluate(() => navigator.userAgent);
      console.log(JSON.stringify({ ok: true, browser: userAgent, extensionMode: first.mode, records: first.count, status: first.status, apiRequests: apiServer.requests, screenshotPath }, null, 2));
    } finally {
      await extensionContext.close();
    }
  } finally {
    if (apiServer) await new Promise(resolve => apiServer.close(resolve));
    if (context) await context.close();
    await browser.close();
    if (profilePath && path.resolve(profilePath).startsWith(path.resolve(os.tmpdir()) + path.sep) &&
        path.basename(profilePath).startsWith("ctd-extension-profile-") && fs.existsSync(profilePath)) {
      fs.rmSync(profilePath, { recursive: true, force: true });
    }
  }
}

async function startMockApi(payload, onStarted) {
  let lastError;
  for (const port of [8787, 8788, 8789]) {
    const server = http.createServer((request, response) => {
      if (!request.url.startsWith("/api/usage")) {
        response.writeHead(404).end();
        return;
      }
      server.requests += 1;
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(payload));
    });
    server.requests = 0;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      onStarted(server);
      return port;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => server.close(resolve));
    }
  }
  throw new Error("No free localhost port from 8787 to 8789: " + lastError?.message);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

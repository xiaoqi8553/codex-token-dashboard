const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const dashboardOrigin = "https://xiaoqi8553.github.io";
const dashboardUrl = dashboardOrigin + "/codex-token-dashboard/";
const useLiveLocalApi = process.argv.includes("--live");

function localAsset(url) {
  const pathname = decodeURIComponent(url.pathname).replace(/^\/codex-token-dashboard\/?/, "");
  const candidate = path.join(root, pathname || "index.html");
  if (!candidate.startsWith(root) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  const extension = path.extname(candidate).toLowerCase();
  const contentType = extension === ".js" ? "text/javascript" : extension === ".json" ? "application/json" : "text/html";
  return { body: fs.readFileSync(candidate), contentType };
}

async function main() {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    permissions: ["local-network-access"]
  });
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(root, "sample-data", "demo-usage-index.json"), "utf8"));
    payload.ok = true;
    payload.updatedAt = new Date().toISOString();
    let apiRequests = 0;
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname === "notion.test") {
        return route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><iframe src="' + dashboardUrl + '" style="width:100%;height:100vh;border:0"></iframe>' });
      }
      if (url.origin === dashboardOrigin) {
        const asset = localAsset(url);
        return asset ? route.fulfill({ status: 200, contentType: asset.contentType, body: asset.body }) : route.fulfill({ status: 404, body: "Not found" });
      }
      if (url.origin === "http://127.0.0.1:8787") {
        if (useLiveLocalApi) return route.continue();
        const cors = {
          "access-control-allow-origin": dashboardOrigin,
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-allow-private-network": "true",
          "access-control-max-age": "300",
          "vary": "Origin"
        };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        if (url.pathname !== "/api/usage" && url.pathname !== "/api/config") return route.fulfill({ status: 404, headers: cors, body: "{}" });
        apiRequests += 1;
        return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(payload) });
      }
      return route.continue();
    });

    const page = await context.newPage();
    const errors = [];
    const failedRequests = [];
    let usageRequests = 0;
    page.on("request", request => {
      if (request.url().startsWith("http://127.0.0.1:") && new URL(request.url()).pathname === "/api/usage") usageRequests += 1;
    });
    page.on("requestfailed", request => failedRequests.push({ url: request.url().replace(/^http:\/\/127\.0\.0\.1:[0-9]+/, "http://127.0.0.1:<port>"), error: request.failure()?.errorText }));
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("https://notion.test/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("iframe")).length > 0);
    const frame = page.frames().find(item => item.url().startsWith(dashboardUrl));
    if (!frame) throw new Error("The Notion-like dashboard iframe was not loaded.");
    await frame.waitForFunction(() => state.initialized, undefined, { timeout: 30000 });
    await frame.waitForFunction(() => state.directLocalMode && state.localApiConnected && state.records.length > 0, undefined, { timeout: 30000 }).catch(async error => {
      const diagnostics = await frame.evaluate(() => ({ mode: state.dataMode, directLocalMode: state.directLocalMode, localApiConnected: state.localApiConnected, records: state.records.length, status: document.querySelector("#statusLine")?.textContent }));
      throw new Error(`${error.message}; diagnostics=${JSON.stringify({ ...diagnostics, errors, failedRequests })}`);
    });
    const before = await frame.evaluate(() => ({ mode: state.dataMode, records: state.records.length, calendarRecords: state.calendarRecords.length }));
    const deadline = Date.now() + 20000;
    while ((useLiveLocalApi ? usageRequests : apiRequests) < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if ((useLiveLocalApi ? usageRequests : apiRequests) < 2) throw new Error("Notion desktop direct sync did not repeat the local usage request.");
    if (errors.length) throw new Error("Browser errors: " + JSON.stringify(errors));
    console.log(JSON.stringify({ ok: true, localApi: useLiveLocalApi ? "real" : "fixture", mode: before.mode, directLocalMode: true, records: before.records, calendarRecords: before.calendarRecords, automaticRefreshes: (useLiveLocalApi ? usageRequests : apiRequests) - 1, consoleErrors: errors.length }, null, 2));
  } finally {
    await context.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

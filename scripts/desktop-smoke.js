const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-desktop-smoke-"));
  const sessions = path.join(temporaryRoot, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const now = new Date().toISOString();
  const fixture = [
    { type: "session_meta", timestamp: now, payload: { id: "desktop-smoke", model_provider: "openai" } },
    { type: "token_usage_record", timestamp: now, payload: { session_id: "desktop-smoke", response_id: "smoke-1", usage: { input_tokens: 90, cached_input_tokens: 20, output_tokens: 10, total_tokens: 100 } } }
  ];
  fs.writeFileSync(path.join(sessions, "desktop-smoke.jsonl"), fixture.map(JSON.stringify).join("\n"), "utf8");

  const debugPort = await freePort();
  const packagedExecutable = process.env.CODEX_TOKEN_DESKTOP_SMOKE_EXE;
  const electronPath = packagedExecutable || require("electron");
  const electronArgs = [
    ...(packagedExecutable ? [] : [root]),
    `--user-data-dir=${path.join(temporaryRoot, "profile")}`,
    `--remote-debugging-port=${debugPort}`
  ];
  const child = spawn(electronPath, electronArgs, {
    cwd: root,
    env: { ...process.env, CODEX_SESSIONS_DIR: sessions, DASHBOARD_AUTO_OPEN: "0", CODEX_TOKEN_DASHBOARD_SMOKE: "1" },
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let processOutput = "";
  child.stdout.on("data", chunk => { processOutput += chunk.toString(); });
  child.stderr.on("data", chunk => { processOutput += chunk.toString(); });
  let browser;

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${processOutput}`);
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {}
      await delay(150);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    let page;
    const pageDeadline = Date.now() + 20_000;
    while (Date.now() < pageDeadline) {
      page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes("desktop=1"));
      if (page) break;
      await delay(150);
    }
    assert.ok(page, `Electron window never opened the dashboard. ${processOutput}`);
    await page.waitForFunction(() => document.documentElement.dataset.host === "desktop" && document.querySelector("#viewTitle"), { timeout: 12_000 });
    await page.waitForFunction(() => document.querySelector("#viewPanel")?.textContent?.length > 40, { timeout: 12_000 });
    const appInfo = await page.evaluate(() => ({
      title: document.title,
      host: document.documentElement.dataset.host,
      overviewTitle: document.querySelector("#viewTitle")?.textContent.trim(),
      hasUsageApi: performance.getEntriesByType("resource").some(entry => entry.name.includes("/api/usage")),
      pageText: document.body.innerText.includes("100")
    }));
    assert.equal(appInfo.host, "desktop");
    assert.equal(appInfo.overviewTitle, "运行总览");
    assert.equal(appInfo.hasUsageApi, true);
    assert.equal(appInfo.pageText, true);
    process.stdout.write(`Electron desktop smoke passed: ${JSON.stringify(appInfo)}\n`);

    const exitDeadline = Date.now() + 12_000;
    while (child.exitCode === null && Date.now() < exitDeadline) await delay(100);
    assert.equal(child.exitCode, 0, `Electron did not exit cleanly: ${processOutput}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        delay(5_000)
      ]);
    }
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (error) {
      console.warn(`Temporary smoke profile cleanup deferred: ${temporaryRoot} (${error.code || error.message})`);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

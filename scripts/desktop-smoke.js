/**
 * 桌面端冒烟：真的起一个 Electron，用假会话日志喂数据，检查弹窗与看板窗口
 * 都能正常渲染，并且旧版网页看板的入口确实不在了。
 *
 *   npm run desktop:smoke
 *   CODEX_TOKEN_DESKTOP_SMOKE_EXE=<安装目录>/TokenBar.exe npm run desktop:smoke
 */

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

// 造一份跟真实 Codex 日志同构的会话：session_meta + 两轮 token_count
function writeFixture(sessionsDir) {
  const dir = path.join(sessionsDir, "2026", "10", "30");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const usage = (input, cached, output) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    total_tokens: input + output
  });
  const lines = [
    { timestamp: now, type: "session_meta", payload: { id: "desktop-smoke", cwd: root, model_provider: "openai" } },
    {
      timestamp: now,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: usage(900, 400, 100), total_token_usage: usage(900, 400, 100) },
        rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 5400 } }
      }
    },
    {
      timestamp: new Date(Date.now() + 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: usage(400, 100, 100), total_token_usage: usage(1300, 500, 200) }
      }
    }
  ];
  fs.writeFileSync(path.join(dir, "rollout-desktop-smoke.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

async function findPage(browser, match, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = browser.contexts()
      .flatMap(context => context.pages())
      .find(candidate => candidate.url().includes(match));
    if (page) return page;
    await delay(150);
  }
  return null;
}

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-smoke-"));
  const sessions = path.join(temporaryRoot, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  writeFixture(sessions);

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
    env: {
      ...process.env,
      CODEX_HOME: temporaryRoot,
      WORKBUDDY_HOME: path.join(temporaryRoot, "no-workbuddy"),
      CODEX_TOKEN_DASHBOARD_SMOKE: "1",
      CODEX_TOKEN_DASHBOARD_SMOKE_TIMEOUT: "90000"
    },
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let processOutput = "";
  child.stdout.on("data", chunk => { processOutput += chunk.toString(); });
  child.stderr.on("data", chunk => { processOutput += chunk.toString(); });

  let browser;
  try {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Electron 提前退出（code=${child.exitCode}）：\n${processOutput}`);
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {}
      await delay(150);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);

    // 1. 托盘弹窗：主入口
    const popover = await findPage(browser, "popover.html", 25_000);
    assert.ok(popover, `弹窗没打开。\n${processOutput}`);
    await popover.waitForFunction(
      () => document.body.innerText.trim().length > 20,
      { timeout: 20_000 }
    );
    const popoverInfo = await popover.evaluate(() => ({
      title: document.title,
      host: document.documentElement.dataset.host || "",
      text: document.body.innerText.slice(0, 400),
      hasDashboardButton: !!document.querySelector("#dashboard")
    }));
    assert.equal(popoverInfo.title, "TokenBar");
    assert.ok(popoverInfo.hasDashboardButton, "弹窗里应该有打开完整看板的按钮");

    // 2. 从弹窗点开完整看板
    await popover.click("#dashboard");
    const dashboard = await findPage(browser, "dashboard.html", 20_000);
    assert.ok(dashboard, `看板窗口没打开。\n${processOutput}`);
    await dashboard.waitForFunction(
      () => document.querySelector("#hour-badge") && document.querySelectorAll("#range button").length === 4,
      { timeout: 25_000 }
    );

    // 3. 看板本身：双数据源、区间切换、时段徽标、口径文案
    const info = await dashboard.evaluate(() => ({
      title: document.title,
      sources: [...document.querySelectorAll("#source [data-source]")].map(el => el.dataset.source),
      ranges: [...document.querySelectorAll("#range [data-key]")].map(el => el.dataset.key),
      hourMetrics: [...document.querySelectorAll("#hour-tabs [data-metric]")].map(el => el.dataset.metric),
      hourBadge: (document.querySelector("#hour-badge") || {}).textContent || "",
      bodyText: document.body.innerText,
      legacyButton: !!document.querySelector("#btn-legacy, [data-action='open-legacy']"),
      legacyApi: !!window.dashboard && "openLegacy" in window.dashboard
    }));
    assert.match(info.title, /TokenBar/);
    assert.deepEqual(info.sources.sort(), ["codex", "workbuddy"]);
    assert.deepEqual(info.ranges.sort(), ["0", "14", "30", "7"]);
    assert.deepEqual(info.hourMetrics.sort(), ["speed", "tokens"]);
    assert.notEqual(info.hourBadge.trim(), "—", "时段徽标应该已经有数据");
    assert.match(info.bodyText, /等价花费/);
    assert.equal(info.legacyButton, false, "旧版网页看板按钮应该已经删除");
    assert.equal(info.legacyApi, false, "preload 不应该再暴露 openLegacy");

    // 4. 切一次区间，确认活跃时段跟着变
    const before = await dashboard.evaluate(() => (document.querySelector("#hour-badge") || {}).textContent || "");
    await dashboard.click('#range button[data-key="7"]');
    await dashboard.waitForFunction(
      previous => (document.querySelector("#hour-badge") || {}).textContent !== previous,
      before,
      { timeout: 10_000 }
    );

    assert.equal(child.exitCode, null, `测试期间应用不应该退出：\n${processOutput}`);
    process.stdout.write(`desktop smoke passed: ${JSON.stringify({ popover: popoverInfo.title, ...info, bodyText: undefined })}\n`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5_000)]);
    }
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (error) {
      console.warn(`临时目录没清干净：${temporaryRoot}（${error.code || error.message}）`);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

// Real Chromium + IndexedDB + origin-private filesystem regression for browser sync.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { fixtures } = require("../tests/fixtures/accounting");
const { parseSessionFile } = require("../server");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const site = "https://xiaoqi8553.github.io/codex-token-dashboard/";
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_PATH,
  require("playwright").chromium.executablePath(),
  "C:\\Users\\10242\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find(candidate => candidate && fs.existsSync(candidate));

async function main() {
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext();
  context.setDefaultTimeout(20000);
  await context.newPage(); // Keep OPFS alive while testing close/reopen.
  const errors = [];
  let apiRequests = 0;
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) apiRequests += 1;
    const file = url.pathname.endsWith("usage-accounting.js") ? "usage-accounting.js" : url.pathname.endsWith("demo-usage-index.json")
      ? "sample-data/demo-usage-index.json" : "index.html";
    return route.fulfill({ status: 200, contentType: file.endsWith("js") ? "text/javascript" : file.endsWith("json") ? "application/json" : "text/html", body: fs.readFileSync(path.join(root, file)) });
  });
  await context.addInitScript(() => {
    window.syncReads = 0;
    const stream = File.prototype.stream;
    File.prototype.stream = function () { window.syncReads += 1; return stream.call(this); };
    // OPFS has no external-directory permission prompt; simulate permission state only.
    // Native queryPermission on restored OPFS handles crashes Chrome 153 on Windows.
    FileSystemDirectoryHandle.prototype.queryPermission = function () {
      return Promise.resolve(localStorage.getItem("testPermission") === "prompt" ? "prompt" : "granted");
    };
    FileSystemDirectoryHandle.prototype.requestPermission = function () {
      window.permissionRequests = (window.permissionRequests || 0) + 1;
      localStorage.removeItem("testPermission");
      return Promise.resolve("granted");
    };
  });
  const openPage = async () => {
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(site);
    await page.waitForFunction(() => state.initialized && !state.loading);
    return page;
  };
  let page;
  try {
    page = await openPage();
    for (const fixture of fixtures) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-accounting-"));
      try {
        const file = path.join(directory, "rollout-test.jsonl");
        fs.writeFileSync(file, fixture.text);
        const nodeRecords = parseSessionFile(file).records;
        const browserRecords = await page.evaluate(async fixture => (await parseSessionFiles([
          new File([fixture.text], "rollout-test.jsonl", { lastModified: Date.parse("2026-09-09T08:00:00Z") })
        ])).records, fixture);
        const metrics = records => Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens", "reasoningOutputTokens"].map(key => [key, records.reduce((s, r) => s + (r[key] || 0), 0)]));
        assert.equal(metrics(browserRecords).totalTokens, fixture.expected, fixture.name);
        assert.equal(browserRecords.some(r => r.estimated), false, fixture.name);
        assert.deepEqual(metrics(browserRecords), metrics(nodeRecords), fixture.name);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    const benchmark = await page.evaluate(async () => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("sessions", { create: true });
      const oldDate = "2025-01-02T08:00:00.000Z";
      window.writeFixture = async (name, total = 120, padding = 0) => {
        const file = await directory.getFileHandle(name, { create: true });
        const writer = await file.createWritable();
        await writer.write([
          JSON.stringify({ type: "session_meta", payload: { id: name, timestamp: oldDate, model_provider: "custom", cwd: "C:/fixture/project" } }),
          JSON.stringify({ type: "event_msg", timestamp: oldDate, payload: { info: { total_token_usage: { input_tokens: total - 20, cached_input_tokens: 30, output_tokens: 20, total_tokens: total } } } }),
          JSON.stringify({ type: "response_item", payload: { role: "assistant", text: "x".repeat(padding) } })
        ].join("\n"));
        await writer.close();
      };
      for (let i = 0; i < 160; i += 1) await window.writeFixture(`rollout-${i}.jsonl`, 120 + i, 256 * 1024);
      state.sessionsDirectoryHandle = directory;
      state.sessionsDirectoryName = "sessions";
      state.staticSourceType = "sessions-folder";
      state.staticPayload = null;
      await saveSessionsDirectoryHandle(directory);
      const start = performance.now();
      await loadUsage({ manual: true });
      const coldMs = performance.now() - start;
      const baseline = JSON.stringify(state.staticPayload.records);
      const reads = window.syncReads;
      const warmStart = performance.now();
      await loadUsage({ manual: true });
      const warmMs = performance.now() - warmStart;
      return { coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), sizeMiB: 40,
        equal: baseline === JSON.stringify(state.staticPayload.records), additionalReads: window.syncReads - reads,
        parsed: state.staticPayload.stats.parsedFiles, reused: state.staticPayload.stats.reusedFiles };
    });
    assert.equal(benchmark.equal, true);
    assert.equal(benchmark.additionalReads, 0);
    assert.equal(benchmark.parsed, 0);
    assert.equal(benchmark.reused, 160);

    const mutation = await page.evaluate(async () => {
      await window.writeFixture("rollout-0.jsonl", 999);
      await window.writeFixture("rollout-new.jsonl", 555);
      await state.sessionsDirectoryHandle.removeEntry("rollout-1.jsonl");
      await loadUsage({ manual: true });
      const incremental = state.staticPayload;
      const fresh = await parseSessionFiles(await collectDirectoryFiles(state.sessionsDirectoryHandle));
      return { parsed: incremental.stats.parsedFiles, reused: incremental.stats.reusedFiles,
        equal: JSON.stringify(incremental.records) === JSON.stringify(fresh.records) };
    });
    assert.deepEqual(mutation, { parsed: 2, reused: 158, equal: true });

    // Close and reopen the page: use the actual stored handle and parsed payload.
    await page.reload();
    await page.waitForFunction(() => state.initialized && !state.loading);
    assert.deepEqual(await page.evaluate(() => ({ type: state.staticSourceType, records: state.records.length,
      reads: window.syncReads, refreshed: state.lastRefreshAt > 0, from: els.fromDate.value })),
    { type: "sessions-folder", records: 160, reads: 0, refreshed: true, from: "2025-01-02" });

    // One changed file must be read automatically on the next page open.
    await page.evaluate(async () => {
      const file = await state.sessionsDirectoryHandle.getFileHandle("rollout-new.jsonl");
      const writer = await file.createWritable();
      await writer.write(JSON.stringify({ timestamp: "2025-01-02T08:00:00Z", input_tokens: 700, output_tokens: 30, total_tokens: 730 }));
      await writer.close();
    });
    await page.reload();
    await page.waitForFunction(() => state.initialized && !state.loading);
    assert.equal(await page.evaluate(() => state.staticPayload.stats.parsedFiles), 1);
    assert.equal(await page.evaluate(() => window.syncReads), 1);

    // Permission loss preserves data and never requests permission without a click.
    await page.evaluate(() => localStorage.setItem("testPermission", "prompt"));
    await page.reload();
    await page.waitForFunction(() => state.initialized && !state.loading);
    assert.deepEqual(await page.evaluate(() => ({ records: state.records.length, reads: window.syncReads,
      requested: window.permissionRequests || 0, notice: els.statusNotice.textContent.includes("权限") })),
    { records: 160, reads: 0, requested: 0, notice: true });
    await page.getByRole("button", { name: "同步数据", exact: true }).click();
    await page.waitForFunction(() => !state.loading && state.lastRefreshAt > 0);
    assert.equal(await page.evaluate(() => window.permissionRequests), 1);

    // A handle with no cached payload must recover files instead of loading demo data.
    await page.evaluate(() => clearCachedStaticPayload());
    await page.reload();
    await page.waitForFunction(() => state.initialized && !state.loading);
    assert.equal(await page.evaluate(() => state.staticSourceType), "sessions-folder");
    assert.equal(await page.evaluate(() => state.records.length), 160);

    // An old manifest cannot bypass a full parse; simultaneous sync calls share the lock.
    const final = await page.evaluate(async () => {
      state.staticPayload.sessionFileManifest.parserVersion = -1;
      const reads = window.syncReads;
      await Promise.all([loadUsage({ manual: true }), loadUsage({ auto: true }), loadUsage({ manual: true })]);
      return { reads: window.syncReads - reads, parsed: state.staticPayload.stats.parsedFiles };
    });
    assert.deepEqual(final, { reads: 160, parsed: 160 });

    // Upgrade must preserve stale data while access is denied, then rebuild on consent.
    await page.evaluate(async () => {
      const db = await openHandleDatabase();
      const cached = staticPayloadCacheValue(state.staticPayload);
      cached.parserVersion = 10;
      cached.sessionFileManifest.parserVersion = 10;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(handleDb.store, "readwrite");
        tx.objectStore(handleDb.store).put(cached, handleDb.staticPayloadKey);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      localStorage.setItem("testPermission", "prompt");
    });
    await page.reload();
    await page.waitForFunction(() => state.initialized && !state.loading);
    assert.equal(await page.evaluate(() => state.staticPayload.records.length), 160);
    assert.equal(await page.evaluate(() => state.staticPayload.parserStale), true);
    assert.equal(await page.evaluate(() => els.statusNotice.textContent.includes("尚未重新计算")), true);
    assert.equal(await page.evaluate(() => window.syncReads), 0);
    await page.getByRole("button", { name: "同步数据", exact: true }).click();
    await page.waitForFunction(() => !state.loading && !state.staticPayload.parserStale);
    assert.equal(await page.evaluate(() => state.staticPayload.stats.parsedFiles), 160);
    assert.equal(await page.evaluate(async () => (await loadCachedStaticPayload()).parserStale), false);

    // A stale cached date range must not hide newly synced current-day usage.
    await page.evaluate(async () => {
      const file = await state.sessionsDirectoryHandle.getFileHandle("rollout-today.jsonl", { create: true });
      const writer = await file.createWritable();
      await writer.write(JSON.stringify({ timestamp: new Date().toISOString(), input_tokens: 700, output_tokens: 30, total_tokens: 730 }));
      await writer.close();
    });
    await page.reload();
    await page.waitForFunction(() => state.initialized && !state.loading);
    assert.deepEqual(await page.evaluate(() => ({ range: state.range, total: state.staticPayload.records.length,
      visible: state.records.length, today: state.records[0]?.date === todayString() })),
    { range: "7d", total: 161, visible: 1, today: true });

    await page.evaluate(() => localStorage.setItem("codexTokenSourceAttributionMode", "evidence"));
    await page.reload();
    await page.waitForFunction(() => state.initialized && !state.loading);
    assert.equal(await page.evaluate(() => state.staticPayload.stats.parsedFiles), 161);

    // One-shot imports retain their source mode and recover without a directory scan.
    await page.evaluate(async () => {
      state.staticPayload.sourceType = "sessions-files";
      await cacheStaticPayload(state.staticPayload);
    });
    await page.reload();
    await page.waitForFunction(() => state.initialized && !state.loading);
    assert.equal(await page.evaluate(() => state.staticSourceType), "sessions-files");
    assert.equal(await page.evaluate(() => window.syncReads), 0);
    assert.equal(apiRequests, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, benchmark, mutation, checks: ["unchanged reuse", "add/change/delete equality", "reopen IndexedDB", "startup autosync", "permission retry", "handle-only recovery", "parser invalidation", "sync lock", "new current-day data", "evidence mode", "one-shot import recovery", "no Pages API request"] }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

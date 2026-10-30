// Real Chromium + IndexedDB + origin-private filesystem regression for browser sync.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { fixtures } = require("../tests/fixtures/accounting");
const { speedFixture } = require("../tests/fixtures/output-speed");
const OutputSpeed = require("../output-speed");
const compressedFixtures = require("../tests/fixtures/compressed-sessions.json");
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
    if (url.hostname === "notion.test") {
      return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Notion embed test</title><iframe title="dashboard" src="${site}" style="width:100%;height:100vh;border:0"></iframe>` });
    }
    if (url.pathname.startsWith("/api/")) apiRequests += 1;
    const file = url.pathname.endsWith("vendor/fzstd/fzstd.js") ? "vendor/fzstd/fzstd.js" : url.pathname.endsWith("session-files.js") ? "session-files.js" : url.pathname.endsWith("output-speed.js") ? "output-speed.js" : url.pathname.endsWith("usage-accounting.js") ? "usage-accounting.js" : url.pathname.endsWith("demo-usage-index.json")
      ? "sample-data/demo-usage-index.json" : url.pathname.endsWith("folder-picker.html") ? "folder-picker.html" : "index.html";
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
    const coldDemo = await page.evaluate(() => ({ records: state.records.length, samples: CodexOutputSpeed.summarize(state.records).samples.length }));
    assert.ok(coldDemo.records > 0 && coldDemo.samples > 0, "a fresh Pages visit must show demo usage and speed without requiring a sync click");
    const extensionFixture = await page.evaluate(() => state.data);
    for (const fixture of [...fixtures, speedFixture]) {
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
        assert.deepEqual(browserRecords.map(OutputSpeed.timingFields), nodeRecords.map(OutputSpeed.timingFields), `${fixture.name}: browser/Node timing parity`);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    for (const fixture of compressedFixtures) {
      const result = await page.evaluate(async fixture => {
        const bytes = Uint8Array.from(atob(fixture.compressedBase64), char => char.charCodeAt(0));
        const file = new File([bytes], "rollout-compressed.jsonl.zst");
        // Tiny chunks cross zstd headers, blocks, JSON lines and multibyte UTF-8.
        Object.defineProperty(file, "stream", { value: () => new ReadableStream({ start(controller) {
          for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
          controller.close();
        } }) });
        const compressed = await parseSessionFiles([file]);
        const plain = await parseSessionFiles([new File([fixture.text], "rollout-compressed.jsonl")]);
        const fields = rows => rows.map(row => [row.totalTokens, row.inputTokens, row.outputTokens, row.cachedInputTokens, row.model, row.estimated, row.turnDurationMs || 0]);
        return { compressed: fields(compressed.records), plain: fields(plain.records), count: compressed.stats.compressedFiles };
      }, fixture);
      assert.deepEqual(result.compressed, result.plain, `${fixture.name}: streaming compressed import matches plain logs`);
      assert.equal(result.count, 1);
    }
    const compression = await page.evaluate(async fixtures => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("codex-root", { create: true });
      const sessions = await root.getDirectoryHandle("sessions", { create: true });
      const archives = await root.getDirectoryHandle("archived_sessions", { create: true });
      const bytes = fixture => Uint8Array.from(atob(fixture.compressedBase64), char => char.charCodeAt(0));
      const write = async (dir, name, data) => { const writer = await (await dir.getFileHandle(name, { create: true })).createWritable(); await writer.write(data); await writer.close(); };
      await write(sessions, "rollout-active.jsonl.zst", bytes(fixtures[0]));
      await write(archives, "rollout-archive.jsonl.zst", bytes(fixtures[1]));
      await write(root, "auth.json", '{"fake":"must not become usage"}');
      const selected = await collectDirectoryFiles(root);
      const first = await parseSessionFiles(selected);
      const archiveOnly = await parseSessionFiles(await collectDirectoryFiles(archives));
      const warm = await parseSessionFiles(await collectDirectoryFiles(root), { previousPayload: first });
      await write(sessions, "rollout-active.jsonl", fixtures[0].text);
      const duplicate = await parseSessionFiles(await collectDirectoryFiles(root), { previousPayload: warm });
      const total = payload => payload.records.reduce((sum, row) => sum + row.totalTokens, 0);
      state.sessionsDirectoryHandle = root; state.sessionsDirectoryName = ".codex";
      state.dataMode = "static"; state.staticSourceType = "sessions-folder"; state.staticPayload = duplicate;
      await write(archives, "rollout-archive.jsonl.zst", "broken compressed data");
      await loadUsage({ silent: true });
      return { first: first.stats, archiveOnly: archiveOnly.stats, warm: warm.stats, duplicate: duplicate.stats, totals: [total(first), total(warm), total(duplicate)], preserved: state.staticPayload === duplicate, error: document.querySelector("#statusNotice").textContent };
    }, compressedFixtures);
    assert.equal(compression.first.sessionFiles, 2);
    assert.equal(compression.first.compressedFiles, 2);
    assert.equal(compression.first.archivedFiles, 1);
    assert.equal(compression.archiveOnly.archivedFiles, 1);
    assert.equal(compression.warm.parsedFiles, 0);
    assert.equal(compression.warm.reusedFiles, 2);
    assert.equal(compression.duplicate.sessionFiles, 2);
    assert.equal(compression.duplicate.compressedFiles, 1);
    assert.equal(compression.duplicate.parsedFiles, 1);
    assert.ok(compression.totals.every(total => total === compression.totals[0]));
    assert.equal(compression.preserved, true);
    assert.match(compression.error, /压缩.*失败/);

    const transientRead = await page.evaluate(async fixture => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("retry-sessions", { create: true });
      const fileHandle = await directory.getFileHandle("rollout-network.jsonl", { create: true });
      const writer = await fileHandle.createWritable();
      await writer.write(fixture.text);
      await writer.close();
      const getFile = fileHandle.getFile.bind(fileHandle);
      let freshSnapshots = 0;
      fileHandle.getFile = async () => { freshSnapshots += 1; return getFile(); };
      const originalStream = File.prototype.stream;
      let attempts = 0;
      File.prototype.stream = function () {
        if (this.name === "rollout-network.jsonl" && attempts++ === 0) {
          return new ReadableStream({ start(controller) { controller.error(new DOMException("network error", "NetworkError")); } });
        }
        return originalStream.call(this);
      };
      try {
        const payload = await parseSessionFiles([{
          file: await fileHandle.getFile(), fileHandle, relativePath: "sessions/rollout-network.jsonl"
        }]);
        return { attempts, freshSnapshots, records: payload.records.length,
          total: payload.records.reduce((sum, row) => sum + row.totalTokens, 0), expected: fixture.expected };
      } finally {
        File.prototype.stream = originalStream;
      }
    }, fixtures[0]);
    assert.deepEqual(transientRead, { attempts: 2, freshSnapshots: 2, records: 1, total: fixtures[0].expected, expected: fixtures[0].expected });

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

    // Use real pointer clicks; parsing tests alone miss a swallowed import click.
    const retained = await page.evaluate(() => state.staticPayload.records.length);
    await page.evaluate(() => {
      window.pickerCalls = 0;
      window.showDirectoryPicker = () => {
        window.pickerCalls += 1;
        window.pickerActivation = navigator.userActivation.isActive;
        return Promise.reject(new DOMException("Picker aborted", "AbortError"));
      };
      state.loading = true; // A silent background refresh does not disable import.
    });
    await page.locator("#importBtn").click();
    await page.locator("#importFolderBtn").click();
    await page.waitForFunction(() => !state.directoryPickerOpen);
    assert.deepEqual(await page.evaluate(() => ({ calls: window.pickerCalls, active: window.pickerActivation, loading: state.loading })),
      { calls: 1, active: true, loading: true }, "background sync must not swallow the click or lose its busy lock on picker cancellation");
    assert.match(await page.locator("#statusNotice").innerText(), /一次性兼容导入/);
    assert.equal(await page.evaluate(() => state.staticPayload.records.length), retained);
    await page.evaluate(() => { state.loading = false; window.showDirectoryPicker = () => Promise.reject(new DOMException("Not allowed", "SecurityError")); });
    await page.locator("#importBtn").click();
    await page.locator("#importFolderBtn").click();
    await page.waitForFunction(() => !state.directoryPickerOpen);
    assert.match(await page.locator("#statusNotice").innerText(), /Not allowed.*一次性兼容导入/);

    // A successful selection made during a refresh waits before swapping handles.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      window.selectedDirectory = await root.getDirectoryHandle("picker-selection", { create: true });
      const file = await window.selectedDirectory.getFileHandle("rollout-picker.jsonl", { create: true });
      const writer = await file.createWritable();
      await writer.write(JSON.stringify({ timestamp: new Date().toISOString(), input_tokens: 100, output_tokens: 25, total_tokens: 125 }));
      await writer.close();
      window.previousDirectory = state.sessionsDirectoryHandle;
      window.showDirectoryPicker = () => Promise.resolve(window.selectedDirectory);
      state.loading = true;
    });
    await page.locator("#importBtn").click();
    await page.locator("#importFolderBtn").click();
    assert.equal(await page.evaluate(() => state.sessionsDirectoryHandle === window.previousDirectory), true);
    await page.evaluate(() => { state.loading = false; });
    await page.waitForFunction(() => !state.directoryPickerOpen && !state.loading);
    assert.equal(await page.evaluate(() => state.staticPayload.records.reduce((sum, row) => sum + row.totalTokens, 0)), 125);

    const pickerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-picker-"));
    try {
      const codexRoot = path.join(pickerDirectory, ".codex");
      fs.mkdirSync(path.join(codexRoot, "sessions"), { recursive: true });
      fs.mkdirSync(path.join(codexRoot, "archived_sessions"));
      fs.writeFileSync(path.join(codexRoot, "sessions", "rollout-picker.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), input_tokens: 50, output_tokens: 10, total_tokens: 60 }));
      fs.writeFileSync(path.join(codexRoot, "archived_sessions", "rollout-archive.jsonl.zst"), Buffer.from(compressedFixtures[0].compressedBase64, "base64"));
      fs.writeFileSync(path.join(codexRoot, "auth.json"), "{\"unrelated\":true}");
      for (const width of [1920, 1366, 390]) {
        await page.setViewportSize({ width, height: 920 });
        // Keep a native promise pending, then use the independently clickable fallback.
        await page.evaluate(() => { window.showDirectoryPicker = () => new Promise(resolve => { window.latePicker = resolve; }); });
        await page.locator("#importBtn").click();
        await page.locator("#importFolderBtn").click();
        assert.equal(await page.evaluate(() => state.directoryPickerOpen), true);
        await page.locator("#importBtn").click();
        const chooserEvent = page.waitForEvent("filechooser");
        await page.locator("#importFolderCompatBtn").click();
        const chooser = await chooserEvent;
        assert.equal(chooser.isMultiple(), true);
        await chooser.setFiles(codexRoot);
        await page.waitForFunction(() => !state.loading && !state.directoryPickerOpen);
        assert.deepEqual(await page.evaluate(() => ({ type: state.staticSourceType, files: state.staticPayload.stats.sessionFiles,
          compressed: state.staticPayload.stats.compressedFiles, archived: state.staticPayload.stats.archivedFiles,
          total: state.staticPayload.records.reduce((sum, row) => sum + row.totalTokens, 0) })),
        { type: "sessions-files", files: 2, compressed: 1, archived: 1, total: 310 });
        await page.evaluate(() => window.latePicker(window.selectedDirectory));
        assert.equal(await page.evaluate(() => state.sessionsDirectoryHandle), null, "a late native result cannot replace compatibility import");
        assert.match(await page.locator("#toast").innerText(), /一次性导入/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      // Browsers without File System Access use the same native input event path.
      await page.evaluate(() => { window.showDirectoryPicker = undefined; });
      await page.locator("#importBtn").click();
      const chooserEvent = page.waitForEvent("filechooser");
      await page.locator("#importFolderBtn").click();
      await (await chooserEvent).setFiles(codexRoot);
      await page.waitForFunction(() => !state.loading && !state.directoryPickerOpen);
      assert.equal(await page.evaluate(() => state.staticSourceType), "sessions-files");

      // Notion may sever the popup's opener, so persistent folder handles are
      // not transferred from the static embed. Explain the local Node route.
      const embedPage = await context.newPage();
      embedPage.on("pageerror", error => errors.push(error.message));
      await embedPage.addInitScript(() => {
        const nativeSetInterval = window.setInterval.bind(window);
        window.setInterval = (callback, delay, ...args) => nativeSetInterval(callback, delay === 30000 || delay === 5000 ? 150 : delay, ...args);
      });
      await embedPage.addInitScript(payload => {
        if (window.location.hostname !== "xiaoqi8553.github.io") return;
        window.__extensionUsageCalls = 0;
        window.addEventListener("message", event => {
          const request = event.data;
          if (event.source !== window || event.origin !== window.location.origin ||
              request?.channel !== "codex-token-dashboard-page-bridge") return;
          let result;
          if (request.type === "probe") {
            result = { ok: true, extensionVersion: "test" };
          } else if (request.type === "usage") {
            window.__extensionUsageCalls += 1;
            result = { ok: true, payload: { ...payload, ok: true, scanMs: 1, config: { accountSyncAvailable: false } } };
          } else {
            return;
          }
          window.postMessage({
            channel: request.channel,
            type: "response",
            requestId: request.requestId,
            result
          }, window.location.origin);
        });
      }, extensionFixture);
      await embedPage.goto("https://notion.test/");
      const embedded = embedPage.frameLocator('iframe[title="dashboard"]');
      const dashboardFrame = embedPage.frames().find(frame => frame.url().startsWith(site));
      assert.ok(dashboardFrame, "Notion-like page must load the dashboard as a separate origin");
      await dashboardFrame.waitForFunction(() => state.initialized && state.dataMode === "extension" && state.records.length > 0);
      await dashboardFrame.waitForFunction(() => window.__extensionUsageCalls >= 2);
      assert.equal(await dashboardFrame.evaluate(() => state.data?.ok), true, "extension transport must apply the local usage API response");
      assert.equal(await dashboardFrame.evaluate(() => state.records.length), extensionFixture.records.length, "extension sync must populate the iframe from the returned API records");
      await dashboardFrame.evaluate(() => { window.popupCalls = 0; window.open = () => { window.popupCalls += 1; return null; }; });
      await embedded.locator("#importBtn").click();
      await embedded.locator("#importFolderBtn").click();
      assert.match(await embedded.locator("#toast").innerText(), /扩展已自动同步本机数据/);
      assert.match(await embedded.locator("#importFolderBtn").innerText(), /扩展已持续同步本机数据/);
      assert.equal(await dashboardFrame.evaluate(() => state.directoryPickerOpen), false, "a blocked popup must not leave folder sync locked");
      assert.equal(await dashboardFrame.evaluate(() => window.popupCalls), 0, "Notion embed must not launch a disconnected authorization popup");
      await embedPage.close();
    } finally {
      fs.rmSync(pickerDirectory, { recursive: true, force: true });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, benchmark, mutation, checks: ["unchanged reuse", "add/change/delete equality", "reopen IndexedDB", "startup autosync", "permission retry", "handle-only recovery", "parser invalidation", "sync lock", "transient file network error retry", "new current-day data", "evidence mode", "one-shot import recovery", "no Pages API request", "picker click during sync", "picker abort and security feedback", "native picker selection waits for sync", "compatibility filechooser at 1920/1366/mobile", "Notion cross-origin iframe extension handshake and repeated local usage refresh", "Notion embed skips disconnected folder picker popup", "late native result ignored", "unsupported native picker fallback"] }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

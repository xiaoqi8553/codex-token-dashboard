const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const buildSource = fs.readFileSync(path.join(root, "scripts", "build-static.js"), "utf8");
const auditSource = fs.readFileSync(path.join(root, "scripts", "ui-review.js"), "utf8");
const visualSource = fs.readFileSync(path.join(root, "scripts", "visual-check.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const { createBridge } = require(path.join(root, "scripts", "account-bridge.js"));
const { safeAccountName } = require(path.join(root, "scripts", "account-snapshot-process.js"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function bridgeRequest(port, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : "";
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: options.path || "/api/account/snapshot",
      method: options.method || "POST",
      headers: {
        origin: options.origin || "https://xiaoqi8553.github.io",
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
        ...(options.headers || {})
      }
    }, response => {
      let responseBody = "";
      response.on("data", chunk => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: responseBody }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = indexSource.lastIndexOf(marker);
  assert.notEqual(start, -1, `Missing ${name}`);

  const signatureEnd = indexSource.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `Missing body for ${name}`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = bodyStart; index < indexSource.length; index += 1) {
    const char = indexSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return indexSource.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated ${name}`);
}

test("chart date expansion preserves local date keys in UTC+8", () => {
  const context = {
    els: {
      fromDate: { value: "2026-06-08" },
      toDate: { value: "2026-06-09" }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction("localDateKey")}; ${extractFunction("expandChartDays")}; this.expandChartDays = expandChartDays;`, context);

  const result = context.expandChartDays([
    { date: "2026-06-08", totalTokens: 10 },
    { date: "2026-06-09", totalTokens: 20 }
  ]);

  assert.deepEqual(Array.from(result, day => day.date), ["2026-06-08", "2026-06-09"]);
  assert.equal(result[1].totalTokens, 20);
});

test("sessions import streams large files and ignores irrelevant rollout records", () => {
  const relevantStart = indexSource.lastIndexOf("function isRelevantSessionImportLine(");
  const relevantEnd = indexSource.indexOf("function yieldSessionImport(", relevantStart);
  const relevantSource = indexSource.slice(relevantStart, relevantEnd);
  const readerSource = extractFunction("readSessionFileLines");
  const parserSource = extractFunction("parseSessionFiles");

  assert.match(relevantSource, /recordType === "session_meta" \|\| recordType === "turn_context"/);
  assert.match(relevantSource, /recordType === "event_msg"/);
  assert.match(relevantSource, /recordType === "response_item"/);
  assert.match(relevantSource, /"compacted", "world_state", "inter_agent_communication_metadata"/);
  assert.match(relevantSource, /if \(recordType\) return usagePattern\.test\(text\)/);
  assert.match(readerSource, /file\.stream/);
  assert.match(readerSource, /yieldSessionImport/);
  assert.match(parserSource, /readSessionFileLines/);
  assert.match(parserSource, /fallbackText = fallbackText \|\| await file\.text\(\)/);
  assert.match(parserSource, /const estimated = estimateTokens\(fallbackText\)/);
  assert.match(indexSource, /onProgress:\s*reportSessionImportProgress/);
});

test("large browser imports persist in IndexedDB and restore on startup", () => {
  const cacheSource = extractFunction("cacheStaticPayload");
  const loadSource = extractFunction("loadCachedStaticPayload");
  const clearSource = extractFunction("clearCachedStaticPayload");
  const initializeSource = extractFunction("initializeDashboard");

  assert.match(indexSource, /staticPayloadKey:\s*"staticPayload"/);
  assert.match(cacheSource, /await saveStaticPayloadToDatabase\(cached\)/);
  assert.match(loadSource, /get\(handleDb\.staticPayloadKey\)/);
  assert.match(loadSource, /codexTokenStaticPayload/);
  assert.match(clearSource, /delete\(handleDb\.staticPayloadKey\)/);
  assert.match(initializeSource, /await restoreSavedSessionsDirectory/);
  assert.ok(initializeSource.indexOf("await restoreSavedSessionsDirectory") < initializeSource.indexOf('applyRange("7d")'));
  assert.match(indexSource, /await cacheStaticPayload\(payload\)/);
});

test("0.7 KPI typography is container-responsive and uses one left alignment", () => {
  const heroBlocks = indexSource.match(/\.metric\.hero\s*\{[^}]+\}/g) || [];
  const heroCss = heroBlocks.at(-1) || "";
  const heroValueCss = [...indexSource.matchAll(/\.metric\.hero \.metric-value\s*\{[^}]+\}/g)].at(-1)?.[0] || "";
  const metricValueCss = [...indexSource.matchAll(/\.metric:not\(\.hero\) \.metric-value\s*\{[^}]+\}/g)].at(-1)?.[0] || "";
  const trendTotalCss = [...indexSource.matchAll(/\.trend-total-value\s*\{[^}]+\}/g)].at(-1)?.[0] || "";

  assert.match(heroCss, /linear-gradient/);
  assert.doesNotMatch(heroCss, /28px 28px/);
  assert.doesNotMatch(heroCss, /background:\s*var\(--ink\)/);
  assert.match(heroValueCss, /clamp\(42px,\s*13cqi,\s*58px\)/);
  assert.match(metricValueCss, /clamp\(32px,\s*9\.5cqi,\s*42px\)/);
  assert.match(trendTotalCss, /clamp\(34px,\s*20cqi,\s*46px\)/);
  assert.match(indexSource, /\.metric\s*\{[^}]*container-type:\s*inline-size/s);
  assert.match(indexSource, /--hero-bg-a:\s*#f5f9ff/);
  assert.match(indexSource, /--hero-bg-b:\s*#e4efff/);
  assert.match(indexSource, /\.metric\.hero \.metric-body\s*\{[^}]*justify-items:\s*start[^}]*text-align:\s*left/s);
  assert.match(indexSource, /\.metric\.hero \.metric-foot\s*\{\s*justify-content:\s*flex-start/);
});

test("sessions import fits dates only when the current preset hides every record", () => {
  const makeContext = () => ({
    state: { range: "7d" },
    els: {
      fromDate: { value: "2026-07-04" },
      toDate: { value: "2026-07-10" }
    },
    syncDateDisplays() {},
    setActiveRange(value) { this.activeRange = value; }
  });

  const hiddenContext = makeContext();
  vm.createContext(hiddenContext);
  vm.runInContext(`${extractFunction("fitDateRangeToRecords")}; this.fitDateRangeToRecords = fitDateRangeToRecords;`, hiddenContext);
  hiddenContext.fitDateRangeToRecords([
    { date: "2026-05-01" },
    { date: "2026-05-03" }
  ], { preservePreset: true });
  assert.equal(hiddenContext.els.fromDate.value, "2026-05-01");
  assert.equal(hiddenContext.els.toDate.value, "2026-05-03");
  assert.equal(hiddenContext.state.range, "custom");

  const overlappingContext = makeContext();
  vm.createContext(overlappingContext);
  vm.runInContext(`${extractFunction("fitDateRangeToRecords")}; this.fitDateRangeToRecords = fitDateRangeToRecords;`, overlappingContext);
  overlappingContext.fitDateRangeToRecords([{ date: "2026-07-10" }], { preservePreset: true });
  assert.equal(overlappingContext.els.fromDate.value, "2026-07-04");
  assert.equal(overlappingContext.els.toDate.value, "2026-07-10");
  assert.equal(overlappingContext.state.range, "7d");
});

test("daily Token trend remains a stacked bar chart", () => {
  const trendSource = extractFunction("renderTrend");
  assert.match(trendSource, /<button class="day"/);
  assert.doesNotMatch(trendSource, /renderUsageCurveChart/);
});

test("daily Token trend uses a layered chart treatment", () => {
  assert.match(indexSource, /<style id="v072-trend-design">/);
  assert.match(indexSource, /\.trend::before\s*\{/);
  assert.match(indexSource, /\.stack::before\s*\{/);
  assert.match(indexSource, /linear-gradient\(105deg/);
  assert.match(indexSource, /\.day:hover \.stack\s*\{/);
  assert.match(indexSource, /.stack-outer::after\s*\{/);
});

test("daily Token trend date labels fit within the chart card", () => {
  const trendSource = extractFunction("renderTrend");
  const trendCss = indexSource.match(/\.trend\s*\{[^}]+\}/)?.[0] || "";
  const dayLabelCss = indexSource.match(/\.day-label\s*\{[^}]+\}/)?.[0] || "";
  assert.match(trendCss, /minmax\(0,\s*1fr\)/);
  assert.match(trendCss, /gap:\s*var\(--bar-gap/);
  assert.doesNotMatch(trendCss, /minmax\(24px,\s*1fr\)/);
  assert.match(dayLabelCss, /display:\s*grid/);
  assert.match(trendSource, /--bar-gap/);
  assert.match(trendSource, /dataset\.density/);
  assert.match(trendSource, /day-label-month/);
  assert.match(trendSource, /day-label-day/);
  assert.doesNotMatch(indexSource, /\.day:first-child\s+\.bar-value/);
  assert.doesNotMatch(indexSource, /\.day:last-child\s+\.bar-value/);
  assert.match(indexSource, /\.trend\[data-density="regular"\]\s*\{\s*padding-inline:\s*32px/);
  assert.doesNotMatch(dayLabelCss, /writing-mode:\s*vertical-rl/);
  assert.doesNotMatch(dayLabelCss, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(dayLabelCss, /overflow:\s*hidden/);
});

test("daily Token trend supports one year range with a total summary", () => {
  const applyRangeSource = extractFunction("applyRange");
  const trendSource = extractFunction("renderTrend");
  const totalSource = extractFunction("renderTrendTotal");
  const monthlySource = extractFunction("bucketTrendDays");
  const summaryCss = [...indexSource.matchAll(/\.trend-total-card\s*\{[^}]+\}/g)].findLast(block => /container-type/.test(block[0]))?.[0] || "";

  assert.match(indexSource, /data-range="1y"[^>]*>1年/);
  assert.match(applyRangeSource, /range === "1y"/);
  assert.match(applyRangeSource, /todayString\(-364\)/);
  assert.match(monthlySource, /const bucketKey = date\.slice\(0, 7\)/);
  assert.match(trendSource, /bucketTrendDays\(expandedDays\)/);
  assert.match(indexSource, /id="trendTotal"/);
  assert.match(totalSource, /累计 Token/);
  assert.match(summaryCss, /min-width:\s*0/);
  assert.match(summaryCss, /container-type:\s*inline-size/);
});

test("ratio chart uses an accessible SVG ring and structured legend", () => {
  const ratioSource = extractFunction("renderRatio");
  assert.match(ratioSource, /class="ratio-ring"/);
  assert.match(ratioSource, /role="img"/);
  assert.match(ratioSource, /<title>/);
  assert.match(ratioSource, /ratio-legend-row/);
  assert.match(ratioSource, /缓存输入/);
  assert.doesNotMatch(ratioSource, /class="donut"/);
  assert.doesNotMatch(ratioSource, /class="bar-row"/);
});

test("UI audit blocks key number overflow, KPI drift, and tiny daily labels", () => {
  assert.match(auditSource, /key-content-overflow/);
  assert.match(auditSource, /kpi-value-misaligned/);
  assert.match(auditSource, /kpi-text-misaligned/);
  assert.match(auditSource, /trend-label-small/);
  assert.match(auditSource, /trend-value-misaligned/);
  assert.match(auditSource, /trend-value-overflow/);
  assert.match(auditSource, /\.trend-total-value/);
  assert.match(auditSource, /scrollWidth > item\.clientWidth/);
  assert.doesNotMatch(auditSource, /新增项目维度 Token 统计/);
  assert.match(indexSource, /--control-active-bg:\s*#79a1ff/);
  assert.match(indexSource, /--control-active-ink:\s*#0b1522/);
  assert.match(visualSource, /navContrast >= 4\.5/);
  assert.match(visualSource, /rangeContrast >= 4\.5/);
  assert.match(auditSource, /nodeModules.*playwright/);
  assert.match(visualSource, /nodeModules.*playwright/);
  assert.match(auditSource, /settings-bridge.*staticMode:\s*true/);
  assert.match(auditSource, /pageInfo\.staticMode[\s\S]*api\/usage[\s\S]*Static preview/);
});

test("usage trend has no persistent numeric overlays or summaries", () => {
  const curveSource = extractFunction("renderUsageCurveChart");
  const cacheSource = extractFunction("renderCacheTrend");

  assert.doesNotMatch(curveSource, /usage-value-label/);
  assert.doesNotMatch(curveSource, /usage-trend-topline/);
  assert.doesNotMatch(curveSource, /usage-trend-badges/);
  assert.doesNotMatch(indexSource, /cacheTrendSummary/);
  assert.doesNotMatch(cacheSource, /峰值 active|缓存 \$\{formatToken|命中率 \$\{avgHit\}% \/ active/);
});

test("0.8.3 uses the engineering workspace shell and removes Work Replay", () => {
  assert.equal(packageJson.version, "0.8.3");
  assert.match(indexSource, /class="side-rail shell"/);
  assert.match(indexSource, /id="viewTitle"/);
  assert.match(indexSource, /v0\.8\.3/);
  assert.doesNotMatch(indexSource, /replayBtn|replay\.html|工作回放/);
  assert.doesNotMatch(buildSource, /replay\.html/);
  assert.equal(fs.existsSync(path.join(root, "replay.html")), false);
});

test("local account snapshot keeps credentials out of metadata", t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-account-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const codexHome = path.join(tempRoot, ".codex");
  const accountRoot = path.join(tempRoot, "XQ_acc");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { account_id: "test-account", access_token: "SECRET_SHOULD_NOT_BE_IN_METADATA" } }));
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"gpt-5\"\n");
  const result = childProcess.spawnSync(process.execPath, [
    path.join(root, "scripts", "sync-codex-account.js"),
    "--account-name", "测试账号",
    "--codex-home", codexHome,
    "--account-root", accountRoot,
    "--json"
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(accountRoot, "测试账号");
  assert.equal(fs.existsSync(path.join(target, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(target, "config.toml")), true);
  assert.doesNotMatch(fs.readFileSync(path.join(target, "metadata.json"), "utf8"), /SECRET_SHOULD_NOT_BE_IN_METADATA/);
  assert.match(serverSource, /\/api\/account\/snapshot/);
  assert.match(serverSource, /PUBLIC_ACCESS \|\| !isLoopbackHost\(HOST\)/);
});

test("account snapshot names accept emails but reject unsafe Windows names", () => {
  assert.equal(safeAccountName("user.name+codex@example.com"), "user.name+codex@example.com");
  assert.equal(safeAccountName("账号 A（Plus）"), "账号 A（Plus）");
  assert.throws(() => safeAccountName("../escape"));
  assert.throws(() => safeAccountName("CON"));
  assert.throws(() => safeAccountName("trailing."));
});

test("GitHub Pages account bridge requires origin and one-time pairing key", async t => {
  let snapshotCalls = 0;
  const bridge = createBridge({
    port: 0,
    pairingKey: "ABCD2345",
    closeAfterSuccess: false,
    snapshotRunner: async payload => {
      snapshotCalls += 1;
      return {
        ok: true,
        accountName: payload.accountName,
        accountDir: "C:\\SECRET\\ACCOUNT",
        updatedFiles: ["auth.json", "config.toml"],
        ccswitch: { requested: true, status: "updated", providerName: "OpenAI Official", backupPath: "C:\\SECRET\\BACKUP" }
      };
    }
  });
  await new Promise((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    if (bridge.server.listening) bridge.server.close();
  });
  const port = bridge.server.address().port;

  const preflight = await bridgeRequest(port, {
    method: "OPTIONS",
    headers: {
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-codex-bridge-key",
      "access-control-request-private-network": "true"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://xiaoqi8553.github.io");
  assert.equal(preflight.headers["access-control-allow-private-network"], "true");

  const blockedOrigin = await bridgeRequest(port, {
    origin: "https://example.com",
    headers: { "x-codex-bridge-key": "ABCD-2345" },
    body: { accountName: "工作号" }
  });
  assert.equal(blockedOrigin.status, 403);

  const wrongKey = await bridgeRequest(port, {
    headers: { "x-codex-bridge-key": "WXYZ-6789" },
    body: { accountName: "工作号" }
  });
  assert.equal(wrongKey.status, 401);
  assert.equal(snapshotCalls, 0);

  const success = await bridgeRequest(port, {
    headers: { "x-codex-bridge-key": "ABCD-2345" },
    body: { accountName: "工作号", syncCcSwitch: true }
  });
  assert.equal(success.status, 200);
  assert.equal(snapshotCalls, 1);
  assert.doesNotMatch(success.body, /SECRET|accountDir|backupPath/);
  assert.match(indexSource, /targetAddressSpace:\s*"loopback"/);
  assert.match(indexSource, /start-account-bridge\.bat/);
  assert.doesNotMatch(extractFunction("syncAccountSnapshotViaBridge"), /localStorage/);
});

test("GitHub Pages bridge runs the real snapshot process and writes the requested archive path", async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-bridge-e2e-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    tokens: { account_id: "bridge-test", access_token: "BRIDGE_TEST_SECRET" }
  }));
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"bridge-test-model\"\n");

  const bridge = createBridge({
    port: 0,
    pairingKey: "ABCD2345",
    closeAfterSuccess: false,
    codexHome
  });
  await new Promise((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    if (bridge.server.listening) bridge.server.close();
  });

  const response = await bridgeRequest(bridge.server.address().port, {
    headers: { "x-codex-bridge-key": "ABCD-2345" },
    body: { accountName: "user.name+codex@example.com" }
  });
  assert.equal(response.status, 200, response.body);
  assert.equal(JSON.parse(response.body).ok, true);

  const target = path.join(codexHome, "XQ", "_acc", "user.name+codex@example.com");
  assert.equal(fs.existsSync(path.join(target, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(target, "config.toml")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "auth.json"), "utf8")).tokens.account_id, "bridge-test");
  assert.doesNotMatch(fs.readFileSync(path.join(target, "metadata.json"), "utf8"), /BRIDGE_TEST_SECRET/);
  assert.doesNotMatch(response.body, /BRIDGE_TEST_SECRET|accountDir/);
});

test("Windows account bridge launcher is CRLF-safe and keeps diagnostics visible", () => {
  const launcherPath = path.join(root, "start-account-bridge.bat");
  const launcher = fs.readFileSync(launcherPath);
  const launcherText = launcher.toString("utf8");
  const powershellLauncher = fs.readFileSync(path.join(root, "scripts", "start-account-bridge.ps1"), "utf8");

  assert.doesNotMatch(launcherText, /(?<!\r)\n/);
  assert.match(launcherText, /powershell\.exe .*start-account-bridge\.ps1/i);
  assert.match(powershellLauncher, /Find-NodeExecutable/);
  assert.match(powershellLauncher, /codex-account-bridge-launch\.log/);
  assert.match(powershellLauncher, /Read-Host/);
});

test("static build emits the OpenAI Sites worker contract", () => {
  const workerSource = fs.readFileSync(path.join(root, "sites-worker.js"), "utf8");
  assert.match(buildSource, /dist, "server"/);
  assert.match(buildSource, /sites-worker\.js/);
  assert.match(workerSource, /env\.ASSETS\.fetch/);
  assert.match(workerSource, /export default/);
});

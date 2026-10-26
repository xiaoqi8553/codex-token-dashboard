const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { gunzipSync } = require("node:zlib");

const root = path.resolve(__dirname, "..");
const extensionDir = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const workerSource = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");
const pageSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const setupSource = fs.readFileSync(path.join(root, "scripts", "setup-notion-sync.ps1"), "utf8");
const backgroundRunnerSource = fs.readFileSync(path.join(root, "scripts", "run-dashboard-background.ps1"), "utf8");

test("extension is restricted to the dashboard page and local read-only usage ports", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, []);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://xiaoqi8553.github.io/codex-token-dashboard/*"]);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.deepEqual(manifest.host_permissions, [
    "http://127.0.0.1:8787/*",
    "http://127.0.0.1:8788/*",
    "http://127.0.0.1:8789/*"
  ]);
  assert.match(workerSource, /method: "GET"/);
  assert.match(workerSource, /CompressionStream\("gzip"\)/);
  assert.doesNotMatch(workerSource, /method: "POST"/);
  assert.doesNotMatch(workerSource, /\/api\/(account|import)/);
});

test("extension worker forwards only usage queries from the dashboard and falls through busy ports", async () => {
  const calls = [];
  const listeners = [];
  const context = vm.createContext({
    URL,
    AbortSignal,
    chrome: {
      runtime: {
        onMessage: { addListener: listener => listeners.push(listener) },
        getManifest: () => ({ version: "0.2.0" })
      }
    },
    Blob,
    CompressionStream,
    Response,
    btoa,
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes(":8787/")) throw new Error("port busy");
      return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ ok: true, records: ["完整会话数据"] }) };
    }
  });
  vm.runInContext(workerSource, context);
  const fetchResult = await vm.runInContext('fetchUsage("/api/usage?from=2026-10-01")', context);
  assert.equal(fetchResult.encoding, "gzip-base64");
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(fetchResult.data, "base64")).toString("utf8")), { ok: true, records: ["完整会话数据"] });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:8787\/api\/usage\?/);
  assert.match(calls[1].url, /^http:\/\/127\.0\.0\.1:8788\/api\/usage\?/);
  assert.equal(calls[1].options.method, "GET");

  await assert.rejects(
    vm.runInContext('fetchUsage("https://example.com/api/usage")', context),
    /只允许读取仪表盘用量接口/
  );
  await assert.rejects(
    vm.runInContext('fetchUsage("/api/account/snapshot")', context),
    /只允许读取仪表盘用量接口/
  );

  const listener = listeners[0];
  const ignored = listener({ channel: "codex-token-dashboard", type: "probe" }, { url: "https://example.com/" }, () => {});
  assert.equal(ignored, false);
  assert.match(pageSource, /state\.dataMode === "extension"/);
  assert.match(pageSource, /serverAutoRefreshMs = 5000/);
  assert.match(pageSource, /DecompressionStream\("gzip"\)/);
  assert.match(pageSource, /async function reconnectExtensionBridge\(\)/);
  assert.match(pageSource, /!isEmbeddedDashboard\(\)/);
  assert.match(pageSource, /Notion 看板尚未连接本机/);
  assert.match(setupSource, /CurrentVersion\\Run/);
  assert.match(setupSource, /New-ItemProperty/);
  assert.match(backgroundRunnerSource, /DASHBOARD_AUTO_OPEN = "0"/);
  assert.match(backgroundRunnerSource, /127\.0\.0\.1:\$port\/api\/config/);
});

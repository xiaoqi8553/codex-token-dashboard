const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("desktop status endpoint exposes compact local and cumulative token totals", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-desktop-api-"));
  const sessionsDir = path.join(temporaryRoot, "sessions");
  const dataDir = path.join(temporaryRoot, "app-data");
  const userDataDir = path.join(temporaryRoot, "user-data");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const localIso = new Date().toISOString();
  const lines = [
    { type: "session_meta", timestamp: localIso, payload: { id: "desktop-fixture", model_provider: "openai" } },
    { type: "token_usage_record", timestamp: localIso, payload: { session_id: "desktop-fixture", response_id: "one", usage: { input_tokens: 80, cached_input_tokens: 20, output_tokens: 20, total_tokens: 100 } } }
  ];
  fs.writeFileSync(path.join(sessionsDir, "desktop-fixture.jsonl"), lines.map(JSON.stringify).join("\n"), "utf8");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_TOKEN_DASHBOARD_PORT: String(port),
      CODEX_TOKEN_DASHBOARD_DATA_DIR: dataDir,
      CODEX_TOKEN_DASHBOARD_USER_DATA_DIR: userDataDir,
      CODEX_SESSIONS_DIR: sessionsDir,
      DASHBOARD_AUTO_OPEN: "0",
      PUBLIC_ACCESS: "0"
    },
    windowsHide: true,
    stdio: "ignore"
  });

  try {
    const configUrl = `http://127.0.0.1:${port}/api/config`;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Test server exited: ${child.exitCode}`);
      try {
        const response = await fetch(configUrl, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/desktop/status`);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.ok, true);
    assert.equal(status.totals.totalTokens, 100);
    assert.equal(status.totals.inputTokens, 80);
    assert.equal(status.totals.cachedInputTokens, 20);
    assert.equal(status.totals.outputTokens, 20);
    assert.equal(status.today.totalTokens, 100);
    assert.equal(status.today.outputTokens, 20);
    assert.equal(status.sessions, 1);
    assert.equal("records" in status, false);
    assert.equal("calendarRecords" in status, false);

    const refreshed = await fetch(`http://127.0.0.1:${port}/api/desktop/status?force=1`);
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).totals.totalTokens, 100);
  } finally {
    child.kill();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

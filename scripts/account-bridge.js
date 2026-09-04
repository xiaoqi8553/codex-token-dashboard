#!/usr/bin/env node

const childProcess = require("child_process");
const crypto = require("crypto");
const http = require("http");
const path = require("path");

const DEFAULT_PORT = 43127;
const DEFAULT_SITE_URL = "https://xiaoqi8553.github.io/codex-token-dashboard/?accountBridge=1";
const DEFAULT_ORIGIN = "https://xiaoqi8553.github.io";
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    if (key === "open") args.open = true;
    else args[key] = argv[index + 1] || "";
  }
  return args;
}

function createPairingKey() {
  let value = "";
  for (let index = 0; index < 8; index += 1) {
    value += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  }
  return value;
}

function displayPairingKey(value) {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function normalizePairingKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
}

function secureKeyEquals(actual, expected) {
  const left = Buffer.from(normalizePairingKey(actual));
  const right = Buffer.from(normalizePairingKey(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseOrigins(value) {
  return new Set(String(value || DEFAULT_ORIGIN).split(",").map(item => item.trim()).filter(Boolean));
}

function runAccountSnapshot(payload, options = {}) {
  const scriptPath = path.join(__dirname, "sync-codex-account.js");
  const args = [scriptPath, "--account-name", String(payload.accountName || ""), "--json"];
  if (payload.syncCcSwitch === true) args.push("--sync-ccswitch");
  if (options.codexHome) args.push("--codex-home", options.codexHome);
  if (options.accountRoot) args.push("--account-root", options.accountRoot);
  if (options.ccswitchDb) args.push("--ccswitch-db", options.ccswitchDb);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, args, {
      cwd: path.resolve(__dirname, ".."),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      const output = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error(stderr.trim() || `账号快照脚本退出码：${code}`));
      }
    });
  });
}

function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > limit) reject(new Error("请求内容过大"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("请求内容不是有效 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sanitizeSnapshotResult(result) {
  const ccStatus = String(result?.ccswitch?.status || "");
  return {
    ok: Boolean(result?.ok),
    accountName: String(result?.accountName || ""),
    updatedFiles: Array.isArray(result?.updatedFiles) ? result.updatedFiles.map(String) : [],
    ccswitch: {
      requested: Boolean(result?.ccswitch?.requested),
      status: ccStatus,
      message: ccStatus === "failed"
        ? "CC Switch 同步失败，请查看本机助手窗口"
        : ccStatus === "skipped"
          ? "未找到 CC Switch 数据库"
          : "",
      providerName: String(result?.ccswitch?.providerName || "")
    }
  };
}

function createBridge(options = {}) {
  const port = options.port == null ? DEFAULT_PORT : Number(options.port);
  const pairingKey = normalizePairingKey(options.pairingKey || createPairingKey());
  const allowedOrigins = options.allowedOrigins || parseOrigins(process.env.CODEX_ACCOUNT_BRIDGE_ORIGINS);
  const snapshotRunner = options.snapshotRunner || (payload => runAccountSnapshot(payload, options));
  const closeAfterSuccess = options.closeAfterSuccess !== false;
  const maxFailedAttempts = Number(options.maxFailedAttempts || 5);
  let failedAttempts = 0;
  let completed = false;

  function corsHeaders(origin) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-codex-bridge-key",
      "access-control-allow-private-network": "true",
      "access-control-max-age": "300",
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "vary": "Origin",
      "x-content-type-options": "nosniff"
    };
  }

  function sendJson(res, origin, status, payload) {
    res.writeHead(status, corsHeaders(origin));
    res.end(JSON.stringify(payload));
  }

  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || "");
    const host = String(req.headers.host || "").toLowerCase();
    const boundPort = server.address()?.port || port;
    const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
    if (!allowedHosts.has(host) || !allowedOrigins.has(origin)) {
      res.writeHead(403, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ ok: false, error: "此来源无权访问本机账号助手" }));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/api/account/bridge/status") {
      sendJson(res, origin, 200, { ok: true, service: "codex-account-bridge", ready: !completed });
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/account/snapshot") {
      sendJson(res, origin, 404, { ok: false, error: "接口不存在" });
      return;
    }
    if (completed) {
      sendJson(res, origin, 409, { ok: false, error: "本次配对已使用，请重新启动本机助手" });
      return;
    }
    if (failedAttempts >= maxFailedAttempts) {
      sendJson(res, origin, 429, { ok: false, error: "配对失败次数过多，请重新启动本机助手" });
      return;
    }
    if (!secureKeyEquals(req.headers["x-codex-bridge-key"], pairingKey)) {
      failedAttempts += 1;
      sendJson(res, origin, 401, { ok: false, error: "配对码不正确" });
      return;
    }
    try {
      const payload = await readJsonBody(req);
      const result = await snapshotRunner(payload);
      if (!result?.ok) {
        console.error(`账号快照更新失败：${result?.error || "未知错误"}`);
        sendJson(res, origin, 500, { ok: false, error: "账号快照更新失败，请查看本机助手窗口" });
        return;
      }
      if (result.ccswitch?.status === "failed") console.error(`CC Switch 同步失败：${result.ccswitch.message || "未知错误"}`);
      completed = true;
      sendJson(res, origin, 200, sanitizeSnapshotResult(result));
      if (closeAfterSuccess) setTimeout(() => {
        server.close();
        server.closeIdleConnections?.();
      }, 250);
    } catch (error) {
      console.error(`账号快照更新失败：${error.message || "未知错误"}`);
      sendJson(res, origin, 500, { ok: false, error: "账号快照更新失败，请查看本机助手窗口" });
    }
  });

  return { server, pairingKey, port, allowedOrigins };
}

function openSite(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = childProcess.spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.CODEX_ACCOUNT_BRIDGE_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error("本机助手端口必须是 1024-65535 之间的整数");
    process.exitCode = 1;
    return;
  }
  const siteUrl = args["site-url"] || DEFAULT_SITE_URL;
  const bridge = createBridge({ port });
  bridge.server.on("error", error => {
    console.error(`本机账号助手启动失败：${error.message}`);
    process.exitCode = 1;
  });
  bridge.server.listen(port, "127.0.0.1", () => {
    console.log("");
    console.log("Codex 账号快照本机助手已启动");
    console.log(`配对码：${displayPairingKey(bridge.pairingKey)}`);
    console.log("请在网页的 系统设置 -> Codex 账号快照 中输入配对码。");
    console.log("成功更新一次后助手会自动关闭。按 Ctrl+C 可随时取消。");
    console.log("");
    if (args.open) openSite(siteUrl);
  });
}

if (require.main === module) main();

module.exports = {
  createBridge,
  createPairingKey,
  displayPairingKey,
  normalizePairingKey,
  parseOrigins,
  runAccountSnapshot,
  sanitizeSnapshotResult,
  secureKeyEquals
};

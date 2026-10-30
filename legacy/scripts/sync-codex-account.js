#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { deriveAccountName, safeAccountName } = require("./account-snapshot-process");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    if (["sync-ccswitch", "json", "force"].includes(key)) args[key] = true;
    else args[key] = argv[index + 1] || "";
  }
  return args;
}

function fail(message, json) {
  const payload = { ok: false, error: message };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else console.error(message);
  process.exitCode = 1;
}

function atomicCopy(source, target) {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(source, temp);
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    fs.rmSync(target, { force: true });
    fs.renameSync(temp, target);
  }
}

function moveToBackup(filePath, backupDir) {
  if (!fs.existsSync(filePath)) return false;
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath)));
  return true;
}

function runCcSwitchSync(authPath, configPath, dbPath) {
  if (!fs.existsSync(dbPath)) return { ok: true, status: "skipped", message: "未找到 CC Switch 数据库" };
  const helper = path.join(__dirname, "update-ccswitch.py");
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  let lastError = "未找到可用的 Python 运行时";
  for (const command of candidates) {
    const result = childProcess.spawnSync(command, [helper, "--db", dbPath, "--auth", authPath, "--config", configPath || ""], {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
    if (result.error) {
      lastError = result.error.message;
      continue;
    }
    const output = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    try {
      return JSON.parse(output);
    } catch {
      lastError = String(result.stderr || output || `Python exited with ${result.status}`).trim();
    }
  }
  return { ok: false, status: "failed", message: lastError };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const json = Boolean(args.json);
  try {
    const codexHome = path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    const accountRoot = path.resolve(args["account-root"] || process.env.CODEX_ACCOUNT_ARCHIVE_DIR || path.join(codexHome, "XQ_acc"));
    const authPath = path.join(codexHome, "auth.json");
    const configPath = path.join(codexHome, "config.toml");
    if (!fs.existsSync(authPath)) throw new Error(`当前 Codex auth.json 不存在：${authPath}`);
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const requestedName = args["account-name"] || args.name;
    const accountName = requestedName ? safeAccountName(requestedName) : deriveAccountName(auth);

    const targetDir = path.join(accountRoot, accountName);
    const backupDir = path.join(accountRoot, ".backups", `${Date.now()}-${accountName}`);
    fs.mkdirSync(targetDir, { recursive: true });
    const backedUpFiles = [];
    for (const filename of ["auth.json", "config.toml"]) {
      const target = path.join(targetDir, filename);
      if (moveToBackup(target, backupDir)) backedUpFiles.push(filename);
    }
    atomicCopy(authPath, path.join(targetDir, "auth.json"));
    const hasConfig = fs.existsSync(configPath);
    if (hasConfig) atomicCopy(configPath, path.join(targetDir, "config.toml"));
    else fs.rmSync(path.join(targetDir, "config.toml"), { force: true });

    const metadata = {
      accountName,
      updatedAt: new Date().toISOString(),
      authFingerprint: crypto.createHash("sha256").update(fs.readFileSync(authPath)).digest("hex").slice(0, 16),
      files: { auth: true, config: hasConfig },
      backupFiles: backedUpFiles,
      source: "local-codex",
      ccswitch: { requested: Boolean(args["sync-ccswitch"]) }
    };
    const ccswitchDb = path.resolve(args["ccswitch-db"] || process.env.CCSWITCH_DB || path.join(os.homedir(), ".cc-switch", "cc-switch.db"));
    if (args["sync-ccswitch"]) {
      metadata.ccswitch = { requested: true, ...runCcSwitchSync(path.join(targetDir, "auth.json"), hasConfig ? path.join(targetDir, "config.toml") : "", ccswitchDb) };
    }
    fs.writeFileSync(path.join(targetDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    const result = { ok: true, accountName, accountDir: targetDir, updatedFiles: ["auth.json", ...(hasConfig ? ["config.toml"] : [])], ccswitch: metadata.ccswitch };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`账号快照已更新：${accountName}`);
  } catch (error) {
    fail(error.message || String(error), json);
  }
}

main();

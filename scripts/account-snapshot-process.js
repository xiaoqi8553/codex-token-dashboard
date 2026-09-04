"use strict";

function safeAccountName(value) {
  const name = String(value || "").trim();
  const reservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    !name ||
    name.length > 64 ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(name) ||
    /[. ]$/u.test(name) ||
    reservedName.test(name)
  ) {
    throw new Error("账号名称长度须为 1-64 个字符，且不能包含 Windows 路径字符、控制字符、尾部点或空格及系统保留名");
  }
  return name;
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return {};
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function deriveAccountName(auth) {
  const tokenPayload = decodeJwtPayload(auth?.tokens?.id_token);
  const email = [auth?.email, auth?.account?.email, auth?.tokens?.email, tokenPayload?.email]
    .find(value => typeof value === "string" && value.trim());
  if (email) return safeAccountName(email);

  const accountId = [
    auth?.account_id,
    auth?.account?.id,
    auth?.tokens?.account_id,
    tokenPayload?.["https://api.openai.com/auth"]?.chatgpt_account_id,
    tokenPayload?.sub
  ].find(value => typeof value === "string" && value.trim());
  if (accountId) return safeAccountName(`codex-${accountId}`.slice(0, 64));
  throw new Error("无法识别当前 Codex 账号，请确认 auth.json 来自已登录的 Codex 客户端");
}

function parseSnapshotProcessOutput(stdout, stderr, exitCode) {
  const output = String(stdout || "").trim();
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error(String(stderr || "").trim() || `账号快照脚本退出码：${exitCode}`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`账号快照脚本返回格式无效，退出码：${exitCode}`);
  }
  if (exitCode !== 0 && result.ok !== false) {
    throw new Error(String(stderr || "").trim() || `账号快照脚本退出码：${exitCode}`);
  }
  return result;
}

module.exports = { decodeJwtPayload, deriveAccountName, parseSnapshotProcessOutput, safeAccountName };

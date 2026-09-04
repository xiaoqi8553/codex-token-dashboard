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

module.exports = { parseSnapshotProcessOutput, safeAccountName };

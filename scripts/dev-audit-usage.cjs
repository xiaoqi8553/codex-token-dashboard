// 用量口径审计：对比「逐轮累加」与「会话累计」，并检查续跑/归档造成的差异
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOTS = [
  path.join(os.homedir(), ".codex", "sessions"),
  path.join(os.homedir(), ".codex", "archived_sessions")
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap(root => walk(root));
console.log(`扫描文件数: ${files.length}`);

const records = [];

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  let sessionId = null;
  let sumLast = 0;
  let events = 0;
  let eventsNoInfo = 0;
  let finalTotal = 0;
  let maxTotal = 0;
  let decreases = 0;
  let prevTotal = 0;
  let turnRecords = 0;
  let turnRecordSum = 0;
  let firstAt = null;
  let lastAt = null;

  for (const line of lines) {
    if (line.length < 24) continue;
    if (line.startsWith('{"timestamp"') && line.includes('"session_meta"')) {
      try {
        const j = JSON.parse(line);
        sessionId = j.payload && (j.payload.session_id || j.payload.id) || sessionId;
        firstAt = firstAt || j.payload && j.payload.timestamp || null;
      } catch { /* ignore */ }
      continue;
    }
    if (line.includes("token_usage_record")) {
      try {
        const j = JSON.parse(line);
        const usage = j.payload && j.payload.usage;
        if (usage) { turnRecords += 1; turnRecordSum += usage.total_tokens || 0; }
      } catch { /* ignore */ }
      continue;
    }
    if (!line.includes("token_count")) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const payload = j.payload;
    if (!payload || payload.type !== "token_count") continue;
    events += 1;
    if (j.timestamp) lastAt = j.timestamp;
    const info = payload.info;
    if (!info) { eventsNoInfo += 1; continue; }
    if (info.last_token_usage) sumLast += info.last_token_usage.total_tokens || 0;
    if (info.total_token_usage) {
      const total = info.total_token_usage.total_tokens || 0;
      if (total < prevTotal) decreases += 1;
      prevTotal = total;
      finalTotal = total;
      if (total > maxTotal) maxTotal = total;
    }
  }

  records.push({
    file: path.relative(os.homedir(), file),
    archived: file.includes("archived_sessions"),
    sessionId: sessionId || file,
    sumLast,
    finalTotal,
    maxTotal,
    events,
    eventsNoInfo,
    decreases,
    turnRecords,
    turnRecordSum,
    firstAt,
    lastAt
  });
}

const sumLastAll = records.reduce((a, r) => a + r.sumLast, 0);
const sumFinalAll = records.reduce((a, r) => a + r.finalTotal, 0);
const sumTurnRecords = records.reduce((a, r) => a + r.turnRecordSum, 0);

// 按 session_id 归并
const bySession = new Map();
for (const r of records) {
  const prev = bySession.get(r.sessionId);
  if (!prev) {
    bySession.set(r.sessionId, { ...r, files: 1 });
  } else {
    prev.files += 1;
    prev.sumLast += r.sumLast;
    prev.finalTotal = Math.max(prev.finalTotal, r.finalTotal);
    prev.maxTotal = Math.max(prev.maxTotal, r.maxTotal);
    prev.events += r.events;
    prev.turnRecords += r.turnRecords;
    prev.turnRecordSum += r.turnRecordSum;
  }
}

const sessions = [...bySession.values()];
const sumMaxPerSession = sessions.reduce((a, r) => a + r.maxTotal, 0);
const sumLastPerSession = sessions.reduce((a, r) => a + r.sumLast, 0);

const fmt = n => (n / 1e9).toFixed(2) + "B";

console.log("");
console.log("=== 总量对比 ===");
console.log(`逐轮 last_token_usage 累加 (全部文件): ${fmt(sumLastAll)}`);
console.log(`token_usage_record.usage 累加:          ${fmt(sumTurnRecords)}`);
console.log(`每文件 total_token_usage 求和:          ${fmt(sumFinalAll)}`);
console.log(`按会话取 max(total) 求和 (去重):        ${fmt(sumMaxPerSession)}`);
console.log(`按会话逐轮累加 (去重):                  ${fmt(sumLastPerSession)}`);
console.log("");
console.log(`文件数 ${records.length} / 唯一会话 ${sessions.length}`);
console.log(`其中归档文件 ${records.filter(r => r.archived).length} 个`);
console.log(`累计值中途下降（疑似重置）次数: ${records.reduce((a, r) => a + r.decreases, 0)}`);
console.log(`没有 info 的 token_count 事件: ${records.reduce((a, r) => a + r.eventsNoInfo, 0)}`);
console.log("");
console.log("=== 差异最大的 8 个会话（逐轮 vs 会话累计）===");
sessions
  .map(s => ({ ...s, gap: s.maxTotal - s.sumLast }))
  .sort((a, b) => b.gap - a.gap)
  .slice(0, 8)
  .forEach(s => {
    console.log(`  ${String(s.sessionId).slice(0, 20)}  文件${s.files}  逐轮 ${(s.sumLast / 1e6).toFixed(0)}M  会话累计 ${(s.maxTotal / 1e6).toFixed(0)}M  差 ${(s.gap / 1e6).toFixed(0)}M`);
  });

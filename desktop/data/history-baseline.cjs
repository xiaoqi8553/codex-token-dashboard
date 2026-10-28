"use strict";

/**
 * 历史基线：把旧版网页看板积累的 usage-index.json 转成紧凑的按天聚合。
 *
 * 为什么需要它：Codex 会清理早期的 rollout 会话文件，磁盘上现在只剩最近一段
 * 时间。旧版看板有个持久索引，把历史上扫到过的每一条请求记录都存了下来
 * （本机 40956 条、134 天、5.70B），这是日志里已经找不到的历史。
 *
 * 索引很大（160MB+），这里逐条解析、边解析边聚合，不构建完整对象数组，
 * 产出只有几 MB 的按天摘要，之后每次直接读摘要。
 */

const fs = require("node:fs");
const path = require("node:path");

// v2：按本地日期归集，并给每天补 24 小时分布（活跃时段图要能被 7/14/30/全部 切换驱动）
const BASELINE_VERSION = 2;

function emptyBucket() {
  return { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, records: 0 };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

/** 本地日期键，必须与看板/日志侧的 dayKeyOf 完全一致，否则同一天会被拆成两天 */
function localDayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addInto(target, source) {
  target.totalTokens += source.totalTokens || 0;
  target.inputTokens += source.inputTokens || 0;
  target.cachedInputTokens += source.cachedInputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.records += 1;
}

/**
 * 逐条切分 records 数组。
 * 索引是美化缩进格式，不能靠分隔符切，这里用花括号深度扫描（处理字符串与转义），
 * 只在遇到完整记录时才 JSON.parse，避免整体解析 160MB。
 */
function forEachRecord(text, onRecord) {
  // 顶层键缩进 2 格写作 `\n  "records": [`；
  // stats.sourceEvidence 里也有一个同名的嵌套数组，必须避开。
  let anchor = text.indexOf('\n  "records": [');
  if (anchor === -1) anchor = text.lastIndexOf('"records": [');
  if (anchor === -1) return 0;
  const arrayStart = text.indexOf("[", anchor);
  if (arrayStart === -1) return 0;

  const QUOTE = 34;
  const BACKSLASH = 92;
  const OPEN = 123;
  const CLOSE = 125;
  const BRACKET = 93;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let objStart = -1;
  let count = 0;

  for (let i = arrayStart + 1; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === BACKSLASH) escaped = true;
      else if (code === QUOTE) inString = false;
      continue;
    }
    if (code === QUOTE) { inString = true; continue; }
    if (code === OPEN) {
      if (depth === 0) objStart = i;
      depth += 1;
      continue;
    }
    if (code === CLOSE) {
      depth -= 1;
      if (depth === 0 && objStart !== -1) {
        try {
          onRecord(JSON.parse(text.slice(objStart, i + 1)));
          count += 1;
        } catch {
          /* 单条损坏跳过 */
        }
        objStart = -1;
      }
      continue;
    }
    if (code === BRACKET && depth === 0) break;
  }
  return count;
}

function buildBaseline(indexPath, { onProgress } = {}) {
  const stat = fs.statSync(indexPath);
  const text = fs.readFileSync(indexPath, "utf8");

  /** @type {Record<string, any>} day -> 聚合 */
  const days = {};
  /** @type {Record<string, any>} sessionId -> 聚合 */
  const sessions = {};
  const models = {};
  let total = 0;
  let processed = 0;

  const count = forEachRecord(text, record => {
    // 索引里的 date 是 UTC 日期，直接当本地日期用会让跨零点的记录落到错误的「天」，
    // 与日志侧按本地日期归集的结果对不上，所以优先用 timestamp 转本地时间。
    const stamp = record.timestamp ? new Date(record.timestamp) : null;
    const stamped = Boolean(stamp && !Number.isNaN(stamp.getTime()));
    const day = stamped ? localDayKey(stamp) : (record.date || String(record.timestamp || "").slice(0, 10));
    if (!day) return;
    const bucket = {
      totalTokens: Number(record.totalTokens) || 0,
      inputTokens: Number(record.inputTokens) || 0,
      cachedInputTokens: Number(record.cachedInputTokens) || 0,
      outputTokens: Number(record.outputTokens) || 0
    };
    if (!bucket.totalTokens && !bucket.inputTokens) return;

    const sessionId = record.sessionId || "unknown";
    const model = record.model || record.turnModel || "unknown";
    const project = record.projectName || null;

    total += bucket.totalTokens;
    processed += 1;

    let dayEntry = days[day];
    if (!dayEntry) {
      dayEntry = { ...emptyBucket(), hours: new Array(24).fill(0), sessions: {}, models: {} };
      days[day] = dayEntry;
    }
    addInto(dayEntry, bucket);
    // 小时分布：没有 timestamp 的老记录无法定位到小时，仍计入当天总量
    if (stamped) dayEntry.hours[stamp.getHours()] += bucket.totalTokens;

    let cell = dayEntry.sessions[sessionId];
    if (!cell) {
      cell = { ...emptyBucket(), models: {}, project };
      dayEntry.sessions[sessionId] = cell;
    }
    addInto(cell, bucket);
    if (project && !cell.project) cell.project = project;

    const cellModel = cell.models[model] || (cell.models[model] = emptyBucket());
    addInto(cellModel, bucket);

    const dayModel = dayEntry.models[model] || (dayEntry.models[model] = emptyBucket());
    addInto(dayModel, bucket);

    const globalModel = models[model] || (models[model] = emptyBucket());
    addInto(globalModel, bucket);

    let sessionEntry = sessions[sessionId];
    if (!sessionEntry) {
      sessionEntry = { ...emptyBucket(), firstAt: null, lastAt: null, project: null, models: {} };
      sessions[sessionId] = sessionEntry;
    }
    addInto(sessionEntry, bucket);
    if (project && !sessionEntry.project) sessionEntry.project = project;
    const sessionModel = sessionEntry.models[model] || (sessionEntry.models[model] = emptyBucket());
    addInto(sessionModel, bucket);
    if (record.timestamp) {
      if (!sessionEntry.firstAt || record.timestamp < sessionEntry.firstAt) sessionEntry.firstAt = record.timestamp;
      if (!sessionEntry.lastAt || record.timestamp > sessionEntry.lastAt) sessionEntry.lastAt = record.timestamp;
    }
  });

  return {
    version: BASELINE_VERSION,
    builtAt: new Date().toISOString(),
    source: indexPath,
    sourceMtimeMs: stat.mtimeMs,
    sourceSize: stat.size,
    records: processed,
    totalTokens: total,
    hourTokens: Object.values(days).reduce((acc, day) => acc + (day.hours || []).reduce((a, b) => a + b, 0), 0),
    days,
    sessions,
    models
  };
}

function baselineIsFresh(baseline, indexPath) {
  if (!baseline || baseline.version !== BASELINE_VERSION) return false;
  try {
    const stat = fs.statSync(indexPath);
    return baseline.sourceMtimeMs === stat.mtimeMs && baseline.sourceSize === stat.size;
  } catch {
    return false;
  }
}

function loadBaseline(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function saveBaseline(filePath, baseline) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(baseline), "utf8");
}

module.exports = {
  BASELINE_VERSION,
  buildBaseline,
  baselineIsFresh,
  loadBaseline,
  saveBaseline
};

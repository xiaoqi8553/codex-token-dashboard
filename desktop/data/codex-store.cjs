"use strict";

/**
 * CodexStore — 独立用量数据层
 *
 * 直接读取 ~/.codex/sessions 下的 JSONL 会话日志，不依赖 server.js，
 * 不需要启动本地 HTTP 服务，也不需要 index.html。
 *
 * 设计目标：
 *  - 首屏快：只读最新几个文件的尾部，几百毫秒内给出配额快照
 *  - 增量：按 size/mtime 跳过未变更文件，只读新增字节
 *  - 可恢复：索引进度缓存在磁盘，重启不用重新全量扫描
 *  - 零依赖：纯 Node 标准库，主进程可直接 require
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const CACHE_VERSION = 3;
const TAIL_BYTES = 8 * 1024 * 1024;
const FAST_FILE_COUNT = 3;
const EMPTY_BUCKET = () => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  records: 0
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dayKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dayKeyFromTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dayKeyOf(date);
}

function addToBucket(bucket, usage, sign) {
  if (!usage) return;
  bucket.inputTokens += sign * (usage.input_tokens || 0);
  bucket.cachedInputTokens += sign * (usage.cached_input_tokens || 0);
  bucket.outputTokens += sign * (usage.output_tokens || 0);
  bucket.reasoningOutputTokens += sign * (usage.reasoning_output_tokens || 0);
  bucket.totalTokens += sign * (usage.total_tokens || 0);
  bucket.records += sign * 1;
}

function zeroBucket() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    records: 0
  };
}

function normalizeRateLimits(raw, timestamp) {
  if (!raw || typeof raw !== "object") return null;
  const pick = window => {
    if (!window || typeof window !== "object") return null;
    const usedPercent = Number(window.used_percent);
    if (!Number.isFinite(usedPercent)) return null;
    return {
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
      windowMinutes: Number(window.window_minutes) || null,
      resetsAt: Number(window.resets_at) || null
    };
  };
  const primary = pick(raw.primary);
  const secondary = pick(raw.secondary);
  if (!primary && !secondary) return null;
  return {
    session: primary,
    weekly: secondary,
    credits: raw.credits && typeof raw.credits === "object"
      ? {
        hasCredits: Boolean(raw.credits.has_credits),
        unlimited: Boolean(raw.credits.unlimited),
        balance: raw.credits.balance != null ? String(raw.credits.balance) : null
      }
      : null,
    planType: raw.plan_type || null,
    limitReached: Boolean(raw.rate_limit_reached_type),
    sampledAt: timestamp || null
  };
}

// ---------------------------------------------------------------------------
// 单行解析：只对疑似 token_count 的行做 JSON.parse
// ---------------------------------------------------------------------------

function parseTokenCountLine(line) {
  if (line.length < 32) return null;
  if (line.indexOf("token_count") === -1) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = parsed && parsed.payload;
  if (!payload || payload.type !== "token_count") return null;
  return {
    timestamp: parsed.timestamp || payload.timestamp || null,
    usage: payload.info && payload.info.last_token_usage ? payload.info.last_token_usage : null,
    sessionTotal: payload.info && payload.info.total_token_usage ? payload.info.total_token_usage : null,
    rateLimits: payload.rate_limits || null
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class CodexStore {
  constructor(options = {}) {
    this.sessionsDir = options.sessionsDir;
    this.cacheFile = options.cacheFile;
    /** @type {Map<string, {size:number,mtimeMs:number,offset:number,sessionTotal:object|null,days:Map<string,object>,full:boolean}>} */
    this.files = new Map();
    /** @type {Map<string, object>} */
    this.daily = new Map();
    this.rateLimits = null;
    this.rateLimitsAt = null;
    this.lastEventAt = null;
    this.sessionCount = 0;
    this.lastBuiltAt = null;
    this.phase = "idle"; // idle | fast | full
    this._buildPromise = null;
    this._fullPromise = null;
  }

  // -- 缓存 --------------------------------------------------------------

  loadCache() {
    if (!this.cacheFile) return false;
    try {
      const raw = fs.readFileSync(this.cacheFile, "utf8");
      const data = JSON.parse(raw);
      if (!data || data.version !== CACHE_VERSION) return false;
      this.daily = new Map(Object.entries(data.daily || {}));
      this.rateLimits = data.rateLimits || null;
      this.rateLimitsAt = data.rateLimitsAt || null;
      this.lastEventAt = data.lastEventAt || null;
      this.sessionCount = Number(data.sessionCount) || 0;
      this.lastBuiltAt = data.lastBuiltAt || null;
      this.files = new Map();
      for (const entry of data.files || []) {
        this.files.set(entry.path, {
          size: Number(entry.size) || 0,
          mtimeMs: Number(entry.mtimeMs) || 0,
          offset: Number(entry.offset) || 0,
          sessionTotal: entry.sessionTotal || null,
          days: new Map(Object.entries(entry.days || {})),
          full: Boolean(entry.full)
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  saveCache() {
    if (!this.cacheFile) return;
    try {
      const payload = {
        version: CACHE_VERSION,
        savedAt: new Date().toISOString(),
        daily: Object.fromEntries(this.daily),
        rateLimits: this.rateLimits,
        rateLimitsAt: this.rateLimitsAt,
        lastEventAt: this.lastEventAt,
        sessionCount: this.sessionCount,
        lastBuiltAt: this.lastBuiltAt,
        files: [...this.files.entries()].map(([filePath, entry]) => ({
          path: filePath,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          offset: entry.offset,
          sessionTotal: entry.sessionTotal,
          days: Object.fromEntries(entry.days),
          full: Boolean(entry.full)
        }))
      };
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(payload), "utf8");
    } catch {
      /* 缓存失败不影响功能 */
    }
  }

  clearCache() {
    this.files.clear();
    this.daily.clear();
    this.rateLimits = null;
    this.rateLimitsAt = null;
    this.lastEventAt = null;
    try {
      if (this.cacheFile) fs.rmSync(this.cacheFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  // -- 文件枚举 ----------------------------------------------------------

  async listSessionFiles() {
    const output = [];
    const walk = async dir => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          try {
            const stat = await fsp.stat(full);
            output.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
          } catch {
            /* 文件消失则跳过 */
          }
        }
      }
    };
    await walk(this.sessionsDir);
    output.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return output;
  }

  // -- 单文件增量解析 ----------------------------------------------------

  async ingestFile(info, options = {}) {
    const { full = false, tailBytes = TAIL_BYTES } = options;
    const existing = this.files.get(info.path);
    const priorFull = existing ? existing.full : false;
    const effectiveFull = full || priorFull;

    // 未变化：直接用缓存
    if (existing && existing.size === info.size && existing.mtimeMs === info.mtimeMs && existing.full === effectiveFull) {
      return false;
    }

    let startOffset = 0;
    let truncatedFromTail = false;
    if (existing && existing.offset && info.size >= existing.offset) {
      startOffset = existing.offset;
    } else if (!effectiveFull) {
      startOffset = Math.max(0, info.size - tailBytes);
      truncatedFromTail = startOffset > 0;
    }

    if (info.size <= startOffset) return false;

    let buffer;
    try {
      const handle = await fsp.open(info.path, "r");
      try {
        const length = info.size - startOffset;
        buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, startOffset);
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }

    let text = buffer.toString("utf8");
    if (truncatedFromTail) {
      // 从尾部读时首行可能被截断，丢弃到第一个换行
      const firstBreak = text.indexOf("\n");
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }

    // 建立 / 重置该文件的日归集
    const entry = existing || {
      size: 0,
      mtimeMs: 0,
      offset: 0,
      sessionTotal: null,
      days: new Map(),
      full: false
    };

    if (effectiveFull && !priorFull) {
      // 首次全量：清掉该文件此前基于尾部的部分贡献
      for (const [day, bucket] of entry.days) {
        const globalBucket = this.daily.get(day);
        if (!globalBucket) continue;
        for (const key of Object.keys(EMPTY_BUCKET())) {
          globalBucket[key] -= bucket[key] || 0;
        }
        if (globalBucket.records <= 0) this.daily.delete(day);
      }
      entry.days.clear();
    }

    const lines = text.split("\n");
    let touched = false;
    for (const line of lines) {
      const event = parseTokenCountLine(line);
      if (!event) continue;
      touched = true;

      if (event.usage) {
        const day = dayKeyFromTimestamp(event.timestamp) || dayKeyOf(new Date());
        let fileBucket = entry.days.get(day);
        if (!fileBucket) {
          fileBucket = zeroBucket();
          entry.days.set(day, fileBucket);
        }
        addToBucket(fileBucket, event.usage, 1);

        let globalBucket = this.daily.get(day);
        if (!globalBucket) {
          globalBucket = zeroBucket();
          this.daily.set(day, globalBucket);
        }
        addToBucket(globalBucket, event.usage, 1);
      }

      if (event.sessionTotal) entry.sessionTotal = event.sessionTotal;

      if (event.rateLimits) {
        const stamp = event.timestamp || null;
        const isNewer = !this.rateLimitsAt || !stamp || stamp >= this.rateLimitsAt;
        if (isNewer) {
          const normalized = normalizeRateLimits(event.rateLimits, stamp);
          if (normalized) {
            this.rateLimits = normalized;
            this.rateLimitsAt = stamp;
          }
        }
      }

      if (event.timestamp && (!this.lastEventAt || event.timestamp > this.lastEventAt)) {
        this.lastEventAt = event.timestamp;
      }
    }

    entry.size = info.size;
    entry.mtimeMs = info.mtimeMs;
    entry.offset = info.size;
    entry.full = effectiveFull || entry.full;
    this.files.set(info.path, entry);

    return touched || effectiveFull;
  }

  // -- 构建 --------------------------------------------------------------

  /** 快速快照：只处理最新几个文件，用于首屏 */
  async buildFast() {
    if (this._buildPromise) return this._buildPromise;
    this._buildPromise = (async () => {
      this.phase = "fast";
      const files = await this.listSessionFiles();
      this.sessionCount = files.length;
      const recent = files.slice(0, FAST_FILE_COUNT);
      for (const info of recent) {
        await this.ingestFile(info, { full: false, tailBytes: TAIL_BYTES });
      }
      // 让今日数据更可信：今天改动过的文件也纳入
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayFiles = files.filter(f => f.mtimeMs >= todayStart.getTime() && !recent.some(r => r.path === f.path));
      for (const info of todayFiles.slice(0, 12)) {
        await this.ingestFile(info, { full: false, tailBytes: TAIL_BYTES });
      }
      this.lastBuiltAt = new Date().toISOString();
      this.phase = "fast-done";
      this.saveCache();
      return this.snapshot();
    })();
    try {
      return await this._buildPromise;
    } finally {
      this._buildPromise = null;
    }
  }

  /** 全量构建：读所有文件全部内容，后台执行 */
  async buildFull() {
    if (this._fullPromise) return this._fullPromise;
    this._fullPromise = (async () => {
      this.phase = "full";
      const files = await this.listSessionFiles();
      this.sessionCount = files.length;
      for (const info of files) {
        await this.ingestFile(info, { full: true });
      }
      this.lastBuiltAt = new Date().toISOString();
      this.phase = "full-done";
      this.saveCache();
      return this.snapshot();
    })();
    try {
      return await this._fullPromise;
    } finally {
      this._fullPromise = null;
    }
  }

  // -- 输出 --------------------------------------------------------------

  bucketsSince(days) {
    const out = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(date.getDate() - offset);
      const key = dayKeyOf(date);
      const bucket = this.daily.get(key) || zeroBucket();
      out.push({
        day: key,
        totalTokens: Math.max(0, bucket.totalTokens),
        inputTokens: Math.max(0, bucket.inputTokens),
        cachedInputTokens: Math.max(0, bucket.cachedInputTokens),
        outputTokens: Math.max(0, bucket.outputTokens),
        records: Math.max(0, bucket.records)
      });
    }
    return out;
  }

  totals() {
    const sum = zeroBucket();
    for (const bucket of this.daily.values()) {
      for (const key of Object.keys(sum)) sum[key] += Math.max(0, bucket[key] || 0);
    }
    // 会话累计以 session 日志里的 total_token_usage 为准（更接近 Codex 内部口径）
    let sessionTotal = null;
    for (const entry of this.files.values()) {
      if (!entry.sessionTotal) continue;
      if (!sessionTotal) {
        sessionTotal = zeroBucket();
        sessionTotal.records = 0;
        delete sessionTotal.records;
      }
      sessionTotal.inputTokens += entry.sessionTotal.input_tokens || 0;
      sessionTotal.cachedInputTokens += entry.sessionTotal.cached_input_tokens || 0;
      sessionTotal.outputTokens += entry.sessionTotal.output_tokens || 0;
      sessionTotal.reasoningOutputTokens += entry.sessionTotal.reasoning_output_tokens || 0;
      sessionTotal.totalTokens += entry.sessionTotal.total_tokens || 0;
    }
    sessionTotal = sessionTotal || zeroBucket();
    return {
      totals: { ...sum, sessions: this.sessionCount },
      sessionTotals: sessionTotal
    };
  }

  snapshot() {
    const { totals, sessionTotals } = this.totals();
    const series = this.bucketsSince(14);
    const todayKey = dayKeyOf(new Date());
    const today = series.find(item => item.day === todayKey) || zeroBucket();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = series.find(item => item.day === dayKeyOf(yesterdayDate)) || zeroBucket();

    return {
      ok: true,
      source: "codex-store",
      phase: this.phase,
      updatedAt: this.lastBuiltAt,
      lastEventAt: this.lastEventAt,
      sessions: this.sessionCount,
      totals: {
        inputTokens: sessionTotals.inputTokens || totals.inputTokens,
        cachedInputTokens: sessionTotals.cachedInputTokens || totals.cachedInputTokens,
        outputTokens: sessionTotals.outputTokens || totals.outputTokens,
        totalTokens: sessionTotals.totalTokens || totals.totalTokens,
        records: totals.records
      },
      today,
      yesterday,
      series,
      quota: this.rateLimits ? { ...this.rateLimits, sampledAt: this.rateLimitsAt } : null,
      providers: [],
      scannedFiles: this.files.size
    };
  }

  // -- 对外 --------------------------------------------------------------

  async init({ full = true } = {}) {
    this.loadCache();
    const cached = this.files.size > 0;
    if (!cached) {
      await this.buildFast();
    }
    if (full) {
      this.buildFull().catch(() => {});
    }
    return this.snapshot();
  }

  async refresh({ full = false } = {}) {
    if (full) return this.buildFull();
    const files = await this.listSessionFiles();
    this.sessionCount = files.length;
    const recent = files.slice(0, FAST_FILE_COUNT);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const active = files.filter(f => f.mtimeMs >= todayStart.getTime());
    const targets = [...recent, ...active].filter(
      (item, index, list) => list.findIndex(other => other.path === item.path) === index
    );
    for (const info of targets) {
      await this.ingestFile(info, { full: false });
    }
    this.lastBuiltAt = new Date().toISOString();
    this.saveCache();
    return this.snapshot();
  }
}

module.exports = {
  CodexStore,
  dayKeyOf,
  normalizeRateLimits,
  CACHE_VERSION
};

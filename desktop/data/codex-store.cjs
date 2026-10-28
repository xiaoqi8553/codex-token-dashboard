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
const { normalizeTable, costOfModels, costOfBucket, describeTable, unitPriceCny, priceEntry } = require("./pricing.cjs");

const CACHE_VERSION = 3;
const DETAIL_CACHE_VERSION = 6;
const TAIL_BYTES = 8 * 1024 * 1024;
const FAST_FILE_COUNT = 3;
/** 明细扫描的分块大小：大文件流式读，不整块进内存 */
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
/** 小时分布的统计窗口（天），避免缓存文件无限膨胀 */
const HOUR_WINDOW_DAYS = 13;
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

/** 从工作目录推断项目名（取最后一段路径） */
function projectNameOf(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
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
    /** 明细扫描结果单独缓存，与轻量索引互不影响 */
    this.detailFile = options.detailCacheFile || null;
    /** @type {Map<string, {size:number,mtimeMs:number,detail:object|null}>} */
    this.detailFiles = new Map();
    this.detailBuiltAt = null;
    this._detailPromise = null;
    /** 旧版索引沉淀下来的历史（日志已被清理的那部分），按天聚合 */
    this.baseline = options.baseline || null;
    /** 模型价格表：把 token 折算成钱，口径见 pricing.cjs */
    this.pricing = normalizeTable(options.pricing || {});
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
    if (effectiveFull && !priorFull) {
      // 从「尾部快照」升级到「全量」：必须从头重读。
      // 否则 offset 已指向文件末尾，会被下面的 size 判断直接跳过，
      // 文件前半段的用量将永远统计不到。
      startOffset = 0;
    } else if (existing && existing.offset && info.size >= existing.offset) {
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

  /**
   * 某一天的最终桶：磁盘日志与历史索引按天取大者。
   * 两边扫的是同一批 rollout，同一天的数据只会重叠、不会互补，所以取大者
   * 既能补上被清理的历史，又不会把同一天算两遍。
   */
  mergedDay(key) {
    const logDay = this.daily.get(key) || null;
    const baseDay = this.baseline && this.baseline.days ? this.baseline.days[key] : null;
    if (!baseDay || !baseDay.totalTokens) return logDay;
    if (!logDay) return baseDay;
    return (baseDay.totalTokens || 0) > (logDay.totalTokens || 0) ? baseDay : logDay;
  }

  mergedDayKeys() {
    const keys = new Set(this.daily.keys());
    if (this.baseline && this.baseline.days) {
      for (const key of Object.keys(this.baseline.days)) keys.add(key);
    }
    return keys;
  }

  bucketsSince(days) {
    const out = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(date.getDate() - offset);
      const key = dayKeyOf(date);
      const bucket = this.mergedDay(key) || zeroBucket();
      out.push({
        day: key,
        totalTokens: Math.max(0, bucket.totalTokens),
        inputTokens: Math.max(0, bucket.inputTokens),
        cachedInputTokens: Math.max(0, bucket.cachedInputTokens),
        outputTokens: Math.max(0, bucket.outputTokens),
        // 历史索引里没有推理 token 字段，缺失时按 0 处理
        reasoningOutputTokens: Math.max(0, bucket.reasoningOutputTokens || 0),
        records: Math.max(0, bucket.records)
      });
    }
    return out;
  }

  totals() {
    const sum = zeroBucket();
    for (const key of this.mergedDayKeys()) {
      const bucket = this.mergedDay(key);
      if (!bucket) continue;
      for (const field of Object.keys(sum)) sum[field] += Math.max(0, bucket[field] || 0);
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

  baselineMeta() {
    const baseline = this.baseline;
    if (!baseline || !baseline.days) return null;
    return {
      days: Object.keys(baseline.days).length,
      records: baseline.records || 0,
      totalTokens: baseline.totalTokens || 0,
      sessions: Object.keys(baseline.sessions || {}).length,
      builtAt: baseline.builtAt || null
    };
  }

  /** 从一份「天 → 桶」映射里取最近 N 天，用于让弹窗与看板共用同一份日聚合 */
  bucketsFromMap(map, days) {
    const out = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(date.getDate() - offset);
      const key = dayKeyOf(date);
      const bucket = map.get(key) || zeroBucket();
      out.push({
        day: key,
        totalTokens: Math.max(0, bucket.totalTokens || 0),
        inputTokens: Math.max(0, bucket.inputTokens || 0),
        cachedInputTokens: Math.max(0, bucket.cachedInputTokens || 0),
        outputTokens: Math.max(0, bucket.outputTokens || 0),
        reasoningOutputTokens: Math.max(0, bucket.reasoningOutputTokens || 0),
        records: Math.max(0, bucket.records || 0)
      });
    }
    return out;
  }

  snapshot() {
    // 明细扫描就绪后，弹窗也改用它的日聚合。
    // 否则弹窗走「快扫尾部」、看板走「全量明细」，同一时刻会显示两个今日用量。
    const detailDays = this._detailDays;
    let totals;
    let series;
    if (detailDays) {
      const sum = zeroBucket();
      for (const bucket of detailDays.values()) {
        for (const key of Object.keys(sum)) sum[key] += Math.max(0, bucket[key] || 0);
      }
      totals = { ...sum, sessions: this._detailSessions || this.sessionCount };
      series = this.bucketsFromMap(detailDays, 14);
    } else {
      totals = this.totals().totals;
      series = this.bucketsSince(14);
    }
    const todayKey = dayKeyOf(new Date());
    const today = series.find(item => item.day === todayKey) || zeroBucket();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = series.find(item => item.day === dayKeyOf(yesterdayDate)) || zeroBucket();

    const legacy = this.baselineMeta();

    return {
      ok: true,
      source: "codex-store",
      phase: this.phase,
      updatedAt: this.lastBuiltAt,
      lastEventAt: this.lastEventAt,
      // 会话数取「磁盘文件数」与「历史索引会话数」的较大者：
      // 索引里的 223 个会话覆盖了磁盘上已清理的那部分
      sessions: Math.max(this.sessionCount || 0, legacy ? legacy.sessions : 0),
      // 累计口径：按每轮 last_token_usage 逐条累加，再与历史索引按天取大者合并。
      // 不能用各会话 total_token_usage 相加——续跑（resume）会生成新会话文件，
      // 其 total 携带了此前的累计值，相加会把历史用量重复计算。
      totals: {
        inputTokens: totals.inputTokens,
        cachedInputTokens: totals.cachedInputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.totalTokens,
        records: totals.records
      },
      baseline: legacy,
      today,
      yesterday,
      series,
      quota: this.rateLimits ? { ...this.rateLimits, sampledAt: this.rateLimitsAt } : null,
      // 花费要按模型单价折算：明细扫描过就用明细的，否则用缓存里的文件聚合
      cost: this._detailCost || this.costSummary(),
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

  // ---------------------------------------------------------------------
  // 明细扫描：模型 / 项目 / 会话 / 小时分布
  //
  // 与 buildFast/buildFull 相互独立：那两条路径只为弹窗提供「今日常用」的
  // 聚合桶，信息粒度到天为止；完整看板需要按模型、按项目、按会话拆分，
  // 因此单独做一次全量流式扫描，结果按文件签名增量缓存。
  // ---------------------------------------------------------------------

  detailCacheFile() {
    return this.detailFile || null;
  }

  loadDetailCache() {
    const file = this.detailCacheFile();
    if (!file) return false;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || data.version !== DETAIL_CACHE_VERSION) return false;
      this.detailFiles = new Map();
      for (const entry of data.files || []) {
        this.detailFiles.set(entry.path, {
          size: Number(entry.size) || 0,
          mtimeMs: Number(entry.mtimeMs) || 0,
          detail: entry.detail || null
        });
      }
      // 缓存命中也要先算一遍日聚合，否则弹窗会在 detail 扫描前用快扫口径
      if (this.detailFiles.size) {
        try {
          this.detailSnapshot();
        } catch {
          /* 缓存结构异常时交给后续扫描重建 */
        }
      }
      return this.detailFiles.size > 0;
    } catch {
      return false;
    }
  }

  saveDetailCache() {
    const file = this.detailCacheFile();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        version: DETAIL_CACHE_VERSION,
        savedAt: new Date().toISOString(),
        files: [...this.detailFiles.entries()].map(([filePath, entry]) => ({
          path: filePath,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          detail: entry.detail
        }))
      }), "utf8");
    } catch {
      /* 缓存失败不影响功能 */
    }
  }

  /**
   * 流式读取单个会话文件，提取明细。
   * 分块读取 + 保留未完结行的 Buffer，避免大文件整块进内存，也避免
   * 多字节字符被块边界切断。
   */
  async scanFileDetail(filePath, size, onLine) {
    const handle = await fsp.open(filePath, "r");
    try {
      let remainder = Buffer.alloc(0);
      let position = 0;
      while (position < size) {
        const length = Math.min(SCAN_CHUNK_BYTES, size - position);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (!bytesRead) break;
        position += bytesRead;

        const joined = remainder.length ? Buffer.concat([remainder, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const lastBreak = joined.lastIndexOf(0x0a);
        if (lastBreak === -1) {
          remainder = Buffer.from(joined);
          continue;
        }
        const body = joined.subarray(0, lastBreak);
        remainder = Buffer.from(joined.subarray(lastBreak + 1));
        onLine(body.toString("utf8"));
      }
      if (remainder.length) onLine(remainder.toString("utf8"));
    } finally {
      await handle.close();
    }
  }

  /** 创建单文件明细累加器：feeds 分块文本，finish() 返回结果 */
  createDetailBuilder(filePath) {
    const detail = {
      file: filePath,
      sessionId: null,
      cwd: null,
      project: null,
      source: null,
      originator: null,
      cliVersion: null,
      firstAt: null,
      lastAt: null,
      tokens: zeroBucket(),
      /** Codex 自己维护的线程累计（total_token_usage 的最大值） */
      sessionTotal: 0,
      models: {},
      modelDays: {},
      days: {},
      hours: {},
      /** turn_id -> 该轮 output tokens（取 turn_token_usage 的累计值） */
      turnOutput: new Map(),
      /** turn_id -> task_complete 的耗时与首字延迟 */
      turnDone: new Map(),
      /** turn_id -> 该轮用的模型，速度要按模型拆开看 */
      turnModel: new Map(),
      quota: null
    };
    let currentModel = null;

    const feed = text => {
      for (const line of text.split("\n")) {
        if (line.length < 24) continue;

        if (line.indexOf('"session_meta"') !== -1) {
          try {
            const payload = JSON.parse(line).payload;
            if (payload) {
              detail.sessionId = payload.session_id || payload.id || detail.sessionId;
              detail.cwd = payload.cwd || detail.cwd;
              detail.source = payload.source || detail.source;
              detail.originator = payload.originator || detail.originator;
              detail.cliVersion = payload.cli_version || detail.cliVersion;
              if (!detail.firstAt && payload.timestamp) detail.firstAt = payload.timestamp;
            }
          } catch {
            /* 单行损坏跳过 */
          }
          continue;
        }

        if (line.indexOf('"turn_context"') !== -1) {
          try {
            const payload = JSON.parse(line).payload;
            const settings = payload && payload.collaboration_mode && payload.collaboration_mode.settings;
            const model = payload && (payload.model || (settings && settings.model));
            if (model) currentModel = model;
            if (payload && payload.cwd && !detail.cwd) detail.cwd = payload.cwd;
          } catch {
            /* ignore */
          }
          continue;
        }

        // 输出速度：task_complete 给了每轮的 duration_ms，token_usage_record 给了每轮的
        // output tokens，两者按 turn_id 配对就能算出真实的完成轮吞吐（tokens/s）。
        // 注意这是「整轮耗时」口径：包含了工具调用与等待，不是纯流式解码速度。
        if (line.indexOf('"task_complete"') !== -1) {
          try {
            const event = JSON.parse(line);
            const payload = event && event.payload;
            const duration = Number(payload && payload.duration_ms);
            if (payload && payload.type === "task_complete" && payload.turn_id && duration > 0) {
              const completedMs = Number(payload.completed_at) > 0
                ? Number(payload.completed_at) * 1000
                : Date.parse(event.timestamp || "");
              const ttft = Number(payload.time_to_first_token_ms);
              detail.turnDone.set(payload.turn_id, {
                durationMs: duration,
                ttftMs: Number.isFinite(ttft) && ttft >= 0 && ttft <= duration ? ttft : null,
                completedAt: Number.isFinite(completedMs) ? new Date(completedMs).toISOString() : null
              });
            }
          } catch {
            /* ignore */
          }
          continue;
        }

        if (line.indexOf('"token_usage_record"') !== -1) {
          try {
            const payload = JSON.parse(line).payload;
            const turnId = payload && payload.turn_id;
            if (turnId) {
              const usage = payload.turn_token_usage || payload.usage || {};
              const output = Number(usage.output_tokens) || 0;
              // turn_token_usage 是轮内累计值，取最大值可避免续跑时重复文件把它叠高
              if (output > (detail.turnOutput.get(turnId) || 0)) detail.turnOutput.set(turnId, output);
              if (!detail.turnModel.has(turnId)) detail.turnModel.set(turnId, payload.model || currentModel || "unknown");
            }
          } catch {
            /* ignore */
          }
          continue;
        }

        if (line.indexOf("token_count") === -1) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const payload = event.payload;
        if (!payload || payload.type !== "token_count") continue;

        const stamp = event.timestamp || payload.timestamp || null;
        if (stamp) {
          if (!detail.firstAt || stamp < detail.firstAt) detail.firstAt = stamp;
          if (!detail.lastAt || stamp > detail.lastAt) detail.lastAt = stamp;
        }

        if (payload.info && payload.info.last_token_usage) {
          const usage = payload.info.last_token_usage;
          addToBucket(detail.tokens, usage, 1);

          // 同时记下线程累计：这是 Codex 自己的账，包含已被清理的早期历史
          const runningTotal = payload.info.total_token_usage && Number(payload.info.total_token_usage.total_tokens);
          if (runningTotal && runningTotal > detail.sessionTotal) detail.sessionTotal = runningTotal;

          const model = currentModel || "unknown";
          if (!detail.models[model]) detail.models[model] = zeroBucket();
          addToBucket(detail.models[model], usage, 1);

          const date = stamp ? new Date(stamp) : new Date();
          if (!Number.isNaN(date.getTime())) {
            const day = dayKeyOf(date);
            if (!detail.days[day]) detail.days[day] = zeroBucket();
            addToBucket(detail.days[day], usage, 1);

            // 按天×模型留一份，供看板切换时间范围时重算模型占比
            if (!detail.modelDays[day]) detail.modelDays[day] = {};
            if (!detail.modelDays[day][model]) detail.modelDays[day][model] = zeroBucket();
            addToBucket(detail.modelDays[day][model], usage, 1);

            // 全天候保留小时桶：活跃时段图要跟着 7/14/30/全部 区间切换
            const hourKey = `${day}T${pad2(date.getHours())}`;
            detail.hours[hourKey] = (detail.hours[hourKey] || 0) + (usage.total_tokens || 0);
          }
        }

        if (payload.rate_limits) {
          const normalized = normalizeRateLimits(payload.rate_limits, stamp);
          if (normalized && (!detail.quota || !stamp || !detail.quota.sampledAt || stamp >= detail.quota.sampledAt)) {
            detail.quota = normalized;
          }
        }
      }
    };

    return {
      feed,
      finish() {
        detail.project = projectNameOf(detail.cwd);

        // 输出速度：把每轮的 output tokens 与 task_complete 的耗时配对。
        // 同时按「天」「模型」「小时」各留一份，界面才能回答
        // 「哪个模型快」「什么时段快」，而不只是一个总数。
        const throughput = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [], days: {}, models: {}, hours: {}, dayHours: {}, modelDays: {} };
        const cellOf = (target, key) => {
          if (!target[key]) target[key] = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [] };
          return target[key];
        };
        for (const [turnId, done] of detail.turnDone) {
          const output = detail.turnOutput.get(turnId) || 0;
          if (!output || !done.durationMs) continue;
          throughput.turns += 1;
          throughput.outputTokens += output;
          throughput.durationMs += done.durationMs;
          if (done.ttftMs !== null) throughput.ttft.push(done.ttftMs);

          const model = detail.turnModel.get(turnId) || "unknown";
          const cells = [cellOf(throughput.models, model)];
          if (done.completedAt) {
            // 按本地日期归集：completedAt 是 ISO(UTC)，直接 slice 会在时区边界错一天
            const completedAt = new Date(done.completedAt);
            const day = dayKeyOf(completedAt);
            cells.push(cellOf(throughput.days, day));
            if (!throughput.modelDays[day]) throughput.modelDays[day] = {};
            cells.push(cellOf(throughput.modelDays[day], model));
            const hour = completedAt.getHours();
            if (Number.isFinite(hour)) {
              cells.push(cellOf(throughput.hours, String(hour)));
              if (!throughput.dayHours[day]) throughput.dayHours[day] = {};
              cells.push(cellOf(throughput.dayHours[day], String(hour)));
            }
          }
          for (const cell of cells) {
            cell.turns += 1;
            cell.outputTokens += output;
            cell.durationMs += done.durationMs;
            if (done.ttftMs !== null) cell.ttft.push(done.ttftMs);
          }
        }
        detail.turnOutput = null;
        detail.turnDone = null;
        detail.turnModel = null;
        detail.throughput = throughput;
        return detail;
      }
    };
  }

  /** 全量明细扫描（增量：按 size/mtime 跳过未变更文件） */
  async buildDetail({ onProgress } = {}) {
    if (this._detailPromise) return this._detailPromise;
    this._detailPromise = (async () => {
      const files = await this.listSessionFiles();
      this.sessionCount = files.length;
      let index = 0;
      let changed = false;
      for (const info of files) {
        index += 1;
        if (onProgress) onProgress({ index, total: files.length, name: path.basename(info.path) });
        const existing = this.detailFiles.get(info.path);
        if (existing && existing.size === info.size && existing.mtimeMs === info.mtimeMs && existing.detail) continue;
        try {
          const builder = this.createDetailBuilder(info.path);
          await this.scanFileDetail(info.path, info.size, builder.feed);
          this.detailFiles.set(info.path, {
            size: info.size,
            mtimeMs: info.mtimeMs,
            detail: builder.finish()
          });
          changed = true;
        } catch {
          /* 单个文件读取失败继续 */
        }
      }
      if (changed || !this.detailBuiltAt) this.detailBuiltAt = new Date().toISOString();
      if (changed) this.saveDetailCache();
      return this.detailSnapshot();
    })();
    try {
      return await this._detailPromise;
    } finally {
      this._detailPromise = null;
    }
  }

  /**
   * 花费摘要：只做聚合，不生成完整明细。
   * 弹窗在明细扫描之前也要能显示「等价花费」，所以单独给一条轻量路径。
   */
  costSummary() {
    if (!this.detailFiles.size && !this.baseline) return null;

    /** 天 → { totalTokens, models: 模型 → 桶 } */
    const days = new Map();
    for (const entry of this.detailFiles.values()) {
      const detail = entry && entry.detail;
      if (!detail) continue;
      for (const [day, byModel] of Object.entries(detail.modelDays || {})) {
        let cell = days.get(day);
        if (!cell) {
          cell = { totalTokens: 0, models: {} };
          days.set(day, cell);
        }
        for (const [model, bucket] of Object.entries(byModel)) {
          if (!cell.models[model]) cell.models[model] = zeroBucket();
          const target = cell.models[model];
          for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;
          cell.totalTokens += bucket.totalTokens || 0;
        }
      }
    }

    // 与历史索引按天取大者：Codex 清理掉的旧 rollout 只在索引里
    const baseline = this.baseline;
    if (baseline && baseline.days) {
      for (const [day, baseDay] of Object.entries(baseline.days)) {
        if (!baseDay || !baseDay.totalTokens) continue;
        const local = days.get(day);
        if (local && local.totalTokens >= baseDay.totalTokens) continue;
        const models = {};
        for (const [model, bucket] of Object.entries(baseDay.models || {})) {
          models[model] = { ...zeroBucket(), ...bucket };
        }
        days.set(day, { totalTokens: baseDay.totalTokens, models });
      }
    }

    const all = {};
    const todayKey = dayKeyOf(new Date());
    let todayCny = 0;
    for (const [day, cell] of days) {
      for (const [model, bucket] of Object.entries(cell.models)) {
        if (!all[model]) all[model] = zeroBucket();
        const target = all[model];
        for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;
      }
      if (day === todayKey) todayCny = costOfModels(cell.models, this.pricing).cny;
    }

    const total = costOfModels(all, this.pricing);
    if (!total.cny) return null;
    return {
      cny: total.cny,
      usd: total.cny / this.pricing.usdCny,
      todayCny,
      estimatedTokens: total.estimatedTokens,
      rate: this.pricing.usdCny
    };
  }

  detailSnapshot() {
    /** 按 session_id 合并：续跑会为同一会话生成多个 rollout 文件 */
    const sessionsById = new Map();
    const models = new Map();
    const projects = new Map();
    const days = new Map();
    /** @type {Record<string, Record<string, object>>} 天 → 模型 → 桶 */
    const modelDays = {};
    /** @type {Record<string, Record<string, object>>} 天 → 项目 → 桶 */
    const projectDays = {};
    const hours = new Array(24).fill(0);
    /** @type {Record<string, number[]>} 天 → 24 小时桶，用于「昨日同期」这类对比 */
    const dailyHours = {};
    const sum = zeroBucket();
    /** 输出速度汇总：turns/outputTokens/durationMs 三项累加后算加权 tps */
    const speed = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [], days: {}, models: {}, hours: {}, dayHours: {}, modelDays: {} };

    const todayKey = dayKeyOf(new Date());
    const hourFloor = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const entry of this.detailFiles.values()) {
      const detail = entry.detail;
      if (!detail) continue;

      const sessionKey = detail.sessionId || detail.file;
      let session = sessionsById.get(sessionKey);
      if (!session) {
        session = {
          id: sessionKey,
          sessionId: detail.sessionId,
          project: detail.project || "未标注",
          cwd: detail.cwd,
          source: detail.source,
          firstAt: detail.firstAt,
          lastAt: detail.lastAt,
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          records: 0,
          files: 0,
          sessionTotal: 0,
          modelSet: new Set(),
          /** 会话内「模型 → 桶」：各家单价不同，成本必须按模型分别折算 */
          modelBuckets: {},
          quota: null
        };
        sessionsById.set(sessionKey, session);
      }
      session.files += 1;
      if ((detail.sessionTotal || 0) > session.sessionTotal) session.sessionTotal = detail.sessionTotal || 0;
      session.totalTokens += detail.tokens.totalTokens;
      session.inputTokens += detail.tokens.inputTokens;
      session.cachedInputTokens += detail.tokens.cachedInputTokens;
      session.outputTokens += detail.tokens.outputTokens;
      session.records += detail.tokens.records;
      for (const [name, bucket] of Object.entries(detail.models)) {
        session.modelSet.add(name);
        if (!session.modelBuckets[name]) session.modelBuckets[name] = zeroBucket();
        const dest = session.modelBuckets[name];
        for (const key of Object.keys(zeroBucket())) dest[key] += bucket[key] || 0;
      }

      // 输出速度：会话级也留一份，会话表里能直接看每轮快慢
      const fileSpeed = detail.throughput;
      if (fileSpeed && fileSpeed.turns) {
        session.speedTurns = (session.speedTurns || 0) + fileSpeed.turns;
        session.speedOutput = (session.speedOutput || 0) + fileSpeed.outputTokens;
        session.speedDuration = (session.speedDuration || 0) + fileSpeed.durationMs;
        speed.turns += fileSpeed.turns;
        speed.outputTokens += fileSpeed.outputTokens;
        speed.durationMs += fileSpeed.durationMs;
        if (fileSpeed.ttft) for (const value of fileSpeed.ttft) speed.ttft.push(value);
        const mergeSpeedCell = (target, key, cell) => {
          const dest = target[key] || (target[key] = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [] });
          dest.turns += cell.turns;
          dest.outputTokens += cell.outputTokens;
          dest.durationMs += cell.durationMs;
          if (cell.ttft) for (const value of cell.ttft) dest.ttft.push(value);
        };
        for (const [day, cell] of Object.entries(fileSpeed.days || {})) mergeSpeedCell(speed.days, day, cell);
        for (const [model, cell] of Object.entries(fileSpeed.models || {})) mergeSpeedCell(speed.models, model, cell);
        for (const [hour, cell] of Object.entries(fileSpeed.hours || {})) mergeSpeedCell(speed.hours, hour, cell);
        for (const [day, hours] of Object.entries(fileSpeed.dayHours || {})) {
          if (!speed.dayHours[day]) speed.dayHours[day] = {};
          for (const [hour, cell] of Object.entries(hours)) mergeSpeedCell(speed.dayHours[day], hour, cell);
        }
        for (const [day, byModel] of Object.entries(fileSpeed.modelDays || {})) {
          if (!speed.modelDays[day]) speed.modelDays[day] = {};
          for (const [model, cell] of Object.entries(byModel)) mergeSpeedCell(speed.modelDays[day], model, cell);
        }
      }
      if (detail.firstAt && (!session.firstAt || detail.firstAt < session.firstAt)) session.firstAt = detail.firstAt;
      if (detail.lastAt && (!session.lastAt || detail.lastAt > session.lastAt)) session.lastAt = detail.lastAt;
      if (detail.quota && (!session.quota || String(detail.quota.sampledAt || "") > String(session.quota.sampledAt || ""))) {
        session.quota = detail.quota;
      }

      for (const [name, bucket] of Object.entries(detail.models)) {
        let target = models.get(name);
        if (!target) {
          target = { model: name, ...zeroBucket() };
          models.set(name, target);
        }
        for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;
      }

      const projectKey = detail.project || "未标注";
      let project = projects.get(projectKey);
      if (!project) {
        project = { project: projectKey, cwd: detail.cwd, ...zeroBucket(), sessions: 0 };
        projects.set(projectKey, project);
      }
      for (const key of Object.keys(zeroBucket())) project[key] += detail.tokens[key] || 0;
      project.sessions += 1;

      for (const [day, bucket] of Object.entries(detail.days)) {
        let target = days.get(day);
        if (!target) {
          target = { day, ...zeroBucket() };
          days.set(day, target);
        }
        for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;

        // 项目维度没有跨会话混合，可直接按该会话的日桶归属
        if (!projectDays[day]) projectDays[day] = {};
        if (!projectDays[day][projectKey]) projectDays[day][projectKey] = zeroBucket();
        for (const key of Object.keys(zeroBucket())) projectDays[day][projectKey][key] += bucket[key] || 0;
      }

      for (const [day, byModel] of Object.entries(detail.modelDays || {})) {
        if (!modelDays[day]) modelDays[day] = {};
        for (const [model, bucket] of Object.entries(byModel)) {
          if (!modelDays[day][model]) modelDays[day][model] = zeroBucket();
          for (const key of Object.keys(zeroBucket())) modelDays[day][model][key] += bucket[key] || 0;
        }
      }

      for (const [hourKey, tokens] of Object.entries(detail.hours)) {
        const [dayPart, hourPart] = hourKey.split("T");
        // 全量落进 dailyHours，前端按 7/14/30/全部 现算，不再写死 7 天
        if (!dailyHours[dayPart]) dailyHours[dayPart] = new Array(24).fill(0);
        dailyHours[dayPart][Number(hourPart)] += tokens;

        const stamp = new Date(`${hourKey}:00:00`).getTime();
        if (Number.isNaN(stamp) || stamp < hourFloor) continue;
        hours[new Date(stamp).getHours()] += tokens;
      }

      for (const key of Object.keys(zeroBucket())) sum[key] += detail.tokens[key] || 0;
    }

    // ------------------------------------------------------------------
    // 与历史基线合并
    //
    // Codex 会清理/压缩旧的 rollout，磁盘上的日志往往只有最近一段。
    // 旧版索引把历史上扫到过的请求都留了下来（本机 135 天、5.70B）。
    // 这里按「天」逐个裁决：哪边的量大就用哪边，避免重复计入同一天。
    // ------------------------------------------------------------------
    const baseline = this.baseline;
    if (baseline && baseline.days) {
      for (const [day, baseDay] of Object.entries(baseline.days)) {
        if (!baseDay || !baseDay.totalTokens) continue;
        const logDay = days.get(day);
        const useBaseline = !logDay || baseDay.totalTokens > (logDay.totalTokens || 0);
        if (!useBaseline) continue;

        days.set(day, {
          day,
          totalTokens: baseDay.totalTokens,
          inputTokens: baseDay.inputTokens,
          cachedInputTokens: baseDay.cachedInputTokens,
          outputTokens: baseDay.outputTokens,
          records: baseDay.records
        });

        // 模型维度整体替换为基线的（保证同一天内各维度口径一致）
        modelDays[day] = {};
        for (const [model, bucket] of Object.entries(baseDay.models || {})) {
          modelDays[day][model] = { ...zeroBucket(), ...bucket };
        }

        // 项目维度同理
        projectDays[day] = {};
        for (const cell of Object.values(baseDay.sessions || {})) {
          const project = cell.project || "历史索引";
          if (!projectDays[day][project]) projectDays[day][project] = zeroBucket();
          const target = projectDays[day][project];
          target.totalTokens += cell.totalTokens || 0;
          target.inputTokens += cell.inputTokens || 0;
          target.cachedInputTokens += cell.cachedInputTokens || 0;
          target.outputTokens += cell.outputTokens || 0;
          target.records += cell.records || 0;
        }

        // 小时分布：整天被基线接管时，用基线的小时桶覆盖日志的那一份，
        // 否则活跃时段图只统计得到本机残留日志（约 1/3 量），切区间看着像没反应。
        if (Array.isArray(baseDay.hours) && baseDay.hours.length === 24) {
          dailyHours[day] = baseDay.hours.slice();
        }
      }

      // 只存在于历史索引里的会话补进会话列表
      for (const [sessionId, baseSession] of Object.entries(baseline.sessions || {})) {
        if (sessionsById.has(sessionId)) continue;
        sessionsById.set(sessionId, {
          id: sessionId,
          sessionId,
          project: baseSession.project || "历史索引",
          cwd: null,
          source: "legacy-index",
          firstAt: baseSession.firstAt,
          lastAt: baseSession.lastAt,
          totalTokens: baseSession.totalTokens,
          inputTokens: baseSession.inputTokens,
          cachedInputTokens: baseSession.cachedInputTokens,
          outputTokens: baseSession.outputTokens,
          records: baseSession.records,
          files: 0,
          sessionTotal: baseSession.totalTokens,
          modelSet: new Set(Object.keys(baseSession.models || {})),
          modelBuckets: Object.fromEntries(
            Object.entries(baseSession.models || {}).map(([name, bucket]) => [name, { ...zeroBucket(), ...bucket }])
          ),
          quota: null
        });
      }
    }

    // 合并后按天重算总量与各维度，避免新旧口径混在一起
    const merged = zeroBucket();
    for (const bucket of days.values()) {
      merged.totalTokens += bucket.totalTokens || 0;
      merged.inputTokens += bucket.inputTokens || 0;
      merged.cachedInputTokens += bucket.cachedInputTokens || 0;
      merged.outputTokens += bucket.outputTokens || 0;
      merged.records += bucket.records || 0;
    }

    const priceTable = this.pricing;

    const sessions = [...sessionsById.values()]
      .map(item => {
        const { modelSet, modelBuckets, speedTurns, speedOutput, speedDuration, ...rest } = item;
        return {
          ...rest,
          models: [...modelSet],
          turns: speedTurns || 0,
          // 会话成本：按会话内各模型各自的单价折算
          cost: costOfModels(modelBuckets || {}, priceTable).cny,
          // 会话级加权速度：总输出 ÷ 总耗时，避免被单个极快/极慢的轮次带偏
          tps: speedDuration > 0 ? (speedOutput || 0) * 1000 / speedDuration : null
        };
      })
      .sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));

    const series = [...days.values()]
      .map(item => ({
        day: item.day,
        totalTokens: item.totalTokens,
        inputTokens: item.inputTokens,
        cachedInputTokens: item.cachedInputTokens,
        outputTokens: item.outputTokens,
        records: item.records
      }))
      .sort((a, b) => a.day.localeCompare(b.day));

    // 每天花费：按「天 → 模型」的桶各自单价折算，这样区间花费能跟着筛选重算
    for (const item of series) {
      item.cost = costOfModels(modelDays[item.day] || {}, priceTable).cny;
    }

    const modelList = Object.entries(modelDays).reduce((acc, [, byModel]) => {
      for (const [model, bucket] of Object.entries(byModel)) {
        if (!acc[model]) acc[model] = { model, ...zeroBucket() };
        const target = acc[model];
        target.totalTokens += bucket.totalTokens || 0;
        target.inputTokens += bucket.inputTokens || 0;
        target.cachedInputTokens += bucket.cachedInputTokens || 0;
        target.outputTokens += bucket.outputTokens || 0;
        target.records += bucket.records || 0;
      }
      return acc;
    }, {});

    const modelCost = costOfModels(modelList, priceTable);
    const modelListArray = Object.values(modelList)
      .map(item => {
        const cell = modelCost.perModel[item.model] || {};
        return {
          ...item,
          share: merged.totalTokens ? item.totalTokens / merged.totalTokens : 0,
          cost: cell.unit ? cell.cny : null,
          unit: cell.unit || null,
          estimated: Boolean(cell.estimated)
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const projectTotals = Object.entries(projectDays).reduce((acc, [, byProject]) => {
      for (const [project, bucket] of Object.entries(byProject)) {
        if (!acc[project]) acc[project] = { project, ...zeroBucket(), sessions: 0 };
        const target = acc[project];
        target.totalTokens += bucket.totalTokens || 0;
        target.inputTokens += bucket.inputTokens || 0;
        target.cachedInputTokens += bucket.cachedInputTokens || 0;
        target.outputTokens += bucket.outputTokens || 0;
        target.records += bucket.records || 0;
      }
      return acc;
    }, {});

    const projectList = Object.values(projectTotals)
      .map(item => ({ ...item, share: merged.totalTokens ? item.totalTokens / merged.totalTokens : 0 }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    // 累计口径 = 磁盘日志 ∪ 历史索引，按天去重后求和。
    // 这就是「总共用了多少」，不需要再叠加任何线程计数器。
    const legacy = this.baselineMeta();

    /** 中位数：比平均值更抗单次卡顿 */
    const median = list => {
      if (!list.length) return null;
      const sorted = [...list].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const speedCell = cell => ({
      turns: cell.turns,
      outputTokens: cell.outputTokens,
      durationMs: cell.durationMs,
      tps: cell.durationMs > 0 ? cell.outputTokens * 1000 / cell.durationMs : null,
      ttftMs: median(cell.ttft || [])
    });

    const throughput = speed.durationMs > 0
      ? {
        turns: speed.turns,
        outputTokens: speed.outputTokens,
        durationMs: speed.durationMs,
        tps: speed.outputTokens * 1000 / speed.durationMs,
        ttftMs: median(speed.ttft),
        days: Object.fromEntries(Object.entries(speed.days).map(([day, cell]) => [day, speedCell(cell)])),
        models: Object.entries(speed.models)
          .map(([model, cell]) => ({ model, ...speedCell(cell) }))
          .sort((a, b) => b.turns - a.turns),
        hours: Array.from({ length: 24 }, (_, hour) => {
          const cell = speed.hours[String(hour)];
          return cell ? speedCell(cell) : { turns: 0, outputTokens: 0, durationMs: 0, tps: null, ttftMs: null };
        }),
        dayHours: Object.fromEntries(Object.entries(speed.dayHours).map(([day, byHour]) => [
          day,
          Array.from({ length: 24 }, (_, hour) => {
            const cell = byHour[String(hour)];
            return cell ? speedCell(cell) : null;
          })
        ])),
        modelDays: Object.fromEntries(Object.entries(speed.modelDays).map(([day, byModel]) => [
          day,
          Object.fromEntries(Object.entries(byModel).map(([model, cell]) => [model, speedCell(cell)]))
        ]))
      }
      : null;

    // 供 snapshot() 复用：弹窗与看板从此共用这一份日聚合
    this._detailDays = days;
    this._detailSessions = sessions.length;
    this._detailCost = {
      cny: modelCost.cny,
      usd: modelCost.cny / priceTable.usdCny,
      todayCny: (series.find(item => item.day === todayKey) || {}).cost || 0,
      rate: priceTable.usdCny
    };

    return {
      ok: true,
      builtAt: this.detailBuiltAt || null,
      sessions: sessions.length,
      scannedFiles: this.detailFiles.size,
      baseline: legacy,
      throughput,
      totals: {
        inputTokens: merged.inputTokens,
        cachedInputTokens: merged.cachedInputTokens,
        outputTokens: merged.outputTokens,
        totalTokens: merged.totalTokens,
        records: merged.records,
        sessions: sessions.length,
        cost: modelCost.cny
      },
      cost: {
        cny: modelCost.cny,
        usd: modelCost.cny / priceTable.usdCny,
        todayCny: (series.find(item => item.day === todayKey) || {}).cost || 0,
        estimatedTokens: modelCost.estimatedTokens,
        rate: priceTable.usdCny,
        updatedAt: priceTable.updatedAt,
        note: priceTable.note,
        sources: priceTable.sources
      },
      pricing: describeTable(priceTable, modelListArray.map(item => item.model)),
      series,
      models: modelListArray,
      projects: projectList,
      modelDays,
      projectDays,
      hourly: hours,
      dailyHours,
      sessionList: sessions,
      today: series.find(item => item.day === todayKey) || null
    };
  }
}

module.exports = {
  CodexStore,
  dayKeyOf,
  normalizeRateLimits,
  projectNameOf,
  CACHE_VERSION,
  DETAIL_CACHE_VERSION
};

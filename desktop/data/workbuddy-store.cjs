"use strict";

/**
 * WorkBuddyStore — WorkBuddy 用量数据层
 *
 * 数据来源：~/.workbuddy/projects/<工作区转义名>/<会话id>.jsonl
 * 每条模型调用在 providerData 里带一份 usage：
 *   providerData.usage = { inputTokens, outputTokens, totalTokens,
 *                          inputTokensDetails:[{cached_tokens}],
 *                          outputTokensDetails:[{reasoning_tokens}] }
 *   providerData.model / requestModelName / traceId / stepSeq / conversationRequestId
 *   providerData.rawUsage.credit = 本次调用消耗的积分
 *
 * 口径要点（与 wb-token-meter 对齐）：
 *  - input **含**缓存命中，所以「新增输入 = input - cached」
 *  - 一次会话请求（conversationRequestId）会被拆成多个 step，每个 step 都是一次
 *    独立的模型调用、各带一份 usage。按 conversationRequestId 去重会少算几十倍，
 *    因此去重键用 traceId|stepSeq。
 *  - 日志会在同一步里重复写多行（function_call / message），按 key 去重避免重复计入。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { normalizeTable, costOfModels, describeTable } = require("./pricing.cjs");

// 2：扫描范围从单一 ~/.workbuddy 扩到国际版 ~/.workbuddy-ai，缓存按会话 id 合并去重
const CACHE_VERSION = 2;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dayKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function projectNameOf(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
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

function addBucket(target, source, sign = 1) {
  for (const key of Object.keys(zeroBucket())) target[key] += sign * (source[key] || 0);
}

class WorkBuddyStore {
  /**
   * @param {{root?:string, roots?:string[], cacheFile?:string}} options
   *   roots 支持多套安装：国内版写 `~/.workbuddy`，国际版写 `~/.workbuddy-ai`。
   *   两边常常是同一批会话（国际版首次启动会把旧目录整份搬过去），所以扫描时按会话去重。
   */
  constructor(options = {}) {
    const home = require("node:os").homedir();
    const roots = Array.isArray(options.roots) && options.roots.length
      ? options.roots.filter(Boolean)
      : [options.root || path.join(home, ".workbuddy")];
    /** @type {string[]} 去重后的安装根目录，顺序决定同名会话谁优先 */
    this.roots = [...new Set(roots)];
    this.root = this.roots[0];
    /** 模型价格表：和 Codex 共用一份，口径见 pricing.cjs */
    this.pricing = normalizeTable(options.pricing || {});
    this.projectsDir = path.join(this.root, "projects");
    this.cacheFile = options.cacheFile || null;
    /** @type {Map<string, {size:number,mtimeMs:number,detail:object}>} */
    this.files = new Map();
    /** 每个根目录扫到多少、最终留下多少，供界面说明数据来自哪套安装 */
    this.rootsInfo = [];
    this.builtAt = null;
    this.phase = "idle";
    this._promise = null;
  }

  /**
   * 递归列出所有会话日志（按 mtime 升序，新的在后面）。
   * 同一会话 id 在多套安装里都存在时，取体积更大的那份——国际版是接着国内版续写的，
   * 直接两边都算会把整段历史重复计入。
   */
  listFiles() {
    const walk = dir => {
      const out = [];
      const dig = current => {
        let entries;
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            dig(full);
          } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            try {
              const stat = fs.statSync(full);
              out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
            } catch {
              /* 边走边删的日志跳过 */
            }
          }
        }
      };
      dig(dir);
      return out;
    };

    /** @type {Map<string, {path:string,size:number,mtimeMs:number,root:string}>} */
    const bySession = new Map();
    const info = [];
    for (const root of this.roots) {
      const found = walk(path.join(root, "projects"));
      let kept = 0;
      for (const entry of found) {
        const sessionId = path.basename(entry.path, ".jsonl");
        const prev = bySession.get(sessionId);
        const wins = !prev
          || entry.size > prev.size
          || (entry.size === prev.size && entry.mtimeMs > prev.mtimeMs);
        if (!wins) continue;
        bySession.set(sessionId, { ...entry, root });
        kept += 1;
      }
      info.push({ root, files: found.length, kept });
    }
    this.rootsInfo = info;

    const out = [...bySession.values()];
    out.sort((a, b) => a.mtimeMs - b.mtimeMs);
    return out;
  }

  loadCache() {
    if (!this.cacheFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      if (!raw || raw.version !== CACHE_VERSION || !Array.isArray(raw.files)) return;
      for (const entry of raw.files) {
        if (!entry || !entry.path || !entry.detail) continue;
        this.files.set(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs, detail: entry.detail });
      }
      this.builtAt = raw.savedAt || null;
    } catch {
      /* 缓存坏了就当没有 */
    }
  }

  saveCache() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({
        version: CACHE_VERSION,
        savedAt: new Date().toISOString(),
        files: [...this.files.entries()].map(([filePath, entry]) => ({
          path: filePath,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          detail: entry.detail
        }))
      }), "utf8");
    } catch {
      /* 写不进去不影响使用 */
    }
  }

  /** 流式读单个文件：保留未完结的一行，避免多字节字符被块边界切断 */
  async scanFile(filePath, size, onLine) {
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
        onLine(joined.subarray(0, lastBreak).toString("utf8"));
        remainder = Buffer.from(joined.subarray(lastBreak + 1));
      }
      if (remainder.length) onLine(remainder.toString("utf8"));
    } finally {
      await handle.close();
    }
  }

  createFileBuilder(filePath) {
    const detail = {
      file: filePath,
      sessionId: path.basename(filePath, ".jsonl"),
      cwd: null,
      project: null,
      firstAt: null,
      lastAt: null,
      tokens: zeroBucket(),
      credits: 0,
      models: {},
      modelDays: {},
      days: {},
      hours: {},
      /** 去重键：traceId|stepSeq，同一个 step 在日志里可能写多行 */
      keys: []
    };
    const seen = new Set();

    const feed = text => {
      for (const line of text.split("\n")) {
        if (line.length < 32) continue;
        if (line.indexOf('"providerData"') === -1) continue;
        if (line.indexOf('"usage"') === -1) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const provider = record && record.providerData;
        const usage = provider && provider.usage;
        if (!usage || typeof usage !== "object") continue;

        const key = provider.traceId || provider.conversationRequestId
          ? `${provider.traceId || provider.conversationRequestId}|${provider.stepSeq || 0}`
          : `ts:${record.timestamp || 0}:${provider.stepSeq || 0}:${detail.keys.length}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const inputTokens = Number(usage.inputTokens) || 0;
        const outputTokens = Number(usage.outputTokens) || 0;
        const cached = Number(usage.inputTokensDetails && usage.inputTokensDetails[0] && usage.inputTokensDetails[0].cached_tokens) || 0;
        const reasoning = Number(usage.outputTokensDetails && usage.outputTokensDetails[0] && usage.outputTokensDetails[0].reasoning_tokens) || 0;
        const totalTokens = Number(usage.totalTokens) || (inputTokens + outputTokens);
        // 空记录（只有 requests:1、token 全 0 的占位）不计入，避免污染日序列与占比
        if (totalTokens <= 0) continue;
        detail.keys.push(key);

        const bucket = {
          inputTokens,
          cachedInputTokens: Math.min(cached, inputTokens),
          outputTokens,
          reasoningOutputTokens: reasoning,
          totalTokens,
          records: 1
        };

        const stamp = Number(record.timestamp);
        const date = Number.isFinite(stamp) ? new Date(stamp) : null;
        const iso = date ? date.toISOString() : null;
        if (iso) {
          if (!detail.firstAt || iso < detail.firstAt) detail.firstAt = iso;
          if (!detail.lastAt || iso > detail.lastAt) detail.lastAt = iso;
        }
        if (!detail.cwd && record.cwd) detail.cwd = record.cwd;
        if (!detail.sessionId && record.sessionId) detail.sessionId = record.sessionId;

        addBucket(detail.tokens, bucket);
        detail.credits += Number(provider.rawUsage && provider.rawUsage.credit) || Number(provider.credit) || 0;

        const model = provider.model || provider.requestModelId || "unknown";
        if (!detail.models[model]) detail.models[model] = zeroBucket();
        addBucket(detail.models[model], bucket);

        if (date) {
          const day = dayKeyOf(date);
          if (!detail.days[day]) detail.days[day] = zeroBucket();
          addBucket(detail.days[day], bucket);
          if (!detail.modelDays[day]) detail.modelDays[day] = {};
          if (!detail.modelDays[day][model]) detail.modelDays[day][model] = zeroBucket();
          addBucket(detail.modelDays[day][model], bucket);
          const hourKey = `${day}T${pad2(date.getHours())}`;
          detail.hours[hourKey] = (detail.hours[hourKey] || 0) + totalTokens;
        }
      }
    };

    return {
      feed,
      finish() {
        detail.project = projectNameOf(detail.cwd) || "WorkBuddy";
        // 缓存键随明细一起缓存，跨文件重复（续跑/分叉）靠它对账
        return detail;
      }
    };
  }

  async build({ onProgress, force = false } = {}) {
    if (this._promise) return this._promise;
    this._promise = (async () => {
      this.phase = "scanning";
      const files = this.listFiles();
      let index = 0;
      let changed = false;
      /** 全局去重：同一 step 在多个会话文件里出现过就只算一次 */
      const globalKeys = new Set();

      for (const info of files) {
        index += 1;
        if (onProgress) onProgress({ index, total: files.length, name: path.basename(info.path) });
        const existing = this.files.get(info.path);
        if (!force && existing && existing.size === info.size && existing.mtimeMs === info.mtimeMs && existing.detail) {
          for (const key of existing.detail.keys || []) globalKeys.add(key);
          continue;
        }
        try {
          const builder = this.createFileBuilder(info.path);
          await this.scanFile(info.path, info.size, builder.feed);
          const detail = builder.finish();
          this.files.set(info.path, { size: info.size, mtimeMs: info.mtimeMs, detail });
          for (const key of detail.keys) globalKeys.add(key);
          changed = true;
        } catch {
          /* 单个文件读失败继续 */
        }
      }

      // 清理已经消失的日志
      for (const key of [...this.files.keys()]) {
        if (!files.some(info => info.path === key)) {
          this.files.delete(key);
          changed = true;
        }
      }

      if (changed || !this.builtAt) this.builtAt = new Date().toISOString();
      if (changed) this.saveCache();
      this.phase = "ready";
      return this.snapshot();
    })();
    try {
      return await this._promise;
    } finally {
      this._promise = null;
    }
  }

  /** 聚合所有文件，返回与 CodexStore 明细同构的对象，前端可以共用渲染逻辑 */
  snapshot() {
    const sessionsById = new Map();
    const days = new Map();
    const modelDays = {};
    const projectDays = {};
    const dailyHours = {};
    const sum = zeroBucket();
    const seenKeys = new Set();
    const priceTable = this.pricing;
    let credits = 0;

    for (const entry of this.files.values()) {
      const detail = entry.detail;
      if (!detail) continue;

      // 跨文件去重后仍保留整份明细：重复只可能整份复制，出现重复说明该文件是续跑副本
      const duplicate = (detail.keys || []).length > 0 && (detail.keys || []).every(key => seenKeys.has(key));
      for (const key of detail.keys || []) seenKeys.add(key);
      if (duplicate) continue;

      const sessionKey = detail.sessionId || detail.file;
      let session = sessionsById.get(sessionKey);
      if (!session) {
        session = {
          id: sessionKey,
          sessionId: detail.sessionId,
          project: detail.project || "WorkBuddy",
          cwd: detail.cwd,
          firstAt: detail.firstAt,
          lastAt: detail.lastAt,
          ...zeroBucket(),
          credit: 0,
          models: new Set(),
          /** 会话内「模型 → 桶」，按各自单价折算成本 */
          modelBuckets: {}
        };
        sessionsById.set(sessionKey, session);
      }
      addBucket(session, detail.tokens);
      for (const [model, bucket] of Object.entries(detail.models || {})) {
        if (!session.modelBuckets[model]) session.modelBuckets[model] = zeroBucket();
        addBucket(session.modelBuckets[model], bucket);
      }
      session.credit += detail.credits || 0;
      if (detail.firstAt && (!session.firstAt || detail.firstAt < session.firstAt)) session.firstAt = detail.firstAt;
      if (detail.lastAt && (!session.lastAt || detail.lastAt > session.lastAt)) session.lastAt = detail.lastAt;
      for (const model of Object.keys(detail.models)) session.models.add(model);

      addBucket(sum, detail.tokens);
      credits += detail.credits || 0;

      const projectKey = detail.project || "WorkBuddy";

      for (const [day, bucket] of Object.entries(detail.days)) {
        if (!days.has(day)) days.set(day, { day, ...zeroBucket() });
        addBucket(days.get(day), bucket);

        if (!modelDays[day]) modelDays[day] = {};
        for (const [model, cell] of Object.entries(detail.modelDays[day] || {})) {
          if (!modelDays[day][model]) modelDays[day][model] = zeroBucket();
          addBucket(modelDays[day][model], cell);
        }

        if (!projectDays[day]) projectDays[day] = {};
        if (!projectDays[day][projectKey]) projectDays[day][projectKey] = zeroBucket();
        addBucket(projectDays[day][projectKey], bucket);

        if (!dailyHours[day]) dailyHours[day] = new Array(24).fill(0);
        for (const [hourKey, tokens] of Object.entries(detail.hours)) {
          const [dayPart, hourPart] = hourKey.split("T");
          if (dayPart !== day) continue;
          dailyHours[day][Number(hourPart)] += tokens;
        }
      }
    }

    const merged = zeroBucket();
    for (const bucket of days.values()) addBucket(merged, bucket);

    const hourly = new Array(24).fill(0);
    for (const row of Object.values(dailyHours)) {
      for (let hour = 0; hour < 24; hour += 1) hourly[hour] += row[hour] || 0;
    }

    const series = [...days.values()]
      .map(item => ({ ...item }))
      .sort((a, b) => a.day.localeCompare(b.day));

    // 每天花费：按「天 → 模型」桶各自单价折算，区间筛选后能重算
    for (const item of series) {
      item.cost = costOfModels(modelDays[item.day] || {}, priceTable).cny;
    }

    const modelTotals = {};
    for (const byModel of Object.values(modelDays)) {
      for (const [model, bucket] of Object.entries(byModel)) {
        if (!modelTotals[model]) modelTotals[model] = { model, ...zeroBucket() };
        addBucket(modelTotals[model], bucket);
      }
    }
    const modelCost = costOfModels(modelTotals, priceTable);
    const models = Object.values(modelTotals)
      .map(item => {
        const cell = modelCost.perModel[item.model] || {};
        return {
          ...item,
          share: merged.totalTokens ? item.totalTokens / merged.totalTokens : 0,
          cost: cell.unit ? cell.cny : null,
          unit: cell.unit || null,
          estimated: Boolean(cell.estimated),
          turns: 0,
          tps: null
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const projectTotals = {};
    for (const byProject of Object.values(projectDays)) {
      for (const [project, bucket] of Object.entries(byProject)) {
        if (!projectTotals[project]) projectTotals[project] = { project, ...zeroBucket(), sessions: 0 };
        addBucket(projectTotals[project], bucket);
      }
    }
    const projects = Object.values(projectTotals)
      .map(item => ({ ...item, share: merged.totalTokens ? item.totalTokens / merged.totalTokens : 0 }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const todayKey = dayKeyOf(new Date());
    const sessionList = [...sessionsById.values()]
      .filter(item => item.records > 0 && item.totalTokens > 0)
      .map(item => {
        const { models: modelSet, modelBuckets, ...rest } = item;
        return {
          ...rest,
          models: [...modelSet],
          cost: costOfModels(modelBuckets || {}, priceTable).cny,
          turns: 0,
          tps: null
        };
      })
      .sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));

    return {
      ok: true,
      source: "workbuddy",
      builtAt: this.builtAt,
      sessions: sessionList.length,
      scannedFiles: this.files.size,
      /** 数据来自哪几套安装（国际版 ~/.workbuddy-ai、国内版 ~/.workbuddy） */
      roots: this.rootsInfo,
      baseline: null,
      throughput: null,
      credits: { total: credits, today: sessionList.reduce((acc, item) => acc + (item.credit || 0), 0) },
      totals: { ...merged, sessions: sessionList.length, cost: modelCost.cny },
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
      pricing: describeTable(priceTable, models.map(item => item.model)),
      series,
      models,
      projects,
      modelDays,
      projectDays,
      hourly,
      dailyHours,
      sessionList,
      today: series.find(item => item.day === todayKey) || null
    };
  }

  /** 弹窗用的轻量摘要 */
  summary() {
    const snap = this.snapshot();
    return {
      ok: snap.ok,
      sessions: snap.sessions,
      days: snap.series.length,
      today: snap.today ? { day: snap.today.day, totalTokens: snap.today.totalTokens, records: snap.today.records, outputTokens: snap.today.outputTokens, cachedInputTokens: snap.today.cachedInputTokens, inputTokens: snap.today.inputTokens } : null,
      totals: { totalTokens: snap.totals.totalTokens, records: snap.totals.records, inputTokens: snap.totals.inputTokens, cachedInputTokens: snap.totals.cachedInputTokens, outputTokens: snap.totals.outputTokens, cost: snap.totals.cost },
      credits: snap.credits,
      roots: snap.roots,
      cost: snap.cost ? { cny: snap.cost.cny, usd: snap.cost.usd, todayCny: snap.cost.todayCny } : null
    };
  }
}

module.exports = { WorkBuddyStore, CACHE_VERSION };

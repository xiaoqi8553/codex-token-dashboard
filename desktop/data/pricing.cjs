"use strict";

/**
 * pricing.cjs — 模型标价与「花了多少钱」换算
 *
 * 口径：官方 API 刊例价（standard / 非批量、非区域处理），单位「每 100 万 tokens」。
 * 计费公式与各家官方一致：
 *
 *   cost = (新增输入 / 1e6 × 输入价)
 *        + (缓存命中 / 1e6 × 缓存价)
 *        + (输出 / 1e6   × 输出价)
 *
 * 其中「新增输入 = inputTokens - cachedInputTokens」。Codex 和 WorkBuddy 的
 * inputTokens 都**包含**缓存命中部分，直接按输入价乘会把缓存算贵几倍。
 *
 * reasoning（思考）token 在各家都计入 output_tokens，所以不再单列一档。
 *
 * 价格随厂商调整，所以整张表可以在 userData/data/pricing.json 里覆盖：
 * 文件里 entries 按 match 覆盖内置项、也可新增，不改代码即可更新价格。
 */

/** 美元换人民币：只影响「另一种货币」的展示，不影响人民币口径 */
const DEFAULT_USD_CNY = 7.2;

/** 单位：每 100 万 tokens。cached = 缓存命中的输入价 */
const DEFAULT_ENTRIES = [
  // ---------------- OpenAI（USD） ----------------
  {
    match: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    vendor: "OpenAI",
    currency: "USD",
    input: 2,
    cached: 0.1,
    output: 10
  },
  {
    match: "gpt-6-sol",
    label: "GPT-6 Sol",
    vendor: "OpenAI",
    currency: "USD",
    input: 2,
    cached: 0.2,
    output: 10
  },
  {
    match: "gpt-6.1-terra",
    label: "GPT-6.1 Terra",
    vendor: "OpenAI",
    currency: "USD",
    input: 1,
    cached: 0.05,
    output: 5
  },
  {
    match: "gpt-6-luna",
    label: "GPT-6 Luna",
    vendor: "OpenAI",
    currency: "USD",
    input: 0.1,
    cached: 0.01,
    output: 0.5
  },
  {
    match: "gpt-6-astra",
    label: "GPT-6 Astra",
    vendor: "OpenAI",
    currency: "USD",
    input: 10,
    cached: 1,
    output: 50
  },
  {
    match: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    vendor: "OpenAI",
    currency: "USD",
    input: 4,
    cached: 0.4,
    output: 20
  },
  {
    match: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    vendor: "OpenAI",
    currency: "USD",
    input: 0.2,
    cached: 0.02,
    output: 1.2
  },
  {
    match: "gpt-5.5",
    label: "GPT-5.5",
    vendor: "OpenAI",
    currency: "USD",
    input: 5,
    cached: 0.5,
    output: 30
  },
  {
    match: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    vendor: "OpenAI",
    currency: "USD",
    input: 0.75,
    cached: 0.075,
    output: 4.5
  },
  {
    match: "gpt-5.4",
    label: "GPT-5.4",
    vendor: "OpenAI",
    currency: "USD",
    input: 2.5,
    cached: 0.25,
    output: 15
  },
  {
    match: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    vendor: "OpenAI",
    currency: "USD",
    input: 2,
    cached: 0.2,
    output: 12
  },
  {
    match: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    vendor: "OpenAI",
    currency: "USD",
    input: 1.75,
    cached: 0.175,
    output: 14
  },

  // ---------------- DeepSeek（CNY，空闲时段价） ----------------
  {
    match: "deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    vendor: "DeepSeek",
    currency: "CNY",
    input: 1,
    cached: 0.02,
    output: 4,
    note: "按空闲时段价；工作日 9–12 / 14–18 点为高峰，价格翻倍"
  },
  {
    match: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    vendor: "DeepSeek",
    currency: "CNY",
    input: 4.5,
    cached: 0.15,
    output: 13.5,
    note: "按空闲时段价；高峰翻倍"
  },
  {
    match: "deepseek",
    label: "DeepSeek V4.1 Flash",
    vendor: "DeepSeek",
    currency: "CNY",
    input: 1,
    cached: 0.02,
    output: 4,
    note: "未知版本，按 V4.1 Flash 空闲价估算"
  },

  // ---------------- 智谱 GLM（CNY） ----------------
  {
    match: "glm-5.3-flashx",
    label: "GLM-5.3-FlashX",
    vendor: "智谱",
    currency: "CNY",
    input: 2,
    cached: 0.57,
    output: 7
  },
  {
    match: "glm-5.3-flash",
    label: "GLM-5.3-Flash",
    vendor: "智谱",
    currency: "CNY",
    input: 0.8,
    cached: 0.23,
    output: 2.8
  },
  {
    match: "glm-5.3",
    label: "GLM-5.3",
    vendor: "智谱",
    currency: "CNY",
    input: 8,
    cached: 2,
    output: 28
  },

  // ---------------- 腾讯混元（CNY） ----------------
  {
    match: "hy4-preview",
    label: "Hunyuan Hy4 preview",
    vendor: "腾讯混元",
    currency: "CNY",
    input: 6,
    cached: 0.3,
    output: 18
  },
  {
    match: "hy3",
    label: "Hunyuan Hy3",
    vendor: "腾讯混元",
    currency: "CNY",
    input: 1,
    cached: 0.25,
    output: 4
  },

  // ---------------- 月之暗面 Kimi（USD） ----------------
  {
    match: "kimi-k3",
    label: "Kimi K3",
    vendor: "月之暗面",
    currency: "USD",
    input: 3,
    cached: 0.3,
    output: 15
  },
  {
    match: "kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    vendor: "月之暗面",
    currency: "USD",
    input: 0.95,
    cached: 0.19,
    output: 4
  },
  {
    match: "kimi-k2.6",
    label: "Kimi K2.6",
    vendor: "月之暗面",
    currency: "USD",
    input: 0.95,
    cached: 0.16,
    output: 4
  },

  // ---------------- MiniMax（CNY） ----------------
  {
    match: "minimax-m3",
    label: "MiniMax M3",
    vendor: "MiniMax",
    currency: "CNY",
    input: 2.1,
    cached: 0.42,
    output: 8.4
  }
];

/** 表里没有的模型用这个兜底，界面上会标「估算」 */
const DEFAULT_FALLBACK = {
  label: "未知模型",
  vendor: "—",
  currency: "CNY",
  input: 4,
  cached: 0.4,
  output: 12,
  estimated: true
};

const DEFAULT_TABLE = {
  version: 1,
  updatedAt: "2026-10-28",
  usdCny: DEFAULT_USD_CNY,
  note: "官方 API 刊例价，单位：每 100 万 tokens；缓存价指命中缓存的输入",
  sources: [
    "https://openai.com/api/pricing",
    "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
    "https://docs.bigmodel.cn/cn/guide/start/pricing",
    "https://hy.tencent.com/research/hy4-preview",
    "https://platform.kimi.ai/docs/pricing/chat-k3"
  ],
  entries: DEFAULT_ENTRIES,
  fallback: DEFAULT_FALLBACK
};

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const match = String(raw.match || "").trim().toLowerCase();
  if (!match) return null;
  const currency = String(raw.currency || "CNY").toUpperCase() === "USD" ? "USD" : "CNY";
  return {
    match,
    label: String(raw.label || raw.match),
    vendor: String(raw.vendor || "—"),
    currency,
    input: Math.max(0, num(raw.input)),
    cached: Math.max(0, num(raw.cached, num(raw.input))),
    output: Math.max(0, num(raw.output)),
    note: raw.note ? String(raw.note) : "",
    estimated: Boolean(raw.estimated)
  };
}

/** 把内置表与用户覆盖合并，返回可直接用于计算的表 */
function normalizeTable(input) {
  const base = input && typeof input === "object" ? input : {};
  const overrides = Array.isArray(base.entries) ? base.entries.map(normalizeEntry).filter(Boolean) : [];
  const byMatch = new Map();
  for (const entry of DEFAULT_ENTRIES.map(normalizeEntry).filter(Boolean)) byMatch.set(entry.match, entry);
  for (const entry of overrides) byMatch.set(entry.match, entry);
  return {
    version: num(base.version, DEFAULT_TABLE.version),
    updatedAt: String(base.updatedAt || DEFAULT_TABLE.updatedAt),
    usdCny: num(base.usdCny, DEFAULT_USD_CNY) || DEFAULT_USD_CNY,
    note: String(base.note || DEFAULT_TABLE.note),
    sources: Array.isArray(base.sources) && base.sources.length ? base.sources.map(String) : DEFAULT_TABLE.sources,
    entries: [...byMatch.values()],
    fallback: normalizeEntry({ ...DEFAULT_FALLBACK, ...(base.fallback || {}), match: "__fallback__" })
  };
}

/** 模型名看起来像路径（历史索引里混进过 E:\论文\... 这类键），不做定价 */
function looksLikePath(name) {
  return /[\\/]/.test(name) || /^[a-z]:/i.test(name) || name.length > 64;
}

/** 按「最长匹配」找价格：glm-5.3-flashx 优先于 glm-5.3-flash，再优先于 glm-5.3 */
function priceEntry(model, table) {
  const key = String(model || "").trim().toLowerCase();
  if (!key || looksLikePath(key)) return null;
  let best = null;
  for (const entry of table.entries) {
    if (!key.includes(entry.match)) continue;
    if (!best || entry.match.length > best.match.length) best = entry;
  }
  return best;
}

/** 折成人民币单价（每 100 万 tokens） */
function unitPriceCny(entry, rate) {
  if (!entry) return null;
  if (entry.currency === "USD") {
    return { input: entry.input * rate, cached: entry.cached * rate, output: entry.output * rate };
  }
  return { input: entry.input, cached: entry.cached, output: entry.output };
}

/**
 * 单个桶的花费（人民币）
 * @param {{inputTokens:number,cachedInputTokens:number,outputTokens:number}} bucket
 * @param {{input:number,cached:number,output:number}} unit 每百万 tokens 的人民币单价
 */
function costOfBucket(bucket, unit) {
  if (!bucket || !unit) return 0;
  const input = Math.max(0, num(bucket.inputTokens));
  const cached = Math.min(input, Math.max(0, num(bucket.cachedInputTokens)));
  const output = Math.max(0, num(bucket.outputTokens));
  const fresh = input - cached;
  return (fresh * unit.input + cached * unit.cached + output * unit.output) / 1e6;
}

/**
 * 聚合「模型 → 桶」的花费
 * @returns {{cny:number, perModel:Record<string,{cny:number,unit:object,entry:object}>, unpricedTokens:number}}
 */
function costOfModels(models, table) {
  const out = { cny: 0, perModel: {}, estimatedTokens: 0 };
  for (const [model, bucket] of Object.entries(models || {})) {
    if (!bucket) continue;
    const entry = priceEntry(model, table);
    // 表里没有的型号按兜底价估算：token 是真实消耗的，直接丢成本只会让总额偏小
    const effective = entry || table.fallback;
    const unit = unitPriceCny(effective, table.usdCny);
    const cost = costOfBucket(bucket, unit);
    out.cny += cost;
    if (!entry) out.estimatedTokens += num(bucket.totalTokens);
    out.perModel[model] = { cny: cost, unit, entry: effective, estimated: !entry || Boolean(effective.estimated) };
  }
  return out;
}

/**
 * 给前端的精简价格表：模型名 → 人民币单价。
 * 前端要按「当前区间」重算花费，必须能自己按模型查价。
 */
function describeTable(table, modelNames) {
  const models = {};
  for (const name of modelNames || []) {
    const entry = priceEntry(name, table);
    // 路径型脏键（历史索引里混进来的文件名）不参与定价，界面显示「—」
    if (!entry && looksLikePath(String(name))) {
      models[name] = { label: String(name), vendor: "—", currency: "CNY", unit: null, estimated: false, note: "" };
      continue;
    }
    const effective = entry || table.fallback;
    models[name] = {
      label: effective.label === "未知模型" ? String(name) : effective.label,
      vendor: effective.vendor,
      currency: effective.currency,
      unit: unitPriceCny(effective, table.usdCny),
      estimated: Boolean(effective.estimated) || !entry,
      note: effective.note || ""
    };
  }
  return {
    rate: table.usdCny,
    updatedAt: table.updatedAt,
    note: table.note,
    sources: table.sources,
    models,
    fallback: {
      label: table.fallback.label,
      unit: unitPriceCny(table.fallback, table.usdCny),
      estimated: true
    },
    // 单价表本身也给一份，方便「价格表」浮层展示
    entries: table.entries.map(entry => ({
      match: entry.match,
      label: entry.label,
      vendor: entry.vendor,
      currency: entry.currency,
      input: entry.input,
      cached: entry.cached,
      output: entry.output,
      cny: unitPriceCny(entry, table.usdCny),
      note: entry.note || ""
    }))
  };
}

/** 读用户的价格覆盖文件，文件不存在就返回内置表 */
function loadTable(filePath) {
  if (!filePath) return normalizeTable({});
  try {
    const raw = require("node:fs").readFileSync(filePath, "utf8");
    return normalizeTable(JSON.parse(raw));
  } catch {
    return normalizeTable({});
  }
}

/** 把内置表写到磁盘，用户在文件里改单价即可生效（不覆盖已有文件） */
function ensureTableFile(filePath) {
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    if (fs.existsSync(filePath)) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = {
      ...DEFAULT_TABLE,
      entries: DEFAULT_ENTRIES,
      fallback: { ...DEFAULT_FALLBACK, match: "unknown" }
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_ENTRIES,
  DEFAULT_TABLE,
  DEFAULT_FALLBACK,
  DEFAULT_USD_CNY,
  normalizeTable,
  priceEntry,
  unitPriceCny,
  costOfBucket,
  costOfModels,
  describeTable,
  loadTable,
  ensureTableFile,
  looksLikePath
};

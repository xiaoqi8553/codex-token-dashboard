const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pricing = require("../desktop/data/pricing.cjs");

const table = pricing.normalizeTable({});
const bucket = (inputTokens, cachedInputTokens, outputTokens) => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  records: 1
});
const cost = (model, b, tab = table) => {
  const entry = pricing.priceEntry(model, tab);
  return pricing.costOfBucket(b, pricing.unitPriceCny(entry, tab.usdCny));
};

test("按「新增输入 + 缓存命中 + 输出」三段计价", () => {
  // GPT-6.1 Sol：$2 / $0.10 / $10，汇率 7.2 → ¥14.4 / ¥0.72 / ¥72
  assert.equal(cost("gpt-6.1-sol", bucket(1e6, 0, 0)).toFixed(2), (14.4).toFixed(2));

  // 100 万输入里 90 万命中缓存 + 100 万输出 = 0.1×14.4 + 0.9×0.72 + 72
  const mixed = cost("gpt-6.1-sol", bucket(1e6, 9e5, 1e6));
  assert.equal(mixed.toFixed(3), (1.44 + 0.648 + 72).toFixed(3));
});

test("缓存命中价必须低于输入价，且不会超过输入量", () => {
  const entry = pricing.priceEntry("gpt-6.1-sol", table);
  const unit = pricing.unitPriceCny(entry, table.usdCny);
  assert.ok(unit.cached < unit.input);
  // 缓存量写成比输入还大时按输入上限截断，不能出现负的「新增输入」
  const wrong = pricing.costOfBucket(bucket(1e6, 2e6, 0), unit);
  assert.equal(wrong.toFixed(4), (1e6 * unit.cached / 1e6).toFixed(4));
});

test("模型名按最长匹配，不会被同前缀的低价型号吃掉", () => {
  assert.equal(pricing.priceEntry("glm-5.3-flashx", table).label, "GLM-5.3-FlashX");
  assert.equal(pricing.priceEntry("glm-5.3-flash", table).label, "GLM-5.3-Flash");
  assert.equal(pricing.priceEntry("glm-5.3", table).label, "GLM-5.3");
  assert.equal(pricing.priceEntry("deepseek-v4.1-flash", table).label, "DeepSeek V4.1 Flash");
  // 只写到厂商名时退回该厂商的默认型号
  assert.equal(pricing.priceEntry("deepseek-v9", table).label, "DeepSeek V4.1 Flash");
  assert.equal(pricing.priceEntry("kimi-k3", table).label, "Kimi K3");
});

test("路径型脏键不参与定价，避免把文件名当模型算钱", () => {
  assert.equal(pricing.priceEntry("E:\\论文\\02_大论文\\XYC_4Axle.slx", table), null);
  assert.equal(pricing.priceEntry("XYC_LTIMPC_4axle.slx", table), null);
  assert.equal(pricing.looksLikePath("E:/论文/02_大论文"), true);
});

test("未知型号按兜底价估算，但会把用量单独标出来", () => {
  const result = pricing.costOfModels(
    {
      "gpt-6.1-sol": bucket(1e6, 0, 0),
      "some-new-model-9": bucket(1e6, 0, 0)
    },
    table
  );
  assert.ok(result.cny > 14.4, "兜底价也要计入总额，否则总花费偏小");
  assert.equal(result.estimatedTokens, 1e6);
  assert.equal(result.perModel["some-new-model-9"].estimated, true);
  assert.equal(result.perModel["gpt-6.1-sol"].estimated, false);
});

test("人民币与美元两种口径能互相折算", () => {
  const usd = table.entries.find(entry => entry.match === "gpt-6-luna");
  const cnyUnit = pricing.unitPriceCny(usd, table.usdCny);
  assert.equal(cnyUnit.input, usd.input * table.usdCny);
  const cny = table.entries.find(entry => entry.match === "hy4-preview");
  const sameUnit = pricing.unitPriceCny(cny, table.usdCny);
  assert.equal(sameUnit.input, 6, "人民币报价的模型不该再乘汇率");
});

test("用户可以在 pricing.json 里覆盖单价", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pricing.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      usdCny: 7,
      entries: [{ match: "gpt-6.1-sol", currency: "USD", input: 1, cached: 0.05, output: 5 }]
    }),
    "utf8"
  );
  const custom = pricing.loadTable(file);
  assert.equal(custom.usdCny, 7);
  const entry = pricing.priceEntry("gpt-6.1-sol", custom);
  assert.equal(entry.input, 1, "文件里的项覆盖内置项");
  assert.ok(pricing.priceEntry("gpt-6-luna", custom), "没被覆盖的型号仍然可用");
});

test("describeTable 给前端的单价表覆盖到每个出现的型号", () => {
  const names = ["gpt-6.1-sol", "hy4-preview", "unknown-model-x"];
  const described = pricing.describeTable(table, names);
  assert.equal(described.rate, table.usdCny);
  for (const name of names) {
    assert.ok(described.models[name].unit, `${name} 要有单价`);
  }
  assert.equal(described.models["gpt-6.1-sol"].unit.output, 72);
  assert.equal(described.models["hy4-preview"].unit.output, 18);
  assert.equal(described.models["unknown-model-x"].estimated, true);
});

test("ensureTableFile 生成一次就够，不覆盖用户改过的文件", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pricing.json");
  assert.equal(pricing.ensureTableFile(file), true);
  const first = fs.readFileSync(file, "utf8");
  assert.ok(JSON.parse(first).entries.length > 5);
  fs.writeFileSync(file, JSON.stringify({ usdCny: 6.5, entries: [] }), "utf8");
  assert.equal(pricing.ensureTableFile(file), false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).usdCny, 6.5);
});

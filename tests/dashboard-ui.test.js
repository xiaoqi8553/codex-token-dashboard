const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = indexSource.lastIndexOf(marker);
  assert.notEqual(start, -1, `Missing ${name}`);

  const bodyStart = indexSource.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = bodyStart; index < indexSource.length; index += 1) {
    const char = indexSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return indexSource.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated ${name}`);
}

test("chart date expansion preserves local date keys in UTC+8", () => {
  const context = {
    els: {
      fromDate: { value: "2026-06-08" },
      toDate: { value: "2026-06-09" }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction("localDateKey")}; ${extractFunction("expandChartDays")}; this.expandChartDays = expandChartDays;`, context);

  const result = context.expandChartDays([
    { date: "2026-06-08", totalTokens: 10 },
    { date: "2026-06-09", totalTokens: 20 }
  ]);

  assert.deepEqual(Array.from(result, day => day.date), ["2026-06-08", "2026-06-09"]);
  assert.equal(result[1].totalTokens, 20);
});

test("daily Token trend remains a stacked bar chart", () => {
  const trendSource = extractFunction("renderTrend");
  assert.match(trendSource, /<button class="day"/);
  assert.doesNotMatch(trendSource, /renderUsageCurveChart/);
});

test("usage trend has no persistent numeric overlays or summaries", () => {
  const curveSource = extractFunction("renderUsageCurveChart");
  const cacheSource = extractFunction("renderCacheTrend");

  assert.doesNotMatch(curveSource, /usage-value-label/);
  assert.doesNotMatch(curveSource, /usage-trend-topline/);
  assert.doesNotMatch(curveSource, /usage-trend-badges/);
  assert.doesNotMatch(indexSource, /cacheTrendSummary/);
  assert.doesNotMatch(cacheSource, /峰值 active|缓存 \$\{formatToken|命中率 \$\{avgHit\}% \/ active/);
});

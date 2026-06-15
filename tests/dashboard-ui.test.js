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

test("daily Token trend date labels fit within the chart card", () => {
  const trendSource = extractFunction("renderTrend");
  const trendCss = indexSource.match(/\.trend\s*\{[^}]+\}/)?.[0] || "";
  const dayLabelCss = indexSource.match(/\.day-label\s*\{[^}]+\}/)?.[0] || "";
  assert.match(trendCss, /minmax\(0,\s*1fr\)/);
  assert.match(trendCss, /gap:\s*var\(--bar-gap/);
  assert.doesNotMatch(trendCss, /minmax\(24px,\s*1fr\)/);
  assert.match(dayLabelCss, /display:\s*grid/);
  assert.match(trendSource, /--bar-gap/);
  assert.match(trendSource, /day-label-month/);
  assert.match(trendSource, /day-label-day/);
  assert.match(indexSource, /\.day:first-child\s+\.bar-value/);
  assert.match(indexSource, /\.day:last-child\s+\.bar-value/);
  assert.doesNotMatch(dayLabelCss, /writing-mode:\s*vertical-rl/);
  assert.doesNotMatch(dayLabelCss, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(dayLabelCss, /overflow:\s*hidden/);
});

test("daily Token trend supports one year range with a total summary", () => {
  const applyRangeSource = extractFunction("applyRange");
  const trendSource = extractFunction("renderTrend");
  const totalSource = extractFunction("renderTrendTotal");
  const monthlySource = extractFunction("bucketTrendDays");
  const summaryCss = indexSource.match(/\.trend-total-card\s*\{[^}]+\}/)?.[0] || "";

  assert.match(indexSource, /data-range="1y"[^>]*>1年/);
  assert.match(applyRangeSource, /range === "1y"/);
  assert.match(applyRangeSource, /todayString\(-364\)/);
  assert.match(monthlySource, /const bucketKey = date\.slice\(0, 7\)/);
  assert.match(trendSource, /bucketTrendDays\(expandedDays\)/);
  assert.match(indexSource, /id="trendTotal"/);
  assert.match(totalSource, /累计 Token/);
  assert.match(summaryCss, /min-width:\s*150px/);
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

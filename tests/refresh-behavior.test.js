const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const uiReviewSource = fs.readFileSync(path.join(root, "scripts", "ui-review.js"), "utf8");
const visualCheckSource = fs.readFileSync(path.join(root, "scripts", "visual-check.js"), "utf8");

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.lastIndexOf(marker);
  assert.notEqual(start, -1, `Missing ${name}`);

  const paramsEnd = source.indexOf(")", start);
  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
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
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated ${name}`);
}

test("server auto refresh keeps current data on transient failures", () => {
  const loadUsageSource = extractFunction(indexSource, "loadUsage");
  const apiFetchSource = extractFunction(indexSource, "apiFetch");
  const fetchWithTimeoutSource = extractFunction(indexSource, "fetchWithTimeout");

  assert.match(loadUsageSource, /options = \{\}/);
  assert.match(loadUsageSource, /state\.refreshFailures/);
  assert.match(loadUsageSource, /if \(state\.data && options\.auto\)/);
  assert.doesNotMatch(loadUsageSource, /catch \(error\) \{\s*await enterStaticMode/);
  assert.match(apiFetchSource, /retries/);
  assert.match(fetchWithTimeoutSource, /AbortController/);
});

test("refresh scheduler updates after background throttling", () => {
  assert.match(indexSource, /const serverAutoRefreshMs = 5000/);
  assert.match(indexSource, /visibilitychange/);
  assert.match(indexSource, /window\.addEventListener\("focus"/);
  assert.match(indexSource, /loadUsage\(\{ silent: true, auto: true, force: true \}\)/);
});

test("server reuses cached index for frequent usage requests", () => {
  assert.match(serverSource, /let indexCache = null/);
  assert.match(serverSource, /function getUsageIndex/);
  assert.match(serverSource, /INDEX_REFRESH_INTERVAL_MS/);
  assert.match(serverSource, /url\.searchParams\.get\("force"\) === "1"/);
  assert.match(serverSource, /setInterval\(\(\) => refreshIndexCache/);
  assert.doesNotMatch(serverSource, /function apiUsage\(url\) \{\s*const started = Date\.now\(\);\s*const index = buildIndex\(\);/);
});

test("visual review scripts discover bundled Playwright versions", () => {
  for (const source of [uiReviewSource, visualCheckSource]) {
    assert.match(source, /readdirSync\(base, \{ withFileTypes: true \}\)/);
    assert.match(source, /\^playwright\(\?:-core\)\?@/);
    assert.doesNotMatch(source, /playwright@1\.60\.0/);
  }
});

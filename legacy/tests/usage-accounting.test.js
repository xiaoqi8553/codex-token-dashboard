const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Accounting = require("../usage-accounting");
const { fixtures } = require("./fixtures/accounting");
const { parseSessionFile } = require("../server");

for (const fixture of fixtures) {
  test(`accounting: ${fixture.name}`, t => {
    const tracker = Accounting.createTracker();
    const selected = fixture.events.map(item => tracker.select(Accounting.extract(item), { sessionId: "fixture" })).filter(Boolean);
    assert.equal(selected.reduce((s, u) => s + u.totalTokens, 0), fixture.expected, "shared policy");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-accounting-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "rollout-test.jsonl");
    fs.writeFileSync(file, fixture.text);
    const { records } = parseSessionFile(file);
    assert.equal(records.reduce((s, r) => s + r.totalTokens, 0), fixture.expected, "Node parser");
    assert.equal(records.some(r => r.estimated), false, "real usage must not fall back to text estimation");
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"]) {
      assert.equal(records.reduce((s, r) => s + (r[key] || 0), 0), selected.reduce((s, r) => s + r[key], 0), key);
    }
  });
}

test("browser and Node invalidate old caches with the same accounting version", () => {
  assert.ok(Accounting.version > 18);
  assert.match(fs.readFileSync(path.join(__dirname, "../server.js"), "utf8"), /INDEX_VERSION = UsageAccounting.version/);
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /staticParserVersion = CodexUsageAccounting.version/);
  assert.match(html, /src="usage-accounting.js"/);
});

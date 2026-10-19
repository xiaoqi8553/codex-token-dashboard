const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Speed = require("../output-speed");
const { parseSessionFile } = require("../server");
const { speedFixture } = require("./fixtures/output-speed");

test("Node attaches completed-turn timing without changing usage or counting duration twice", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-speed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, speedFixture.text);
  const { records } = parseSessionFile(file);
  assert.equal(records.length, 3);
  assert.equal(records.reduce((s, row) => s + row.totalTokens, 0), 420);
  const result = Speed.summarize(records);
  assert.deepEqual(result.samples.map(row => row.tps), [10, 20]);
  assert.equal(result.weightedTps, 120000 / 11000);
  assert.equal(result.medianFirstTokenMs, 1000);
  assert.equal(result.latest.tps, 20);
  assert.equal(Speed.summarize(records.slice(0, 1)).latest.tps, 10, "a filtered record uses the complete turn's output");
});

test("Speed excludes missing, invalid, estimated and unfinished timing", () => {
  const record = { sessionId: "a", turnId: "t", outputTokens: 10, turnDurationMs: 1000, turnOutputTokens: 10, turnCompletedAt: "2026-10-19T08:00:00Z", timeToFirstTokenMs: 0 };
  for (const invalid of [{ turnDurationMs: 0 }, { turnDurationMs: -1 }, { turnDurationMs: Infinity }, { turnCompletedAt: "bad" }, { estimated: true }, { turnId: "" }, { turnOutputTokens: 0 }]) {
    assert.equal(Speed.summarize([{ ...record, ...invalid }]).samples.length, 0);
  }
  assert.equal(Speed.summarize([record]).medianFirstTokenMs, 0);
  assert.equal(Speed.summarize([{ ...record, timeToFirstTokenMs: 2000 }]).medianFirstTokenMs, null);
  assert.equal(Speed.summarize([]).weightedTps, null);
});

test("Identical turn ids in separate sessions remain separate speed samples", () => {
  const row = { turnId: "t", outputTokens: 10, turnDurationMs: 1000, turnOutputTokens: 10, turnCompletedAt: "2026-10-19T08:00:00Z" };
  const result = Speed.summarize([{ ...row, sessionId: "a" }, { ...row, sessionId: "b" }]);
  assert.equal(result.samples.length, 2);
  assert.equal(result.weightedTps, 10);
});

test("Completion timing cannot cross sessions or be inferred from adjacent timestamps", () => {
  const collector = Speed.createCollector();
  collector.observe({ type: "event_msg", timestamp: "2026-10-19T08:00:01Z", payload: { type: "task_complete", turn_id: "t", duration_ms: 1000 } }, { sessionId: "a" });
  collector.observe({ type: "event_msg", timestamp: "2026-10-19T08:00:02Z", payload: { type: "task_complete", turn_id: "u" } }, { sessionId: "a" });
  const rows = [{ sessionId: "a", turnId: "t", outputTokens: 10 }, { sessionId: "b", turnId: "t", outputTokens: 20 }, { sessionId: "a", turnId: "u", outputTokens: 30 }];
  collector.apply(rows);
  assert.equal(rows[0].turnDurationMs, 1000);
  assert.equal(rows[1].turnDurationMs, undefined);
  assert.equal(rows[2].turnDurationMs, undefined);
  assert.equal(Speed.summarize(rows).missingRecords, 2);
});

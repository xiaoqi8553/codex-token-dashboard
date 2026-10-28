"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildBaseline } = require("../desktop/data/history-baseline.cjs");

function writeIndex(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-baseline-"));
  const file = path.join(dir, "usage-index.json");
  // 旧版索引是缩进格式，锚点必须是顶层的 `\n  "records": [`
  fs.writeFileSync(file, JSON.stringify({ version: 21, records }, null, 2), "utf8");
  return { dir, file };
}

test("baseline keeps a 24-hour bucket per local day", () => {
  const local = new Date(2026, 9, 27, 15, 30, 0);
  const { dir, file } = writeIndex([
    {
      timestamp: local.toISOString(),
      date: "2026-10-27",
      sessionId: "s1",
      model: "gpt-5.5",
      projectName: "p",
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1000
    },
    {
      timestamp: new Date(2026, 9, 27, 15, 52, 0).toISOString(),
      date: "2026-10-27",
      sessionId: "s1",
      model: "gpt-5.5",
      projectName: "p",
      inputTokens: 400,
      outputTokens: 100,
      totalTokens: 500
    }
  ]);

  const baseline = buildBaseline(file);
  const day = baseline.days["2026-10-27"];
  assert.ok(day, "应按本地日期归集出 2026-10-27");
  assert.equal(day.hours.length, 24);
  assert.equal(day.hours[15], 1500, "两条记录都落在本地 15 点");
  assert.equal(day.totalTokens, 1500);
  assert.equal(baseline.hourTokens, 1500);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("baseline day key follows local time, not the UTC date field", () => {
  // 本地 2026-10-28 07:30 在 UTC 是 10-27，索引的 date 字段会写 10-27
  const local = new Date(2026, 9, 28, 7, 30, 0);
  const { dir, file } = writeIndex([
    {
      timestamp: local.toISOString(),
      date: "2026-10-27",
      sessionId: "s2",
      model: "gpt-5.5",
      projectName: "p",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150
    }
  ]);

  const baseline = buildBaseline(file);
  assert.ok(baseline.days["2026-10-28"], "跨零点的记录要落到本地日期");
  assert.equal(baseline.days["2026-10-28"].hours[7], 150);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("store merges baseline hourly buckets so the activity chart follows the range", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "desktop", "data", "codex-store.cjs"),
    "utf8"
  );
  assert.match(source, /dailyHours\[day\] = baseDay\.hours\.slice\(\)/);
});

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const fzstd = require("../vendor/fzstd/fzstd");
const Files = require("../session-files");
const fixtures = require("./fixtures/compressed-sessions.json");
const { parseSessionFile, listSessionFiles } = require("../server");
const metrics = records => records.map(row => Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens", "reasoningOutputTokens", "estimated", "model", "turnDurationMs", "turnOutputTokens"].map(key => [key, row[key]])));

for (const fixture of fixtures) {
  test(`compressed logs preserve plain-text accounting: ${fixture.name}`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-zstd-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const plain = path.join(dir, "rollout-test.jsonl"), zipped = `${plain}.zst`;
    const bytes = Buffer.from(fixture.compressedBase64, "base64");
    fs.writeFileSync(plain, fixture.text); fs.writeFileSync(zipped, bytes);
    const expected = metrics(parseSessionFile(plain).records);
    assert.deepEqual(metrics(parseSessionFile(zipped).records), expected);
    const native = zlib.zstdDecompressSync;
    try {
      zlib.zstdDecompressSync = undefined; // Node 18/20 fallback must also decode real compressed blocks.
      assert.deepEqual(metrics(parseSessionFile(zipped).records), expected);
    } finally { zlib.zstdDecompressSync = native; }
    const output = [];
    const stream = new fzstd.Decompress(chunk => output.push(Buffer.from(chunk)));
    for (const byte of bytes) stream.push(Uint8Array.of(byte));
    stream.push(new Uint8Array(0), true);
    assert.equal(Buffer.concat(output).toString("utf8"), fixture.text);
  });
}

test("Node includes sibling archives and ignores duplicate compressed/plain rollout copies", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-coverage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "sessions")); fs.mkdirSync(path.join(dir, "archived_sessions"));
  const plain = path.join(dir, "sessions/rollout-same.jsonl");
  fs.writeFileSync(plain, fixtures[0].text);
  fs.writeFileSync(`${plain}.zst`, Buffer.from(fixtures[0].compressedBase64, "base64"));
  fs.writeFileSync(path.join(dir, "archived_sessions/rollout-same.jsonl.zst"), Buffer.from(fixtures[0].compressedBase64, "base64"));
  fs.writeFileSync(path.join(dir, "archived_sessions/rollout-other.jsonl.zst"), Buffer.from(fixtures[1].compressedBase64, "base64"));
  const files = listSessionFiles(path.join(dir, "sessions"));
  assert.equal(files.length, 2);
  assert.ok(files.includes(plain));
  assert.deepEqual(Files.stats(files, file => file), { compressedFiles: 1, archivedFiles: 1 });
});

test("Corrupt compressed logs raise an error instead of becoming text estimates", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-corrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout-bad.jsonl.zst");
  fs.writeFileSync(file, Buffer.from("not a zstd file"));
  assert.throws(() => parseSessionFile(file), /压缩会话解压失败/);
});

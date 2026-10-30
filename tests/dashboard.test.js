"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

const packageJson = JSON.parse(read("package.json"));
const dashboard = read("desktop/dashboard.html");
const popover = read("desktop/popover.html");
const main = read("desktop/main.cjs");
const builder = read("desktop/builder.config.cjs");
const readme = read("README.md");

const { WorkBuddyStore } = require(path.join(root, "desktop", "data", "workbuddy-store.cjs"));

test("2.0 项目名与版本已经换到 TokenBar", () => {
  assert.equal(packageJson.name, "tokenbar");
  assert.equal(packageJson.version, "2.0.0");
  assert.match(builder, /productName: "TokenBar"/);
  assert.match(builder, /appId: "com\.xiaoqi\.tokenbar"/);
  assert.match(main, /const PRODUCT_NAME = "TokenBar"/);
  assert.match(dashboard, /<title>TokenBar/);
  assert.match(popover, /<title>TokenBar<\/title>/);
  assert.doesNotMatch(readme, /Codex Token 用量看板/);
});

test("2.0 桌面看板仍是双数据源 + 时段徽标", () => {
  assert.match(dashboard, /data-source="codex"/);
  assert.match(dashboard, /data-source="workbuddy"/);
  assert.match(dashboard, /id="hour-badge"/);
  assert.match(dashboard, /id="hour-tabs"/);
  assert.match(dashboard, /等价花费/);
});

test("2.0 旧网页看板已经归档到 legacy，主进程仍能拉起", () => {
  assert.ok(fs.existsSync(path.join(root, "legacy", "server.js")));
  assert.ok(fs.existsSync(path.join(root, "legacy", "index.html")));
  assert.equal(fs.existsSync(path.join(root, "server.js")), false);
  assert.match(main, /path\.join\(APP_ROOT, "legacy", "server\.js"\)/);
  assert.match(builder, /"legacy\/server\.js"/);
});

test("2.0 WorkBuddy 同时读国际版与国内版，并按会话去重", async () => {
  assert.match(main, /\.workbuddy-ai/);
  assert.match(readme, /~\/\.workbuddy-ai\/projects/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-roots-"));
  const intl = path.join(home, "intl");
  const cn = path.join(home, "cn");
  const write = (base, workspace, session, lines) => {
    const dir = path.join(base, "projects", workspace);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, session + ".jsonl");
    fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    return file;
  };
  const usage = (tokens, day) => ({
    type: "message",
    timestamp: new Date(2026, 9, 30, 10, 0, 0).getTime(),
    providerData: {
      traceId: "t-" + day,
      stepSeq: 1,
      model: "deepseek-v4.1-flash",
      usage: { inputTokens: tokens, outputTokens: 10, totalTokens: tokens + 10 }
    }
  });

  // 同一个会话 id 在两套安装里都存在：国内版 1 条、国际版续写到 3 条
  write(cn, "ws", "same-session", [usage(100, 1)]);
  write(intl, "ws", "same-session", [usage(100, 1), usage(200, 2), usage(300, 3)]);
  // 只存在于国际版的新会话
  write(intl, "ws2", "intl-only", [usage(400, 4)]);

  const store = new WorkBuddyStore({ roots: [intl, cn] });
  const files = store.listFiles();
  assert.equal(files.length, 2, "同名会话只留一份，另一个是国际版独有");
  assert.equal(files.filter(item => item.path.includes("intl")).length, 2);

  const snap = await store.build();
  assert.equal(snap.sessions, 2);
  assert.equal(snap.totals.records, 4, "续写后的 3 条 + 独有会话 1 条");
  assert.equal(snap.totals.totalTokens, 100 + 200 + 300 + 400 + 40);

  const intlInfo = snap.roots.find(item => item.root === intl);
  const cnInfo = snap.roots.find(item => item.root === cn);
  assert.equal(intlInfo.kept, 2);
  assert.equal(cnInfo.kept, 0, "国内版那份被更大的同名文件取代");

  fs.rmSync(home, { recursive: true, force: true });
});

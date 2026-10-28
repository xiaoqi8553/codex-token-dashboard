#!/usr/bin/env node
"use strict";

/**
 * 校验「累计」口径：磁盘日志 ∪ 历史索引 合并后，总量是否与旧版索引的原始总量一致。
 *
 * 合并规则是按天取大者，所以合并结果应当 ≥ 索引总量，且增量只来自索引构建之后
 * 新增的用量。如果结果明显小于索引总量，说明合并没有生效（例如 baseline 读失败），
 * 界面上就会退回「只看磁盘日志」的偏小数字。
 *
 * 用法：
 *   node scripts/verify-usage-merge.cjs
 *   node scripts/verify-usage-merge.cjs --index <usage-index.json> --sessions <sessions 目录>
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { CodexStore } = require(path.join(ROOT, "desktop", "data", "codex-store.cjs"));
const { buildBaseline } = require(path.join(ROOT, "desktop", "data", "history-baseline.cjs"));

function argOf(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function fmt(n) {
  const value = Number(n) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(3)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

async function main() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const defaultIndex = path.join(appData, "codex-token-dashboard", "data", "usage-index.json");
  const indexPath = argOf("--index", defaultIndex);
  const sessionsDir = argOf("--sessions", path.join(os.homedir(), ".codex", "sessions"));

  if (!fs.existsSync(indexPath)) {
    console.error(`找不到旧版索引：${indexPath}`);
    console.error("如果这台机器没跑过旧版网页看板，合并不会生效，累计就只能反映磁盘上剩下的日志。");
    process.exit(2);
  }
  if (!fs.existsSync(sessionsDir)) {
    console.error(`找不到 sessions 目录：${sessionsDir}`);
    process.exit(2);
  }

  const startedAt = Date.now();
  const baseline = buildBaseline(indexPath);
  const baselineDays = Object.keys(baseline.days).length;
  const baselineSessions = Object.keys(baseline.sessions).length;
  console.log(`历史索引  ${fmt(baseline.totalTokens)}  ${baseline.records} 条 / ${baselineDays} 天 / ${baselineSessions} 会话`);
  console.log(`          ${indexPath}`);
  console.log(`          构建耗时 ${Date.now() - startedAt}ms`);

  const store = new CodexStore({
    sessionsDir,
    cacheFile: path.join(os.tmpdir(), "codex-verify-usage-cache.json"),
    detailCacheFile: path.join(os.tmpdir(), "codex-verify-usage-detail.json"),
    baseline
  });

  await store.init({ full: false });
  const fast = store.snapshot();
  console.log(`快速扫描  ${fmt(fast.totals.totalTokens)}  ${fast.totals.records} 条（只扫最近若干文件，启动瞬间用）`);

  const full = await store.buildFull();
  console.log(`全量扫描  ${fmt(full.totals.totalTokens)}  ${full.totals.records} 条（弹窗的「累计」用这个）`);

  const detail = await store.buildDetail();
  console.log(`看板明细  ${fmt(detail.totals.totalTokens)}  ${detail.totals.records} 条 / ${detail.series.length} 天 / ${detail.sessions} 会话`);

  const delta = full.totals.totalTokens - baseline.totalTokens;
  const diff = Math.abs(full.totals.totalTokens - detail.totals.totalTokens);

  console.log("");
  console.log(`合并 - 索引 = ${fmt(delta)}（索引构建之后新增的用量，正常应为较小的正数）`);
  console.log(`弹窗 - 看板 = ${fmt(diff)}（两条路径必须一致）`);

  const problems = [];
  if (full.totals.totalTokens < baseline.totalTokens) {
    problems.push("合并后总量小于索引总量：baseline 未生效，界面会显示偏小的数字");
  }
  if (delta > baseline.totalTokens * 0.5) {
    problems.push("合并后比索引多出超过 50%：可能存在重复计入");
  }
  if (diff > 2e6) {
    problems.push("弹窗与看板口径不一致：full 扫描与明细扫描结果不同");
  }

  if (problems.length) {
    console.error("");
    for (const item of problems) console.error(`✗ ${item}`);
    process.exit(1);
  }
  console.log("");
  console.log("✓ 口径一致");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

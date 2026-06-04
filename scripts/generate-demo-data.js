const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "sample-data", "demo-usage-index.json");
const models = ["gpt-5-codex", "gpt-5-mini", "gpt-4.1", "claude-3.7-sonnet"];
const sources = ["official_plus", "relay", "unknown"];
const taskScenarios = [
  { type: "coding", project: "codex-token-dashboard-demo", title: "实现 token dashboard feature", path: "sample-sessions/coding/dashboard-feature.jsonl" },
  { type: "debug", project: "codex-token-dashboard-demo", title: "debug Netlify build error and API fallback", path: "sample-sessions/debug/netlify-error.log" },
  { type: "frontend", project: "codex-token-dashboard-demo", title: "优化前端 UI 布局和暗色模式", path: "sample-sessions/frontend/ui-layout.jsonl" },
  { type: "docs", project: "ai-writing-notes", title: "更新 README docs and changelog", path: "sample-sessions/docs/readme-update.txt" },
  { type: "deploy", project: "codex-token-dashboard-demo", title: "部署 GitHub Netlify production build", path: "sample-sessions/deploy/netlify-production.jsonl" },
  { type: "data", project: "vehicle-can-toolkit", title: "分析 CSV JSON token chart 数据", path: "sample-sessions/data/token-analysis.jsonl" },
  { type: "refactor", project: "usage-ledger-core", title: "refactor usage index parser structure", path: "sample-sessions/refactor/parser-cleanup.jsonl" },
  { type: "planning", project: "ai-product-roadmap", title: "制定 roadmap plan and architecture", path: "sample-sessions/planning/roadmap-plan.md" },
  { type: "other", project: "misc-lab", title: "临时会话和未识别上下文", path: "sample-sessions/misc/unknown-session.jsonl" }
];
const records = [];
const base = new Date("2026-05-01T09:00:00.000Z");

function id(parts) {
  return parts.join("-").replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
}

for (let day = 0; day < 30; day += 1) {
  const date = new Date(base);
  date.setUTCDate(base.getUTCDate() + day);
  const isoDate = date.toISOString().slice(0, 10);
  const dailyRecords = 5 + (day % 5);

  for (let index = 0; index < dailyRecords; index += 1) {
    const source = sources[(day + index) % sources.length];
    const model = models[(day * 2 + index) % models.length];
    const scenario = taskScenarios[(day + index * 2) % taskScenarios.length];
    const timestamp = new Date(date);
    timestamp.setUTCHours(8 + (index * 2) % 12, (day * 7 + index * 11) % 60, 0, 0);

    const estimated = (day + index) % 17 === 0;
    const inputTokens = 85000 + day * 9200 + index * 36000 + (source === "relay" ? 60000 : 0);
    const cacheRatio = source === "unknown" ? 0.18 + (index % 3) * 0.08 : 0.42 + ((day + index) % 5) * 0.09;
    const cachedInputTokens = estimated ? 0 : Math.round(inputTokens * Math.min(cacheRatio, 0.82));
    const outputTokens = estimated ? Math.round(inputTokens * 0.12) : 11000 + index * 6400 + (day % 6) * 2900;
    const totalTokens = inputTokens + outputTokens;
    const sessionId = `demo-${source}-${isoDate}-${String(index + 1).padStart(2, "0")}`;

    records.push({
      id: id(["demo", isoDate, source, index + 1]),
      timestamp: timestamp.toISOString(),
      date: isoDate,
      sessionId,
      model,
      source,
      provider: source === "official_plus" ? "openai" : source === "relay" ? "relay_import" : "unknown",
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
      effectiveTokens: Math.max(inputTokens - cachedInputTokens, 0) + outputTokens,
      reasoningOutputTokens: source === "official_plus" ? Math.round(outputTokens * 0.12) : 0,
      estimated,
      estimateReason: estimated ? "demo_missing_usage_fields_text_length" : "",
      requestId: "",
      filePath: "",
      relativePath: source === "relay" ? `sample-data/imports/demo-relay-${scenario.type}.csv` : `${scenario.path.replace("sample-sessions/", `sample-sessions/${isoDate}/`)}`,
      projectName: scenario.project,
      projectPath: `[demo]/projects/${scenario.project}`,
      projectSource: "cwd",
      lineNumber: index + 1,
      sessionTitle: `${scenario.title} (${source} / ${model})`,
      taskType: scenario.type,
      detailText: "",
      imported: source === "relay",
      importBatch: source === "relay" ? "demo-relay.csv" : ""
    });
  }
}

const payload = {
  version: 2,
  demo: true,
  sessionsDir: "[demo]/.codex/sessions",
  dataDir: "[demo]/data",
  updatedAt: "2026-05-30T08:00:00.000Z",
  stats: {
    sessionFiles: 30,
    importFiles: 1,
    reusedFiles: 0,
    parsedFiles: 30,
    records: records.length
  },
  files: {},
  imports: {},
  records
};

fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${records.length} demo records to ${output}`);

// Dev-only preload：给离屏渲染的弹窗喂真实快照或样例数据，
// 这样截图反映的是实际版式，而不是假数据堆出来的效果。
const { contextBridge } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SNAPSHOT_FILE = path.join(__dirname, "..", "docs", "popover-snapshot.json");

const FALLBACK = {
  ok: true,
  phase: "full-done",
  updatedAt: new Date().toISOString(),
  sessions: 33,
  totals: {
    totalTokens: 3748990253,
    inputTokens: 3737239690,
    cachedInputTokens: 3627112832,
    outputTokens: 11750563,
    records: 10208
  },
  today: {
    day: "today",
    totalTokens: 47316979,
    inputTokens: 46984251,
    cachedInputTokens: 45538304,
    outputTokens: 183152,
    reasoningOutputTokens: 74120,
    records: 237
  },
  series: Array.from({ length: 14 }, (_, index) => ({
    day: `d${index}`,
    totalTokens: [38, 112, 190, 40, 239, 238, 47, 90, 130, 60, 21, 175, 210, 47][index] * 1e6
  })),
  quota: {
    session: {
      usedPercent: 13,
      remainingPercent: 87,
      windowMinutes: 300,
      resetsAt: Math.floor(Date.now() / 1000) + 4 * 3600 + 44 * 60
    },
    weekly: {
      usedPercent: 2,
      remainingPercent: 98,
      windowMinutes: 10080,
      resetsAt: Math.floor(Date.now() / 1000) + 6 * 86400 + 14 * 3600
    },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    planType: "plus"
  },
  providers: []
};

function loadSnapshot() {
  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.ok) return parsed;
  } catch {
    /* 没有快照文件时用内置样例 */
  }
  return FALLBACK;
}

const STATUS = loadSnapshot();

contextBridge.exposeInMainWorld("codexBar", {
  onStatus(callback) {
    if (typeof callback === "function") callback(STATUS);
  },
  refresh: async () => STATUS,
  setHeight: () => {},
  openDashboard: () => {},
  openStatusPage: () => {},
  setLaunchAtLogin: async () => ({ launchAtLogin: true }),
  getPrefs: async () => ({ launchAtLogin: true }),
  quit: () => {},
  close: () => {}
});

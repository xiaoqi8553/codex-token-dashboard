// Dev-only preload: feeds the popover a fixed sample payload so the layout can
// be screenshotted without starting the whole desktop lifecycle.
const { contextBridge } = require("electron");

const SAMPLE = {
  ok: true,
  updatedAt: new Date().toISOString(),
  sessions: 128,
  totals: {
    totalTokens: 5695900467,
    inputTokens: 5669865924,
    cachedInputTokens: 5334718592,
    outputTokens: 24699257,
    records: 40954
  },
  today: { totalTokens: 43954659, outputTokens: 161793, records: 220 },
  providers: [
    { key: "official_plus", totalTokens: 5695881209, todayTokens: 43954659, records: 40953 },
    { key: "unknown", totalTokens: 19258, todayTokens: 0, records: 1 }
  ],
  quota: {
    limitId: "codex",
    limitName: "",
    session: {
      usedPercent: 12,
      remainingPercent: 88,
      windowMinutes: 300,
      resetsAt: new Date(Date.now() + (4 * 60 + 45) * 60000).toISOString(),
      resetsAtEpoch: 0
    },
    weekly: {
      usedPercent: 2,
      remainingPercent: 98,
      windowMinutes: 10080,
      resetsAt: new Date(Date.now() + (6 * 24 * 60 + 15 * 60) * 60000).toISOString(),
      resetsAtEpoch: 0
    },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    observedAt: new Date().toISOString()
  }
};

let statusCallback = null;

contextBridge.exposeInMainWorld("codexBar", {
  onStatus(callback) {
    statusCallback = callback;
    if (statusCallback) statusCallback(SAMPLE);
  },
  refresh: async () => SAMPLE,
  openDashboard: () => {},
  setLaunchAtLogin: async () => {},
  getPrefs: async () => ({ launchAtLogin: true }),
  quit: () => {},
  close: () => {}
});

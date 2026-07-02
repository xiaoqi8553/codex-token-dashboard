const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const childProcess = require("child_process");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const IMPORT_DIR = path.join(DATA_DIR, "imports");
const INDEX_PATH = path.join(DATA_DIR, "usage-index.json");
const INDEX_VERSION = 17;
const SUPPORTED_SESSION_EXTENSIONS = new Set([".jsonl", ".json", ".log", ".txt"]);

loadDotEnv();

const CONFIG = loadConfig();
const PORT = Number(CONFIG.port || 8787);
const HOST = CONFIG.host || "127.0.0.1";
const PUBLIC_ACCESS = Boolean(CONFIG.allowPublicAccess);
const ANONYMIZE_DATA = Boolean(CONFIG.anonymizeData);
const ACCESS_TOKEN = String(CONFIG.publicAccessToken || "").trim();
const DASHBOARD_PASSWORD = String(CONFIG.dashboardPassword || "").trim();
const SOURCE_ATTRIBUTION_MODE = normalizeSourceAttributionMode(CONFIG.sourceAttributionMode);
const SESSIONS_DIR = path.resolve(CONFIG.sessionsDir || path.join(os.homedir(), ".codex", "sessions"));
const INDEX_REFRESH_INTERVAL_MS = Number(envString("INDEX_REFRESH_INTERVAL_MS", "5000"));
let activePort = PORT;
let indexCache = null;
let indexCacheUpdatedAt = 0;
let indexRefreshPromise = null;

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function envString(name, fallback) {
  return process.env[name] === undefined || process.env[name] === "" ? fallback : process.env[name];
}

function loadConfig() {
  const fileConfig = readJsonIfExists(path.join(ROOT, "config.json"));
  const publicAccess = envBool("PUBLIC_ACCESS", Boolean(fileConfig.allowPublicAccess));
  return {
    sessionsDir: envString("CODEX_SESSIONS_DIR", envString("SESSIONS_DIR", fileConfig.sessionsDir || "")),
    port: Number(envString("CODEX_TOKEN_DASHBOARD_PORT", envString("PORT", fileConfig.port || 8787))),
    host: envString("HOST", fileConfig.host || (publicAccess ? "0.0.0.0" : "127.0.0.1")),
    autoOpenBrowser: envBool("DASHBOARD_AUTO_OPEN", Boolean(fileConfig.autoOpenBrowser)),
    defaultDateRange: envString("DEFAULT_DATE_RANGE", fileConfig.defaultDateRange || "7d"),
    allowPublicAccess: publicAccess,
    publicAccessToken: envString("ACCESS_TOKEN", envString("PUBLIC_ACCESS_TOKEN", fileConfig.publicAccessToken || "")),
    dashboardPassword: envString("DASHBOARD_PASSWORD", fileConfig.dashboardPassword || ""),
    anonymizeData: envBool("ANONYMIZE_DATA", publicAccess ? true : Boolean(fileConfig.anonymizeData)),
    sourceAttributionMode: envString("SOURCE_ATTRIBUTION_MODE", fileConfig.sourceAttributionMode || "custom-fast")
  };
}

function normalizeSourceAttributionMode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["evidence", "precise", "slow"].includes(text)) return "evidence";
  return "custom-fast";
}

function validateSecurityConfig() {
  const hostIsPublic = !["127.0.0.1", "localhost", "::1"].includes(String(HOST).toLowerCase());
  if (hostIsPublic && !PUBLIC_ACCESS) {
    throw new Error("Refusing to listen on a public host while PUBLIC_ACCESS=false. Set PUBLIC_ACCESS=true and configure DASHBOARD_PASSWORD or ACCESS_TOKEN.");
  }
  if (PUBLIC_ACCESS && !ACCESS_TOKEN && !DASHBOARD_PASSWORD) {
    throw new Error("PUBLIC_ACCESS=true requires DASHBOARD_PASSWORD or ACCESS_TOKEN. Refusing to start.");
  }
}

function maskMiddle(value, head = 8, tail = 4) {
  const text = value && typeof value === "object" ? `anon-${hashText(JSON.stringify(value)).slice(0, 12)}` : String(value || "");
  if (!text || text === "unknown") return text || "unknown";
  if (text === "[object Object]") return "anon-session";
  if (text.length <= head + tail) return `${text.slice(0, Math.max(2, head))}...`;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
}

function loadIndex() {
  try {
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    if (index.version !== INDEX_VERSION) return { version: INDEX_VERSION, files: {}, imports: {}, records: [] };
    return index;
  } catch {
    return { version: INDEX_VERSION, files: {}, imports: {}, records: [] };
  }
}

function writeIndex(index) {
  ensureDirs();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
}

function listFiles(dir, extensions) {
  const files = [];

  function walk(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
  }

  walk(dir);
  return files;
}

function statSignature(filePath) {
  const stat = fs.statSync(filePath);
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

function isSameSignature(a, b) {
  return a && b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function hashText(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function repairInvalidBackslashes(line) {
  const validEscapes = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
  let repaired = "";

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char !== "\\") {
      repaired += char;
      continue;
    }

    if (validEscapes.has(next)) {
      repaired += char + next;
      index += 1;
    } else {
      repaired += "\\\\";
    }
  }

  return repaired;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    try {
      return JSON.parse(repairInvalidBackslashes(line));
    } catch {
      return null;
    }
  }
}

function extractRawField(line, field) {
  const match = line.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`));
  return match ? match[1] : "";
}

function toIso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function toDate(value) {
  const iso = toIso(value);
  if (!iso) return "";
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const cleaned = String(value).replace(/,/g, "").trim();
  const number = Number(cleaned);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function estimateTokens(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return 0;
  const cjk = (compact.match(/[\u3400-\u9fff]/g) || []).length;
  const nonCjk = Math.max(compact.length - cjk, 0);
  return Math.max(1, Math.ceil(cjk * 0.8 + nonCjk / 4));
}

function normalizeSource(provider, explicitSource = "") {
  const values = [explicitSource, provider]
    .map(value => scalarText(value).trim().toLowerCase())
    .filter(value => value && value !== "unknown");
  if (values.some(value => isRightCodeBillableEndpoint(value))) return "relay";
  if (values.some(value => isOfficialEndpoint(value))) return "official_plus";
  if (values.some(value => (
    ["relay", "relay_import", "rightcode", "right_code", "right-code", "proxy", "中转站"].includes(value) ||
    value.includes("rightcode") ||
    value.includes("right-code") ||
    value.includes("relay")
  ))) return "relay";
  if (SOURCE_ATTRIBUTION_MODE === "custom-fast" && values.some(value => value === "custom")) return "relay";
  // Codex++ can wrap official Plus sessions as model_provider=custom and source=vscode.
  // Bare "custom" is therefore treated as official Plus unless there is an explicit relay hint.
  if (values.some(value => value === "custom")) return "official_plus";
  if (values.some(value => ["official_plus", "official", "plus", "openai", "chatgpt"].includes(value))) return "official_plus";
  return "unknown";
}

function parseEndpointUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return new URL(text);
  } catch {
    const match = text.match(/https?:\/\/[^\s:{"']+/i);
    if (!match) return null;
    try {
      return new URL(match[0]);
    } catch {
      return null;
    }
  }
}

function isRightCodeBillableEndpoint(value) {
  const url = parseEndpointUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  return host === "www.right.codes" && (pathname.startsWith("/codex-pro/v1") || pathname.startsWith("/v1"));
}

function isOfficialEndpoint(value) {
  const url = parseEndpointUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  return host === "chatgpt.com" ||
    host.endsWith(".chatgpt.com") ||
    host === "openai.com" ||
    host.endsWith(".openai.com") ||
    (host === "right.codes" && pathname.startsWith("/codex/v1"));
}

function scalarText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return scalarText(value.find(item => scalarText(item)));
  if (typeof value === "object") {
    for (const key of ["id", "session_id", "turn_id", "model", "slug", "name", "value"]) {
      const text = scalarText(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function firstScalar(...values) {
  for (const value of values) {
    const text = scalarText(value).trim();
    if (text) return text;
  }
  return "";
}

let endpointEvidenceCache;

function hasRightCodeConfig() {
  const accountRoot = path.join(os.homedir(), ".codex", "XQ_acc");
  let entries = [];
  try {
    entries = fs.readdirSync(accountRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(entry => {
    if (!entry.isDirectory()) return false;
    const configPath = path.join(accountRoot, entry.name, "config.toml");
    const authPath = path.join(accountRoot, entry.name, "auth.json");
    const configText = readTextFile(configPath).toLowerCase();
    if (!configText.includes("right.codes") && !configText.includes("right code")) return false;
    const authText = readTextFile(authPath).toLowerCase();
    return authText.includes("openai_api_key") || authText.includes("\"key\"");
  });
}

function loadEndpointEvidence() {
  if (endpointEvidenceCache) return endpointEvidenceCache;
  endpointEvidenceCache = {
    byTurnId: {},
    bySessionId: {},
    events: [],
    eventsByProject: {},
    switchIntervals: [],
    stats: {
      rightCodeConfig: hasRightCodeConfig(),
      turnRules: 0,
      relayTurns: 0,
      officialTurns: 0,
      sessionRules: 0,
      relaySessions: 0,
      officialSessions: 0,
      timeRules: 0,
      globalTimeRules: 0,
      relayEvents: 0,
      officialEvents: 0,
      switchIntervals: 0,
      relaySwitchIntervals: 0,
      officialSwitchIntervals: 0,
      switchRules: 0,
      sourceAttributionMode: SOURCE_ATTRIBUTION_MODE
    }
  };
  if (SOURCE_ATTRIBUTION_MODE === "custom-fast") return endpointEvidenceCache;

  const dbPath = path.join(os.homedir(), ".codex", "logs_2.sqlite");
  if (!fs.existsSync(dbPath)) return endpointEvidenceCache;

  const script = `
import sqlite3, json, re
from urllib.parse import urlparse
db = r'''${dbPath.replace(/\\/g, "\\\\")}'''
con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
cur = con.cursor()
rows = cur.execute("""
select ts, feedback_log_body
from logs
where feedback_log_body like '%turn.id=%'
   or feedback_log_body like '%turn_id=%'
   or feedback_log_body like '%submission.id=%'
   or (feedback_log_body like '%conversation.id=%' and feedback_log_body like '%provider_name=%')
   or feedback_log_body like '%POST to %'
""").fetchall()
rules = {}
session_rules = {}
events = []
for (ts, body) in rows:
    text = body or ""
    lower = text.lower()
    turn_ids = set(re.findall(r'turn\\.id=([0-9a-f-]{36})', text))
    turn_ids.update(re.findall(r'turn_id=([0-9a-f-]{36})', text))
    turn_ids.update(re.findall(r'submission\\.id="([0-9a-f-]{36})"', text))
    session_ids = set(re.findall(r'conversation\\.id=([0-9a-f-]{36})', text))
    cwd = ""
    cwd_match = re.search(r'cwd=(.*?)}:try_run_sampling_request', text)
    if cwd_match:
        cwd = cwd_match.group(1).strip()
    elif " cwd=" in text:
        cwd_match = re.search(r'\\bcwd=([^}]+)', text)
        if cwd_match:
            cwd = cwd_match.group(1).strip()
    if session_ids:
        provider_relay = "provider_name=rightcode" in lower
        provider_official = "provider_name=openai" in lower or "provider_name=chatgpt" in lower
        if provider_relay or provider_official:
            for session_id in session_ids:
                entry = session_rules.setdefault(session_id, {"relayHits": 0, "officialHits": 0})
                if provider_relay:
                    entry["relayHits"] += 1
                if provider_official:
                    entry["officialHits"] += 1
    if not turn_ids:
        continue
    endpoints = []
    for match in re.findall(r'''POST to\\s+(https?://[^\\s:{"']+)''', text):
        try:
            parsed = urlparse(match)
            endpoints.append((parsed.netloc.lower(), parsed.path.lower()))
        except Exception:
            pass
    is_relay = any(host == "www.right.codes" and (path.startswith("/codex-pro/v1") or path.startswith("/v1")) for host, path in endpoints)
    is_official = any(
        host == "chatgpt.com" or
        host.endswith(".chatgpt.com") or
        host == "openai.com" or
        host.endswith(".openai.com") or
        (host == "right.codes" and path.startswith("/codex/v1"))
        for host, path in endpoints
    )
    if not is_relay and not is_official:
        continue
    if cwd:
        events.append({
            "ts": int(ts or 0),
            "source": "relay" if is_relay else "official_plus",
            "cwd": cwd
        })
    for turn_id in turn_ids:
        entry = rules.setdefault(turn_id, {"relayHits": 0, "officialHits": 0})
        if is_relay:
            entry["relayHits"] += 1
        if is_official:
            entry["officialHits"] += 1
print(json.dumps({"turnRules": rules, "sessionRules": session_rules, "events": events}))
con.close()
`;

  try {
    const result = childProcess.spawnSync("python", ["-c", script], { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0 || !result.stdout) return endpointEvidenceCache;
    const parsed = JSON.parse(result.stdout);
    const rules = parsed.turnRules || parsed;
    const sessionRules = parsed.sessionRules || {};
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    for (const [turnId, counts] of Object.entries(rules)) {
      const relayHits = Number(counts.relayHits || 0);
      const officialHits = Number(counts.officialHits || 0);
      if (relayHits > 0) {
        endpointEvidenceCache.byTurnId[turnId] = { source: "relay", rule: "auto:rightcode-turn-endpoint", relayHits, officialHits };
        endpointEvidenceCache.stats.relayTurns += 1;
      } else if (officialHits > 0) {
        endpointEvidenceCache.byTurnId[turnId] = { source: "official_plus", rule: "auto:official-turn-endpoint", relayHits, officialHits };
        endpointEvidenceCache.stats.officialTurns += 1;
      }
    }
    endpointEvidenceCache.stats.turnRules = Object.keys(endpointEvidenceCache.byTurnId).length;
    for (const [sessionId, counts] of Object.entries(sessionRules)) {
      const relayHits = Number(counts.relayHits || 0);
      const officialHits = Number(counts.officialHits || 0);
      if (relayHits > 0) {
        endpointEvidenceCache.bySessionId[sessionId] = { source: "relay", rule: "auto:rightcode-session-provider", relayHits, officialHits };
        endpointEvidenceCache.stats.relaySessions += 1;
      } else if (officialHits > 0) {
        endpointEvidenceCache.bySessionId[sessionId] = { source: "official_plus", rule: "auto:official-session-provider", relayHits, officialHits };
        endpointEvidenceCache.stats.officialSessions += 1;
      }
    }
    endpointEvidenceCache.stats.sessionRules = Object.keys(endpointEvidenceCache.bySessionId).length;
    for (const event of events) {
      const projectKey = normalizePathText(event.cwd || "").toLowerCase();
      const ts = Number(event.ts || 0);
      if (!projectKey || !ts || !["relay", "official_plus"].includes(event.source)) continue;
      endpointEvidenceCache.events.push({
        ts,
        source: event.source,
        rule: event.source === "relay" ? "auto:rightcode-time-endpoint" : "auto:official-time-endpoint"
      });
      if (!endpointEvidenceCache.eventsByProject[projectKey]) endpointEvidenceCache.eventsByProject[projectKey] = [];
      endpointEvidenceCache.eventsByProject[projectKey].push({
        ts,
        source: event.source,
        rule: event.source === "relay" ? "auto:rightcode-time-endpoint" : "auto:official-time-endpoint"
      });
      if (event.source === "relay") endpointEvidenceCache.stats.relayEvents += 1;
      if (event.source === "official_plus") endpointEvidenceCache.stats.officialEvents += 1;
    }
    for (const eventsForProject of Object.values(endpointEvidenceCache.eventsByProject)) {
      eventsForProject.sort((a, b) => a.ts - b.ts);
    }
    endpointEvidenceCache.events.sort((a, b) => a.ts - b.ts);
    addCodexPlusSwitchEvidence(endpointEvidenceCache);
  } catch {
    return endpointEvidenceCache;
  }

  return endpointEvidenceCache;
}

function addCodexPlusSwitchEvidence(evidence) {
  const logPath = path.join(os.homedir(), ".codex-session-delete", "codex-plus.log");
  if (!fs.existsSync(logPath)) return;
  const lines = readTextFile(logPath).split(/\r?\n/).filter(Boolean);
  const changes = [];
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const event = String(row.event || "");
    const detail = row.detail || {};
    const ts = Math.floor(Number(row.timestamp_ms || 0) / 1000);
    if (!ts || !event.endsWith(".ok")) continue;
    const relayName = String(detail.relayName || detail.targetRelayName || "").toLowerCase();
    const relayId = String(detail.relayId || detail.activeRelayId || detail.targetRelayId || "").toLowerCase();
    const relayMode = String(detail.relayMode || detail.targetRelayMode || "").toLowerCase();
    const configured = detail.configured === undefined ? true : Boolean(detail.configured);
    if (!configured) continue;

    const isRightCode = relayName.includes("right code") || relayId.includes("rightcode");
    const isOfficial = relayMode === "official" ||
      relayName.includes("openai official") ||
      relayName.includes("默认中转") ||
      relayId === "default" ||
      relayId.includes("codex-official");

    if (isRightCode) {
      changes.push({ ts, source: "relay" });
    } else if (isOfficial) {
      changes.push({ ts, source: "official_plus" });
    }
  }
  changes.sort((a, b) => a.ts - b.ts);
  let current = null;
  for (const change of changes) {
    if (current && current.source !== change.source && current.ts < change.ts) {
      evidence.switchIntervals.push({
        start: current.ts,
        end: change.ts,
        source: current.source,
        rule: current.source === "relay" ? "auto:rightcode-codex-plus-switch" : "auto:official-codex-plus-switch"
      });
    }
    current = change;
  }
  if (current) {
    evidence.switchIntervals.push({
      start: current.ts,
      end: Infinity,
      source: current.source,
      rule: current.source === "relay" ? "auto:rightcode-codex-plus-switch" : "auto:official-codex-plus-switch"
    });
  }
  evidence.stats.switchIntervals = evidence.switchIntervals.length;
  evidence.stats.relaySwitchIntervals = evidence.switchIntervals.filter(item => item.source === "relay").length;
  evidence.stats.officialSwitchIntervals = evidence.switchIntervals.filter(item => item.source === "official_plus").length;
}

function findNearestEvent(events, timestamp, maxDeltaSeconds = 300) {
  if (!events?.length) return null;
  const recordTs = Math.floor(Date.parse(timestamp) / 1000);
  if (!Number.isFinite(recordTs)) return null;

  let best = null;
  for (const event of events) {
    const delta = Math.abs(event.ts - recordTs);
    if (delta > maxDeltaSeconds && event.ts > recordTs) break;
    if (delta <= maxDeltaSeconds && (!best || delta < best.delta)) {
      best = { ...event, delta };
    }
  }
  return best;
}

function findNearestEndpointEvidence(record) {
  if (!record.timestamp) return null;
  const evidence = loadEndpointEvidence();
  const projectKey = normalizePathText(record.projectPath || "").toLowerCase();
  const projectMatch = projectKey ? findNearestEvent(evidence.eventsByProject[projectKey], record.timestamp) : null;
  if (projectMatch) {
    return {
      source: projectMatch.source,
      rule: projectMatch.rule,
      deltaSeconds: projectMatch.delta,
      scope: "project"
    };
  }
  return null;
}

function findSwitchEvidence(record) {
  if (!record.timestamp) return null;
  const recordTs = Math.floor(Date.parse(record.timestamp) / 1000);
  if (!Number.isFinite(recordTs)) return null;
  const intervals = loadEndpointEvidence().switchIntervals || [];
  return intervals.find(interval => recordTs >= interval.start && recordTs < interval.end) || null;
}

function applyAutomaticSourceEvidence(record) {
  if (SOURCE_ATTRIBUTION_MODE === "custom-fast") {
    if (record.provider === "custom") return { ...record, source: "relay", sourceRule: "fallback:custom-fast-provider" };
    if (record.source === "relay") return { ...record, sourceRule: record.sourceRule || "explicit:relay" };
    return record;
  }
  if (record.source === "relay") return { ...record, sourceRule: record.sourceRule || "explicit:relay" };
  const evidence = record.turnId ? loadEndpointEvidence().byTurnId[record.turnId] : null;
  if (evidence) {
    return { ...record, source: evidence.source, sourceRule: evidence.rule };
  }
  const timeEvidence = findNearestEndpointEvidence(record);
  if (timeEvidence) {
    if (timeEvidence.scope === "global") {
      loadEndpointEvidence().stats.globalTimeRules += 1;
    } else {
      loadEndpointEvidence().stats.timeRules += 1;
    }
    return {
      ...record,
      source: timeEvidence.source,
      sourceRule: timeEvidence.rule,
      sourceEvidenceDeltaSeconds: timeEvidence.deltaSeconds
    };
  }
  const switchEvidence = findSwitchEvidence(record);
  if (switchEvidence) {
    loadEndpointEvidence().stats.switchRules += 1;
    return { ...record, source: switchEvidence.source, sourceRule: switchEvidence.rule };
  }
  const sessionEvidence = record.sessionId ? loadEndpointEvidence().bySessionId[record.sessionId] : null;
  if (sessionEvidence) {
    return { ...record, source: sessionEvidence.source, sourceRule: sessionEvidence.rule };
  }
  if (record.provider === "custom" && record.source === "unknown") {
    return { ...record, source: "official_plus", sourceRule: "fallback:custom-without-relay-evidence" };
  }
  if (record.provider === "custom" && record.source === "official_plus") {
    return { ...record, sourceRule: record.sourceRule || "fallback:custom-without-relay-evidence" };
  }
  return record;
}

function normalizeModel(value) {
  return String(value || "unknown").trim() || "unknown";
}

function normalizePathText(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

function basenameFromPath(value) {
  const text = normalizePathText(value);
  if (!text) return "";
  return text.split("/").filter(Boolean).pop() || "";
}

function inferProject(raw = {}) {
  const projectPath = normalizePathText(raw.projectPath || raw.project_path || raw.cwd || raw.workspace || raw.workspacePath || raw.workspace_path);
  const explicitName = String(raw.projectName || raw.project_name || raw.project || "").trim();
  if (explicitName || projectPath) {
    return {
      projectName: explicitName || basenameFromPath(projectPath) || "未命名项目",
      projectPath,
      projectSource: projectPath ? "cwd" : "provided"
    };
  }
  const imported = String(raw.importBatch || "").trim();
  if (imported) {
    return { projectName: basenameFromPath(imported) || imported, projectPath: "", projectSource: "imported" };
  }
  return { projectName: "未识别项目", projectPath: "", projectSource: "unknown" };
}

function getPayloadObject(item) {
  if (!item || typeof item !== "object") return {};
  return item.payload && typeof item.payload === "object" ? item.payload : item;
}

function usageFromObject(item) {
  const payload = getPayloadObject(item);
  const info = payload.info || payload;
  const total = info.total_token_usage || info.usage || info.token_usage || info;
  const last = info.last_token_usage || payload.last_token_usage || null;
  const input = toNumber(total.input_tokens || total.prompt_tokens || total.input);
  const cached = toNumber(total.cached_input_tokens || total.cached_tokens || total.cache_read_input_tokens);
  const output = toNumber(total.output_tokens || total.completion_tokens || total.output);
  const totalTokens = toNumber(total.total_tokens || total.tokens || input + output);
  const reasoning = toNumber(total.reasoning_output_tokens || total.reasoning_tokens);

  if (!input && !cached && !output && !totalTokens && !reasoning) return null;

  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens,
    reasoningOutputTokens: reasoning,
    lastUsage: last ? {
      inputTokens: toNumber(last.input_tokens || last.prompt_tokens || last.input),
      cachedInputTokens: toNumber(last.cached_input_tokens || last.cached_tokens || last.cache_read_input_tokens),
      outputTokens: toNumber(last.output_tokens || last.completion_tokens || last.output),
      totalTokens: toNumber(last.total_tokens || last.tokens),
      reasoningOutputTokens: toNumber(last.reasoning_output_tokens || last.reasoning_tokens)
    } : null
  };
}

function textFromMessagePayload(payload) {
  const content = payload?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(entry => {
      if (typeof entry === "string") return entry;
      return entry?.text || entry?.input_text || "";
    })
    .filter(Boolean)
    .join(" ");
}

function isLowValueTitle(value) {
  const text = String(value || "").trim().toLowerCase();
  return !text ||
    text.startsWith("<environment_context>") ||
    text.includes("# agents.md instructions") ||
    text.includes("current_date") ||
    text.includes("<cwd>") ||
    text.length < 8;
}

function cleanSessionTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const requestMarker = text.match(/(?:my request for codex:|我的请求[:：]|请你|现在我|我现在|还有几个问题|版本即将)/i);
  const trimmed = requestMarker ? text.slice(requestMarker.index).trim() : text;
  return trimmed
    .replace(/^my request for codex:\s*/i, "")
    .replace(/^我的请求[:：]\s*/i, "")
    .slice(0, 180);
}

function considerSessionTitle(meta, candidate) {
  const title = cleanSessionTitle(candidate);
  if (!title || isLowValueTitle(title)) return;
  if (isLowValueTitle(meta.title) || title.length > String(meta.title || "").length) meta.title = title;
}

function applySessionMetaLine(line, meta) {
  if (!line.includes("session_meta")) return;
  const provider = extractRawField(line, "model_provider");
  const source = extractRawField(line, "source");
  const threadSource = extractRawField(line, "thread_source");
  const id = extractRawField(line, "id");
  const model = extractRawField(line, "model");
  const timestamps = [...line.matchAll(/"timestamp"\s*:\s*"([^"]*)"/g)].map(match => match[1]);

  if (provider) meta.provider = provider;
  if (source || threadSource) meta.source = source || threadSource;
  if (id) meta.sessionId = id;
  if (model) meta.model = model;
  if (timestamps[1] || timestamps[0]) meta.timestamp = timestamps[1] || timestamps[0];
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function recordId(parts) {
  return hashText(parts.filter(Boolean).join("|"));
}

function createRecord(raw) {
  const inputTokens = toNumber(raw.inputTokens);
  const cachedInputTokens = toNumber(raw.cachedInputTokens);
  const outputTokens = toNumber(raw.outputTokens);
  const totalTokens = toNumber(raw.totalTokens || inputTokens + outputTokens);
  const effectiveTokens = Math.max(inputTokens - cachedInputTokens, 0) + outputTokens;
  const timestamp = toIso(raw.timestamp) || new Date(0).toISOString();
  const source = normalizeSource(raw.provider, raw.source);
  const project = inferProject(raw);

  const record = {
    id: raw.id,
    timestamp,
    date: toDate(timestamp),
    sessionId: firstScalar(raw.sessionId, "unknown"),
    model: normalizeModel(firstScalar(raw.model)),
    source,
    provider: firstScalar(raw.provider, source, "unknown"),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    effectiveTokens,
    reasoningOutputTokens: toNumber(raw.reasoningOutputTokens),
    estimated: Boolean(raw.estimated),
    estimateReason: raw.estimateReason || "",
    requestId: firstScalar(raw.requestId),
    turnId: firstScalar(raw.turnId),
    filePath: raw.filePath || "",
    relativePath: raw.relativePath || "",
    projectName: project.projectName,
    projectPath: project.projectPath,
    projectSource: project.projectSource,
    lineNumber: raw.lineNumber || 0,
    sessionTitle: firstScalar(raw.sessionTitle, raw.sessionId, "unknown"),
    detailText: raw.detailText || "",
    imported: Boolean(raw.imported),
    importBatch: raw.importBatch || "",
    sourceRule: firstScalar(raw.sourceRule)
  };
  return applyAutomaticSourceEvidence(record);
}

function parseSessionFile(filePath) {
  const text = readTextFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const relativePath = path.relative(SESSIONS_DIR, filePath);
  const meta = {
    sessionId: "",
    provider: "",
    source: "",
    model: "",
    timestamp: "",
    title: "",
    cwd: "",
    turnId: ""
  };
  const records = [];
  const seen = new Set();
  let parseErrors = 0;
  let previousTotal = null;

  function addUsage(usage, item, lineNumber, fallbackText = "") {
    const payload = getPayloadObject(item);
    const timestamp = item?.timestamp || payload.timestamp || meta.timestamp || "";
    const sessionId = firstScalar(payload.session_id, payload.sessionId, payload.id, meta.sessionId, path.basename(filePath));
    const model = firstScalar(payload.model, payload.model_name, meta.model);
    const provider = firstScalar(payload.model_provider, payload.provider, meta.provider);
    const source = firstScalar(payload.source, payload.thread_source, meta.source);
    const requestId = firstScalar(payload.request_id, payload.requestId, payload.id);
    const turnId = firstScalar(payload.turn_id, payload.turnId, meta.turnId);
    let tokenSet = usage;

    // Codex token_count records contain cumulative totals plus last_token_usage.
    // Prefer last_token_usage for request-level records; otherwise calculate a delta from the previous cumulative total.
    if (usage.lastUsage && (usage.lastUsage.totalTokens || usage.lastUsage.inputTokens || usage.lastUsage.outputTokens)) {
      tokenSet = usage.lastUsage;
    } else if (previousTotal && usage.totalTokens >= previousTotal.totalTokens) {
      tokenSet = {
        inputTokens: Math.max(usage.inputTokens - previousTotal.inputTokens, 0),
        cachedInputTokens: Math.max(usage.cachedInputTokens - previousTotal.cachedInputTokens, 0),
        outputTokens: Math.max(usage.outputTokens - previousTotal.outputTokens, 0),
        reasoningOutputTokens: Math.max(usage.reasoningOutputTokens - previousTotal.reasoningOutputTokens, 0),
        totalTokens: Math.max(usage.totalTokens - previousTotal.totalTokens, 0)
      };
    }
    previousTotal = usage;

    const id = recordId([
      filePath,
      lineNumber,
      sessionId,
      requestId,
      timestamp,
      tokenSet.inputTokens,
      tokenSet.cachedInputTokens,
      tokenSet.outputTokens,
      tokenSet.totalTokens,
      turnId
    ]);
    if (seen.has(id)) return;
    seen.add(id);

    records.push(createRecord({
      id,
      timestamp,
      sessionId,
      model,
      provider,
      source,
      inputTokens: tokenSet.inputTokens,
      cachedInputTokens: tokenSet.cachedInputTokens,
      outputTokens: tokenSet.outputTokens,
      totalTokens: tokenSet.totalTokens || tokenSet.inputTokens + tokenSet.outputTokens,
      reasoningOutputTokens: tokenSet.reasoningOutputTokens,
      requestId,
      turnId,
      filePath,
      relativePath,
      projectPath: meta.cwd,
      lineNumber,
      sessionTitle: meta.title || fallbackText.slice(0, 120) || sessionId,
      detailText: fallbackText
    }));
  }

  function visitJson(item, lineNumber) {
    if (!item || typeof item !== "object") return;
    const payload = getPayloadObject(item);

    if (item.type === "session_meta" || item.type === "turn_context" || payload.model_provider || payload.thread_source || payload.model) {
      meta.sessionId = firstScalar(payload.id, payload.session_id, meta.sessionId);
      meta.provider = firstScalar(payload.model_provider, payload.provider, meta.provider);
      meta.source = firstScalar(payload.source, payload.thread_source, meta.source);
      meta.model = firstScalar(payload.model, payload.model_name, meta.model);
      meta.timestamp = firstScalar(payload.timestamp, item.timestamp, meta.timestamp);
      meta.cwd = firstScalar(payload.cwd, meta.cwd);
      meta.turnId = firstScalar(payload.turn_id, payload.turnId, meta.turnId);
    }

    if (item.type === "response_item" && payload.type === "message" && payload.role === "user") {
      considerSessionTitle(meta, textFromMessagePayload(payload));
    }
    if (payload.role === "user" || item.role === "user") {
      considerSessionTitle(meta, textFromMessagePayload(payload) || textFromMessagePayload(item));
    }

    const usage = usageFromObject(item);
    if (usage) {
      addUsage(usage, item, lineNumber, meta.title);
      return;
    }

    for (const value of Object.values(item)) {
      if (value && typeof value === "object") {
        if (Array.isArray(value)) value.forEach(child => visitJson(child, lineNumber));
        else visitJson(value, lineNumber);
      }
    }
  }

  if (ext === ".json") {
    const item = parseJsonLine(text);
    if (item) visitJson(item, 1);
    else parseErrors += 1;
  } else {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const lineNumber = index + 1;
      const item = parseJsonLine(line);
      if (item) {
        visitJson(item, lineNumber);
        return;
      }
      applySessionMetaLine(line, meta);
      const regexUsage = usageFromLogLine(line);
      if (regexUsage) addUsage(regexUsage, { timestamp: extractTimestamp(line) || meta.timestamp }, lineNumber, line);
      else parseErrors += 1;
    });
  }

  if (!records.length && text.trim()) {
    const estimated = estimateTokens(text);
    records.push(createRecord({
      id: recordId([filePath, "estimated", hashText(text)]),
      timestamp: meta.timestamp || fs.statSync(filePath).mtime.toISOString(),
      sessionId: meta.sessionId || path.basename(filePath),
      model: meta.model || "unknown",
      provider: meta.provider,
      inputTokens: estimated,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: estimated,
      estimated: true,
      estimateReason: "missing_usage_fields_text_length",
      filePath,
      relativePath,
      projectPath: meta.cwd,
      sessionTitle: meta.title || path.basename(filePath),
      detailText: text.slice(0, 2000)
    }));
  }

  if (!isLowValueTitle(meta.title)) {
    for (const record of records) {
      if (isLowValueTitle(record.sessionTitle)) record.sessionTitle = meta.title;
    }
  }

  return {
    signature: statSignature(filePath),
    path: filePath,
    relativePath,
    parseErrors,
    records
  };
}

function extractTimestamp(line) {
  const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
  return match ? match[0] : "";
}

function usageFromLogLine(line) {
  const lower = line.toLowerCase();
  if (!/(token|usage|prompt|completion|cached)/.test(lower)) return null;
  const input = numberAfter(line, ["input_tokens", "prompt_tokens", "input"]);
  const cached = numberAfter(line, ["cached_input_tokens", "cached_tokens", "cached"]);
  const output = numberAfter(line, ["output_tokens", "completion_tokens", "output"]);
  const total = numberAfter(line, ["total_tokens", "total"]);
  if (!input && !cached && !output && !total) return null;
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output, totalTokens: total || input + output };
}

function numberAfter(line, names) {
  for (const name of names) {
    const pattern = new RegExp(`${name}\\s*[:=]\\s*"?([\\d,]+)"?`, "i");
    const match = line.match(pattern);
    if (match) return toNumber(match[1]);
  }
  return 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted && char === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map(header => header.trim());
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function parseRelayImportFile(filePath) {
  const text = readTextFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const batch = path.basename(filePath);
  let rows = [];

  if (ext === ".json") {
    const parsed = parseJsonLine(text);
    if (Array.isArray(parsed)) rows = parsed;
    else if (Array.isArray(parsed?.data)) rows = parsed.data;
    else if (Array.isArray(parsed?.records)) rows = parsed.records;
    else if (parsed && typeof parsed === "object") rows = [parsed];
  } else if (ext === ".csv") {
    rows = parseCsv(text);
  }

  return rows.map((row, index) => {
    const timestamp = row.timestamp || row.time || row.date || row.created_at || row.createdAt || fs.statSync(filePath).mtime.toISOString();
    const sessionId = row.session_id || row.sessionId || row.conversation_id || row.request_id || row.id || `relay-import-${index + 1}`;
    const inputTokens = toNumber(row.input_tokens || row.prompt_tokens || row.input || row.prompt);
    const cachedInputTokens = toNumber(row.cached_input_tokens || row.cached_tokens || row.cached);
    const outputTokens = toNumber(row.output_tokens || row.completion_tokens || row.output || row.completion);
    const totalTokens = toNumber(row.total_tokens || row.total || row.tokens || inputTokens + outputTokens);

    return createRecord({
      id: recordId(["relay_import", sessionId, timestamp, inputTokens, cachedInputTokens, outputTokens, totalTokens]),
      timestamp,
      sessionId,
      model: row.model || row.model_name || "unknown",
      source: "relay",
      provider: "relay_import",
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
      estimated: !inputTokens && !outputTokens && !totalTokens,
      estimateReason: !inputTokens && !outputTokens && !totalTokens ? "import_missing_usage_fields" : "",
      filePath,
      relativePath: path.relative(ROOT, filePath),
      projectPath: row.project_path || row.projectPath || row.cwd || row.workspace || "",
      projectName: row.project_name || row.projectName || row.project || "",
      sessionTitle: row.title || row.name || sessionId,
      detailText: JSON.stringify(row),
      imported: true,
      importBatch: batch
    });
  });
}

function buildIndex() {
  ensureDirs();
  endpointEvidenceCache = null;
  const previous = loadIndex();
  const nextFiles = {};
  const sessionFiles = listFiles(SESSIONS_DIR, SUPPORTED_SESSION_EXTENSIONS);
  const allRecords = [];
  let reusedFiles = 0;
  let parsedFiles = 0;

  for (const filePath of sessionFiles) {
    const signature = statSignature(filePath);
    const cached = previous.files?.[filePath];
    let entry;
    if (cached && isSameSignature(signature, cached.signature)) {
      entry = cached;
      reusedFiles += 1;
    } else {
      entry = parseSessionFile(filePath);
      parsedFiles += 1;
    }
    nextFiles[filePath] = entry;
    allRecords.push(...entry.records);
  }

  const nextImports = {};
  const importFiles = listFiles(IMPORT_DIR, new Set([".json", ".csv"]));
  for (const filePath of importFiles) {
    const signature = statSignature(filePath);
    const cached = previous.imports?.[filePath];
    let entry;
    if (cached && isSameSignature(signature, cached.signature)) {
      entry = cached;
    } else {
      entry = { signature, path: filePath, records: parseRelayImportFile(filePath) };
    }
    nextImports[filePath] = entry;
    allRecords.push(...entry.records);
  }

  const deduped = dedupeRecords(allRecords);
  const index = {
    version: INDEX_VERSION,
    sessionsDir: SESSIONS_DIR,
    dataDir: DATA_DIR,
    updatedAt: new Date().toISOString(),
    stats: {
      sessionFiles: sessionFiles.length,
      importFiles: importFiles.length,
      reusedFiles,
      parsedFiles,
      records: deduped.length,
      sourceEvidence: loadEndpointEvidence().stats
    },
    files: nextFiles,
    imports: nextImports,
    records: deduped
  };

  writeIndex(index);
  return index;
}

function refreshIndexCache(options = {}) {
  if (indexRefreshPromise && !options.force) return indexRefreshPromise;
  indexRefreshPromise = Promise.resolve()
    .then(() => {
      const index = buildIndex();
      indexCache = index;
      indexCacheUpdatedAt = Date.now();
      return index;
    })
    .catch(error => {
      if (!indexCache) throw error;
      console.warn(`Index refresh failed, keeping cached index: ${error.message}`);
      return indexCache;
    })
    .finally(() => {
      indexRefreshPromise = null;
    });
  return indexRefreshPromise;
}

async function getUsageIndex(options = {}) {
  if (options.force || !indexCache) return refreshIndexCache({ force: true });
  if (Date.now() - indexCacheUpdatedAt > INDEX_REFRESH_INTERVAL_MS) {
    refreshIndexCache().catch(error => console.warn(`Background index refresh failed: ${error.message}`));
  }
  return indexCache;
}

function dedupeRecords(records) {
  const map = new Map();
  for (const record of records) {
    if (!map.has(record.id)) map.set(record.id, record);
  }
  return Array.from(map.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function filterRecords(records, query) {
  let result = records;
  if (query.from) result = result.filter(record => record.date >= query.from);
  if (query.to) result = result.filter(record => record.date <= query.to);
  if (query.source && query.source !== "all") result = result.filter(record => record.source === query.source);
  if (query.model && query.model !== "all") result = result.filter(record => record.model === query.model);
  if (query.search) {
    const search = query.search.toLowerCase();
    result = result.filter(record => [record.sessionId, record.model, record.sessionTitle, record.relativePath].join(" ").toLowerCase().includes(search));
  }
  return result;
}

function summarize(records) {
  const summary = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    effectiveTokens: 0,
    reasoningOutputTokens: 0,
    records: records.length,
    sessions: new Set(),
    models: new Set(),
    estimatedRecords: 0,
    estimatedTokens: 0,
    measuredTokens: 0,
    bySource: {},
    byDay: {},
    byModel: {}
  };

  for (const record of records) {
    addSummary(summary, record);
    summary.sessions.add(record.sessionId);
    summary.models.add(record.model);
    addGroup(summary.bySource, record.source, record);
    addGroup(summary.byDay, record.date || "unknown", record, { date: record.date || "unknown" });
    addGroup(summary.byModel, record.model || "unknown", record, { model: record.model || "unknown" });
  }

  return {
    ...summary,
    sessions: summary.sessions.size,
    models: summary.models.size,
    bySource: objectValues(summary.bySource),
    byDay: objectValues(summary.byDay).sort((a, b) => a.date.localeCompare(b.date)),
    byModel: objectValues(summary.byModel).sort((a, b) => b.totalTokens - a.totalTokens)
  };
}

function emptySummary(seed = {}) {
  return {
    ...seed,
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    effectiveTokens: 0,
    reasoningOutputTokens: 0,
    records: 0,
    sessions: new Set(),
    estimatedRecords: 0,
    estimatedTokens: 0,
    measuredTokens: 0
  };
}

function addGroup(groups, key, record, seed = {}) {
  if (!groups[key]) groups[key] = emptySummary({ key, ...seed });
  addSummary(groups[key], record);
  groups[key].sessions.add(record.sessionId);
}

function addSummary(summary, record) {
  summary.totalTokens += record.totalTokens;
  summary.inputTokens += record.inputTokens;
  summary.cachedInputTokens += record.cachedInputTokens;
  summary.outputTokens += record.outputTokens;
  summary.effectiveTokens += record.effectiveTokens;
  summary.reasoningOutputTokens += record.reasoningOutputTokens;
  summary.records += 1;
  if (record.estimated) {
    summary.estimatedRecords += 1;
    summary.estimatedTokens += record.totalTokens;
  } else {
    summary.measuredTokens += record.totalTokens;
  }
}

function objectValues(groups) {
  return Object.values(groups).map(group => ({
    ...group,
    sessions: group.sessions instanceof Set ? group.sessions.size : group.sessions
  }));
}

async function apiUsage(url) {
  const started = Date.now();
  const force = url.searchParams.get("force") === "1";
  const index = await getUsageIndex({ force });
  const query = Object.fromEntries(url.searchParams.entries());
  delete query.force;
  const records = filterRecords(index.records, query);
  const calendarQuery = { ...query };
  delete calendarQuery.from;
  delete calendarQuery.to;
  const calendarRecords = filterRecords(index.records, calendarQuery);
  const summary = summarize(records);
  const models = Array.from(new Set(index.records.map(record => record.model))).sort();

  return sanitizePayload({
    ok: true,
    sessionsDir: SESSIONS_DIR,
    indexPath: INDEX_PATH,
    updatedAt: index.updatedAt,
    generatedAt: new Date().toISOString(),
    scanMs: Date.now() - started,
    config: {
      publicAccess: PUBLIC_ACCESS,
      anonymizeData: ANONYMIZE_DATA,
      defaultDateRange: CONFIG.defaultDateRange
    },
    stats: index.stats,
    filters: query,
    models,
    summary,
    calendarRecords,
    records
  });
}

function sanitizeRecord(record) {
  if (!PUBLIC_ACCESS && !ANONYMIZE_DATA) return record;
  return {
    ...record,
    sessionId: maskMiddle(record.sessionId, 8, 4),
    requestId: record.requestId ? maskMiddle(record.requestId, 8, 4) : "",
    turnId: record.turnId ? maskMiddle(record.turnId, 8, 4) : "",
    filePath: "",
    relativePath: record.relativePath ? "[hidden]" : "",
    projectPath: record.projectPath ? "[hidden]" : "",
    sessionTitle: record.sessionTitle ? "[hidden]" : "",
    detailText: "",
    importBatch: record.importBatch ? "[hidden]" : ""
  };
}

function sanitizePayload(payload) {
  if (!PUBLIC_ACCESS && !ANONYMIZE_DATA) return payload;
  return {
    ...payload,
    sessionsDir: "[hidden]",
    indexPath: "[hidden]",
    records: Array.isArray(payload.records) ? payload.records.map(sanitizeRecord) : payload.records,
    calendarRecords: Array.isArray(payload.calendarRecords) ? payload.calendarRecords.map(sanitizeRecord) : payload.calendarRecords
  };
}

function saveImport(payload) {
  ensureDirs();
  const filename = String(payload.filename || `relay-import-${Date.now()}.json`).replace(/[^\w.-]+/g, "_");
  const ext = path.extname(filename).toLowerCase() || ".json";
  if (![".json", ".csv"].includes(ext)) throw new Error("Only CSV and JSON imports are supported");
  const target = path.join(IMPORT_DIR, `${Date.now()}-${filename}`);
  fs.writeFileSync(target, String(payload.content || ""), "utf8");
  return target;
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function isApiPath(url) {
  return url.pathname.startsWith("/api/");
}

function isAuthorized(req, url) {
  if (!PUBLIC_ACCESS) return true;
  if (url.pathname === "/api/config") return true;
  const headerToken = req.headers["x-access-token"] || "";
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const queryToken = url.searchParams.get("access_token") || "";
  const password = req.headers["x-dashboard-password"] || url.searchParams.get("password") || "";
  return Boolean(
    (ACCESS_TOKEN && [headerToken, bearer, queryToken].includes(ACCESS_TOKEN)) ||
    (DASHBOARD_PASSWORD && password === DASHBOARD_PASSWORD) ||
    (DASHBOARD_PASSWORD && headerToken === DASHBOARD_PASSWORD)
  );
}

function sendUnauthorized(res) {
  sendJson(res, {
    ok: false,
    error: "Public access mode requires DASHBOARD_PASSWORD or ACCESS_TOKEN authentication."
  }, 401);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const type = path.extname(filePath).toLowerCase() === ".html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${activePort || PORT}`);
  try {
    if (isApiPath(url) && !isAuthorized(req, url)) return sendUnauthorized(res);
    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, {
        ok: true,
        publicAccess: PUBLIC_ACCESS,
        anonymizeData: ANONYMIZE_DATA,
        authRequired: PUBLIC_ACCESS,
        defaultDateRange: CONFIG.defaultDateRange
      });
    }
    if (req.method === "GET" && url.pathname === "/api/usage") return sendJson(res, await apiUsage(url));
    if (req.method === "GET" && url.pathname === "/api/index") {
      if (PUBLIC_ACCESS) return sendJson(res, { ok: false, error: "Raw index is disabled in public access mode." }, 403);
      return sendJson(res, indexCache || loadIndex());
    }
    if (req.method === "POST" && url.pathname === "/api/import/relay") {
      const body = await readRequestBody(req);
      const payload = JSON.parse(body || "{}");
      const filePath = saveImport(payload);
      const index = await refreshIndexCache({ force: true });
      return sendJson(res, { ok: true, importedPath: PUBLIC_ACCESS || ANONYMIZE_DATA ? "[hidden]" : filePath, updatedAt: index.updatedAt });
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, { ok: false, error: error.message }, 500);
  }
});

function openBrowser(url) {
  if (!CONFIG.autoOpenBrowser) return;
  const command = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  childProcess.exec(command, { windowsHide: true }, () => {});
}

function listenWithFallback(port, attemptsLeft = 3) {
  activePort = port;
  server.once("error", error => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 1) {
      console.log(`Port ${port} is in use, trying ${port + 1}...`);
      listenWithFallback(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
    const url = `http://${displayHost}:${port}`;
    console.log(`Codex token dashboard: ${url}`);
    console.log(`Mode: ${PUBLIC_ACCESS ? "public access (authenticated)" : "local private"}`);
    console.log(`Anonymize data: ${ANONYMIZE_DATA ? "true" : "false"}`);
    console.log(`Reading sessions from: ${SESSIONS_DIR}`);
    console.log(`Writing index to: ${INDEX_PATH}`);
    openBrowser(url);
  });
}

function startIndexRefreshLoop() {
  setInterval(() => refreshIndexCache().catch(error => console.warn(`Background index refresh failed: ${error.message}`)), INDEX_REFRESH_INTERVAL_MS);
}

try {
  validateSecurityConfig();
  ensureDirs();
  indexCache = buildIndex();
  indexCacheUpdatedAt = Date.now();
  if (process.argv.includes("--scan")) {
    console.log(`Scan complete. Index written to: ${INDEX_PATH}`);
  } else {
    startIndexRefreshLoop();
    listenWithFallback(PORT, 3);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

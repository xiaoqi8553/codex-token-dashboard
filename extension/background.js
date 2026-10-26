const DASHBOARD_ORIGIN = "https://xiaoqi8553.github.io";
const PORTS = [8787, 8788, 8789];

function isDashboardSender(sender) {
  try {
    const url = new URL(sender.url || "");
    return url.origin === DASHBOARD_ORIGIN && url.pathname.startsWith("/codex-token-dashboard/");
  } catch {
    return false;
  }
}

async function fetchUsage(path) {
  const parsed = new URL(path, DASHBOARD_ORIGIN);
  if (parsed.origin !== DASHBOARD_ORIGIN || parsed.pathname !== "/api/usage") {
    throw new Error("扩展只允许读取仪表盘用量接口。");
  }
  const apiPath = parsed.pathname + parsed.search;
  let lastError;
  for (const port of PORTS) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + apiPath, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(20000)
      });
      const type = response.headers.get("content-type") || "";
      if (!type.includes("application/json")) throw new Error("本机服务未返回用量数据。");
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || ("本机服务返回 " + response.status));
      return payload;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError?.message || "无法连接本机服务；请先运行 start-dashboard.bat。");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isDashboardSender(sender) || !message || message.channel !== "codex-token-dashboard") return false;
  if (message.type === "probe") {
    sendResponse({ ok: true, extensionVersion: chrome.runtime.getManifest().version });
    return false;
  }
  if (message.type !== "usage" || typeof message.path !== "string") return false;
  fetchUsage(message.path).then(
    payload => sendResponse({ ok: true, payload }),
    error => sendResponse({ ok: false, error: error?.message || "本机同步失败。" })
  );
  return true;
});

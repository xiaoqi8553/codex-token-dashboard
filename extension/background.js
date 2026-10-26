const DASHBOARD_ORIGIN = "https://xiaoqi8553.github.io";
const PORTS = [8787, 8788, 8789];

async function gzipBase64(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

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
      if (!response.ok) {
        const errorText = await response.text();
        let errorPayload;
        try { errorPayload = JSON.parse(errorText); } catch {}
        throw new Error(errorPayload?.error || ("本机服务返回 " + response.status));
      }
      const responseText = await response.text();
      return { encoding: "gzip-base64", data: await gzipBase64(responseText) };
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
    compressed => sendResponse({ ok: true, ...compressed }),
    error => sendResponse({ ok: false, error: error?.message || "本机同步失败。" })
  );
  return true;
});

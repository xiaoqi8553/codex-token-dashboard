(() => {
  const CHANNEL = "codex-token-dashboard-page-bridge";
  const DASHBOARD_ORIGIN = "https://xiaoqi8553.github.io";

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== DASHBOARD_ORIGIN) return;
    const request = event.data;
    if (!request || request.channel !== CHANNEL || typeof request.requestId !== "string") return;
    if (request.type !== "probe" && request.type !== "usage") return;
    if (request.type === "usage" && (typeof request.path !== "string" || !request.path.startsWith("/api/usage?"))) return;

    chrome.runtime.sendMessage({
      channel: "codex-token-dashboard",
      type: request.type,
      path: request.path
    }, result => {
      const runtimeError = chrome.runtime.lastError;
      window.postMessage({
        channel: CHANNEL,
        type: "response",
        requestId: request.requestId,
        result: runtimeError ? { ok: false, error: "扩展暂不可用，请检查是否启用。" } : result
      }, DASHBOARD_ORIGIN);
    });
  });
})();

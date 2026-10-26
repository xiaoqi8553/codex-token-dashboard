const DASHBOARD_ORIGIN = "https://xiaoqi8553.github.io";
const READ_ONLY_PATHS = new Set(["/api/config", "/api/usage"]);

function getNotionCorsHeaders({ origin, pathname, publicAccess, host }) {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(String(host || "").toLowerCase());
  if (!loopback || publicAccess || origin !== DASHBOARD_ORIGIN || !READ_ONLY_PATHS.has(pathname)) return null;
  return {
    "access-control-allow-origin": DASHBOARD_ORIGIN,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "300",
    "vary": "Origin"
  };
}

module.exports = { DASHBOARD_ORIGIN, READ_ONLY_PATHS, getNotionCorsHeaders };

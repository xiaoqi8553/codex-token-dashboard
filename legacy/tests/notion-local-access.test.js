const assert = require("node:assert/strict");
const test = require("node:test");
const { getNotionCorsHeaders } = require("../scripts/notion-local-access");

const baseRequest = {
  origin: "https://xiaoqi8553.github.io",
  pathname: "/api/usage",
  publicAccess: false,
  host: "127.0.0.1"
};

test("Notion desktop loopback access is read-only and restricted to the dashboard origin", () => {
  const headers = getNotionCorsHeaders(baseRequest);
  assert.equal(headers["access-control-allow-origin"], "https://xiaoqi8553.github.io");
  assert.equal(headers["access-control-allow-methods"], "GET, OPTIONS");
  assert.equal(headers["access-control-allow-private-network"], "true");
  assert.equal(getNotionCorsHeaders({ ...baseRequest, origin: "https://notion.so" }), null);
  assert.equal(getNotionCorsHeaders({ ...baseRequest, pathname: "/api/import/relay" }), null);
  assert.equal(getNotionCorsHeaders({ ...baseRequest, pathname: "/api/account/snapshot" }), null);
  assert.equal(getNotionCorsHeaders({ ...baseRequest, publicAccess: true }), null);
  assert.equal(getNotionCorsHeaders({ ...baseRequest, host: "0.0.0.0" }), null);
});

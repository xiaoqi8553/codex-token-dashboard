const securityHeaders = {
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff"
};

function withSecurityHeaders(response) {
  const secured = new Response(response.body, response);
  for (const [key, value] of Object.entries(securityHeaders)) secured.headers.set(key, value);
  return secured;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") url.pathname = "/index.html";

    let response = await env.ASSETS.fetch(new Request(url, request));
    if (response.status === 404 && request.method === "GET" && request.headers.get("accept")?.includes("text/html")) {
      const fallback = new URL("/index.html", request.url);
      response = await env.ASSETS.fetch(new Request(fallback, request));
    }
    return withSecurityHeaders(response);
  }
};

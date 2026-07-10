const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const required = [
  "index.html",
  "sites-worker.js",
  "sample-data/demo-usage-index.json",
  "sample-data/usage-index.sample.json",
  "README.md",
  "LICENSE"
];

for (const file of required) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) {
    console.error(`Missing required static asset: ${file}`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, "sample-data"), { recursive: true });
  fs.mkdirSync(path.join(dist, "client", "sample-data"), { recursive: true });
  fs.mkdirSync(path.join(dist, "server"), { recursive: true });
  fs.copyFileSync(path.join(root, "index.html"), path.join(dist, "index.html"));
  fs.copyFileSync(path.join(root, "sample-data", "demo-usage-index.json"), path.join(dist, "sample-data", "demo-usage-index.json"));
  fs.copyFileSync(path.join(root, "sample-data", "usage-index.sample.json"), path.join(dist, "sample-data", "usage-index.sample.json"));
  fs.copyFileSync(path.join(root, "index.html"), path.join(dist, "client", "index.html"));
  fs.copyFileSync(path.join(root, "sample-data", "demo-usage-index.json"), path.join(dist, "client", "sample-data", "demo-usage-index.json"));
  fs.copyFileSync(path.join(root, "sample-data", "usage-index.sample.json"), path.join(dist, "client", "sample-data", "usage-index.sample.json"));
  fs.copyFileSync(path.join(root, "sites-worker.js"), path.join(dist, "server", "index.js"));
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(dist, "LICENSE"));
  fs.writeFileSync(path.join(dist, "_headers"), [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(self)",
    "/sample-data/*",
    "  Cache-Control: public, max-age=300",
    "/index.html",
    "  Cache-Control: public, max-age=0, must-revalidate",
    ""
  ].join("\n"), "utf8");
  console.log("Static build ready for OpenAI Sites, Netlify, and GitHub Pages: dist/");
}

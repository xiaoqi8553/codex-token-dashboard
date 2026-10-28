// Dev utility: render desktop/popover.html offscreen and save a PNG so the
// layout can be compared against the CodexBar reference design.
const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUTPUT = path.join(ROOT, "docs", "popover-preview.png");
const THEME = process.env.POPOVER_SHOT_THEME === "dark" ? "dark" : "light";

app.disableHardwareAcceleration();
nativeTheme.themeSource = THEME;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 400,
    height: 752,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: "#eef0fa",
    webPreferences: {
      preload: path.join(__dirname, "dev-popover-mock-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await window.loadFile(path.join(ROOT, "desktop", "popover.html"));
  window.webContents.on("console-message", (_event, _level, message) => {
    process.stdout.write(`[renderer] ${message}\n`);
  });
  await new Promise(resolve => setTimeout(resolve, 1200));

  const image = await window.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, image.toPNG());
  process.stdout.write(`saved ${OUTPUT}\n`);

  // Second shot with the cost disclosure expanded. The real app grows the panel
  // via IPC, so the preview mirrors that by enlarging the offscreen window.
  await window.webContents.executeJavaScript('document.getElementById("cost-toggle")?.click()');
  await new Promise(resolve => setTimeout(resolve, 400));
  window.setBounds({ x: 0, y: 0, width: 400, height: 900 });
  await new Promise(resolve => setTimeout(resolve, 500));
  const expanded = await window.webContents.capturePage();
  fs.writeFileSync(OUTPUT.replace(/\.png$/, "-expanded.png"), expanded.toPNG());
  process.stdout.write(`saved ${OUTPUT.replace(/\.png$/, "-expanded.png")}\n`);

  app.quit();
});

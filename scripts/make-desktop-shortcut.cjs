// 在桌面创建「Codex Token」快捷方式。
// 使用 Electron 原生 shell.writeShortcutLink（Windows 的 IShellLink 封装），
// 不依赖 WScript.Shell COM，因此在受限环境下也能工作。
//
// 用法：
//   npx electron scripts/make-desktop-shortcut.cjs
//   npx electron scripts/make-desktop-shortcut.cjs --target "D:\\path\\to\\Codex Token.exe"
const { app, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const DEFAULT_TARGET = path.join(ROOT, "release", "desktop", "win-unpacked", "Codex Token.exe");
const LINK_NAME = "Codex Token.lnk";

function resolveTarget() {
  const index = process.argv.indexOf("--target");
  if (index !== -1 && process.argv[index + 1]) return path.resolve(process.argv[index + 1]);
  return DEFAULT_TARGET;
}

function desktopDir() {
  const home = process.env.USERPROFILE || "";
  for (const dir of [path.join(home, "Desktop"), path.join(home, "OneDrive", "Desktop")]) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* 忽略不存在 */
    }
  }
  return path.join(home, "Desktop");
}

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const target = resolveTarget();
  if (!fs.existsSync(target)) {
    console.log(`ERROR: 目标不存在 -> ${target}`);
    console.log("请先用 npm run desktop:dir 打包，或用 --target 指定 exe 路径");
    app.exit(1);
    return;
  }

  const lnkPath = path.join(desktopDir(), LINK_NAME);
  const ok = shell.writeShortcutLink(lnkPath, "create", {
    target,
    cwd: path.dirname(target),
    icon: target,
    iconIndex: 0,
    description: "Codex Token 用量速览",
    appUserModelId: "com.codex.token.dashboard",
  });

  if (!ok) {
    console.log("FAILED: writeShortcutLink 返回 false");
    app.exit(1);
    return;
  }

  const info = shell.readShortcutLink(lnkPath);
  console.log(`OK: ${lnkPath} (${fs.statSync(lnkPath).size} bytes)`);
  console.log(`target=${info.target}`);
  console.log(`cwd=${info.cwd}`);
  app.exit(0);
});

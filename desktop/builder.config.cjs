const path = require("node:path");

module.exports = {
  appId: "com.xiaoqi.codex-token-dashboard",
  productName: "Codex Token",
  artifactName: "Codex-Token-Setup-${version}.${ext}",
  directories: {
    output: process.env.CODEX_TOKEN_BUILD_DIR || "release/desktop"
  },
  asar: false,
  electronDist: path.resolve(__dirname, "../node_modules/electron/dist"),
  files: [
    "desktop/main.cjs",
    "desktop/preload.cjs",
    "desktop/popover.html",
    "desktop/icon.png",
    "server.js",
    "index.html",
    "folder-picker.html",
    "usage-accounting.js",
    "output-speed.js",
    "session-files.js",
    "scripts/**",
    "vendor/**",
    "sample-data/**",
    "package.json"
  ],
  win: {
    target: ["nsis"],
    icon: "desktop/icon.png",
    artifactName: "Codex-Token-Setup-${version}.${ext}"
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Codex Token",
    deleteAppDataOnUninstall: false
  }
};

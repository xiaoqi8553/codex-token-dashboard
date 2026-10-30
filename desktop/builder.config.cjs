const path = require("node:path");

module.exports = {
  appId: "com.xiaoqi.tokenbar",
  productName: "TokenBar",
  artifactName: "TokenBar-Setup-${version}.${ext}",
  directories: {
    output: process.env.TOKENBAR_BUILD_DIR || "release/desktop"
  },
  asar: false,
  electronDist: path.resolve(__dirname, "../node_modules/electron/dist"),
  files: [
    "desktop/main.cjs",
    "desktop/preload.cjs",
    "desktop/popover.html",
    "desktop/dashboard.html",
    "desktop/dashboard-preload.cjs",
    "desktop/icon.png",
    "desktop/data/**",
    // 旧网页看板只在「打开旧版网页看板」时用到，一起打包，避免菜单点了没反应
    "legacy/server.js",
    "legacy/index.html",
    "legacy/folder-picker.html",
    "legacy/usage-accounting.js",
    "legacy/output-speed.js",
    "legacy/session-files.js",
    "legacy/scripts/account-snapshot-process.js",
    "legacy/scripts/notion-local-access.js",
    "legacy/vendor/**",
    "package.json"
  ],
  win: {
    target: ["nsis"],
    icon: "desktop/icon.png",
    artifactName: "TokenBar-Setup-${version}.${ext}"
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "TokenBar",
    deleteAppDataOnUninstall: false
  }
};

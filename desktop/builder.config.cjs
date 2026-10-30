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

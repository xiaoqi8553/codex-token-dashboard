const { contextBridge, ipcRenderer } = require("electron");

// 弹窗没有 Node 集成，所有需要特权的操作都经过这条显式白名单桥。
contextBridge.exposeInMainWorld("codexBar", {
  onStatus(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("popover:status", (_event, payload) => callback(payload));
  },
  refresh: () => ipcRenderer.invoke("popover:refresh"),
  setHeight: height => ipcRenderer.send("popover:set-height", Number(height) || 0),
  openDashboard: () => ipcRenderer.invoke("popover:open-dashboard"),
  openStatusPage: () => ipcRenderer.invoke("popover:open-status-page"),
  setLaunchAtLogin: enabled => ipcRenderer.invoke("popover:set-launch-at-login", Boolean(enabled)),
  getPrefs: () => ipcRenderer.invoke("popover:prefs"),
  quit: () => ipcRenderer.invoke("popover:quit"),
  close: () => ipcRenderer.invoke("popover:close")
});

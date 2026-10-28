const { contextBridge, ipcRenderer } = require("electron");

// The popover runs without Node integration, so every privileged action goes
// through this narrow, explicitly enumerated bridge.
contextBridge.exposeInMainWorld("codexBar", {
  onStatus(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("popover:status", (_event, payload) => callback(payload));
  },
  refresh: () => ipcRenderer.invoke("popover:refresh"),
  setHeight: height => ipcRenderer.send("popover:set-height", Number(height) || 0),
  openDashboard: () => ipcRenderer.invoke("popover:open-dashboard"),
  setLaunchAtLogin: enabled => ipcRenderer.invoke("popover:set-launch-at-login", Boolean(enabled)),
  getPrefs: () => ipcRenderer.invoke("popover:prefs"),
  quit: () => ipcRenderer.invoke("popover:quit"),
  close: () => ipcRenderer.invoke("popover:close")
});

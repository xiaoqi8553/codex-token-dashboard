"use strict";

/**
 * 完整看板的 preload：只暴露白名单方法，页面保持沙箱。
 * 数据全部来自主进程的 CodexStore，不经过任何 HTTP 服务。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dashboard", {
  /** 拉取明细数据（首次会触发扫描，进度通过 onProgress 推送） */
  getDetail: () => ipcRenderer.invoke("dashboard:get-detail"),
  /** 重新扫描（增量，未变更文件会命中缓存） */
  refresh: () => ipcRenderer.invoke("dashboard:refresh"),
  /** 轻量快照：配额、今日，用于首屏先显示 */
  getStatus: () => ipcRenderer.invoke("dashboard:status"),
  /** 扫描进度与状态推送 */
  onProgress: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("dashboard:progress", handler);
    return () => ipcRenderer.removeListener("dashboard:progress", handler);
  },
  onStatus: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("dashboard:status", handler);
    return () => ipcRenderer.removeListener("dashboard:status", handler);
  },
  /** 打开旧版网页看板（需要本地服务，属可选功能） */
  openLegacy: () => ipcRenderer.invoke("dashboard:open-legacy"),
  /** 在资源管理器中打开日志目录 */
  openSessions: () => ipcRenderer.invoke("dashboard:open-sessions"),
  /** 打开周报/外部链接（仅 https） */
  openExternal: url => ipcRenderer.invoke("dashboard:open-external", url)
});

/* AI World 桌面版预加载脚本：只向页面暴露必要的几个方法。 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiWorldDesktop", {
  isDesktop: true,
  /** 切换桌宠模式（透明无边框置顶窗口）。 */
  setPetMode: (on) => ipcRenderer.send("pet-mode", !!on),
});

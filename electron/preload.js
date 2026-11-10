/* AI World 桌面版预加载脚本：只向页面暴露必要的几个方法。 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiWorldDesktop", {
  isDesktop: true,
  /** 切换桌宠模式（透明无边框置顶窗口）。 */
  setPetMode: (on) => ipcRenderer.send("pet-mode", !!on),
  /** 打开智能体设置（菜单「智能体」用）。 */
  openAgentSettings: () => ipcRenderer.send("agent-settings"),
  /** 内置模型请求代理：由主进程发，绕开页面跨域限制。 */
  llmRequest: (payload) => ipcRenderer.invoke("llm:request", payload),
  /**
   * 智能体配置落到用户目录里的 JSON。
   * 桌面版每次启动的本地服务端口都不同，localStorage 会按端口隔离，所以另存一份。
   */
  config: {
    load: () => ipcRenderer.sendSync("agent-config:load"),
    save: (cfg) => ipcRenderer.send("agent-config:save", cfg),
  },
});

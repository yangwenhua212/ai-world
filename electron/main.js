/* AI World 桌面版主进程
 *
 * 页面本身是纯静态资源，直接 file:// 打开会因为 ES Module + importmap 的跨域限制失败，
 * 所以这里起一个只监听 127.0.0.1 的本地静态服务，再用 BrowserWindow 加载。
 *
 * 两种窗口：
 *   - 普通窗口：带边框，正常看房间。
 *   - 桌宠窗口：透明、无边框、置顶，配合页面隐藏房间，把角色贴在桌面上。
 *     Esc 退出桌宠模式。
 */
"use strict";

const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".vrm": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

let win = null;
let petMode = false;
let origin = "";

/** 起本地静态服务，端口交给系统分配，避免和 8080 冲突。 */
function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]);
    const file = path.join(ROOT, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      origin = "http://127.0.0.1:" + server.address().port;
      resolve(origin);
    });
  });
}

function createWindow(pet) {
  if (win) {
    win.destroy();
    win = null;
  }
  petMode = pet;
  win = new BrowserWindow({
    width: pet ? 760 : 1280,
    height: pet ? 720 : 800,
    minWidth: 480,
    minHeight: 360,
    title: "AI World",
    frame: !pet,
    transparent: pet,
    backgroundColor: pet ? "#00000000" : "#14161b",
    alwaysOnTop: pet,
    hasShadow: !pet,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(origin + "/");

  if (pet) {
    win.webContents.once("did-finish-load", () => {
      win.webContents.executeJavaScript(
        "document.body.classList.add('pet-mode');" +
          "var b = document.getElementById('room-toggle'); if (b) b.checked = false;" +
          "window.__aiWorld && window.__aiWorld.setRoomVisible(false);"
      );
    });
    // 桌宠模式没有边框，用 Esc 回到普通窗口。
    win.webContents.on("before-input-event", (ev, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        ev.preventDefault();
        createWindow(false);
      }
    });
  }

  win.on("closed", () => {
    win = null;
  });
}

ipcMain.on("pet-mode", (_ev, on) => {
  if (!!on === petMode) return;
  createWindow(!!on);
});

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "视图",
        submenu: [
          { label: "房间视角", accelerator: "CmdOrCtrl+1", click: () => sendPreset("room") },
          { label: "书桌视角", accelerator: "CmdOrCtrl+2", click: () => sendPreset("desk") },
          { label: "肖像视角", accelerator: "CmdOrCtrl+3", click: () => sendPreset("portrait") },
          { type: "separator" },
          { label: "桌宠模式", accelerator: "CmdOrCtrl+P", click: () => createWindow(!petMode) },
          { type: "separator" },
          { role: "toggleDevTools", label: "开发者工具" },
          { role: "reload", label: "重新加载" },
          { role: "quit", label: "退出" },
        ],
      },
    ])
  );
}

function sendPreset(name) {
  if (win) win.webContents.executeJavaScript(`window.__aiWorld && window.__aiWorld.setPreset(${JSON.stringify(name)})`);
}

app.whenReady().then(async () => {
  await startServer();
  buildMenu();
  createWindow(false);
  app.on("activate", () => {
    if (!win) createWindow(false);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

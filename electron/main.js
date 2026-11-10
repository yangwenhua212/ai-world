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
const https = require("https");
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

/** 智能体配置：存到用户目录，避免每次启动端口变化导致 localStorage 丢失。 */
function configFile() {
  return path.join(app.getPath("userData"), "agent-config.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch (_e) {
    return null;
  }
}

function writeConfig(cfg) {
  try {
    fs.writeFileSync(configFile(), JSON.stringify(cfg || {}, null, 2), "utf8");
  } catch (err) {
    console.warn("[ai-world] 智能体配置写入失败：", err);
  }
}

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

ipcMain.on("agent-config:load", (ev) => {
  ev.returnValue = readConfig();
});

ipcMain.on("agent-config:save", (_ev, cfg) => {
  writeConfig(cfg);
});

ipcMain.on("agent-settings", () => {
  if (!win) return;
  win.webContents.executeJavaScript(
    "(function(){var b=document.getElementById('agent-btn'); if(b) b.click();})()"
  );
});

/** 内置模型请求走主进程：绕开页面跨域限制，任何 OpenAI 兼容接口都能用。 */
function llmRequest(payload) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(String(payload.url || ""));
    } catch (_e) {
      resolve({ ok: false, status: 0, error: "接口地址不合法" });
      return;
    }
    const body = String(payload.body || "");
    const headers = Object.assign({}, payload.headers || {}, {
      "Content-Length": Buffer.byteLength(body),
    });
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data })
        );
      }
    );
    req.setTimeout(25000, () => req.destroy(new Error("请求超时")));
    req.on("error", (err) => resolve({ ok: false, status: 0, error: String(err.message || err) }));
    req.write(body);
    req.end();
  });
}

ipcMain.handle("llm:request", (_ev, payload) => llmRequest(payload || {}));

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "智能体",
        submenu: [
          {
            label: "智能体设置…",
            accelerator: "CmdOrCtrl+,",
            click: () => {
              if (win) {
                win.webContents.executeJavaScript(
                  "(function(){var b=document.getElementById('agent-btn'); if(b) b.click();})()"
                );
              }
            },
          },
        ],
      },
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

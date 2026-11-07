/* AI World — 智能体桥（本项目原创实现，不绑定任何一家智能体）
 *
 * 把任意智能体的 TTS 音频 / 表情 / 状态 / 文本指令接进世界页面，两种入口：
 *   1. 本地 WebSocket：默认 ws://127.0.0.1:8777，可用 ?bridge=ws://host:port 覆盖
 *   2. 父窗口 postMessage（Electron / Tauri / iframe 嵌入）：
 *      parent.postMessage({ __aiWorld: true, type: "speak", data: "<base64>" }, "*")
 *
 * 消息格式（WS 与 postMessage 相同）：
 *   { type: "speak", url?: "http…", data?: "<base64 wav/mp3>", text?: "…" }
 *   { type: "stop" }
 *   { type: "mouth", value: 0..1 }
 *   { type: "expression", name: "happy" | "angry" | "sad" | "relaxed" | "surprised" }
 *   { type: "state", sitting?: true, roomVisible?: true, preset?: "desk" | "room" | "portrait" }
 *   { type: "action", name: "sleep" | "wake" | "phone" | "computer" | "window" | "stretch" | "walk" }
 *   { type: "command", text: "我想睡觉了" }   // 自然语言，不需要语音
 *   { type: "message", text: "帮我整理一下桌面", mode?: "auto" | "task" | "chat", reply?: "…" }
 *     给角色发消息：桌面手机提示 → 自动拿起看 → 回复 → 放下；task 模式直接去电脑干活。
 */
(function (global) {
  "use strict";

  const DEFAULT_URL = "ws://127.0.0.1:8777";
  const RETRY_MIN = 2000;
  const RETRY_MAX = 30000;

  function base64ToBlob(b64, mime) {
    const bin = global.atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new global.Blob([bytes], { type: mime || "audio/wav" });
  }

  class AiWorldBridge {
    constructor(renderer, opts) {
      if (!renderer) throw new Error("语音桥需要渲染器实例");
      opts = opts || {};
      this.renderer = renderer;
      this.url = opts.url || this._resolveUrl();
      this._ws = null;
      this._closed = false;
      this._retryMs = RETRY_MIN;
      this._retryTimer = null;

      renderer.onSpeechEnd = (interrupted) => {
        this.send({ type: "speech-end", interrupted: !!interrupted });
        this._caption("");
      };

      global.addEventListener("message", (ev) => {
        const msg = ev && ev.data;
        if (msg && msg.__aiWorld === true) this.handle(msg);
      });

      this._connect();
    }

    _resolveUrl() {
      try {
        const q = new URLSearchParams(global.location.search);
        const v = q.get("bridge");
        if (v) return v;
      } catch (_e) {
        /* location 不可用时忽略 */
      }
      return DEFAULT_URL;
    }

    _status(text) {
      const el = typeof document !== "undefined" ? document.getElementById("bridge") : null;
      if (el) el.textContent = text;
    }

    _connect() {
      if (this._closed || typeof global.WebSocket !== "function") return;
      this._status("智能体桥：连接中…");
      let ws;
      try {
        ws = new global.WebSocket(this.url);
      } catch (_e) {
        this._scheduleRetry();
        return;
      }
      this._ws = ws;

      ws.onopen = () => {
        this._retryMs = RETRY_MIN;
        this._status("智能体桥：已连接");
        this.send({ type: "hello", role: "world" });
      };
      ws.onmessage = (ev) => {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch (_e) {
          return;
        }
        this.handle(msg);
      };
      ws.onclose = () => {
        this._ws = null;
        if (!this._closed) {
          this._status("智能体桥：未连接");
          this._scheduleRetry();
        }
      };
      ws.onerror = () => {
        /* onclose 会接着触发重连，这里不重复打日志 */
      };
    }

    _scheduleRetry() {
      if (this._closed || this._retryTimer) return;
      const wait = this._retryMs;
      this._retryMs = Math.min(RETRY_MAX, Math.round(this._retryMs * 1.6));
      this._retryTimer = global.setTimeout(() => {
        this._retryTimer = null;
        this._connect();
      }, wait);
    }

    send(obj) {
      if (this._ws && this._ws.readyState === 1) {
        try {
          this._ws.send(JSON.stringify(obj));
        } catch (_e) {
          /* 连接刚断开时忽略 */
        }
      }
    }

    handle(msg) {
      if (!msg || typeof msg !== "object" || !this.renderer) return;
      switch (msg.type) {
        case "speak":
          if (msg.data) {
            this.renderer.speakAudio(base64ToBlob(msg.data, msg.mime), { silent: !!msg.silent });
          } else if (msg.url) {
            this.renderer.speakAudio(msg.url, { silent: !!msg.silent });
          }
          if (typeof msg.text === "string") this._caption(msg.text);
          break;
        case "stop":
          this.renderer.stopSpeaking();
          break;
        case "mouth":
          this.renderer.setMouthOpen(msg.value);
          break;
        case "expression":
          this.renderer.setExpression(msg.index || 0, msg.name);
          break;
        case "state":
          if (typeof msg.sitting === "boolean") this.renderer.setSitting(msg.sitting);
          if (typeof msg.roomVisible === "boolean") this.renderer.setRoomVisible(msg.roomVisible);
          if (msg.preset) this.renderer.setCameraPreset(msg.preset);
          break;
        case "action":
          if (msg.name) this.renderer.setAction(msg.name);
          break;
        case "message":
          if (typeof msg.text === "string") {
            this._caption(msg.text);
            if (typeof this.renderer.notifyMessage === "function") {
              this.renderer.notifyMessage(msg.text, { mode: msg.mode, reply: msg.reply });
            }
          }
          break;
        case "command":
        case "text":
          // 任意智能体都能用一句自然语言驱动人物（不需要 TTS）。
          if (typeof global.__worldCommand === "function" && typeof msg.text === "string") {
            this._caption(msg.text);
            global.__worldCommand(msg.text);
          }
          break;
        default:
          break;
      }
    }

    _caption(text) {
      const el = typeof document !== "undefined" ? document.getElementById("caption") : null;
      if (!el) return;
      el.textContent = text;
      el.style.opacity = text ? "1" : "0";
    }

    dispose() {
      this._closed = true;
      if (this._retryTimer) global.clearTimeout(this._retryTimer);
      this._retryTimer = null;
      if (this._ws) {
        try {
          this._ws.close();
        } catch (_e) {
          /* 忽略 */
        }
        this._ws = null;
      }
    }
  }

  global.AiWorldBridge = AiWorldBridge;
})(typeof window !== "undefined" ? window : globalThis);

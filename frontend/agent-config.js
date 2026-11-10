/* AI World — 智能体配置（本项目原创实现）
 *
 * 两件事：
 *   1. 配置读写：后台智能体的 WebSocket 地址、内置模型（OpenAI 兼容）的地址/密钥/模型。
 *      浏览器里存在 localStorage；桌面版（Electron）额外写一份到用户目录，重开不丢。
 *   2. 内置模型：没接后台智能体时，页面自己调模型，把回复和动作交给世界层。
 *
 * 用法：
 *   AiWorldConfig.get() / AiWorldConfig.save(patch) / AiWorldConfig.openSettings()
 *   AiWorldAgent.chat("今天累不累") -> Promise<{ action, reply } | null>
 */
(function (global) {
  "use strict";

  const KEY = "aiworld.agent.v1";
  const LLM_TIMEOUT = 20000;

  const ACTIONS = [
    "sleep", "wake", "phone", "computer", "window", "stretch", "walk", "sit", "stand",
  ];
  const ACTION_LABEL = {
    sleep: "上床睡觉", wake: "起床", phone: "玩手机", computer: "玩电脑",
    window: "看风景", stretch: "伸懒腰", walk: "走动", sit: "坐下", stand: "站起",
  };
  const SYSTEM_PROMPT = [
    "你是一个住在 3D 房间里的二次元女孩，用户正在房间里跟你说话。",
    "只输出一个 JSON 对象，不要输出其他任何内容：",
    '{"action":"动作或 none","reply":"一句中文回复，20 字以内，第一人称"}',
    "action 只能取这些值：",
    "sleep（上床睡觉）、wake（起床）、phone（玩手机）、computer（玩电脑 / 打字）、",
    "window（走到窗边看风景）、stretch（伸懒腰）、walk（在房间里走动）、",
    "sit（坐下）、stand（站起）、none（不用动）。",
    "只有用户明确让她做这些事时才给 action，闲聊一律 none。",
  ].join("\n");

  function defaults() {
    return { bridgeUrl: "", llmUrl: "", llmKey: "", llmModel: "" };
  }

  function readLocal() {
    try {
      const raw = global.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_e) {
      return null;
    }
  }

  function get() {
    const cfg = Object.assign(defaults(), readLocal() || {});
    // 桌面版：配置文件在用户目录里，跨启动有效（本地服务的端口每次都不同）。
    const desk = global.aiWorldDesktop;
    if (desk && desk.config && typeof desk.config.load === "function") {
      try {
        const res = desk.config.load();
        if (res && typeof res === "object") Object.assign(cfg, res);
      } catch (_e) {
        /* 读不到就用浏览器里的配置 */
      }
    }
    return cfg;
  }

  function save(patch) {
    const next = Object.assign(get(), patch || {});
    try {
      global.localStorage.setItem(KEY, JSON.stringify(next));
    } catch (_e) {
      /* 隐私模式下写不进去，忽略 */
    }
    const desk = global.aiWorldDesktop;
    if (desk && desk.config && typeof desk.config.save === "function") {
      try {
        desk.config.save(next);
      } catch (_e) {
        /* 忽略 */
      }
    }
    return next;
  }

  /* ---------------- 设置面板 ---------------- */

  let dialogWired = false;

  function openSettings() {
    const dlg = global.document.getElementById("agent-dialog");
    if (!dlg) return false;
    const cfg = get();
    const set = (id, v) => {
      const el = global.document.getElementById(id);
      if (el) el.value = v || "";
    };
    set("cfg-bridge", cfg.bridgeUrl);
    set("cfg-llm-url", cfg.llmUrl);
    set("cfg-llm-model", cfg.llmModel);
    set("cfg-llm-key", cfg.llmKey);

    if (!dialogWired) {
      dialogWired = true;
      const form = global.document.getElementById("agent-form");
      if (form) {
        form.addEventListener("submit", (ev) => {
          ev.preventDefault();
          const val = (id) => {
            const el = global.document.getElementById(id);
            return el ? el.value.trim() : "";
          };
          save({
            bridgeUrl: val("cfg-bridge"),
            llmUrl: val("cfg-llm-url"),
            llmModel: val("cfg-llm-model"),
            llmKey: val("cfg-llm-key"),
          });
          if (typeof global.__worldApplyConfig === "function") global.__worldApplyConfig();
          if (dlg.close) dlg.close();
        });
      }
      const cancel = global.document.getElementById("agent-cancel");
      if (cancel) cancel.addEventListener("click", () => dlg.close && dlg.close());
    }

    if (dlg.showModal) dlg.showModal();
    else dlg.setAttribute("open", "");
    return true;
  }

  /* ---------------- 内置模型 ---------------- */

  function endpoints(url) {
    const base = String(url || "").replace(/\/+$/, "");
    if (!base) return [];
    const list = [base];
    if (!/\/chat\/completions$/.test(base)) list.push(base + "/chat/completions");
    return list;
  }

  /** 从模型输出里抠出 JSON（容忍 ```json 代码块和前后废话）。 */
  function parseReply(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        const action = ACTIONS.indexOf(obj.action) >= 0 ? obj.action : "";
        const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
        if (action || reply) return { action, reply };
      } catch (_e) {
        /* 不是合法 JSON，当成纯文本回复 */
      }
    }
    return { action: "", reply: s.replace(/^["'`]+|["'`]+$/g, "").slice(0, 120) };
  }

  /** 发一次 POST：桌面版走主进程代理（不受 CORS 限制），浏览器里直接 fetch。 */
  async function post(url, headers, body, signal) {
    const desk = global.aiWorldDesktop;
    if (desk && typeof desk.llmRequest === "function") {
      const r = await desk.llmRequest({ url: url, headers: headers, body: body });
      if (!r || !r.ok) {
        const err = new Error((r && r.error) || "HTTP " + (r && r.status));
        err.status = r && r.status;
        throw err;
      }
      return JSON.parse(r.body);
    }
    const resp = await global.fetch(url, {
      method: "POST",
      headers: headers,
      body: body,
      signal: signal,
    });
    if (!resp.ok) {
      const err = new Error("HTTP " + resp.status);
      err.status = resp.status;
      throw err;
    }
    return await resp.json();
  }

  async function chat(text) {
    const cfg = get();
    if (!cfg.llmUrl || !cfg.llmModel) return null;
    const ctrl = typeof global.AbortController === "function" ? new global.AbortController() : null;
    const timer = ctrl ? global.setTimeout(() => ctrl.abort(), LLM_TIMEOUT) : 0;
    const headers = { "Content-Type": "application/json" };
    if (cfg.llmKey) headers.Authorization = "Bearer " + cfg.llmKey;
    const body = JSON.stringify({
      model: cfg.llmModel,
      temperature: 0.8,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: String(text || "") },
      ],
    });
    try {
      let lastErr = null;
      for (const url of endpoints(cfg.llmUrl)) {
        let data;
        try {
          data = await post(url, headers, body, ctrl ? ctrl.signal : undefined);
        } catch (err) {
          lastErr = err;
          // 4xx 说明地址通了，是密钥/参数问题，换路径也没用。
          if (err && err.status && err.status < 500) break;
          continue;
        }
        const msg = data && data.choices && data.choices[0] && data.choices[0].message;
        const raw = msg && msg.content;
        return parseReply(raw) || { action: "", reply: "" };
      }
      throw lastErr || new Error("请求失败");
    } finally {
      if (timer) global.clearTimeout(timer);
    }
  }

  function actionLabel(name) {
    return ACTION_LABEL[name] || name;
  }

  global.AiWorldConfig = { get: get, save: save, openSettings: openSettings };
  global.AiWorldAgent = { chat: chat, actions: ACTIONS, actionLabel: actionLabel };
})(typeof window !== "undefined" ? window : globalThis);

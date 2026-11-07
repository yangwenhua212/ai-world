/* AI World — 启动 VRM 渲染器，加载模型，场景层由渲染器自动挂载。 */
(function () {
  "use strict";

  var VRM_URL = "models/avatar.vrm";

  function boot() {
    var canvas = document.getElementById("avatar");
    var status = document.getElementById("status");
    if (!window.AiWorldRenderer || !window.THREE) {
      status.textContent = "three.js 未加载（检查网络 / CDN）";
      return;
    }

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    // 透明画布：房间关闭时露出页面背景（桌宠形态）。
    canvas.style.background = "linear-gradient(180deg,#1b2130 0%,#0c0e14 100%)";

    var renderer;
    try {
      renderer = new window.AiWorldRenderer(canvas, {});
    } catch (err) {
      status.textContent = "渲染器启动失败：" + (err && err.message ? err.message : err);
      return;
    }

    status.textContent = "加载 VRM…";
    renderer.setModel(VRM_URL).then(function (res) {
      if (res && res.ok) {
        var world = renderer._world;
        var mode = world && world._isNight ? "夜间" : "白天";
        status.textContent = "已加载 " + VRM_URL + " · " + mode;
      } else {
        status.textContent = "VRM 加载失败：" + (res && res.error ? res.error : "unknown");
      }
    });

    window.__aiWorldRenderer = renderer;
    var Bridge = window.AiWorldBridge;
    if (Bridge) {
      window.__worldBridge = new Bridge(renderer, {});
    }

    document.querySelectorAll("[data-preset]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        renderer.setCameraPreset(btn.getAttribute("data-preset"));
      });
    });
    document.querySelectorAll("[data-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        renderer.setAction(btn.getAttribute("data-action"));
        if (btn.getAttribute("data-action") === "sleep") renderer.setCameraPreset("bed");
        if (btn.getAttribute("data-action") === "window") renderer.setCameraPreset("window");
        syncToggles();
      });
    });
    document.getElementById("room-toggle").addEventListener("change", function (e) {
      renderer.setRoomVisible(e.target.checked);
    });
    document.getElementById("sit-toggle").addEventListener("change", function (e) {
      renderer.setSitting(e.target.checked);
    });

    // ---- 文字驱动：不接任何语音/智能体，也能用一句话让人物动起来 ----
    // 同步左上角开关，避免睡下/站起后"坐姿"勾选状态和实际姿态不一致。
    function syncToggles() {
      var sit = document.getElementById("sit-toggle");
      var room = document.getElementById("room-toggle");
      if (sit && renderer._world) sit.checked = renderer._world._sitting;
      if (room && renderer._world) room.checked = renderer._world.group.visible;
    }

    var captionEl = document.getElementById("caption");
    var captionTimer = 0;
    function caption(text) {
      if (!captionEl) return;
      captionEl.textContent = text;
      captionEl.style.opacity = text ? "1" : "0";
      if (captionTimer) clearTimeout(captionTimer);
      if (text) captionTimer = setTimeout(function () { captionEl.style.opacity = "0"; }, 1800);
    }

    var RULES = [
      [/起床|醒来|睡醒|别睡/, "wake", "起床"],
      [/睡觉|睡吧|躺下|上床|晚安|休息|困/, "sleep", "上床睡觉"],
      [/玩.{0,3}电脑|用.{0,3}电脑|打字|敲键盘/, "computer", "玩电脑"],
      [/看风景|窗外|风景|开窗|窗户|窗口/, "window", "看风景"],
      [/手机/, "phone", "玩手机"],
      [/懒腰|伸展|伸伸/, "stretch", "伸懒腰"],
      [/走动|走一走|散步|走两步|走路/, "walk", "走动"],
      [/站起来|站起|起立|站着/, "stand", "站起"],
      [/坐下|坐下来|坐好|坐着|坐/, "sit", "坐下"],
      [/书桌视角|电脑前|书桌/, "preset:desk", "书桌视角"],
      [/房间视角|全景/, "preset:room", "房间视角"],
      [/肖像|特写|近景/, "preset:portrait", "肖像视角"],
      [/桌宠|隐藏房间|关掉房间|关闭房间/, "room:off", "桌宠形态"],
      [/显示房间|打开房间/, "room:on", "显示房间"],
    ];

    /** 解析一句自然语言并驱动人物，命中返回 true。 */
    function runCommand(text) {
      var s = String(text || "");
      if (!s.trim()) return false;
      for (var i = 0; i < RULES.length; i++) {
        if (!RULES[i][0].test(s)) continue;
        var code = RULES[i][1];
        var label = RULES[i][2];
        if (code === "sit") {
          renderer.setSitting(true);
          document.getElementById("sit-toggle").checked = true;
        } else if (code === "stand") {
          renderer.setSitting(false);
          document.getElementById("sit-toggle").checked = false;
        } else if (code.indexOf("preset:") === 0) {
          renderer.setCameraPreset(code.slice(7));
        } else if (code.indexOf("room:") === 0) {
          var on = code.slice(5) === "on";
          renderer.setRoomVisible(on);
          document.getElementById("room-toggle").checked = on;
        } else {
          renderer.setAction(code);
          if (code === "sleep") renderer.setCameraPreset("bed");
          if (code === "window") renderer.setCameraPreset("window");
          if (code === "computer") renderer.setCameraPreset("desk");
        }
        syncToggles();
        caption("→ " + label);
        return true;
      }
      // 不是动作指令，就当成一条发给角色的消息：
      // 桌面手机弹提示 → 她自动去拿手机看 → 回复 → 放下；要她做事的消息会直接去电脑。
      if (renderer.notifyMessage && renderer.notifyMessage(s)) {
        caption("收到消息：" + s);
        return true;
      }
      caption("没听懂：" + s);
      return false;
    }

    // 角色回复/说话时同步到字幕，并转发给智能体桥（接了的话）。
    window.addEventListener("ai-world-say", function (ev) {
      var text = String((ev && ev.detail) || "");
      if (!text) return;
      caption(text);
      if (window.__worldBridge && window.__worldBridge.send) {
        window.__worldBridge.send({ type: "reply", text: text });
      }
    });

    // 智能体（任何语言/框架）都可以通过 postMessage 或 WS 发 {type:"command", text:"…"}
    window.__worldCommand = runCommand;

    var form = document.getElementById("cmd-form");
    if (form) {
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var input = document.getElementById("cmd-input");
        runCommand(input.value);
        input.value = "";
        input.focus();
      });
    }

    window.addEventListener("resize", function () {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      if (renderer._renderer) renderer._renderer.setSize(canvas.width, canvas.height, false);
      if (renderer._camera) {
        renderer._camera.aspect = canvas.width / canvas.height;
        renderer._camera.updateProjectionMatrix();
      }
    });
  }

  if (window.__threeReady) boot();
  else window.addEventListener("three-ready", boot);
})();

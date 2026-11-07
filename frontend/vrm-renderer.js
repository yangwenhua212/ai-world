/* AI World — VRM 渲染器（本项目原创实现）
 *
 * 只依赖两个 MIT 库：three.js 与 @pixiv/three-vrm。
 * 职责：透明画布上渲染 VRM 形象；待机摆动、眨眼、口型/表情写入；
 * 把场景层（world-layer.js）挂到同一个 Scene / Camera / 渲染循环上。
 *
 * 对外接口：
 *   new AiWorldRenderer(canvas, opts)
 *   setModel(url)                  -> Promise<{ ok: boolean, error?: string }>
 *   setMouthOpen(v) / resetMouth() 口型 [0,1]
 *   setExpression(index, name)     情绪预设（happy/angry/sad/relaxed/surprised）
 *   setCameraPreset(name)          交给场景层：desk | room | portrait
 *   setRoomVisible(visible)        开/关房间（桌宠形态）
 *   setSitting(on)                 坐/站（房间层负责过渡动画）
 *   dispose()
 */
(function (global) {
  "use strict";

  const LOAD_TIMEOUT_MS = 10000;
  const BLINK_INTERVAL = [2000, 6000]; // 眨眼间隔（毫秒）
  const BLINK_DURATION = 130; // 单次眨眼时长（毫秒）
  const EMOTION_ALIASES = {
    joy: "happy",
    fun: "relaxed",
    anger: "angry",
    sorrow: "sad",
    surprise: "surprised",
  };

  /** 把音频按 100Hz 采样成音量包络（0~1），供口型使用。 */
  function buildEnvelope(buffer) {
    const step = Math.max(1, Math.round(buffer.sampleRate / 100));
    const frames = Math.floor(buffer.length / step);
    const env = new Float32Array(frames);
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      channels.push(buffer.getChannelData(c));
    }
    for (let i = 0; i < frames; i++) {
      const s0 = i * step;
      const s1 = Math.min(buffer.length, s0 + step);
      let sum = 0;
      for (let c = 0; c < channels.length; c++) {
        const d = channels[c];
        for (let s = s0; s < s1; s++) sum += d[s] * d[s];
      }
      env[i] = Math.sqrt(sum / Math.max(1, (s1 - s0) * channels.length));
    }
    // 用 95 分位做归一化，避免个别爆音把整段口型压扁。
    const sorted = Array.from(env).sort((a, b) => a - b);
    const peak = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1] || 0;
    const gain = peak > 0.0001 ? 1 / peak : 0;
    for (let i = 0; i < frames; i++) env[i] = Math.min(1, env[i] * gain);
    return env;
  }

  class AiWorldRenderer {
    constructor(canvas, opts) {
      opts = opts || {};
      const THREE = global.THREE;
      if (!THREE) throw new Error("three.js 未加载");
      if (!canvas) throw new Error("缺少 canvas");
      if (!global.GLTFLoader) throw new Error("GLTFLoader 未加载");

      this.canvas = canvas;
      this._THREE = THREE;
      this.type = "AiWorld";

      // 场景与相机：相机初始值会被房间层的预设立即覆盖。
      this._scene = new THREE.Scene();
      this._camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
      this._camera.position.set(0, 1.5, 3);

      this._renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
      });
      this._renderer.setClearAlpha(0);
      this._renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
      this._renderer.setSize(canvas.width || 1, canvas.height || 1, false);
      this._camera.aspect = (canvas.width || 1) / (canvas.height || 1);
      this._camera.updateProjectionMatrix();

      this._vrm = null;
      this._world = null;
      this._baseY = 0;
      this._baseRotationY = 0;
      this._mouth = 0;
      this._mouthExpr = null;
      this._emotion = null;
      this._ctx = null; // 惰性创建的 AudioContext
      this._speech = null; // { src, env, duration, t0Ctx, t0Wall }
      this._pendingSpeech = null; // 模型还没加载完时先排队，加载完再播
      this._blinkAt = 0;
      this._blinkStart = 0;
      this._lastNow = 0;
      this._elapsed = 0;
      this._running = true;

      // 桌宠形态（房间关闭）下的补光：房间灯在 room 组里，关掉房间就照不到角色。
      this._fillHemi = new THREE.HemisphereLight(0xffffff, 0x8a97a8, 1.0);
      this._fillKey = new THREE.DirectionalLight(0xfff2e2, 1.0);
      this._fillKey.position.set(2, 3, 2.5);
      this._fallbackLights = new THREE.Group();
      this._fallbackLights.add(this._fillHemi);
      this._fallbackLights.add(this._fillKey);
      this._scene.add(this._fallbackLights);
      this._applyLightMode(true); // 默认房间开启，只补一点点光

      // 房间层（可选）：与角色共用场景、相机和渲染循环。
      if (typeof global.WorldLayer === "function") {
        try {
          this._world = new global.WorldLayer({
            THREE: THREE,
            scene: this._scene,
            camera: this._camera,
            renderer: this, // 房间层需要写 _baseY / _baseRotationY
            gltfLoader: global.GLTFLoader,
            canvas: canvas,
          });
        } catch (err) {
          console.warn("[renderer] 房间层挂载失败：", err);
          this._world = null;
        }
      }

      this._lastNow = this._now();
      this._loop = this._frame.bind(this);
      this._raf = global.requestAnimationFrame(this._loop);
    }

    _now() {
      return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    }

    /* ---------------- 模型 ---------------- */

    setModel(url) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (res) => {
          if (settled) return;
          settled = true;
          resolve(res);
        };
        const timer = setTimeout(() => finish({ ok: false, error: "加载超时" }), LOAD_TIMEOUT_MS);

        const loader = new global.GLTFLoader();
        if (global.THREE_VRM && global.THREE_VRM.VRMLoaderPlugin) {
          loader.register((parser) => new global.THREE_VRM.VRMLoaderPlugin(parser));
        }

        loader.load(
          url,
          (gltf) => {
            const vrm = gltf && gltf.userData && gltf.userData.vrm;
            if (!vrm || !vrm.scene) {
              finish({ ok: false, error: "文件不是有效的 VRM" });
              return;
            }
            const utils = global.THREE_VRM && global.THREE_VRM.VRMUtils;
            try {
              // VRM 0.x 的坐标朝向是反的，需要转到 three.js 的约定。
              if (vrm.meta && vrm.meta.metaVersion === "0" && utils && utils.rotateVRM0) {
                utils.rotateVRM0(vrm);
              }
            } catch (_e) {
              /* 旋转失败不影响渲染 */
            }

            this._vrm = vrm;
            this._scene.add(vrm.scene);
            this._detectExpressions();
            if (this._world) this._world.setAvatar(vrm);
            if (this._pendingSpeech) {
              const pending = this._pendingSpeech;
              this._pendingSpeech = null;
              this.speakAudio(pending.source, { silent: pending.silent });
            }
            finish({ ok: true });
            clearTimeout(timer);
          },
          undefined,
          (err) => {
            finish({ ok: false, error: (err && err.message) || "网络或格式错误" });
            clearTimeout(timer);
          }
        );
      });
    }

    _detectExpressions() {
      this._mouthExpr = null;
      const m = this._vrm && this._vrm.expressionManager;
      if (!m) return;
      const names = (m.expressions || []).map((e) => e && e.expressionName);
      this._mouthExpr = names.indexOf("aa") !== -1 ? "aa" : names.indexOf("a") !== -1 ? "a" : null;
    }

    _hasExpression(name) {
      const m = this._vrm && this._vrm.expressionManager;
      if (!m || !name) return false;
      return (m.expressions || []).some((e) => e && e.expressionName === name);
    }

    _setExpressionValue(name, value) {
      const m = this._vrm && this._vrm.expressionManager;
      if (!m || !name) return;
      try {
        m.setValue(name, value);
      } catch (_e) {
        /* 模型没有这个表情时静默跳过 */
      }
    }

    /* ---------------- 口型 / 表情 ---------------- */

    setMouthOpen(v) {
      const n = typeof v === "number" && isFinite(v) ? v : 0;
      this._mouth = Math.max(0, Math.min(1, n));
    }

    resetMouth() {
      this._mouth = 0;
    }

    /* ---------------- 语音 / 口型 ---------------- */

    _ensureAudio() {
      if (!this._ctx) {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return null;
        this._ctx = new Ctx();
      }
      return this._ctx;
    }

    async _loadAudioBytes(source) {
      if (typeof source === "string") {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error("音频请求失败 " + resp.status);
        return await resp.arrayBuffer();
      }
      if (source instanceof ArrayBuffer) return source;
      if (source && typeof source.arrayBuffer === "function") return await source.arrayBuffer();
      throw new Error("不支持的音频输入");
    }

    /**
     * 播放一段 TTS 音频并驱动口型。
     * source 支持：URL / data:URL / ArrayBuffer / Blob。
     * options.silent 为 true 时不出声，只按音量包络驱动口型（声音由宿主播放）。
     * 播放期间每帧从音量包络取口型；再次调用或 stopSpeaking() 会打断上一段。
     */
    async speakAudio(source, options) {
      if (!source) return false;
      const silent = !!(options && options.silent);
      if (!this._vrm) {
        // 模型还在加载：先存着，setModel 完成后自动播放。
        this._pendingSpeech = { source: source, silent: silent };
        return false;
      }
      const ctx = this._ensureAudio();
      if (!ctx) return false;
      this.stopSpeaking();
      try {
        const bytes = await this._loadAudioBytes(source);
        const buffer = await new Promise((resolve, reject) => {
          const maybe = ctx.decodeAudioData(bytes, resolve, reject);
          if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
        });
        if (ctx.state === "suspended") {
          try {
            await ctx.resume();
          } catch (_e) {
            /* 无音频设备时保持静音，口型仍按墙钟推进 */
          }
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        // silent：声音由宿主（Hermes 主窗口）播放，这里只取音量驱动口型。
        if (!silent) src.connect(ctx.destination);
        const startAt = ctx.currentTime + 0.03;
        src.start(startAt);
        this._speech = {
          src: src,
          silent: silent,
          env: buildEnvelope(buffer),
          duration: buffer.duration,
          t0Ctx: startAt,
          t0Wall: this._now() + 30,
        };
        src.onended = () => {
          if (this._speech && this._speech.src === src) this._endSpeech(false);
        };
        return true;
      } catch (err) {
        console.warn("[renderer] 音频播放失败：", err);
        return false;
      }
    }

    stopSpeaking() {
      const sp = this._speech;
      this._speech = null;
      this._mouth = 0;
      if (sp) {
        try {
          sp.src.stop();
        } catch (_e) {
          /* 已结束的 source 再 stop 会抛错，忽略 */
        }
        this._emitSpeechEnd(true);
      }
    }

    _endSpeech(interrupted) {
      const had = !!this._speech;
      this._speech = null;
      this._mouth = 0;
      // 音频 onended 与逐帧超时判断可能同时到达，只回传一次。
      if (had) this._emitSpeechEnd(!!interrupted);
    }

    _emitSpeechEnd(interrupted) {
      if (this.canvas && typeof global.CustomEvent === "function") {
        this.canvas.dispatchEvent(new global.CustomEvent("ai-world:speech-end", { detail: { interrupted: interrupted } }));
      }
      if (typeof this.onSpeechEnd === "function") {
        try {
          this.onSpeechEnd(interrupted);
        } catch (_e) {
          /* 回调异常不影响渲染 */
        }
      }
    }

    _updateSpeechMouth() {
      const sp = this._speech;
      if (!sp) return;
      const ctx = this._ctx;
      // AudioContext 被挂起时音频不前进，改用墙钟，保证口型仍然动。
      const t = ctx && ctx.state === "running" ? ctx.currentTime - sp.t0Ctx : (this._now() - sp.t0Wall) / 1000;
      if (t >= sp.duration) {
        this._endSpeech(false);
        return;
      }
      if (t < 0) return;
      const idx = Math.min(sp.env.length - 1, Math.floor(t * 100));
      const target = Math.pow(sp.env[idx], 0.55); // 稍微夸张一点，低音量也张口
      const k = target > this._mouth ? 0.6 : 0.32; // 张口快、收口慢
      this._mouth += (target - this._mouth) * k;
    }

    setExpression(index, name) {
      const target = EMOTION_ALIASES[name] || name;
      if (this._emotion && this._emotion !== target) {
        this._setExpressionValue(this._emotion, 0);
      }
      if (this._hasExpression(target)) {
        this._setExpressionValue(target, 1);
        this._emotion = target;
      } else {
        // 没有对应预设（例如 neutral）：清掉上一个情绪，保持中性。
        this._emotion = null;
      }
    }

    /* ---------------- 每帧动画 ---------------- */

    _idle() {
      const root = this._vrm && this._vrm.scene;
      if (!root) return;
      // 房间层在走路/躺下时会直接接管根节点，此时不能再叠加待机动作。
      if (this._world && this._world._drivesRoot) return;
      // 轻微摆头 + 呼吸；房间层会在此基础上写自己的基础位置。
      root.rotation.y = this._baseRotationY + Math.sin(this._elapsed * 0.6) * 0.05;
      root.position.y = this._baseY + Math.sin(this._elapsed * 1.2) * 0.01;
    }

    _blink(nowMs) {
      if (!this._hasExpression("blink")) return;
      if (this._blinkAt === 0) {
        this._blinkAt = nowMs + BLINK_INTERVAL[0] + Math.random() * (BLINK_INTERVAL[1] - BLINK_INTERVAL[0]);
      }
      if (this._blinkStart === 0 && nowMs >= this._blinkAt) {
        this._blinkStart = nowMs;
        this._blinkAt = nowMs + BLINK_INTERVAL[0] + Math.random() * (BLINK_INTERVAL[1] - BLINK_INTERVAL[0]);
      }
      if (this._blinkStart === 0) return;
      const p = (nowMs - this._blinkStart) / BLINK_DURATION;
      if (p >= 1) {
        this._blinkStart = 0;
        this._setExpressionValue("blink", 0);
        return;
      }
      // 0→1→0 的三角波：闭眼再睁开。
      this._setExpressionValue("blink", p < 0.5 ? p * 2 : (1 - p) * 2);
    }

    _applyMouth() {
      if (!this._mouthExpr) return;
      this._setExpressionValue(this._mouthExpr, this._mouth);
    }

    _frame(now) {
      if (!this._running) return;
      const t = typeof now === "number" ? now : this._now();
      const dt = Math.min(0.05, Math.max(0, (t - this._lastNow) / 1000));
      this._lastNow = t;
      this._elapsed += dt;

      this._idle();
      this._blink(this._now());

      if (this._vrm && typeof this._vrm.update === "function") {
        try {
          this._vrm.update(dt);
        } catch (_e) {
          /* 单帧异常不中断渲染 */
        }
      }
      this._updateSpeechMouth();
      this._applyMouth();

      if (this._world && typeof this._world.update === "function") {
        try {
          this._world.update(dt);
        } catch (_e) {
          /* 房间层异常不中断渲染 */
        }
      }

      this._renderer.render(this._scene, this._camera);
      this._raf = global.requestAnimationFrame(this._loop);
    }

    /* ---------------- 房间 / 相机 ---------------- */

    setCameraPreset(name) {
      if (this._world) this._world.setPreset(name);
    }

    setRoomVisible(visible) {
      const on = !!visible;
      if (this._world) this._world.setRoomVisible(on);
      this._applyLightMode(on);
    }

    /** 房间自带灯光，开着房间时补光调弱；切到桌宠形态（关房间）时提亮。 */
    _applyLightMode(roomOn) {
      this._fillHemi.intensity = roomOn ? 0.35 : 1.0;
      this._fillKey.intensity = roomOn ? 0.3 : 1.0;
    }

    setSitting(on) {
      if (this._world) this._world.setSitting(on);
    }

    /** 动作：sleep | wake | phone | computer | window | stretch | walk */
    setAction(name) {
      return this._world ? this._world.startAction(name) : false;
    }

    /**
     * 给角色发一条消息：桌面手机提示 → 自动去拿手机看 → 回复 → 放下；
     * 判断为“要她做事”的消息时，直接去电脑前干活。
     * opts: { mode: "auto" | "chat" | "task", reply: "自定义回复" }
     */
    notifyMessage(text, opts) {
      return this._world ? this._world.notifyMessage(text, opts) : false;
    }

    dispose() {
      this._running = false;
      if (this._raf) global.cancelAnimationFrame(this._raf);
      if (this._vrm) {
        this._scene.remove(this._vrm.scene);
        this._vrm = null;
      }
      if (this._ctx) {
        try {
          this._ctx.close();
        } catch (_e) {
          /* 已关闭时忽略 */
        }
        this._ctx = null;
      }
      if (this._renderer) this._renderer.dispose();
    }
  }

  global.AiWorldRenderer = AiWorldRenderer;
})(typeof window !== "undefined" ? window : globalThis);

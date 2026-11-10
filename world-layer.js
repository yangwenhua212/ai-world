/* AI World — three.js 世界场景层
 *
 * 在 VRM 渲染器的场景里追加一个立体房间（地板 / 墙 / 床 / 书桌 / 显示器 /
 * 台灯），并把 VRM 角色放进房间里。房间与角色共用同一个 THREE.Scene、
 * 同一个相机和渲染循环；房间只是一个可开关的 Group。
 *
 * 用法（由 frontend/vrm-renderer.js 挂载）：
 *   const world = new WorldLayer({ THREE, scene, camera, renderer, gltfLoader, canvas });
 *   world.setAvatar(vrm);          // VRM 加载完成后调用
 *   world.setPreset('room');       // desk | room | portrait
 *   world.setRoomVisible(false);   // 切到透明桌宠形态
 */
(function (global) {
  "use strict";

  const PRESETS = {
    desk: { pos: [1.35, 1.50, 1.95], look: [-0.30, 1.05, -1.10], fov: 30 },
    room: { pos: [1.20, 2.00, 2.40], look: [0.55, 0.85, -1.10], fov: 48 },
    portrait: { pos: [0.12, 1.52, 0.34], look: [-0.40, 1.40, -0.55], fov: 26 },
    // 床头视角：躺下睡觉时用，能看全身在床上的姿态。
    bed: { pos: [0.55, 1.45, -1.35], look: [2.05, 0.55, 0.35], fov: 42 },
    // 窗边视角：看风景时用，能同时看到窗户、窗外和角色。
    window: { pos: [0.55, 1.60, 0.80], look: [-2.00, 1.10, -2.05], fov: 46 },
  };

  const AVATAR_POS = [-0.40, 0, -0.22];
  const CHAIR_POS = [-0.40, 0, -0.74]; // 椅心到桌沿 0.29m > 五爪半径 0.25m，旋转时不会插进桌子
  const SIT_OFFSET_Z = 0.09; // 坐姿时角色相对椅心的前移量
  const DESK_TOP = 0.75;
  const BED_FOOT = [1.17, 0.55]; // 躺下后脚所在的位置（床面上，床已向内移避开右墙）
  const BED_WALK = [2.04, -0.62]; // 上床前走到这里（床外侧走道，正对坐下的位置）
  const BED_SIT_HIP = [2.04, -0.30]; // 坐床沿时的髋部位置：屁股压住床垫边，脚垂在床外
  const BED_SIT_YAW = Math.PI; // 坐床沿时的朝向：背对床、面朝房间（脚落在床外地面）
  const BED_LEGS_YAW = -Math.PI / 2; // 在床沿转身后的朝向：身体顺着床的长边（头朝 +X）
  const WINDOW_SPOT = [-2.21, -1.30]; // 看风景的站位：窗洞正前方，避开书桌左沿 -1.40
  const WINDOW_YAW = Math.PI; // 面朝窗户（-Z）
  const WALK_SPEED = 0.80; // m/s

  /** 一阶平滑：cur 向 target 按 speed 收敛，与帧率无关。 */
  function ease(cur, target, speed, dt) {
    return cur + (target - cur) * Math.min(1, dt * speed);
  }

  class WorldLayer {
    constructor(opts) {
      this.THREE = opts.THREE;
      this.scene = opts.scene;
      this.camera = opts.camera;
      this.renderer = opts.renderer;
      this.canvas = opts.canvas;
      this.loader = opts.gltfLoader ? new opts.gltfLoader() : null;

      global.__aiWorld = this; // 全局入口：不绑定任何特定智能体
      this.group = new this.THREE.Group();
      this.group.name = "ai-world";
      this.scene.add(this.group);

      this._avatar = null;
      this._avatarBase = null;
      this._sitting = true; // 默认坐在书桌前
      this._preset = "desk";
      this._look = new this.THREE.Vector3();
      this._targetPos = new this.THREE.Vector3();
      this._targetLook = new this.THREE.Vector3();
      this._fov = 30;
      this._targetFov = 30;

      this._isNight = this._localHour() < 7 || this._localHour() >= 19;
      this._chairAngle = 0;
      this._poseT = 1; // 0 = 站姿，1 = 坐姿；每帧向目标插值
      this._ankleTarget = null; // 站姿下测得的脚踝高度，作为“脚底贴地”的基准
      this._time = 0;

      // ---- 行为状态机 ----
      this._action = "sit"; // sit | stand | walk | sleep | phone | stretch | wake
      this._phase = ""; // 当前动作的子阶段
      this._actionT = 0; // 当前动作已播时长
      this._sleepT = 0; // 入睡后经过的时间
      this._walkTo = new this.THREE.Vector3();
      this._walkAmp = 0; // 走路摆腿幅度 0~1
      this._walkPhase = 0;
      this._phoneT = 0; // 玩手机姿态权重
      this._stretchT = 0; // 伸懒腰权重
      this._lookOut = 0; // 窗边眺望的抬头权重
      this._phoneGrab = 0; // 伸手拿手机的进度
      // ---- 消息驱动（手机提示 → 拿手机看 → 回复 → 放下 / 直接去电脑干活） ----
      this._msgText = ""; // 收到的消息内容
      this._msgReply = ""; // 看完后的回复文案
      this._msgTask = false; // 是否是要她做事的消息（去电脑）
      this._msgNotifyT = 0; // 桌面手机提示倒计时
      this._msgShown = 0; // 消息在手里停留时长
      this._msgReplied = false; // 是否已显示回复
      this._msgBlink = 0; // 提示闪烁相位
      this._lieT = 0; // 躺下权重
      this._lieYFix = null; // 躺下后按包围盒修正的高度
      this._bedSitPos = null; // 坐床沿时的根节点位置（测量得出）
      this._bedSitFrom = null; // 坐下前的站位，用于"站位 ↔ 坐位"插值
      this._bedFold = null; // 大腿折叠权重（躺下/收脚时接管）
      this._bedShin = null; // 小腿折叠权重（收脚时单独控制）
      this._bedSitLeg = 0; // 床沿坐姿的抬腿量（床矮，脚要落回地面）
      this._legT = 0; // 收脚/放脚进度
      this._hipLocal = null; // 髋骨相对根节点的偏移（以髋部为轴放平用）
      this._drivesRoot = false; // 由世界层接管根节点（走路/躺下时）
      this._lieRoot = null; // 躺下时根节点位置（每次上床随机一点点）
      this._lieYaw = -Math.PI / 2; // 躺下时的最终朝向（可小幅随机）

      this._buildRoom();
      this._buildLights();
      this._buildDressing();
      this._initChairDrag();
      this.setPreset("desk", true);
    }

    _localHour() {
      const d = new Date();
      return d.getHours() + d.getMinutes() / 60;
    }

    _mat(color, opts) {
      const THREE = this.THREE;
      return new THREE.MeshStandardMaterial(
        Object.assign({ color: color, roughness: 0.9, metalness: 0 }, opts || {})
      );
    }

    _box(w, h, d, mat, x, y, z) {
      const THREE = this.THREE;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      this.group.add(mesh);
      return mesh;
    }

    /* ---------------- 房间本体 ---------------- */

    _buildRoom() {
      const THREE = this.THREE;
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(6, 5),
        this._mat(0xc79a6b)
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, 0, 0);
      this.group.add(floor);

      // 后墙：左侧留出窗洞（x -2.86~-1.56，y 1.1~2.4），否则窗后是实心墙，看不到外面。
      // 窗洞避开书桌（书桌左沿 -1.40），人才能真的走到窗前。
      const wallMat = this._mat(0xefe6dc);
      this._box(0.14, 3, 0.12, wallMat, -2.93, 1.5, -2.5);
      this._box(4.56, 3, 0.12, wallMat, 0.72, 1.5, -2.5);
      this._box(1.30, 1.1, 0.12, wallMat, -2.21, 0.55, -2.5);
      this._box(1.30, 0.6, 0.12, wallMat, -2.21, 2.7, -2.5);
      this._box(0.12, 3, 5, wallMat, -3, 1.5, 0);
      this._box(0.12, 3, 5, wallMat, 3, 1.5, 0);

      // 窗框。
      const frameMat = this._mat(0xf7f3ee);
      this._box(1.36, 0.07, 0.06, frameMat, -2.21, 2.4, -2.41);
      this._box(1.36, 0.07, 0.06, frameMat, -2.21, 1.1, -2.41);
      this._box(0.07, 1.37, 0.06, frameMat, -2.86, 1.75, -2.41);
      this._box(0.07, 1.37, 0.06, frameMat, -1.56, 1.75, -2.41);
      this._box(0.07, 1.37, 0.06, frameMat, -2.21, 1.75, -2.41);
      // 窗台。
      this._box(1.42, 0.06, 0.22, frameMat, -2.21, 1.07, -2.36);

      this._buildOutside();
      this._buildWindowSashes();
    }

    /** 窗外风景：程序化生成的夜景（天空 / 月亮 / 星星 / 城市灯火），不依赖外部贴图。 */
    _buildOutside() {
      const THREE = this.THREE;
      const night = this._isNight;
      const c = document.createElement("canvas");
      c.width = 1024;
      c.height = 512;
      const g = c.getContext("2d");
      const sky = g.createLinearGradient(0, 0, 0, 512);
      if (night) {
        sky.addColorStop(0, "#080f26");
        sky.addColorStop(0.55, "#182549");
        sky.addColorStop(1, "#39456e");
      } else {
        sky.addColorStop(0, "#5ba7e0");
        sky.addColorStop(0.6, "#b7dcf7");
        sky.addColorStop(1, "#e9f5ff");
      }
      g.fillStyle = sky;
      g.fillRect(0, 0, 1024, 512);

      // 固定种子的伪随机，刷新后风景不变。
      let seed = 20261108;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };

      if (night) {
        for (let i = 0; i < 180; i++) {
          const x = rnd() * 1024;
          const y = rnd() * 260;
          const r = rnd() * 1.4 + 0.4;
          g.fillStyle = "rgba(255,255,255," + (0.35 + rnd() * 0.6).toFixed(2) + ")";
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fill();
        }
        // 月亮 + 光晕。
        const mg = g.createRadialGradient(742, 118, 8, 742, 118, 96);
        mg.addColorStop(0, "rgba(255,252,226,0.95)");
        mg.addColorStop(0.35, "rgba(232,238,255,0.35)");
        mg.addColorStop(1, "rgba(200,220,255,0)");
        g.fillStyle = mg;
        g.fillRect(640, 16, 210, 210);
        g.fillStyle = "#fbf6dc";
        g.beginPath();
        g.arc(742, 118, 34, 0, Math.PI * 2);
        g.fill();
      } else {
        // 白天：几朵云。
        g.fillStyle = "rgba(255,255,255,0.85)";
        for (let i = 0; i < 7; i++) {
          const x = rnd() * 900 + 40;
          const y = 60 + rnd() * 130;
          const w = 60 + rnd() * 90;
          for (let k = 0; k < 5; k++) {
            g.beginPath();
            g.ellipse(x + k * w * 0.22, y + (k % 2) * 8, w * 0.3, 16 + (k % 2) * 6, 0, 0, Math.PI * 2);
            g.fill();
          }
        }
      }

      // 远近三层楼群：越远越淡，夜里亮窗。
      const rows = night
        ? [
            { base: 0.52, col: "#151f3c", win: "rgba(255,214,140,0.85)" },
            { base: 0.64, col: "#1d2a4b", win: "rgba(255,222,158,0.8)" },
            { base: 0.8, col: "#283555", win: "rgba(255,230,180,0.75)" },
          ]
        : [
            { base: 0.52, col: "#9db6cb", win: "rgba(255,255,255,0.35)" },
            { base: 0.64, col: "#8ba4ba", win: "rgba(255,255,255,0.3)" },
            { base: 0.8, col: "#7b93a9", win: "rgba(255,255,255,0.25)" },
          ];
      rows.forEach((row) => {
        let x = -20;
        while (x < 1044) {
          const w = 34 + rnd() * 66;
          const h = (0.1 + rnd() * 0.3) * 512;
          const top = 512 * row.base - h;
          g.fillStyle = row.col;
          g.fillRect(x, top, w, h + 40);
          // 楼顶小檐。
          g.fillRect(x - 2, top - 4, w + 4, 5);
          // 窗户格子。
          const cols = Math.max(1, Math.floor(w / 14));
          const lines = Math.max(2, Math.floor(h / 18));
          for (let cx = 0; cx < cols; cx++) {
            for (let cy = 0; cy < lines; cy++) {
              if (rnd() < 0.45) continue;
              g.fillStyle = row.win;
              g.fillRect(x + 5 + cx * (w / cols), top + 8 + cy * 17, 5, 7);
            }
          }
          x += w + 6 + rnd() * 16;
        }
      });

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(8, 4), mat);
      plane.position.set(-2.21, 2.0, -4.2);
      this.group.add(plane);

      // 窗外透进来的冷光，夜里有一点月光的层次。
      const glow = new THREE.PointLight(0x9fc4ff, night ? 0.55 : 0.3, 4.5, 2);
      glow.position.set(-2.21, 1.85, -2.15);
      this.group.add(glow);
    }

    /** 两扇可开合的窗扇（铰链在窗洞两侧，向房间内打开）。 */
    _buildWindowSashes() {
      const THREE = this.THREE;
      const glassMat = new THREE.MeshStandardMaterial({
        color: 0xcfe6ff,
        roughness: 0.06,
        metalness: 0,
        transparent: true,
        opacity: 0.13,
        side: THREE.DoubleSide,
      });
      const barMat = this._mat(0xf7f3ee, { roughness: 0.55 });
      const hMat = this._mat(0x9aa0aa, { roughness: 0.35, metalness: 0.6 });
      const mk = (hx, dir, open) => {
        const g = new THREE.Group();
        g.position.set(hx, 1.75, -2.46);
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 1.2), glassMat);
        glass.position.set(dir * 0.33, 0, 0);
        g.add(glass);
        const barV = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.26, 0.045), barMat);
        barV.position.set(dir * 0.64, 0, 0);
        g.add(barV);
        const barT = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 0.045), barMat);
        barT.position.set(dir * 0.33, 0.62, 0);
        g.add(barT);
        const barB = barT.clone();
        barB.position.y = -0.62;
        g.add(barB);
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.03), hMat);
        handle.position.set(dir * 0.58, 0.02, 0.045);
        g.add(handle);
        this.group.add(g);
        return { g, open };
      };
      this._winSashes = [
        mk(-2.86, 1, -1.05),
        mk(-1.56, -1, 1.05),
      ];
      this._winT = 0;
    }

    /** 开窗程度 0~1。 */
    _setWindowOpen(t) {
      if (!this._winSashes) return;
      this._winSashes.forEach((s) => {
        s.g.rotation.y = s.open * t;
      });
    }

    _buildLights() {
      const THREE = this.THREE;
      const amb = new THREE.AmbientLight(0xffffff, this._isNight ? 0.22 : 0.55);
      this.group.add(amb);

      const sun = new THREE.DirectionalLight(
        this._isNight ? 0x8fa8ff : 0xfff0dd,
        this._isNight ? 0.18 : 0.95
      );
      sun.position.set(-2.4, 3.2, -1.2);
      this.group.add(sun);

      this._lampLight = new THREE.PointLight(
        0xffc78a,
        this._isNight ? 2.2 : 0.55,
        5,
        2
      );
      this._lampLight.position.set(-2.55, 1.45, 0.55);
      this.group.add(this._lampLight);

      this._screenLight = new THREE.PointLight(0x8fc7ff, this._isNight ? 1.1 : 0.45, 3, 2);
      this._screenLight.position.set(-0.25, 1.15, -1.38);
      this.group.add(this._screenLight);
    }

    /* ---------------- 家具 ---------------- */

    /** 办公转椅：五爪底座 + 万向轮 + 气压杆 + 坐垫 + 靠背。 */
    _buildOfficeChair() {
      const THREE = this.THREE;
      const chair = new THREE.Group();
      chair.position.fromArray(CHAIR_POS);
      this.group.add(chair);
      this._chair = chair;

      const baseMat = this._mat(0x3b4048, { roughness: 0.6, metalness: 0.4 });
      const seatMat = this._mat(0x4a6fa5);
      const metalMat = this._mat(0x9aa0aa, { roughness: 0.4, metalness: 0.6 });

      // 五爪底座。
      for (let i = 0; i < 5; i++) {
        const arm = new THREE.Group();
        arm.rotation.y = (i * Math.PI * 2) / 5;
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.035, 0.06), baseMat);
        bar.position.set(0.125, 0.05, 0);
        arm.add(bar);
        const wheel = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), baseMat);
        wheel.position.set(0.25, 0.04, 0);
        arm.add(wheel);
        chair.add(arm);
      }

      // 气压杆。
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.30, 12), metalMat);
      post.position.set(0, 0.21, 0);
      chair.add(post);

      // 坐垫。
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.09, 0.46), seatMat);
      seat.position.set(0, 0.40, 0);
      chair.add(seat);

      // 靠背（在角色身后，即 -Z 一侧）。
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.52, 0.075), seatMat);
      back.position.set(0, 0.70, -0.24);
      back.rotation.x = 0.12;
      chair.add(back);
    }

    _place(name, target, axis, pos, rotY, rotZ, tint) {
      if (!this.loader) return;
      const THREE = this.THREE;
      this.loader.load(
        "assets/furniture/" + name + ".gltf",
        (gltf) => {
          const obj = gltf.scene;
          obj.rotation.y = rotY || 0;
          if (rotZ) obj.rotation.z = rotZ;
          obj.updateMatrixWorld(true);
          const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
          const base = axis === "y" ? size.y : Math.max(size.x, size.z);
          if (base > 0) obj.scale.setScalar(target / base);
          obj.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(obj);
          obj.position.set(pos[0], pos[1] - box.min.y, pos[2]);
          if (name === "bed_double_A") {
            // 记录床的落地尺寸：躺下时按它对齐身体。
            // top 用射线量真实床垫面（包围盒顶部是床头板，比床垫高 0.3m，会导致整个人悬空）。
            obj.updateMatrixWorld(true);
            const ray = new THREE.Raycaster(
              new THREE.Vector3(pos[0], 3, pos[2]),
              new THREE.Vector3(0, -1, 0)
            );
            const hit = ray.intersectObject(obj, true)[0];
            this._bedBox = {
              x0: pos[0] + box.min.x,
              x1: pos[0] + box.max.x,
              z0: pos[2] + box.min.z,
              z1: pos[2] + box.max.z,
              top: hit ? hit.point.y : pos[1] + (box.max.y - box.min.y),
            };
          }
          obj.traverse((o) => {
            if (o.isMesh && o.material) {
              o.material.roughness = 0.85;
              o.material.metalness = 0;
              if (tint) {
                o.material = o.material.clone();
                o.material.color.set(tint);
              }
            }
          });
          this.group.add(obj);
        },
        undefined,
        (err) => console.warn("[world] load failed:", name, err)
      );
    }

    _buildDressing() {
      const THREE = this.THREE;

      // 书桌：用 KayKit 长桌，高度 0.75m。
      this._place("table_medium_long", DESK_TOP, "y", [-0.40, 0, -1.78], 0);
      // 办公转椅（程序化：五爪底座 + 气压杆 + 靠背）。
      this._buildOfficeChair();
      // 床（靠右墙）。整体向内收 0.18m，否则床头会插进右墙（墙内表面 x=2.94）。
      this._place("bed_double_A", 2.0, "x", [1.92, 0, 0.55], -Math.PI / 2);
      // 枕头要对准头的落点（躺下后头中心 z≈0.55），否则会枕在枕头边缘。
      this._place("pillow_A", 0.5, "x", [2.37, 0.33, 0.50], -Math.PI / 2);
      // 靠墙矮柜。
      this._place("cabinet_medium_decorated", 1.35, "y", [2.16, 0, -2.20], 0);
      // 落地灯。
      this._place("lamp_standing", 1.7, "y", [-2.58, 0, 0.55], 0);
      // 地毯已去掉：地面留空，视角里不再出现那块灰黄色地毯。
      // 长桌左侧补两根桌腿（原模型左端没有支撑）。
      const legMat = this._mat(0x8b5a3c);
      this._box(0.12, DESK_TOP, 0.12, legMat, -1.40, DESK_TOP / 2, -1.16);
      this._box(0.12, DESK_TOP, 0.12, legMat, -1.40, DESK_TOP / 2, -2.40);

      // 桌上书堆。
      this._place("book_set", 0.32, "x", [0.22, DESK_TOP, -1.46], 0.35);
      // 墙上画框。
      this._place("pictureframe_large_A", 0.62, "x", [0.52, 1.55, -2.42], 0);

      // 显示器（程序化）：屏幕朝向 +Z（面向角色和相机）。
      const bodyMat = this._mat(0x2a2f3a);
      const screenMat = new THREE.MeshStandardMaterial({
        color: 0x9fd3ff,
        emissive: 0x7fb8ff,
        emissiveIntensity: this._isNight ? 0.9 : 1.25,
        roughness: 0.35,
      });
      this._box(0.66, 0.40, 0.04, bodyMat, -0.30, DESK_TOP + 0.45, -1.50);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.60, 0.34), screenMat);
      screen.position.set(-0.30, DESK_TOP + 0.45, -1.475);
      this.group.add(screen);
      this._screenMat = screenMat;
      this._screenBase = screenMat.emissiveIntensity;
      this._box(0.06, 0.22, 0.06, bodyMat, -0.30, DESK_TOP + 0.20, -1.50);
      this._box(0.24, 0.02, 0.14, bodyMat, -0.30, DESK_TOP + 0.09, -1.50);

      // 键盘与杯子。
      this._box(0.44, 0.018, 0.15, this._mat(0xd9dde5), -0.30, DESK_TOP + 0.02, -1.08);
      const mug = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.04, 0.10, 16),
        this._mat(0xe8e2d8)
      );
      mug.position.set(-0.74, DESK_TOP + 0.05, -1.16);
      this.group.add(mug);

      // 鼠标垫 + 鼠标（键盘右侧）。
      const padMat = this._mat(0x2b3550, { roughness: 1 });
      this._box(0.22, 0.006, 0.18, padMat, 0.10, DESK_TOP + 0.004, -1.07);
      const mouseMat = this._mat(0xe6eaf2, { roughness: 0.55 });
      const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.042, 16, 12), mouseMat);
      mouse.scale.set(1, 0.48, 1.55);
      mouse.position.set(0.10, DESK_TOP + 0.026, -1.07);
      this.group.add(mouse);
      // 滚轮。
      this._box(0.012, 0.008, 0.02, this._mat(0x3a4150), 0.10, DESK_TOP + 0.045, -1.10);

      // 桌面手机（平放，屏幕朝上）。放在鼠标左后方，坐着伸手刚好能拿到。
      const phoneMat = this._mat(0x1c1f26, { roughness: 0.5, metalness: 0.2 });
      const deskPhone = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.009, 0.155), phoneMat);
      deskPhone.position.set(0.02, DESK_TOP + 0.006, -1.26);
      this.group.add(deskPhone);
      const phoneScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.063, 0.14), this._screenMaterial());
      phoneScreen.rotation.x = -Math.PI / 2;
      phoneScreen.position.set(0.02, DESK_TOP + 0.011, -1.26);
      this.group.add(phoneScreen);
      this._deskPhone = [deskPhone, phoneScreen];
      this._deskScreen = this._screenOf(phoneScreen, 180, 400);
      this._drawPhoneHome(this._deskScreen);

      // 新消息提示：手机上方一颗会闪的小圆点。
      const badge = new THREE.Mesh(
        new THREE.SphereGeometry(0.011, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xffb44d, toneMapped: false })
      );
      badge.position.set(0.02, DESK_TOP + 0.045, -1.26);
      badge.visible = false;
      this.group.add(badge);
      this._deskBadge = badge;
    }

    /** 屏幕材质：用 canvas 贴图，能显示文字（手机消息 / 电脑任务）。 */
    _screenMaterial() {
      const THREE = this.THREE;
      return new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    }

    /** 给屏幕网格挂一张可重绘的 canvas 贴图。 */
    _screenOf(mesh, w, h) {
      const THREE = this.THREE;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      mesh.material.map = tex;
      mesh.material.needsUpdate = true;
      return { canvas: c, ctx: c.getContext("2d"), tex, w, h };
    }

    /** 把一段中文按屏幕宽度折行后画上去。 */
    _drawScreen(scr, title, body, accent, footer) {
      if (!scr) return;
      const g = scr.ctx;
      const W = scr.w;
      const H = scr.h;
      g.clearRect(0, 0, W, H);
      g.fillStyle = "#0a1120";
      g.fillRect(0, 0, W, H);
      // 顶部状态栏 + 标题。
      g.fillStyle = "rgba(140,200,255,0.55)";
      g.fillRect(0, 0, W, Math.max(10, H * 0.036));
      g.fillStyle = accent || "#7fd8ff";
      g.font = "bold " + Math.round(W * 0.115) + "px 'Microsoft YaHei',sans-serif";
      g.fillText(title || "", W * 0.075, H * 0.16);
      // 正文折行。
      g.fillStyle = "#eaf4ff";
      const fs = Math.round(W * 0.105);
      g.font = fs + "px 'Microsoft YaHei',sans-serif";
      const maxChars = Math.max(6, Math.floor((W * 0.86) / fs));
      const chars = String(body || "").split("");
      let y = H * 0.28;
      for (let i = 0; i < chars.length && y < H * 0.9; i += maxChars) {
        g.fillText(chars.slice(i, i + maxChars).join(""), W * 0.07, y);
        y += fs * 1.42;
      }
      // 底部提示条。
      if (footer) {
        g.fillStyle = accent || "#7fd8ff";
        g.fillRect(W * 0.07, H * 0.93, W * 0.86, 2);
        g.font = Math.round(W * 0.085) + "px 'Microsoft YaHei',sans-serif";
        g.fillText(footer, W * 0.07, H * 0.905);
      }
      scr.tex.needsUpdate = true;
    }

    /** 待机画面：亮色锁屏，平放在桌上时一眼就能看出屏幕是朝上的。 */
    _drawPhoneHome(scr) {
      if (!scr) return;
      const g = scr.ctx;
      const W = scr.w;
      const H = scr.h;
      const grd = g.createLinearGradient(0, 0, W * 0.6, H);
      grd.addColorStop(0, "#eef7ff");
      grd.addColorStop(0.55, "#cfe6ff");
      grd.addColorStop(1, "#a9cdf2");
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      const d = new Date();
      const hh = ("0" + d.getHours()).slice(-2);
      const mm = ("0" + d.getMinutes()).slice(-2);
      g.fillStyle = "#1d3c5e";
      g.font = "300 " + Math.round(W * 0.30) + "px 'Microsoft YaHei',sans-serif";
      g.fillText(hh + ":" + mm, W * 0.10, H * 0.34);
      g.fillStyle = "rgba(29,60,94,0.72)";
      g.font = Math.round(W * 0.085) + "px 'Microsoft YaHei',sans-serif";
      g.fillText((d.getMonth() + 1) + "月" + d.getDate() + "日", W * 0.11, H * 0.41);
      g.fillStyle = "rgba(29,60,94,0.9)";
      g.font = "bold " + Math.round(W * 0.095) + "px 'Microsoft YaHei',sans-serif";
      g.fillText("AI WORLD", W * 0.10, H * 0.86);
      g.fillStyle = "rgba(29,60,94,0.18)";
      g.fillRect(W * 0.10, H * 0.89, W * 0.8, 2);
      scr.tex.needsUpdate = true;
    }

    /* ---------------- 角色 ---------------- */

    setAvatar(vrm) {
      if (!vrm || !vrm.scene) return;
      const THREE = this.THREE;
      const root = vrm.scene;

      const box = new THREE.Box3().setFromObject(root);
      const height = box.max.y - box.min.y;
      const scale = height > 0 ? 1.55 / height : 1;
      root.scale.setScalar(scale);
      root.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(root);
      const groundOffset = -box2.min.y;

      this._avatarY = AVATAR_POS[1] + groundOffset;
      root.position.set(AVATAR_POS[0], this._avatarY, AVATAR_POS[2]);
      root.rotation.y = 0; // VRM 1.0 默认面向 +Z（相机方向）
      if (this.renderer) {
        this.renderer._baseRotationY = 0;
        this.renderer._baseY = this._avatarY;
      }

      this._avatar = vrm;
      this._captureBasePose(vrm);
      this._captureFingerPose(vrm);
      this._applyRelaxedArms();
      this._buildHandPhone(vrm, scale);

      // 换模型时回到初始坐姿。
      this._lieT = 0;
      this._phoneT = 0;
      this._stretchT = 0;
      this._walkAmp = 0;
      this._drivesRoot = false;
      this._action = this._sitting ? "sit" : "stand";

      // 先用站姿测出脚踝基准高度（此时模型包围盒底部正好在 y=0）。
      this._ankleTarget = null;
      this._poseT = 0;
      this._applyPose();
      if (this._ankleTarget == null) this._ankleTarget = this._avatarY + 0.06;

      this._poseT = this._sitting ? 1 : 0;
      this._applyPose();
    }

    _captureBasePose(vrm) {
      const h = vrm.humanoid;
      if (!h || typeof h.getNormalizedBoneNode !== "function") {
        this._avatarBase = null;
        return;
      }
      const names = [
        "leftUpperLeg", "rightUpperLeg",
        "leftLowerLeg", "rightLowerLeg",
        "leftFoot", "rightFoot",
        "leftUpperArm", "rightUpperArm",
        "leftLowerArm", "rightLowerArm",
        "neck", "head", "hips", "chest",
      ];
      const base = {};
      names.forEach((n) => {
        const node = h.getNormalizedBoneNode(n);
        if (node) {
          base[n] = {
            q: node.quaternion.clone(),
            y: node.position.y,
          };
        }
      });
      this._avatarBase = base;
    }

    /** 放松站姿：把 T-pose 的手臂放下来，避免角色一直张着胳膊。 */
    _applyRelaxedArms() {
      const vrm = this._avatar;
      const base = this._avatarBase;
      if (!vrm || !base) return;
      const h = vrm.humanoid;
      const THREE = this.THREE;
      this._armBase = {};
      const rotate = (name, axis, angle) => {
        const node = h.getNormalizedBoneNode(name);
        if (!node || !base[name]) return;
        const q = new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(base[name].q);
        this._armBase[name] = q.clone();
        node.quaternion.copy(q);
      };
      rotate("leftUpperArm", new THREE.Vector3(0, 0, 1), -1.15);
      rotate("rightUpperArm", new THREE.Vector3(0, 0, 1), 1.15);
      rotate("leftLowerArm", new THREE.Vector3(1, 0, 0), -0.22);
      rotate("rightLowerArm", new THREE.Vector3(1, 0, 0), -0.22);
    }

    /** 记录手指初始姿态：默认张开的 T-pose 手型不自然，之后按动作收拢。 */
    _captureFingerPose(vrm) {
      const h = vrm.humanoid;
      this._fingerNodes = [];
      if (!h) return;
      const fingers = ["Index", "Middle", "Ring", "Little"];
      const weights = { Proximal: 1, Intermediate: 0.9, Distal: 0.7 };
      ["left", "right"].forEach((side) => {
        fingers.forEach((f) => {
          Object.keys(weights).forEach((part) => {
            const node = h.getNormalizedBoneNode(side + f + part);
            if (!node) return;
            this._fingerNodes.push({
              node,
              base: node.quaternion.clone(),
              w: weights[part],
            });
          });
        });
      });
      // 拇指单独记：握手机时要收到手机正面边缘，其他时候保持自然张开。
      this._thumbNodes = ["rightThumbMetacarpal", "rightThumbProximal", "rightThumbDistal"]
        .map((n) => {
          const node = h.getNormalizedBoneNode(n);
          return node ? { node, base: node.quaternion.clone() } : null;
        })
        .filter(Boolean);
    }

    /** 把手里的手机挂到右手骨骼上（随手臂一起动）。 */
    _buildHandPhone(vrm, scale) {
      const THREE = this.THREE;
      const h = vrm.humanoid;
      // 用归一化骨骼：它才是 _applyPose 实际写入姿态的那套骨骼，
      // 挂在原始骨骼上会慢一帧、手机看起来"脱手"。
      const hand = typeof h.getNormalizedBoneNode === "function"
        ? h.getNormalizedBoneNode("rightHand")
        : null;
      if (!hand) return;
      const s = scale || 1; // 骨骼已继承根节点缩放，网格尺寸要除以 s
      const phone = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.072 / s, 0.012 / s, 0.15 / s),
        new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.55, metalness: 0.2 })
      );
      phone.add(body);
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(0.062 / s, 0.136 / s),
        this._screenMaterial()
      );
      screen.rotation.x = -Math.PI / 2;
      screen.position.y = 0.008 / s;
      phone.add(screen);
      this._handScreen = this._screenOf(screen, 256, 560);
      this._drawPhoneHome(this._handScreen);

      // 手机和手掌绑死：长轴顺着手腕→中指根的方向，屏幕朝掌心外侧
      //（人举着看手机时，掌心也朝向脸）。之后每帧只转手腕让屏幕对准脸，
      // 手机相对手掌不再单独旋转，所以不会切进手指。
      vrm.scene.updateMatrixWorld(true);
      const midBone = h.getNormalizedBoneNode("rightMiddleProximal");
      const pinkyBone = h.getNormalizedBoneNode("rightLittleProximal");
      let basisQuat = new THREE.Quaternion();
      if (midBone && pinkyBone) {
        const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
        const invQ = handQ.clone().invert();
        const w = hand.getWorldPosition(new THREE.Vector3());
        const along = midBone.getWorldPosition(new THREE.Vector3())
          .sub(w).normalize().applyQuaternion(invQ); // 手腕 → 中指根
        const toPinky = pinkyBone.getWorldPosition(new THREE.Vector3())
          .sub(w).normalize().applyQuaternion(invQ);
        const normal = new THREE.Vector3().crossVectors(along, toPinky).normalize();
        if (normal.y > 0) normal.negate(); // T-pose 掌心朝下：法线取掌心一侧
        const side = new THREE.Vector3().crossVectors(normal, along).normalize();
        // 手机本地：X=宽、Y=屏幕法线、Z=长轴（右手系）。
        const m = new THREE.Matrix4().makeBasis(side, normal, along);
        basisQuat = new THREE.Quaternion().setFromRotationMatrix(m);
        phone.quaternion.copy(basisQuat);
        // 位置每帧按手指实际位置再修正一次（见 _updatePhonePose）。
        this._palmFrame = { side: side.clone(), normal: normal.clone(), along: along.clone() };
        this._phoneHalfLen = 0.075 / s;
        this._phoneHalfThick = 0.0063 / s;
        phone.position.set(0, 0, 0)
          .addScaledVector(along, 0.06 / s)
          .addScaledVector(normal, 0.02 / s);
        // 用来算"手掌最靠前的手指在哪"的骨骼。
        this._gripBones = [
          "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
          "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
          "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
          "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal",
        ].map((n) => h.getNormalizedBoneNode(n)).filter(Boolean);
      } else {
        phone.position.set(0, 0.05 / s, 0.03 / s);
      }
      this._phoneBasisQ = basisQuat;
      this._handBaseQ = hand.quaternion.clone();
      phone.visible = false;
      hand.add(phone);
      this._handPhone = phone;
      this._handBone = hand;
    }

    /**
     * 每帧把屏幕转向脸：同一条手腕旋转同时带着手机和手指转，
     * 手机相对手掌的位置固定，不会再出现“手插进手机”。
     */
    _updatePhonePose(weight) {
      const THREE = this.THREE;
      const hand = this._handBone;
      const phone = this._handPhone;
      if (!hand || !phone || !phone.visible || !this._avatar) return;
      const w = Math.max(0, Math.min(1, weight == null ? this._phoneT : weight));
      if (w < 0.02) return;
      const h = this._avatar.humanoid;
      const head = h && h.getNormalizedBoneNode("head");
      this._avatar.scene.updateMatrixWorld(true);
      // 手机背面贴住弯起来的手指最前端：把所有指节投影到掌心法线方向，
      // 取最靠掌心外的那一点，手机整体放在它外面 3mm，任何手指都穿不出屏幕。
      const frame = this._palmFrame;
      if (frame) {
        const tmp = new THREE.Vector3();
        let front = 0.016;
        (this._gripBones || []).forEach((b) => {
          b.getWorldPosition(tmp);
          hand.worldToLocal(tmp);
          const d = tmp.dot(frame.normal);
          if (d > front) front = d;
        });
        // 手机中心 = 最前指节 + 手机半厚 + 3mm 余量，保证手机背面不切进手指。
        phone.position.copy(frame.normal)
          .multiplyScalar(front + (this._phoneHalfThick || 0.006) + 0.003)
          .addScaledVector(frame.along, this._phoneHalfLen - 0.004);
      }
      const handW = hand.getWorldPosition(new THREE.Vector3());
      const headW = head
        ? head.getWorldPosition(new THREE.Vector3())
        : handW.clone().add(new THREE.Vector3(0, 0.45, 0));
      const n = headW.sub(handW).normalize(); // 屏幕法线 → 眼睛
      // 长轴尽量竖直（竖屏看手机），投影到与法线垂直的平面。
      const up = new THREE.Vector3(0, 1, 0);
      const longAxis = up.clone().addScaledVector(n, -up.dot(n));
      if (longAxis.lengthSq() < 1e-4) {
        longAxis.set(0, 0, 1).addScaledVector(n, -n.z);
      }
      longAxis.normalize();
      const side = new THREE.Vector3().crossVectors(n, longAxis).normalize();
      const worldQ = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(side, n, longAxis)
      );
      // 手机相对手部的姿态已知，反推出手部应有的世界姿态。
      const handWorldTarget = worldQ.multiply(this._phoneBasisQ.clone().invert());
      const parentQ = hand.parent.getWorldQuaternion(new THREE.Quaternion());
      const localTarget = parentQ.invert().multiply(handWorldTarget);
      hand.quaternion.copy(this._handBaseQ).slerp(localTarget, w);
    }

    setSitting(on) {
      if (this._action === "sleep" || this._action === "wake") this.stopAction();
      // 只改目标：姿态由 _updatePose 每帧插值推进（坐下/站起约 0.9s）。
      this._sitting = !!on;
      this._action = on ? "sit" : "stand";
      this._phase = "";
    }

    /**
     * 收到一条消息（页面输入框、任意智能体都可以调用）。
     * chat：桌面手机先亮起提示 → 人物自动去拿手机看 → 在手机上回复 → 放回桌上。
     * task：手机提示后直接去电脑前干活（电脑屏幕显示任务，敲键盘）。
     */
    notifyMessage(text, opts) {
      const t = String(text || "").trim();
      if (!t || !this._avatar) return false;
      const o = opts || {};
      const task = o.mode === "task" ? true : o.mode === "chat" ? false : this._looksLikeTask(t);
      this._msgText = t;
      this._msgTask = task;
      this._msgReply = o.reply || (task ? "收到，马上去办～" : "收到你的消息啦～");
      this._msgShown = 0;
      this._msgReplied = false;
      this._msgBlink = 0;
      this._msgNotifyT = 1.1; // 手机先亮一下，再起身去拿
      if (!this._phoneHeld) {
        this._drawScreen(this._deskScreen, "新消息", t, "#ffcf7a", "来自智能体");
        if (this._deskBadge) this._deskBadge.visible = true;
      }
      return true;
    }

    /** 粗略判断"是让她做事"还是"只是聊天"。 */
    _looksLikeTask(text) {
      return /帮我|帮忙|做一下|做事|写下|写个|画个|做个|整理|统计|查一下|查查|搜索|搜一下|分析|总结|翻译|生成|代码|改一下|修复|处理|计算|列出|搞个|建个/.test(
        String(text || "")
      );
    }

    /** 对外播报一句（页面会显示字幕，智能体桥也会转发）。 */
    _say(text) {
      if (!text) return;
      try {
        global.dispatchEvent(new CustomEvent("ai-world-say", { detail: String(text) }));
      } catch (_e) {
        /* 老环境没有 CustomEvent 时忽略 */
      }
    }

    /** 对外动作入口：sleep | wake | phone | message | computer | window | stretch | walk。 */
    startAction(name) {
      const n = String(name || "").toLowerCase();
      if (!this._avatar) return false;
      this._actionT = 0;
      this._sleepT = 0;
      this._afterWalk = null;
      // 切到别的动作时把窗关好、头收回来，窗扇不会一直敞着。
      if (n !== "window") {
        this._lookOut = 0;
        if (this._winT) {
          this._winT = 0;
          this._setWindowOpen(0);
        }
      }
      // 已经躺在床上时：
      //   - 再点睡觉 = 重新计时，不用爬起来再躺
      //   - 点别的动作 = 先起床走回书桌再执行，否则会躺在床/地面上滑动
      if (this._lieT > 0.05 && n !== "wake") {
        if (n === "sleep") {
          this._action = "sleep";
          this._phase = "sleep";
          return true;
        }
        this._afterWalk = n;
        this._action = "wake";
        this._actionT = 0;
        this._phase = "get-up";
        return true;
      }
      // 走路途中（含去窗边、去拿东西）收到别的动作：先走回书桌再执行，
      // 避免站在房间中间/窗边就坐下、或者人留在原地凭空切动作。
      if (this._drivesRoot && n !== "walk" && n !== "sleep" && n !== "window" && n !== "wake") {
        this._afterWalk = n;
        this._action = "wake";
        this._phase = "walk-back";
        this._enterWalk(AVATAR_POS[0], AVATAR_POS[2]);
        return true;
      }
      if (n === "sleep") {
        // 已经在床上（躺下或正在躺）就不再重来一遍，否则会带着躺姿去走路。
        if (this._action === "sleep" && this._lieT > 0.02) return true;
        this._action = "sleep";
        this._sitting = false;
        this._clearLieState();
        this._lieRoot = this._rollLieRoot();
        if (this._poseT > 0.05) {
          this._phase = "stand-up";
        } else {
          this._phase = "walk";
          this._enterWalk(BED_WALK[0], BED_WALK[1]);
        }
        return true;
      }
      if (n === "wake") {
        this._action = "wake";
        this._sitting = false;
        this._phase = this._lieT > 0.02 ? "get-up" : "walk-back";
        if (this._phase === "walk-back") this._enterWalk(AVATAR_POS[0], AVATAR_POS[2]);
        return true;
      }
      if (n === "phone" || n === "message") {
        this._action = n;
        this._sitting = true;
        this._phase = "p-desk";
        // 手动"玩手机"时清掉上一条消息；"message"保留 notifyMessage 写入的内容。
        if (n === "phone") {
          this._msgText = "";
          this._msgReply = "";
          this._msgShown = 0;
          this._msgReplied = false;
          if (this._handScreen) this._drawPhoneHome(this._handScreen);
        } else if (this._phoneHeld) {
          // 上一条消息还没放下就又来一条：手机已经在手上，直接低头看新的。
          this._phase = "p-raise";
          if (this._handScreen && this._msgText) {
            this._drawScreen(this._handScreen, "新消息", this._msgText, "#ffcf7a", "来自智能体");
          }
        }
        return true;
      }
      if (n === "computer") {
        this._action = "computer";
        this._sitting = true;
        this._phase = "c-turn";
        return true;
      }
      if (n === "stretch") {
        this._action = "stretch";
        this._sitting = false;
        this._phase = "up";
        return true;
      }
      if (n === "window") {
        this._action = "window";
        this._sitting = false;
        this._winT = 0;
        this._lookOut = 0;
        this._setWindowOpen(0);
        this._phase = this._poseT > 0.05 ? "w-open-stand" : "w-open-walk";
        if (this._phase === "w-open-walk") this._enterWalk(WINDOW_SPOT[0], WINDOW_SPOT[1]);
        return true;
      }
      if (n === "walk") {
        this._action = "walk";
        this._sitting = false;
        this._phase = "out";
        // 走到房间中央地毯附近：在书桌视角里也保持合适的距离，不会走到镜头前面糊满屏幕。
        this._enterWalk(0.45, 0.45);
        return true;
      }
      return false;
    }

    stopAction() {
      this._phase = "";
      this._drivesRoot = false;
      this._afterWalk = null;
      // 强制收掉躺姿，否则切回坐/站时身体还带着躺下的旋转和高度补偿。
      this._lieT = 0;
      this._clearLieState();
      this._lieRoot = null;
      // 手机 / 消息状态收干净：手机回到桌上，提示点熄灭。
      if (this._phoneHeld) this._transferPhone(false);
      this._msgNotifyT = 0;
      this._msgShown = 0;
      this._msgReplied = false;
      if (this._deskBadge) this._deskBadge.visible = false;
      if (this._deskScreen) this._drawPhoneHome(this._deskScreen);
      if (this._handScreen) this._drawPhoneHome(this._handScreen);
      this._action = this._sitting ? "sit" : "stand";
    }

    /** 清掉躺姿 / 坐床沿的临时几何状态，避免带着上一轮的旋转和高度补偿。 */
    _clearLieState() {
      this._lieYFix = null;
      this._bedSitPos = null;
      this._bedSitFrom = null;
      this._bedFold = null;
      this._bedShin = null;
      this._bedSitLeg = 0;
      this._legT = 0;
    }

    /** 动作收尾：回到书桌前的坐姿，交回坐/站姿态。 */
    _backToSit() {
      this._drivesRoot = false;
      this._sitting = true;
      this._action = "sit";
      this._phase = "";
    }

    /** 每次上床给躺位一点随机：位置 ±5cm、朝向 ±3°，贴床不越界。 */
    _rollLieRoot() {
      const j = (a) => (Math.random() * 2 - 1) * a;
      this._lieYaw = -Math.PI / 2 + j(0.05);
      return { x: BED_FOOT[0] + j(0.05), z: BED_FOOT[1] + j(0.09) };
    }

    /** 躺下姿态的四元数：先绕 Y 转到朝床尾，再仰面放平。 */
    _lieQuat() {
      const THREE = this.THREE;
      return new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._lieYaw)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    }

    _enterWalk(x, z) {
      this._walkTo.set(x, 0, z);
      this._drivesRoot = true;
      this._walkAmp = 0;
      this._rootYaw = this._rootYaw || 0;
    }

    /** 朝目标走一步；到达返回 true。 */
    _moveWalk(dt) {
      const root = this._avatar.scene;
      // 坐姿没收完就迈步会"悬空滑行"：先在原地站直，站好再走。
      if (this._poseT > 0.04) {
        this._walkAmp = 0;
        return false;
      }
      const dx = this._walkTo.x - root.position.x;
      const dz = this._walkTo.z - root.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.02) {
        this._walkAmp = Math.max(0, this._walkAmp - dt * 2);
        return true;
      }
      const step = Math.min(dist, WALK_SPEED * dt);
      root.position.x += (dx / dist) * step;
      root.position.z += (dz / dist) * step;
      // 朝向平滑转过去，起步时不会瞬间甩头。
      const targetYaw = Math.atan2(dx, dz);
      let dyaw = targetYaw - (this._rootYaw || 0);
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      this._rootYaw = (this._rootYaw || 0) + dyaw * Math.min(1, dt * 7);
      this._walkAmp = Math.min(1, this._walkAmp + dt * 2);
      // 步频跟着速度走：0.35rad 摆幅 + 4.3rad/s ≈ 0.8m/s，脚才不会"滑步"。
      this._walkPhase += dt * 4.3;
      // 高度交给 _groundFeet：始终让较低的脚踝贴着地面，起伏随抬腿自然发生。
      return false;
    }

    /** 每帧推进坐/站姿态：0 = 站姿，1 = 坐姿。 */
    _updatePose(dt) {
      if (!this._avatar) return;
      const target = this._sitting ? 1 : 0;
      if (this._poseT !== target) {
        const step = dt / 0.9;
        this._poseT += target > this._poseT ? step : -step;
        this._poseT = Math.max(0, Math.min(1, this._poseT));
      }
      // 停步后摆腿幅度平滑归零，腿不会一帧内从跨步弹回直腿。
      if (!this._drivesRoot) this._walkAmp = Math.max(0, this._walkAmp - dt * 2.5);
      this._updateAction(dt);
      this._applyPose();
    }

    /** 行为状态机：睡觉的起床/走路/躺下，玩手机和伸懒腰的权重。 */
    _updateAction(dt) {
      const a = this._action;

      this._actionT += dt;

      // 新消息提示：桌面手机亮 1 秒 → 自动去拿手机 / 去电脑。
      if (this._msgNotifyT > 0) {
        this._msgNotifyT -= dt;
        this._msgBlink += dt;
        if (this._deskBadge && this._deskBadge.visible) {
          const k = 0.5 + 0.5 * Math.sin(this._msgBlink * 12);
          this._deskBadge.scale.setScalar(0.7 + 0.7 * k);
        }
        if (this._msgNotifyT <= 0) {
          if (this._action === "sleep") {
            this._msgNotifyT = 0.8;
            this.startAction("wake"); // 睡梦中被消息叫醒，醒来再处理
            return;
          }
          if (this._action === "wake") {
            this._msgNotifyT = 0.6; // 还在起床，等站起来再说
            return;
          }
          this._msgNotifyT = 0;
          if (this._deskBadge) this._deskBadge.visible = false;
          if (!this._phoneHeld) this._drawPhoneHome(this._deskScreen);
          this.startAction(this._msgTask ? "computer" : "message");
          return;
        }
      }

      if (a !== "phone" && a !== "message") this._phoneT = ease(this._phoneT, 0, 3, dt);
      // 打字权重和电脑屏幕亮度：离开电脑动作就平滑收回，
      // 否则从"玩电脑"切到手机/窗边时手臂还保持着打字姿势。
      if (a !== "computer") {
        this._typeT = ease(this._typeT || 0, 0, 3, dt);
        if (this._screenMat && this._screenBase != null) {
          this._screenMat.emissiveIntensity = ease(
            this._screenMat.emissiveIntensity,
            this._screenBase,
            3,
            dt
          );
        }
      }

      if (a === "window") {
        this._updateWindow(dt);
        return;
      }

      if (a === "phone" || a === "message") {
        this._updatePhoneAction(dt);
        return;
      }
      if (a === "computer") {
        this._updateComputer(dt);
        return;
      }

      if (a === "stretch") {
        if (this._phase === "up") {
          this._stretchT = ease(this._stretchT, 1, 2.2, dt);
          if (this._actionT > 2.4) {
            this._phase = "down";
            this._actionT = 0;
          }
        } else {
          this._stretchT = ease(this._stretchT, 0, 2.2, dt);
          if (this._actionT > 1.8) this.stopAction();
        }
      } else {
        this._stretchT = ease(this._stretchT, 0, 3, dt);
      }

      if (a === "walk") {
        if (this._moveWalk(dt)) {
          if (this._phase === "out") {
            // 走到目标点再走回桌边，避免瞬间传送回原点。
            this._phase = "back";
            this._enterWalk(AVATAR_POS[0], AVATAR_POS[2]);
          } else {
            this.stopAction();
          }
        }
        return;
      }

      if (a === "sleep" || a === "wake") this._updateSleep(dt);
    }

    _updateSleep(dt) {
      const root = this._avatar.scene;
      const phase = this._phase;

      if (phase === "stand-up") {
        this._walkAmp = 0;
        if (this._poseT <= 0.01) {
          this._poseT = 0;
          this._phase = "walk";
          this._enterWalk(BED_WALK[0], BED_WALK[1]);
        }
        return;
      }
      if (phase === "walk") {
        if (this._moveWalk(dt)) {
          this._walkAmp = 0;
          this._phase = "turn";
        }
        return;
      }
      if (phase === "turn") {
        // 站直先转身再坐下：背对床、面朝房间，退着坐到床沿上。
        this._turnYaw(BED_SIT_YAW, dt * 6);
        let d = BED_SIT_YAW - (this._rootYaw || 0);
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) < 0.03) {
          this._rootYaw = BED_SIT_YAW;
          // 记住站位：坐下时在"站位 ↔ 坐位"之间插值，不会瞬移。
          this._bedSitFrom = { x: root.position.x, z: root.position.z };
          this._measureBedSit();
          this._bedFold = null; // 坐姿阶段腿由坐姿权重驱动
          this._sitting = true; // 大腿抬平、小腿垂下的坐姿
          this._phase = "sit";
        }
        return;
      }
      if (phase === "sit") {
        this._turnYaw(BED_SIT_YAW, dt * 5);
        this._bedSitLeg = 1; // 床沿坐姿：膝盖略高于胯，脚落在床外地面
        // 进入坐姿阶段立刻量坐点：_applyPose 用 poseT 在站位与坐位之间插值，
        // 晚一点才有坐点会让根节点高度中途跳一下。
        if (!this._bedSitPos) this._measureBedSit();
        if (this._poseT >= 0.99 && this._bedSitPos) {
          // 坐稳了再把脚收上床。
          this._bedFold = 1;
          this._bedShin = 1;
          this._bedSitLeg = 1;
          this._legT = 0;
          this._phase = "legs";
        }
        return;
      }
      if (phase === "legs") {
        // 收脚上床：小腿从垂下慢慢伸直，同时身体在床沿转 90° 顺着床躺下。
        // 中途把脚多抬一点，跨过床沿时不会蹭进床架。
        this._legT = Math.min(1, this._legT + dt / 1.0);
        this._bedFold = 1;
        const f = this._legT;
        const s = f * f * (3 - 2 * f);
        this._bedShin = 1 - s;
        this._bedSitLeg = this._bedShin + Math.sin(Math.PI * s);
        let d = BED_LEGS_YAW - BED_SIT_YAW;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this._rootYaw = BED_SIT_YAW + d * s;
        if (this._legT >= 1) {
          this._rootYaw = BED_LEGS_YAW;
          this._bedShin = 0;
          this._bedSitLeg = 0;
          this._legT = 0;
          this._phase = "recline";
        }
        return;
      }
      if (phase === "recline") {
        // 脚已经收好，这时才后仰躺平：大腿随身体一起解开，腿始终贴着床面。
        this._sitting = false;
        this._lieT = Math.min(1, this._lieT + dt / 1.5);
        this._bedFold = this._foldForLie(this._lieT);
        this._bedShin = 0;
        if (this._lieT >= 1) {
          this._lieT = 1;
          this._bedFold = 0;
          this._phase = "sleep";
          this._sleepT = 0;
        }
        return;
      }
      if (phase === "sleep") {
        this._lieT = 1;
        this._bedFold = 0;
        this._bedShin = 0;
        this._sleepT += dt;
        if (this._sleepT > 40) this.startAction("wake"); // 睡 40 秒自己起床
        return;
      }
      if (phase === "get-up") {
        // 起床：先直着腿坐起来，再把小腿放下床沿，最后站起来。
        this._sitting = true;
        this._lieT = Math.max(0, this._lieT - dt / 1.2);
        this._bedFold = this._foldForLie(this._lieT);
        this._bedShin = 0;
        if (this._lieT <= 0.01) {
          this._lieT = 0;
          this._lieYFix = null;
          this._bedFold = 1;
          this._bedShin = 0;
          this._legT = 0;
          this._phase = "legs-down";
        }
        return;
      }
      if (phase === "legs-down") {
        // 放脚：小腿垂回床沿外，同时把身子转回背对床，脚落在床外地面。
        this._legT = Math.min(1, this._legT + dt / 0.9);
        this._bedFold = 1;
        const f = this._legT;
        const s = f * f * (3 - 2 * f);
        this._bedShin = s;
        this._bedSitLeg = s + Math.sin(Math.PI * s);
        let d = BED_SIT_YAW - BED_LEGS_YAW;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this._rootYaw = BED_LEGS_YAW + d * s;
        if (this._legT >= 1) {
          this._rootYaw = BED_SIT_YAW;
          this._bedFold = null;
          this._bedShin = null;
          this._bedSitLeg = 1;
          this._legT = 0;
          this._sitting = false;
          this._phase = "walk-back";
          this._enterWalk(AVATAR_POS[0], AVATAR_POS[2]);
        }
        return;
      }
      if (phase === "walk-back") {
        // 站直后不再压着坐位坐标，交给走路逻辑。
        if (this._poseT <= 0.04) {
          this._bedSitPos = null;
          this._bedSitLeg = 0;
        }
        if (this._moveWalk(dt)) {
          this._bedSitPos = null;
          this._walkAmp = 0;
          const next = this._afterWalk;
          this._afterWalk = null;
          if (next) {
            this.startAction(next);
          } else {
            this._backToSit();
          }
        }
      }
    }

    /** 走到窗边 → 开窗 → 看外面的风景 → 关窗 → 走回书桌。 */
    _updateWindow(dt) {
      const p = this._phase;
      if (p === "w-open-stand") {
        this._walkAmp = 0;
        if (this._poseT <= 0.02) {
          this._poseT = 0;
          this._phase = "w-open-walk";
          this._enterWalk(WINDOW_SPOT[0], WINDOW_SPOT[1]);
        }
        return;
      }
      if (p === "w-open-walk") {
        if (this._moveWalk(dt)) {
          this._walkAmp = 0;
          this._phase = "w-turn";
        }
        return;
      }
      if (p === "w-turn") {
        this._walkAmp = Math.max(0, this._walkAmp - dt * 3);
        this._turnYaw(WINDOW_YAW, dt * 5);
        let d = WINDOW_YAW - (this._rootYaw || 0);
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) < 0.04) {
          this._phase = "w-open";
          this._actionT = 0;
        }
        return;
      }
      if (p === "w-open") {
        // 两扇窗往里推开。
        this._winT = Math.min(1, this._winT + dt / 1.1);
        const s = this._winT * this._winT * (3 - 2 * this._winT);
        this._setWindowOpen(s);
        if (this._winT >= 1) {
          this._phase = "w-look";
          this._actionT = 0;
        }
        return;
      }
      if (p === "w-look") {
        // 抬头看窗外：夜景 / 城市的灯。
        this._lookOut = ease(this._lookOut, 1, 2, dt);
        if (this._actionT > 5) {
          this._phase = "w-close";
          this._actionT = 0;
        }
        return;
      }
      if (p === "w-close") {
        this._lookOut = ease(this._lookOut, 0, 2.5, dt);
        this._winT = Math.max(0, this._winT - dt / 1.0);
        const s = this._winT * this._winT * (3 - 2 * this._winT);
        this._setWindowOpen(s);
        if (this._winT <= 0 && this._actionT > 0.4) {
          this._phase = "w-back";
          this._enterWalk(AVATAR_POS[0], AVATAR_POS[2]);
        }
        return;
      }
      if (p === "w-back") {
        if (this._moveWalk(dt)) {
          this._walkAmp = 0;
          this._phase = "w-settle";
        }
        return;
      }
      if (p === "w-settle") {
        // 站回书桌前后把朝向转正，再交回坐/站姿态，避免起身瞬间甩头。
        this._turnYaw(0, dt * 6);
        let d = 0 - (this._rootYaw || 0);
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) < 0.05) {
          this._rootYaw = 0;
          this._backToSit();
        }
      }
    }

    /** 转椅转到目标角度（最短弧）；到位返回 true。 */
    _turnChairTo(target, dt, rate) {
      let d = target - this._chairAngle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this._chairAngle += d * Math.min(1, dt * rate);
      if (this._chair) this._chair.rotation.y = this._chairAngle;
      return Math.abs(d) < 0.02;
    }

    /** 手机在"桌面道具"和"手持道具"之间切换。 */
    _transferPhone(toHand) {
      this._phoneHeld = !!toHand;
      if (this._deskPhone) this._deskPhone.forEach((o) => { o.visible = !toHand; });
      if (this._handPhone && !toHand) this._handPhone.visible = false;
    }

    /** 玩手机：连人带椅转向书桌 → 从桌上拿起手机 → 转回来低头看 → 放回去。 */
    _updatePhoneAction(dt) {
      const p = this._phase;
      if (p === "p-desk") {
        this._phoneGrab = ease(this._phoneGrab, 0.3, 2.5, dt);
        if (this._turnChairTo(Math.PI, dt, 3.2)) {
          this._phase = "p-reach";
          this._actionT = 0;
        }
        return;
      }
      if (p === "p-reach") {
        this._phoneGrab = ease(this._phoneGrab, 1, 3.5, dt);
        if (this._phoneGrab > 0.8) {
          const wasHeld = this._phoneHeld;
          this._transferPhone(true);
          // 拿到手的那一刻，手机屏幕上就是收到的消息。
          if (!wasHeld && this._action === "message" && this._msgText) {
            this._drawScreen(this._handScreen, "新消息", this._msgText, "#ffcf7a", "来自智能体");
          }
        }
        if (this._actionT > 1.5) this._phase = "p-turn-back";
        return;
      }
      if (p === "p-turn-back") {
        this._phoneGrab = ease(this._phoneGrab, 0.72, 2.5, dt);
        if (this._turnChairTo(0, dt, 3.2)) {
          this._phase = "p-raise";
          this._actionT = 0;
        }
        return;
      }
      if (p === "p-raise") {
        this._phoneGrab = ease(this._phoneGrab, 0, 4, dt);
        this._phoneT = ease(this._phoneT, 1, 3.5, dt);
        if (this._actionT > 1.6) {
          this._phase = "p-read";
          this._actionT = 0;
        }
        return;
      }
      if (p === "p-read") {
        this._phoneGrab = ease(this._phoneGrab, 0, 4, dt);
        if (this._action === "message" && this._msgText) {
          // 看 3 秒后在手机上回一条，再拿着看一会儿才放下。
          this._msgShown += dt;
          if (!this._msgReplied && this._msgShown > 3.0) {
            this._msgReplied = true;
            this._drawScreen(this._handScreen, "已回复", this._msgReply, "#8ef0b6", "已发送");
            this._say(this._msgReply);
          }
          if (this._msgShown > 6.2) {
            this._phase = "p-lower";
            this._actionT = 0;
          }
        } else if (this._actionT > 7) {
          this._phase = "p-lower";
          this._actionT = 0;
        }
        return;
      }
      if (p === "p-lower") {
        this._phoneT = ease(this._phoneT, 0, 3.5, dt);
        if (this._actionT > 1.1) {
          this._phase = "p-desk2";
          this._actionT = 0;
        }
        return;
      }
      if (p === "p-desk2") {
        if (this._turnChairTo(Math.PI, dt, 3.2)) {
          this._phase = "p-place";
          this._actionT = 0;
        }
        return;
      }
      if (p === "p-place") {
        this._phoneGrab = ease(this._phoneGrab, 1, 3, dt);
        if (this._actionT > 1.3) {
          this._transferPhone(false);
          if (this._msgText) {
            // 放回桌上后手机回到待机画面，消息处理完毕。
            if (this._deskScreen) this._drawPhoneHome(this._deskScreen);
            if (this._handScreen) this._drawPhoneHome(this._handScreen);
            this._msgText = "";
            this._msgReply = "";
          }
          this._phoneGrab = 0.9;
          this._phase = "p-home";
          this._actionT = 0;
        }
        return;
      }
      if (p === "p-home") {
        this._phoneGrab = ease(this._phoneGrab, 0, 3, dt);
        if (this._turnChairTo(0, dt, 3.2) && this._actionT > 1.4) {
          this._phoneGrab = 0;
          this._backToSit();
        }
      }
    }

    /** 玩电脑：转椅面向书桌、双手放到键盘上敲，屏幕亮起来。 */
    _updateComputer(dt) {
      const p = this._phase;
      const glow = (on) => {
        if (this._screenMat) {
          const base = this._screenBase == null ? 1 : this._screenBase;
          const flicker = on ? 0.12 * Math.sin(this._time * 7.3) : 0;
          this._screenMat.emissiveIntensity = base * (on ? 1.35 : 1) + flicker;
        }
        if (this._screenLight) {
          this._screenLight.intensity = (this._isNight ? 1.1 : 0.45) * (on ? 1.5 : 1);
        }
      };
      if (p === "c-turn") {
        if (this._turnChairTo(Math.PI, dt, 3.2)) {
          this._phase = "c-type";
          this._actionT = 0;
        }
        return;
      }
      if (p === "c-type") {
        this._typeT = ease(this._typeT || 0, 1, 2.2, dt);
        glow(true);
        if (this._actionT > 24) {
          this._phase = "c-stop";
          this._actionT = 0;
        }
        return;
      }
      if (p === "c-stop") {
        this._typeT = ease(this._typeT || 0, 0, 3, dt);
        glow(false);
        if (this._actionT > 1.1) {
          this._phase = "c-home";
          this._actionT = 0;
        }
        return;
      }
      if (p === "c-home") {
        this._typeT = ease(this._typeT || 0, 0, 3, dt);
        if (this._turnChairTo(0, dt, 3.2) && (this._typeT || 0) < 0.02) {
          this._typeT = 0;
          this._backToSit();
        }
      }
    }

    /** 平滑转向目标朝向（走最短弧）。 */
    _turnYaw(target, rate) {
      let d = target - (this._rootYaw || 0);
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this._rootYaw = (this._rootYaw || 0) + d * Math.min(1, rate);
    }

    /** 躺下/起身时大腿的折叠量：和身体放平的进度反相，腿才一直贴着床面。 */
    _foldForLie(lie) {
      return 1 - lie * lie * (3 - 2 * lie);
    }

    /** 量出"让髋部落到床沿"所需的根节点位置（坐床沿用），同时记下髋骨在模型内的偏移。 */
    _measureBedSit() {
      const THREE = this.THREE;
      const scene = this._avatar.scene;
      const h = this._avatar.humanoid;
      const hips = h && h.getNormalizedBoneNode("hips");
      if (!hips) return;
      const prevPos = scene.position.clone();
      const prevQ = scene.quaternion.clone();
      // 先复位到原点/无旋转，量出髋骨相对根节点的世界偏移（含模型缩放）。
      scene.position.set(0, 0, 0);
      scene.quaternion.identity();
      scene.updateMatrixWorld(true);
      const local = hips.getWorldPosition(new THREE.Vector3());
      this._hipLocal = { x: local.x, y: local.y, z: local.z };
      const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), BED_SIT_YAW);
      const off = local.clone().applyQuaternion(yawQ);
      const top = (this._bedBox && this._bedBox.top) || 0.355;
      this._bedSitPos = {
        x: BED_SIT_HIP[0] - off.x,
        z: BED_SIT_HIP[1] - off.z,
        // 髋部稍微压进床垫（床是软的），腿垂下去刚好够到地面。
        y: top + 0.05 - local.y - this._avatarY,
      };
      scene.position.copy(prevPos);
      scene.quaternion.copy(prevQ);
      scene.updateMatrixWorld(true);
    }

    /** 应用当前姿态：腿部角度 → 根节点位置/朝向 → 脚底贴地。 */
    _applyPose() {
      const vrm = this._avatar;
      const base = this._avatarBase;
      if (!vrm || !base) return;
      const THREE = this.THREE;
      const h = vrm.humanoid;
      const root = vrm.scene;

      // smoothstep：坐下/站起先加速后减速，不像瞬间跳变。
      const t = this._poseT;
      const e = t * t * (3 - 2 * t);
      // 躺下阶段腿的折叠单独控制：大腿先保持屈着，身体放平的过程里同步解开；
      // 小腿在"收脚"阶段先伸直放上床。
      const fold = this._bedFold == null ? e : this._bedFold;
      const foldShin = this._bedShin == null ? fold : this._bedShin;
      const lie = this._lieT;
      const walk = this._walkAmp * (1 - lie);
      const swing = Math.sin(this._walkPhase);

      // 大腿前抬 90°、小腿再后折 90°。小腿的局部旋转与大腿在世界里相互抵消，
      // 所以无论过渡到哪一帧，小腿都保持竖直、脚掌都保持水平。
      // 走路时叠加前后摆腿（±0.35rad，配合 4.3rad/s 步频 ≈ 0.8m/s，不滑步）；
      // 躺下时叠加一点屈膝 / 抬脚，避免像木板一样笔直。
      const X = new THREE.Vector3(1, 0, 0);
      const bend = (name, angle, walkAngle, lieAngle, f) => {
        const node = h.getNormalizedBoneNode(name);
        if (!node || !base[name]) return;
        const q = base[name].q.clone();
        const sx = angle * (f == null ? fold : f);
        if (Math.abs(sx) > 1e-4) {
          q.multiply(new THREE.Quaternion().setFromAxisAngle(X, sx));
        }
        if (Math.abs(walkAngle) > 1e-4) {
          q.multiply(new THREE.Quaternion().setFromAxisAngle(X, walkAngle));
        }
        if (lieAngle && Math.abs(lieAngle) > 1e-4) {
          q.multiply(new THREE.Quaternion().setFromAxisAngle(X, lieAngle));
        }
        node.quaternion.copy(q);
      };
      const legSwing = 0.35 * swing * walk;
      // 摆腿相位：sin 决定大腿前后（正 = 向后蹬），cos 决定这条腿是否正在向前迈。
      // 向前迈（摆动相）才屈膝抬脚，向后蹬/踩地（支撑相）伸直，才不会"拖地滑行"。
      const c = Math.cos(this._walkPhase);
      // 坐床沿时床很低（35cm），大腿要略抬起、膝盖高于胯，脚才刚好落在床外地面。
      const legLift = 0.30 * (this._bedSitLeg || 0);
      bend("leftUpperLeg", -Math.PI / 2 - legLift, legSwing, -0.10 * lie);
      bend("rightUpperLeg", -Math.PI / 2 - legLift, -legSwing, -0.16 * lie);
      const flexL = Math.max(0, -c) * walk;
      const flexR = Math.max(0, c) * walk;
      bend("leftLowerLeg", Math.PI / 2 + legLift, 0.80 * flexL, 0.30 * lie, foldShin);
      bend("rightLowerLeg", Math.PI / 2 + legLift, 0.80 * flexR, 0.38 * lie, foldShin);
      // 脚掌：摆动相脚尖下压；躺下时脚自然放松（脚尖略朝外）。
      const foot = (name, toe) => {
        const node = h.getNormalizedBoneNode(name);
        if (!node || !base[name]) return;
        const q = base[name].q.clone();
        if (Math.abs(toe) > 1e-4) {
          q.multiply(new THREE.Quaternion().setFromAxisAngle(X, toe));
        }
        node.quaternion.copy(q);
      };
      foot("leftFoot", -0.20 * flexL - 0.10 * lie);
      foot("rightFoot", -0.20 * flexR - 0.10 * lie);

      this._applyArms(swing * walk, lie, e);

      // 根节点位置/朝向：日常姿态由房间决定；走路/躺下时由行为接管。
      if (this._drivesRoot) {
        if (lie > 0.001) {
          // 床模型还没加载完就下一帧再量，避免用错误高度。
          if (this._lieYFix == null && lie > 0.05 && this._bedBox) this._measureLieY();
          const Y = new THREE.Vector3(0, 1, 0);
          const X = new THREE.Vector3(1, 0, 0);
          const lieQ = this._lieQuat();
          const k = lie * lie * (3 - 2 * lie);
          const standQ = new THREE.Quaternion().setFromAxisAngle(Y, this._rootYaw || 0);
          const q = standQ.clone().slerp(lieQ, k);
          const hl = this._hipLocal;
          const lieAt = this._lieRoot || { x: BED_FOOT[0], z: BED_FOOT[1] };
          if (hl) {
            // 以髋部为轴放平：髋部从床沿滑到床中间，身体绕着它后仰，
            // 不会出现"整块身体悬在半空转"的效果。
            const hipOff = new THREE.Vector3(hl.x, hl.y, hl.z);
            const top = (this._bedBox && this._bedBox.top) || 0.355;
            const hip0 = new THREE.Vector3(BED_SIT_HIP[0], top + 0.05, BED_SIT_HIP[1]);
            const lieRoot = new THREE.Vector3(
              lieAt.x, this._avatarY + (this._lieYFix || 0), lieAt.z
            );
            const hip1 = lieRoot.clone().add(hipOff.clone().applyQuaternion(lieQ));
            const hip = hip0.lerp(hip1, k);
            root.position.copy(hip.sub(hipOff.clone().applyQuaternion(q)));
          } else {
            const from = this._bedSitPos || { x: lieAt.x, z: lieAt.z, y: 0 };
            const y0 = this._avatarY + (from.y || 0);
            const y1 = this._avatarY + (this._lieYFix || 0);
            root.position.x = from.x + (lieAt.x - from.x) * k;
            root.position.z = from.z + (lieAt.z - from.z) * k;
            root.position.y = y0 + (y1 - y0) * k;
          }
          root.quaternion.copy(q);
        } else {
          // 坐到床沿：身体挪到测量出的坐点。
          if (this._bedSitPos) {
            const k = this._poseT;
            const f = this._bedSitFrom || this._bedSitPos;
            root.position.x = f.x + (this._bedSitPos.x - f.x) * k;
            root.position.z = f.z + (this._bedSitPos.z - f.z) * k;
            // 座位高度：髋部落在床沿上（床比椅子矮，不能只靠脚贴地）。
            root.position.y = this._avatarY + this._bedSitPos.y * k;
            if (this.renderer) this.renderer._baseY = root.position.y;
            // 用 set 清掉躺姿留下的俯仰/翻滚角，否则回到坐姿身体还是歪的。
            root.rotation.set(0, this._rootYaw || 0, 0);
          } else {
            root.rotation.set(0, this._rootYaw || 0, 0);
            // 走路时由最低的脚踝贴地：脚不会悬空，身体起伏也跟着抬腿自然出现。
            this._groundFeet();
          }
        }
        if (this.renderer) this.renderer._baseRotationY = root.rotation.y;
        root.updateMatrixWorld(true);
        return; // 躺下时高度已按床面单独补偿，不再贴地
      }

      const a = this._chairAngle;
      const sitX = CHAIR_POS[0] + SIT_OFFSET_Z * Math.sin(a);
      const sitZ = CHAIR_POS[2] + SIT_OFFSET_Z * Math.cos(a);
      root.position.x = AVATAR_POS[0] + (sitX - AVATAR_POS[0]) * e;
      root.position.z = AVATAR_POS[2] + (sitZ - AVATAR_POS[2]) * e;
      // 朝向：坐着跟随椅子转，站着面向相机；叠加极小的待机摆动。
      root.rotation.set(0, a * e + Math.sin(this._time * 0.6) * 0.05, 0);
      if (this.renderer) this.renderer._baseRotationY = a * e;

      this._groundFeet();
    }

    /** 手臂：坐姿搭腿 / 伸懒腰 / 玩手机 / 走路摆臂，都叠加在放松姿态上。 */
    _applyArms(swing, lie, e) {
      const vrm = this._avatar;
      const h = vrm && vrm.humanoid;
      const base = this._armBase;
      if (!h || !base) return;
      const THREE = this.THREE;
      const Y = new THREE.Vector3(0, 1, 0);
      const X = new THREE.Vector3(1, 0, 0);
      const Z = new THREE.Vector3(0, 0, 1);
      const phone = this._phoneT;
      const grab = this._phoneGrab || 0; // 伸手去桌上拿手机
      const type = this._typeT || 0; // 坐在电脑前打字
      const stretch = this._stretchT * (1 - lie);
      // 坐着且没在做别的动作时，双手自然放到大腿上。
      const sit =
        (e || 0) * (1 - lie) * (1 - phone) * (1 - stretch) * (1 - grab) * (1 - type);
      // 走路时手臂略微内收贴着身体，摆臂才不像"企鹅张开翅膀"。
      const walkAmp =
        this._walkAmp * (1 - lie) * (1 - phone) * (1 - stretch) * (1 - grab) * (1 - type);
      const walkElbow = 0.30 * Math.abs(swing);

      // 俯身：拿手机 / 打字时上身微微前倾，手才够得到桌面。
      const lean = 0.27 * grab + 0.09 * type;
      const chest = h.getNormalizedBoneNode("chest");
      const chestBase = this._avatarBase && this._avatarBase.chest;
      if (chest && chestBase) {
        chest.quaternion
          .copy(chestBase.q)
          .multiply(new THREE.Quaternion().setFromAxisAngle(X, lean));
      }

      // pre 绕世界轴转（改变手臂朝向），post 绕骨骼自身轴转（屈肘）。
      const set = (name, pre, post) => {
        const node = h.getNormalizedBoneNode(name);
        if (!node || !base[name]) return;
        let q = base[name].clone();
        (post || []).forEach(([axis, angle]) => {
          if (Math.abs(angle) > 1e-5) {
            q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
          }
        });
        (pre || []).forEach(([axis, angle]) => {
          if (Math.abs(angle) > 1e-5) {
            q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
          }
        });
        node.quaternion.copy(q);
      };

      set(
        "leftUpperArm",
        [
          [X, -0.15 * type],
          [Z, -1.05 * type],
          [X, -0.50 * swing],
          [X, -0.28 * sit],
          [Z, -0.40 * sit],
          [Z, -0.35 * lie],
          [Z, -0.24 * walkAmp],
        ],
        [[Z, 2.65 * stretch]]
      );
      set(
        "rightUpperArm",
        [
          [X, -0.34 * type],
          [Z, -0.13 * type],
          [X, -0.95 * grab],
          [Z, -0.80 * grab],
          [Y, 0.55 * phone],
          [Z, 0.55 * phone],
          [X, -0.55 * phone],
          [X, 0.50 * swing],
          [X, -0.28 * sit],
          [Z, 0.40 * sit],
          [Z, 0.35 * lie],
          [Z, 0.24 * walkAmp],
        ],
        [[Z, -2.65 * stretch]]
      );
      // 打字时左右手交替敲的细小起伏。
      const tapR = Math.sin(this._time * 11) * 0.07 * type;
      const tapL = Math.sin(this._time * 11 + 2.1) * 0.07 * type;
      // 躺下时手臂贴在身体两侧、手肘微屈（不会举到半空）。
      set(
        "rightLowerArm",
        [],
        [
          [Y, 1.61 * type + tapR],
          [Y, 0.07 * grab],
          [Y, 1.10 * phone],
          [X, 0.55 * phone],
          [Y, 0.60 * sit],
          [Y, walkElbow],
          [Y, 0.22 * lie],
        ]
      );
      set(
        "leftLowerArm",
        [],
        [
          [Y, -2.05 * type - tapL],
          [X, 0.22 * stretch],
          [Y, -0.60 * sit],
          [Y, -walkElbow],
          [Y, -0.12 * lie],
        ]
      );

      // 玩手机时低头看屏，平时轻微左右张望。
      const head = h.getNormalizedBoneNode("head");
      const headBase = this._avatarBase && this._avatarBase.head;
      if (head && headBase) {
        const q = headBase.q.clone();
        q.multiply(new THREE.Quaternion().setFromAxisAngle(X, 0.38 * phone));
        // 伸手拿手机时看着桌面；打字时看着屏幕（略低头）。
        q.multiply(new THREE.Quaternion().setFromAxisAngle(X, 0.26 * grab + 0.10 * type));
        // 窗边看风景：微微抬头，视线落到窗外远处。
        const lookOut = this._lookOut || 0;
        if (lookOut > 0.01) {
          q.multiply(new THREE.Quaternion().setFromAxisAngle(X, -0.26 * lookOut));
          q.multiply(new THREE.Quaternion().setFromAxisAngle(Y, 0.12 * lookOut));
        }
        if (phone < 0.2) {
          q.multiply(
            new THREE.Quaternion().setFromAxisAngle(Y, Math.sin(this._time * 0.35) * 0.14)
          );
        }
        // 躺下时头自然侧向枕头一侧，而不是直挺挺朝上。
        if (lie > 0.001) {
          q.multiply(new THREE.Quaternion().setFromAxisAngle(Z, 0.15 * lie));
          q.multiply(new THREE.Quaternion().setFromAxisAngle(Y, 0.10 * lie));
        }
        head.quaternion.copy(q);
      }

      if (this._handPhone) {
        // 手机在桌面上时是桌面道具，拿到手里才显示手持模型。
        this._handPhone.visible = !!this._phoneHeld;
        if (this._handPhone.visible) this._updatePhonePose();
        else if (this._handBone && this._handBaseQ) {
          // 放下后手腕回正，否则会一直保持"看手机"的扭转角度。
          this._handBone.quaternion.copy(this._handBaseQ);
        }
      }

      // 手指自然收拢：平时微屈，坐着更放松，握手机时只轻轻贴着手机背面
      //（握太紧指尖会翻到屏幕上，看起来就是"手穿过手机"）。
      const curl = 0.10 + 0.06 * phone + 0.16 * grab + 0.26 * type + 0.12 * sit;
      if (this._fingerNodes) {
        const q = new THREE.Quaternion();
        this._fingerNodes.forEach((f) => {
          q.setFromAxisAngle(Z, curl * f.w);
          f.node.quaternion.copy(f.base).multiply(q);
        });
      }
      // 握手机时拇指收拢到手机正面边缘，看起来才是"捏着"而不是摊开手。
      if (this._thumbNodes && this._thumbNodes.length) {
        const w = Math.min(1, phone * 1.2);
        const e = new THREE.Euler(0, 0, 0, "XYZ");
        const q = new THREE.Quaternion();
        const angles = [[0.9 * w, 0, 0.3 * w], [-0.3 * w, 0, -0.4 * w], [0, 0, 0]];
        this._thumbNodes.forEach((t, i) => {
          const a = angles[i] || [0, 0, 0];
          if (!a[0] && !a[1] && !a[2]) {
            t.node.quaternion.copy(t.base);
            return;
          }
          e.set(a[0], a[1], a[2]);
          q.setFromEuler(e);
          t.node.quaternion.copy(t.base).multiply(q);
        });
      }
    }

    /** 躺下时按髋骨高度贴合床面（包围盒会把垂下的手臂/hair 算进来，导致整个人悬空）。 */
    _measureLieY() {
      const THREE = this.THREE;
      const scene = this._avatar.scene;
      const h = this._avatar.humanoid;
      const hips = h && h.getNormalizedBoneNode("hips");
      const top = (this._bedBox && this._bedBox.top) || 0.55;
      const prevQ = scene.quaternion.clone();
      const prevY = scene.position.y;
      // 先临时摆成完全躺下的朝向再量，否则量到的是半躺状态。
      scene.position.y = this._avatarY; // 量"相对站姿高度"的偏移，和躺下时的算法保持一致
      scene.quaternion.copy(this._lieQuat());
      scene.updateMatrixWorld(true);
      if (hips) {
        const world = new THREE.Vector3();
        hips.getWorldPosition(world);
        this._lieYFix = top + 0.10 - world.y; // 躯干中线离床面约 0.10m
      } else {
        const box = new THREE.Box3().setFromObject(scene);
        this._lieYFix = top + 0.02 - box.min.y;
      }
      scene.position.y = prevY;
      scene.quaternion.copy(prevQ);
      scene.updateMatrixWorld(true);
    }

    /** 读取双脚踝骨的世界 Y（取较低的一只）。 */
    _ankleWorldY() {
      const h = this._avatar && this._avatar.humanoid;
      if (!h) return null;
      const lf = h.getNormalizedBoneNode("leftFoot");
      const rf = h.getNormalizedBoneNode("rightFoot");
      if (!lf && !rf) return null;
      this._avatar.scene.updateMatrixWorld(true);
      const v = new this.THREE.Vector3();
      let y = Infinity;
      if (lf) y = Math.min(y, lf.getWorldPosition(v).y);
      if (rf) y = Math.min(y, rf.getWorldPosition(v).y);
      return isFinite(y) ? y : null;
    }

    /** 贴地：整体上下平移根节点，让脚踝始终回到站立时测得的基准高度。 */
    _groundFeet() {
      const y = this._ankleWorldY();
      if (y == null) return;
      const root = this._avatar.scene;
      if (this._ankleTarget == null) this._ankleTarget = y;
      root.position.y += this._ankleTarget - y;
      root.updateMatrixWorld(true);
      if (this.renderer) this.renderer._baseY = root.position.y;
    }

    /* ---------------- 转椅拖拽旋转 ---------------- */

    /** 把椅子角度同步到椅子本体；角色姿态统一交给 _applyPose。 */
    _syncChair() {
      if (this._chair) this._chair.rotation.y = this._chairAngle;
      this._applyPose();
    }

    _pickChair(e) {
      if (!this._raycaster) return false;
      const rect = this.canvas.getBoundingClientRect();
      this._ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      this._raycaster.setFromCamera(this._ndc, this.camera);
      const targets = [this._chair];
      if (this._sitting && this._avatar) targets.push(this._avatar.scene);
      return this._raycaster.intersectObjects(targets, true).length > 0;
    }

    _initChairDrag() {
      const canvas = this.canvas;
      if (!canvas || !this._chair) return;
      const THREE = this.THREE;
      this._raycaster = new THREE.Raycaster();
      this._ndc = new THREE.Vector2();
      this._dragging = false;
      this._dragX = 0;

      canvas.style.touchAction = "none";
      canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !this._pickChair(e)) return;
        this._dragging = true;
        this._dragX = e.clientX;
        canvas.style.cursor = "grabbing";
        if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      canvas.addEventListener("pointermove", (e) => {
        if (this._dragging) {
          this._chairAngle += (e.clientX - this._dragX) * 0.012;
          this._dragX = e.clientX;
          this._syncChair();
          e.preventDefault();
          return;
        }
        canvas.style.cursor = this._pickChair(e) ? "grab" : "default";
      });
      const endDrag = () => {
        this._dragging = false;
        canvas.style.cursor = "default";
      };
      canvas.addEventListener("pointerup", endDrag);
      canvas.addEventListener("pointercancel", endDrag);
    }

    /* ---------------- 相机 / 开关 ---------------- */

    setPreset(name, immediate) {
      const preset = PRESETS[name] || PRESETS.desk;
      this._preset = name;
      this._targetPos.fromArray(preset.pos);
      this._targetLook.fromArray(preset.look);
      this._targetFov = preset.fov || 30;
      // 肖像视角跟随角色，先把目标对准当前位置，避免切换瞬间甩镜头。
      if (name === "portrait") this._followPortrait();
      if (immediate) {
        this.camera.position.copy(this._targetPos);
        this._look.copy(this._targetLook);
        this.camera.lookAt(this._look);
        this._fov = this._targetFov;
        this.camera.fov = this._fov;
        this.camera.updateProjectionMatrix();
      }
    }

    /** 肖像视角跟随：镜头始终对准角色的头部，随站/坐/走/躺一起移动。 */
    _followPortrait() {
      if (!this._avatar) return;
      const THREE = this.THREE;
      const h = this._avatar.humanoid;
      const head = h && h.getNormalizedBoneNode("head");
      if (!head) return;
      const headPos = new THREE.Vector3();
      head.getWorldPosition(headPos);

      if (this._lieT > 0.25) {
        // 躺下时从床外侧斜上方看脸（避开靠墙的一侧）
        this._targetPos.set(headPos.x + 0.02, headPos.y + 0.55, headPos.z - 0.95);
        this._targetLook.copy(headPos);
        this._targetFov = 30;
        return;
      }

      const root = this._avatar.scene;
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
      fwd.normalize();
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      this._targetPos
        .copy(headPos)
        .addScaledVector(fwd, 1.18)
        .addScaledVector(right, 0.16);
      this._targetPos.y += 0.16;
      this._targetLook.copy(headPos);
      this._targetLook.y += 0.015;
      this._targetFov = 26;
    }

    setRoomVisible(visible) {
      this.group.visible = !!visible;
    }

    update(dt) {
      this._time += dt;
      this._updatePose(dt);
      if (this._preset === "portrait") this._followPortrait();
      const k = 1 - Math.pow(0.0025, Math.min(dt, 0.05));
      this.camera.position.lerp(this._targetPos, k);
      this._look.lerp(this._targetLook, k);
      this.camera.lookAt(this._look);
      this._fov += (this._targetFov - this._fov) * k;
      if (Math.abs(this.camera.fov - this._fov) > 0.01) {
        this.camera.fov = this._fov;
        this.camera.updateProjectionMatrix();
      }
    }
  }

  global.WorldLayer = WorldLayer;
})(typeof window !== "undefined" ? window : globalThis);

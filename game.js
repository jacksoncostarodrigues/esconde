(() => {
  'use strict';

  const BOT_SPAWN_INTERVAL = 30;
  const MAP_LIMIT = 21;
  const BOT_CONFIG = {
    viewDistance: 16,
    viewAngleDeg: 110,
    detectionSpeed: 2.2,
    detectionDecay: 0.35,
    chaseThreshold: 0.55,
    patrolSpeed: 2.5,
    chaseSpeed: 4
  };
  const BOT_SPAWNS = [
    { x: -10, z: -15 }, { x: 10, z: 15 }, { x: -18, z: 10 },
    { x: 18, z: -10 }, { x: 0, z: -20 }
  ];
  const $ = id => document.getElementById(id);
  let scene, cameraEl, rigEl, gameOverModalEl, vrPanelEl, alertEl;
  let vrHudEl, vrHudTimeEl, vrHudSlapsEl, vrHudStunsEl, vrHudScoreEl, vrHudHuntersEl, vrHudDetBar;
  let timeEl, scoreEl, finalScoreEl, botCountEl, botStatesEl, detectionFillEl, slapEl, stunEl;
  let slapCount = 0, mouseSpeed = 0, mouseLast = { x: 0, y: 0, t: 0 }, desktopThrust = 0;
  let desktopRightHand, desktopLeftHand, desktopHandsEl, leftTrackedHand, rightTrackedHand;
  let leftControllerEl, rightControllerEl;
  const handSamples = new Map();
  let slapCooldown = { left: 0, right: 0 };
  let survivalTime = 0, score = 0, isGameOver = false;
  let movementPenalty = 0, camoQuality = 0, soundTimer = 0;
  let playerWalkTime = 0, alertTimeout = null, audioCtx = null;
  let lastRigPos = null;
  const keys = new Set();
  const bots = [];
  const hidingSpots = [];
  const tmpPlayer = new THREE.Vector3();
  const tmpSpot = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();

  const DEFAULT_SKIN_COLOR = '#e2a780';

  let isBoostActive = false;
  let boostTimer = 0;
  let powerupEntities = [];

  // Cache de estado da HUD VR para evitar atualizações redundantes.
  const vrHudState = { time: '', slaps: -1, stuns: -1, scoreKey: '', hunters: -1 };

  // ============================================================
  // game-loop — roda a simulação em desktop E em VR (WebXR).
  // ============================================================
  AFRAME.registerComponent('game-loop', {
    tick: function (time, delta) {
      if (!scene || !scene.hasLoaded) return;
      if (isGameOver) return;
      const dt = Math.max(0.001, Math.min(delta / 1000, 0.05));
      updateGame(dt);
    }
  });

  // ============================================================
  // vr-click-handler — emite 'click' nos .clickable ao apertar trigger.
  // ============================================================
  AFRAME.registerComponent('vr-click-handler', {
    init: function () {
      const self = this;
      this.el.addEventListener('triggerdown', function () {
        const rc = self.el.components.raycaster;
        if (!rc || !rc.intersections) return;
        for (let i = 0; i < rc.intersections.length; i++) {
          let target = rc.intersections[i].object && rc.intersections[i].object.el;
          while (target) {
            if (target.classList && target.classList.contains('clickable')) {
              target.emit('click', { intersection: rc.intersections[i] }, false);
              return;
            }
            target = target.parentEl;
          }
        }
      });
    }
  });

  // ============================================================
  // vr-thumbstick-movement — locomoção VR
  // ============================================================
  AFRAME.registerComponent('vr-thumbstick-movement', {
    schema: {
      speed: { type: 'number', default: 3.5 },
      deadzone: { type: 'number', default: 0.25 }
    },

    init: function () {
      this.stickL = { x: 0, y: 0 };
      this.stickR = { x: 0, y: 0 };
      this.rawL = [0, 0, 0, 0];
      this.rawR = [0, 0, 0, 0];
      this.debugEl = null;
      this.debugText = null;
      this.debugTimer = null;
      this._bindControllers();
      this._createDebugHud();
    },

    _bindControllers: function () {
      const self = this;
      ['left', 'right'].forEach(side => {
        const ctrl = document.querySelector('#' + side + '-controller');
        if (!ctrl) return;
        const stickKey = side === 'left' ? 'stickL' : 'stickR';
        const rawKey = side === 'left' ? 'rawL' : 'rawR';

        ctrl.addEventListener('axismove', (evt) => {
          const a = evt.detail && evt.detail.axis;
          if (!a) return;
          for (let i = 0; i < 4; i++) self[rawKey][i] = (typeof a[i] === 'number') ? a[i] : 0;
          let x = self[rawKey][2];
          let y = self[rawKey][3];
          if (Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3) {
            if (Math.abs(self[rawKey][0]) > 1e-3 || Math.abs(self[rawKey][1]) > 1e-3) {
              x = self[rawKey][0];
              y = self[rawKey][1];
            }
          }
          self[stickKey].x = x;
          self[stickKey].y = y;
          self._refreshDebugHud();
        });

        ctrl.addEventListener('thumbstickmoved', (evt) => {
          const d = evt.detail || {};
          if (typeof d.x === 'number') self[stickKey].x = d.x;
          if (typeof d.y === 'number') self[stickKey].y = d.y;
          self._refreshDebugHud();
        });
      });
    },

    _createDebugHud: function () {
      const self = this;
      setTimeout(() => {
        const cam = document.querySelector('#camera');
        if (!cam) return;
        const el = document.createElement('a-entity');
        el.innerHTML = `
          <a-plane width="0.9" height="0.18" color="#000" opacity="0.7"></a-plane>
          <a-text value="Stick: ---" align="center" width="1.2" color="#00ffcc"
                  position="0 0 0.01"></a-text>
        `;
        el.setAttribute('position', '0 -0.55 -1');
        el.setAttribute('visible', 'false');
        cam.appendChild(el);
        self.debugEl = el;
        self.debugText = el.querySelector('a-text');
      }, 600);
    },

    _refreshDebugHud: function () {
      if (!this.debugEl || !this.debugText) return;
      const L = this.stickL, R = this.stickR;
      const val =
        `L:${L.x.toFixed(2)},${L.y.toFixed(2)}  R:${R.x.toFixed(2)},${R.y.toFixed(2)}\n` +
        `rawL:${this.rawL.map(v => v.toFixed(1)).join(',')}  rawR:${this.rawR.map(v => v.toFixed(1)).join(',')}`;
      this.debugText.setAttribute('value', val);
      this.debugEl.setAttribute('visible', 'true');
      if (this.debugTimer) clearTimeout(this.debugTimer);
      this.debugTimer = setTimeout(() => {
        if (this.debugEl) this.debugEl.setAttribute('visible', 'false');
      }, 2500);
    },

    tick: function (time, delta) {
      const sceneEl = this.el.sceneEl;
      if (!sceneEl || !sceneEl.is('vr-mode')) return;

      let stickX = 0, stickY = 0;
      if (Math.abs(this.stickL.x) > Math.abs(stickX)) stickX = this.stickL.x;
      if (Math.abs(this.stickR.x) > Math.abs(stickX)) stickX = this.stickR.x;
      if (Math.abs(this.stickL.y) > Math.abs(stickY)) stickY = this.stickL.y;
      if (Math.abs(this.stickR.y) > Math.abs(stickY)) stickY = this.stickR.y;

      const DZ = this.data.deadzone;
      if (Math.abs(stickX) < DZ) stickX = 0;
      if (Math.abs(stickY) < DZ) stickY = 0;
      if (!stickX && !stickY) return;

      const camera = sceneEl.camera;
      if (!camera) return;

      const dt = Math.min(delta / 1000, 0.05);

      const camQuat = new THREE.Quaternion();
      camera.getWorldQuaternion(camQuat);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuat);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) {
        forward.set(0, 0, -1).applyQuaternion(this.el.object3D.quaternion);
        forward.y = 0;
      }
      forward.normalize();

      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      const moveDir = new THREE.Vector3()
        .addScaledVector(forward, -stickY)
        .addScaledVector(right,   stickX);

      if (moveDir.lengthSq() < 1e-6) return;
      moveDir.normalize();

      const speed = this.data.speed * (isBoostActive ? 1.8 : 1) * dt;
      this.el.object3D.position.addScaledVector(moveDir, speed);
    }
  });

  // ============================================================
  // Construção das mãos
  // ============================================================
  function buildDesktopHand(handEl, left) {
    if (!handEl || handEl.dataset.built === '1') return;
    handEl.dataset.built = '1';
    const add = (tag, attrs, parent = handEl) => {
      const el = document.createElement(tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      parent.appendChild(el); return el;
    };

    const skin = DEFAULT_SKIN_COLOR, shadow = '#c28760';

    add('a-sphere', { class: 'hand-part', position: '0 0 0', radius: '0.11', scale: '1.1 0.7 0.5', color: skin, material: 'roughness: 0.6; metalness: 0.1' });

    for (let i = 0; i < 4; i++) {
      const x = (i - 1.5) * 0.044;
      const length = [0.09, 0.11, 0.10, 0.08][i];
      add('a-cylinder', { class: 'hand-part', position: `${x} ${0.06 + length / 2} 0`, radius: '0.016', height: String(length), color: skin, material: 'roughness: 0.7' });
      add('a-sphere', { class: 'hand-part-shadow', position: `${x} ${0.06 + length} 0`, radius: '0.017', color: shadow });
      add('a-cylinder', { class: 'hand-part', position: `${x} ${0.06 + length + 0.03} -0.01`, radius: '0.014', height: '0.05', rotation: '-15 0 0', color: skin, material: 'roughness: 0.7' });
      add('a-sphere', { class: 'hand-part', position: `${x} ${0.06 + length + 0.055} -0.018`, radius: '0.014', color: skin });
    }

    const thumbX = left ? '0.08' : '-0.08';
    add('a-cylinder', { class: 'hand-part', position: `${thumbX} 0.01 0.02`, radius: '0.018', height: '0.08', rotation: `20 0 ${left ? '-45' : '45'}`, color: skin, material: 'roughness: 0.7' });
    add('a-sphere', { class: 'hand-part', position: `${left ? '0.12' : '-0.12'} 0.03 0.03`, radius: '0.018', color: skin });

    handEl.setAttribute('scale', '1 1 1');
  }

  function attachVRHandToController(controllerEl, left) {
    if (!controllerEl || controllerEl.querySelector('.vr-hand')) return;
    const handEl = document.createElement('a-entity');
    handEl.classList.add('vr-hand');
    handEl.classList.add('hand-part');
    buildDesktopHand(handEl, left);
    handEl.setAttribute('scale', '1.1 1.1 1.1');
    handEl.setAttribute('rotation', '-90 0 0');
    handEl.setAttribute('position', '0 0.02 -0.05');
    controllerEl.appendChild(handEl);
  }

  function updateVRHandsVisibility() {
    if (!scene || !scene.is('vr-mode')) return;
    ['left', 'right'].forEach(side => {
      const ctrl = $(side + '-controller');
      if (!ctrl) return;
      const ctrlHand = ctrl.querySelector('.vr-hand');
      const trackedHand = $(side + '-tracked-hand');
      const comp = ctrl.components && ctrl.components['tracked-controls'];
      const hasController = !!(comp && comp.controller);
      if (ctrlHand) ctrlHand.setAttribute('visible', hasController ? 'true' : 'false');
      if (trackedHand) trackedHand.setAttribute('visible', hasController ? 'false' : 'true');
    });
  }

  // ============================================================
  // Mouse / Desktop
  // ============================================================
  function onMouseMove(e) {
    const now = performance.now();
    if (mouseLast.t) {
      const dt = Math.max(0.008, (now - mouseLast.t) / 1000);
      mouseSpeed = Math.hypot(e.clientX - mouseLast.x, e.clientY - mouseLast.y) / dt;
      if (!scene.is('vr-mode') && mouseSpeed > 850) desktopThrust = 0.24;
    }
    mouseLast = { x: e.clientX, y: e.clientY, t: now };
    if (!scene.is('vr-mode') && desktopRightHand && cameraEl) {
      const x = Math.max(-0.58, Math.min(0.58, (e.clientX / window.innerWidth - 0.5) * 1.15));
      const y = Math.max(-0.42, Math.min(0.28, (0.5 - e.clientY / window.innerHeight) * 0.75 - 0.18));
      desktopRightHand.object3D.position.x = x;
      desktopRightHand.object3D.position.y = y;
    }
  }

  function updateDesktopHand(dt) {
    if (!desktopRightHand || scene.is('vr-mode')) return;
    desktopThrust = Math.max(0, desktopThrust - dt * 0.9);
    const p = desktopRightHand.object3D.position;
    p.z = -0.68 - desktopThrust * 2.1;
    mouseSpeed = Math.max(0, mouseSpeed - dt * 1800);
  }

  // ============================================================
  // Detecção de tapas
  // ============================================================
  function getTrackedPalmPosition(handEl, out) {
    const component = handEl.components && handEl.components['hand-tracking-controls'];
    const joints = component && component.jointEls;
    if (!joints || !joints.length) { handEl.object3D.getWorldPosition(out); return out; }
    const ids = [0, 5, 10, 15, 20];
    out.set(0, 0, 0);
    let count = 0;
    ids.forEach(i => {
      const joint = joints[i];
      if (joint && joint.object3D && joint.object3D.visible) {
        const p = new THREE.Vector3(); joint.object3D.getWorldPosition(p);
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) { out.add(p); count++; }
      }
    });
    if (count) out.multiplyScalar(1 / count);
    else handEl.object3D.getWorldPosition(out);
    return out;
  }

  function getSourcePosition(src, out) {
    if (src.kind === 'hand') {
      if (src.el.getAttribute('visible') === false) return false;
      const comp = src.el.components && src.el.components['hand-tracking-controls'];
      const joints = comp && comp.jointEls;
      if (!joints || !joints.length) return false;
      let anyTracked = false;
      for (let i = 0; i < joints.length; i++) {
        const j = joints[i];
        if (j && j.object3D && j.object3D.visible) { anyTracked = true; break; }
      }
      if (!anyTracked) return false;
      getTrackedPalmPosition(src.el, out);
      return true;
    }
    if (src.kind === 'controller') {
      const comp = src.el.components && src.el.components['tracked-controls'];
      if (!comp || !comp.controller) return false;
      src.el.object3D.getWorldPosition(out);
      const q = src.el.object3D.getWorldQuaternion(new THREE.Quaternion());
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      out.add(fwd.multiplyScalar(0.10));
      return true;
    }
    if (src.kind === 'desktop') {
      src.el.object3D.getWorldPosition(out);
      return true;
    }
    return false;
  }

  function detectHandSlaps(dt) {
    const inVR = scene.is('vr-mode');

    const sources = [];
    if (

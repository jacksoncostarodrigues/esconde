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
  let scene, cameraEl, rigEl, gameOverModalEl, vrPanelEl, alertEl, vrHudEl, vrHudTextEl;
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

  // ============================================================
  // COMPONENTE: locomoção por thumbstick (VR)
  // - Lê por DOIS caminhos: 'thumbstickmoved' (direto) e 'axismove'
  //   (array completo, thumbstick = índices 2/3 no Quest).
  // - Combina os dois controles: usa o que estiver mais deslocado.
  // - Deadzone alta (0.25) para eliminar drift.
  // - HUD de diagnóstico visível em VR com valores ao vivo.
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

        // Caminho 1: axismove sempre dispara — traz o array COMPLETO dos eixos.
        // No Quest (xr-standard), axes[2]/[3] é o thumbstick, axes[0]/[1] é touchpad.
        ctrl.addEventListener('axismove', (evt) => {
          const a = evt.detail && evt.detail.axis;
          if (!a) return;
          for (let i = 0; i < 4; i++) self[rawKey][i] = (typeof a[i] === 'number') ? a[i] : 0;
          // Thumbstick é 2/3 no Quest. Se forem 0 mas 0/1 têm valor,
          // o controle mapeia o stick em 0/1 (raro, mas acontece).
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

        // Caminho 2: thumbstickmoved (A-Frame extrai do gamepad).
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
      // Cria no próximo frame para o #camera já existir
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

      // Combina os dois controles: valor de maior magnitude por eixo
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

      // Direção da cabeça em mundo
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

      // xr-standard: thumbstick Y = -1 quando empurrado PRA CIMA (frente),
      // +1 quando puxado pra baixo. Por isso forward = -stickY.
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
    if (inVR) {
      sources.push({ id: 'left',  el: leftTrackedHand,   kind: 'hand' });
      sources.push({ id: 'right', el: rightTrackedHand,  kind: 'hand' });
      sources.push({ id: 'left',  el: leftControllerEl,  kind: 'controller' });
      sources.push({ id: 'right', el: rightControllerEl, kind: 'controller' });
    } else {
      sources.push({ id: 'right', el: desktopRightHand,  kind: 'desktop' });
    }

    const usedSides = new Set();

    for (const src of sources) {
      if (!src.el || !src.el.object3D) continue;
      if (usedSides.has(src.id)) continue;

      const world = new THREE.Vector3();
      if (!getSourcePosition(src, world)) continue;
      usedSides.add(src.id);

      const prev = handSamples.get(src.id);
      let speed = 0;
      if (prev && prev.kind === src.kind) {
        speed = world.distanceTo(prev.pos) / Math.max(dt, 0.001);
      }
      handSamples.set(src.id, { pos: world.clone(), kind: src.kind });

      if (src.kind === 'desktop') {
        speed = Math.max(speed, desktopThrust > 0.13 && mouseSpeed > 350 ? 2.8 : 0);
      }

      const minSpeed = src.kind === 'desktop' ? 1.6 : 1.65;
      if (speed < minSpeed || slapCooldown[src.id] > 0) continue;

      let closest = null, closestDist = Infinity;
      for (const bot of bots) {
        if (!bot.active || bot.stunned > 0.15) continue;
        const target = new THREE.Vector3();
        bot.el.object3D.getWorldPosition(target);
        target.y += 1.45;
        const d = world.distanceTo(target);
        if (d < closestDist) { closestDist = d; closest = bot; }
      }

      const maxRange = src.kind === 'hand' ? 1.1 : src.kind === 'controller' ? 1.4 : 1.35;
      if (!closest || closestDist >= maxRange) continue;

      const botForward = new THREE.Vector3(0, 0, -1).applyQuaternion(closest.el.object3D.quaternion);
      const botPos = new THREE.Vector3();
      closest.el.object3D.getWorldPosition(botPos);
      const handDir = world.clone().sub(botPos).normalize();
      const dot = botForward.dot(handDir);

      if (dot > 0.1) {
        alertEl.textContent = '😱 O ROBÔ TE VIU DANDO O TAPA DE FRENTE!';
        alertEl.style.display = 'block';
        triggerGameOver();
        return;
      } else {
        slapRobot(closest, src.id);
      }
    }
  }

  function slapRobot(bot, handId) {
    bot.stunned = 3.2; bot.dizzyTime = 0; bot.slapCount++;
    bot.state = 'Tonteado'; bot.detectionMeter = Math.max(0, bot.detectionMeter - 0.8);
    slapCount++; score = Math.floor(survivalTime * 10) + slapCount * 100;
    slapCooldown[handId] = 0.65;
    alertEl.textContent = '💥 PÁ! TAPA NAS COSTAS! O ROBÔ FICOU TONTO! ⭐';
    alertEl.style.display = 'block';
    if (alertTimeout) clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => { if (!isGameOver) alertEl.style.display = 'none'; }, 1400);
    playBeep(180, 0.11); setTimeout(() => playBeep(420, 0.12), 80);
    const head = bot.el.querySelector('a-sphere');
    if (head) {
      head.setAttribute('color', '#ffcc00');
      head.setAttribute('scale', '1.25 0.8 1.15');
      setTimeout(() => { if (head.isConnected) { head.setAttribute('scale', '1 1 1'); } }, 350);
    }
    let stars = bot.el.querySelector('.dizzy-stars');
    if (!stars) {
      stars = document.createElement('a-entity'); stars.classList.add('dizzy-stars');
      for (let i = 0; i < 3; i++) {
        const star = document.createElement('a-text');
        star.setAttribute('value', '★'); star.setAttribute('color', '#ffff00'); star.setAttribute('align', 'center');
        star.setAttribute('width', '2');
        star.setAttribute('position', `${Math.cos(i * 2.1) * 0.42} 2.55 ${Math.sin(i * 2.1) * 0.25}`);
        stars.appendChild(star);
      }
      bot.el.appendChild(stars);
    }
    stars.setAttribute('visible', 'true');
    setTimeout(() => { if (stars.isConnected && bot.stunned <= 0.1) stars.setAttribute('visible', 'false'); }, 3300);
  }

  function randomWaypoint() { return { x: (Math.random() * 2 - 1) * 20, z: (Math.random() * 2 - 1) * 20 }; }

  function createBot(index) {
    const botEl = document.createElement('a-entity');
    botEl.id = `seeker-bot-${index + 1}`;
    botEl.setAttribute('position', `${BOT_SPAWNS[index].x} 0 ${BOT_SPAWNS[index].z}`);
    botEl.setAttribute('visible', index === 0 ? 'true' : 'false');
    botEl.innerHTML = `
      <a-box class="bot-body" position="0 1.1 0" width="0.8" height="1.1" depth="0.5" color="#00ff00"></a-box>
      <a-sphere position="0 1.95 0" radius="0.3" color="#222222">
        <a-box class="bot-visor" position="0 0.05 -0.25" width="0.4" height="0.12" depth="0.1" color="#00ff00"></a-box>
        <a-cylinder position="0 0.35 0" radius="0.02" height="0.2" color="#444444"></a-cylinder>
        <a-sphere class="bot-antenna-light" position="0 0.48 0" radius="0.05" color="#00ff00"></a-sphere>
      </a-sphere>
      <a-entity class="bot-arm-r" position="0.5 1.5 0"><a-box position="0 -0.4 0" width="0.2" height="0.8" depth="0.25" color="#333333"></a-box></a-entity>
      <a-entity class="bot-arm-l" position="-0.5 1.5 0"><a-box position="0 -0.4 0" width="0.2" height="0.8" depth="0.25" color="#333333"></a-box></a-entity>
      <a-entity class="bot-leg-r" position="0.25 0.7 0"><a-cylinder position="0 -0.35 0" radius="0.1" height="0.7" color="#333333"></a-cylinder></a-entity>
      <a-entity class="bot-leg-l" position="-0.25 0.7 0"><a-cylinder position="0 -0.35 0" radius="0.1" height="0.7" color="#333333"></a-cylinder></a-entity>`;
    $('bot-container').appendChild(botEl);
    return {
      id: botEl.id, el: botEl, active: index === 0,
      state: index === 0 ? 'Patrulhando' : 'Inativo', detectionMeter: 0,
      currentPatrolTarget: randomWaypoint(), waitTime: 0, walkTime: 0,
      spawnPos: { x: BOT_SPAWNS[index].x, z: BOT_SPAWNS[index].z },
      lastKnownPos: { x: 0, z: 0 }, stunned: 0, dizzyTime: 0, slapCount: 0
    };
  }

  function init() {
    scene = $('game-scene'); cameraEl = $('camera'); rigEl = $('rig');
    gameOverModalEl = $('game-over-modal'); vrPanelEl = $('vr-game-over-panel'); alertEl = $('alert-overlay');
    vrHudEl = $('vr-hud'); vrHudTextEl = $('vr-hud-text');
    timeEl = $('time-val'); scoreEl = $('score-val'); finalScoreEl = $('final-score');
    botCountEl = $('bot-count-val'); botStatesEl = $('bot-states-list'); detectionFillEl = $('detection-fill');
    slapEl = $('slap-val'); stunEl = $('stun-val');
    desktopHandsEl = $('desktop-hands'); desktopRightHand = $('desktop-right-hand'); desktopLeftHand = $('desktop-left-hand');
    leftTrackedHand = $('left-tracked-hand'); rightTrackedHand = $('right-tracked-hand');
    leftControllerEl = $('left-controller'); rightControllerEl = $('right-controller');

    buildDesktopHand(desktopLeftHand, true);
    buildDesktopHand(desktopRightHand, false);

    attachVRHandToController(leftControllerEl, true);
    attachVRHandToController(rightControllerEl, false);

    if (!scene || !cameraEl || !rigEl) return;
    document.querySelectorAll('.hiding-spot').forEach(el => hidingSpots.push(el));
    BOT_SPAWNS.forEach((_, i) => bots.push(createBot(i)));
    lastRigPos = rigEl.object3D.position.clone();

    // Componente de locomoção VR no rig
    rigEl.setAttribute('vr-thumbstick-movement', 'speed: 3.5; deadzone: 0.25');

    $('btn-restart-2d').addEventListener('click', restartGame);
    $('btn-quit-2d').addEventListener('click', quitGame);
    $('vr-btn-restart').addEventListener('click', restartGame);
    $('vr-btn-quit').addEventListener('click', quitGame);

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => keys.clear());
    document.addEventListener('pointerdown', unlockAudio, { once: true });
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    $('controls-hint').textContent = 'PC: WASD/setas para mover · mouse para olhar.';

    scene.addEventListener('enter-vr', () => {
      $('controls-hint').textContent = 'Quest: empurre o ANALÓGICO para andar · aproxime por TRÁS e dê um tapa.';
      if (desktopHandsEl) desktopHandsEl.setAttribute('visible', 'false');
      if (vrHudEl) vrHudEl.setAttribute('visible', 'true');
    });

    scene.addEventListener('exit-vr', () => {
      $('controls-hint').textContent = 'PC: WASD/setas para mover · mouse para olhar · mova o mouse rapidamente nas costas do robô.';
      if (desktopHandsEl) desktopHandsEl.setAttribute('visible', 'true');
      if (leftTrackedHand) leftTrackedHand.setAttribute('visible', 'false');
      if (rightTrackedHand) rightTrackedHand.setAttribute('visible', 'false');
      if (vrHudEl) vrHudEl.setAttribute('visible', 'false');
    });

    requestAnimationFrame(loop);
  }

  function onKeyDown(e) {
    const key = e.key.toLowerCase();
    if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright',' '].includes(key)) e.preventDefault();
    keys.add(key);
    if (key === 'r' && isGameOver) restartGame();
    unlockAudio();
  }

  function unlockAudio() {
    if (!audioCtx) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioCtor) audioCtx = new AudioCtor();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

  function moveDesktopPlayer(dt) {
    if (scene.is('vr-mode')) return;
    const forward = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const side = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    if (!forward && !side) return;
    const yaw = cameraEl.object3D.rotation.y;
    const moveX = (-Math.sin(yaw) * forward + Math.cos(yaw) * side);
    const moveZ = (-Math.cos(yaw) * forward - Math.sin(yaw) * side);
    const len = Math.hypot(moveX, moveZ) || 1;

    const baseSpeed = (keys.has('shift') ? 6 : 4.2);
    const speed = (isBoostActive ? baseSpeed * 1.8 : baseSpeed) * dt;

    rigEl.object3D.position.x += moveX / len * speed;
    rigEl.object3D.position.z += moveZ / len * speed;
  }

  // ============================================================
  // Powerups (raios)
  // ============================================================
  function createRayElement() {
    const rayContainer = document.createElement('a-entity');
    rayContainer.classList.add('powerup-ray-item');
    rayContainer.innerHTML = `
      <a-cone position="0.08 0.4 0" rotation="0 0 -25" radius-bottom="0.02" radius-top="0.12" height="0.45" color="#ffee00" material="emissive: #ffff00; emissiveIntensity: 0.9"></a-cone>
      <a-box position="0 0.15 0" rotation="0 0 45" width="0.25" height="0.1" depth="0.1" color="#ffff00" material="emissive: #ffff00; emissiveIntensity: 1"></a-box>
      <a-cone position="-0.08 -0.15 0" rotation="0 0 -25" radius-bottom="0.13" radius-top="0.01" height="0.45" color="#ffee00" material="emissive: #ffff00; emissiveIntensity: 0.9"></a-cone>
      <a-light type="point" color="#ffff00" intensity="1.2" distance="4"></a-light>
    `;
    const rx = (Math.random() * 2 - 1) * MAP_LIMIT;
    const rz = (Math.random() * 2 - 1) * MAP_LIMIT;
    rayContainer.setAttribute('position', `${rx} 1.1 ${rz}`);
    scene.appendChild(rayContainer);
    return rayContainer;
  }

  function syncPowerups(targetCount) {
    while (powerupEntities.length < targetCount) {
      powerupEntities.push(createRayElement());
    }
  }

  function removeAllPowerups() {
    powerupEntities.forEach(el => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    powerupEntities = [];
  }

  function checkPowerupPickup(playerPos) {
    for (let i = powerupEntities.length - 1; i >= 0; i--) {
      const el = powerupEntities[i];
      if (!el || !el.object3D) continue;
      const p = el.object3D.position;
      const dist = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);

      if (dist < 1.4) {
        if (el.parentNode) el.parentNode.removeChild(el);
        powerupEntities.splice(i, 1);

        isBoostActive = true;
        boostTimer = 5.0;
        playBeep(1200, 0.25);
        alertEl.textContent = '⚡ RAIO PEGO! SUPER VELOCIDADE ATIVADA! 🚀';
        alertEl.style.display = 'block';
        setTimeout(() => { if (!isGameOver) alertEl.style.display = 'none'; }, 1500);
      }
    }
  }

  // ============================================================
  // Colisões / limites
  // ============================================================
  function enforceVRWorldBoundsAndCollisions() {
    const camPos = cameraEl.object3D.position;
    const rigPos = rigEl.object3D.position;

    const playerWorldX = rigPos.x + camPos.x;
    const playerWorldZ = rigPos.z + camPos.z;

    const clampedX = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, playerWorldX));
    const clampedZ = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, playerWorldZ));

    rigPos.x += (clampedX - playerWorldX);
    rigPos.z += (clampedZ - playerWorldZ);

    for (const spot of hidingSpots) {
      spot.object3D.getWorldPosition(tmpSpot);
      const sx = parseFloat(spot.dataset.sizex || spot.dataset.size) || 2;
      const sz = parseFloat(spot.dataset.sizez || spot.dataset.size) || 2;
      const hx = sx / 2 + 0.45, hz = sz / 2 + 0.45;

      const currentWorldX = rigPos.x + camPos.x;
      const currentWorldZ = rigPos.z + camPos.z;
      const dx = currentWorldX - tmpSpot.x;
      const dz = currentWorldZ - tmpSpot.z;

      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        const ox = hx - Math.abs(dx);
        const oz = hz - Math.abs(dz);
        if (ox < oz) rigPos.x += (dx >= 0 ? ox : -ox);
        else rigPos.z += (dz >= 0 ? oz : -oz);
      }
    }
  }

  function checkBotSpawns() {
    const count = Math.min(5, 1 + Math.floor(survivalTime / BOT_SPAWN_INTERVAL));
    for (let i = 0; i < count; i++) {
      const bot = bots[i];
      if (bot.active) continue;
      bot.active = true; bot.state = 'Patrulhando'; bot.currentPatrolTarget = randomWaypoint();
      bot.el.setAttribute('visible', 'true');
      alertEl.textContent = `⚠️ NOVO CAÇADOR ENTRANDO! (${i + 1}/5) ⚠️`;
      alertEl.style.display = 'block';
      if (alertTimeout) clearTimeout(alertTimeout);
      alertTimeout = setTimeout(() => { alertEl.style.display = 'none'; }, 2500);
      playBeep(880, 0.12);
    }
  }

  function calculateCamouflage(playerPos) {
    let minDist = Infinity;
    let closestColor = DEFAULT_SKIN_COLOR;

    hidingSpots.forEach(spot => {
      spot.object3D.getWorldPosition(tmpSpot);
      const d = Math.hypot(playerPos.x - tmpSpot.x, playerPos.z - tmpSpot.z);
      if (d < minDist) { minDist = d; closestColor = spot.getAttribute('color') || DEFAULT_SKIN_COLOR; }
    });

    camoQuality = minDist < 4 ? 1 - minDist / 4 : 0;
    const activeColor = camoQuality > 0.1 ? closestColor : DEFAULT_SKIN_COLOR;

    if (desktopHandsEl) {
      document.querySelectorAll('.hand-part').forEach(part => {
        part.setAttribute('color', activeColor);
      });
    }

    if (leftTrackedHand && leftTrackedHand._lastColor !== activeColor) {
      leftTrackedHand._lastColor = activeColor;
      leftTrackedHand.setAttribute('hand-tracking-controls', `hand: left; modelStyle: mesh; modelColor: ${activeColor}`);
    }
    if (rightTrackedHand && rightTrackedHand._lastColor !== activeColor) {
      rightTrackedHand._lastColor = activeColor;
      rightTrackedHand.setAttribute('hand-tracking-controls', `hand: right; modelStyle: mesh; modelColor: ${activeColor}`);
    }
  }

  function updateBot(bot, playerPos, dt) {
    const p = bot.el.object3D.position; p.y = 0;
    const dx = playerPos.x - p.x, dz = playerPos.z - p.z;
    const dist = Math.hypot(dx, dz);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(bot.el.object3D.quaternion);
    tmpDir.set(dx, 0, dz).normalize();
    const angle = dist > 0.001 ? forward.angleTo(tmpDir) * 180 / Math.PI : 0;
    let sees = false;
    if (dist <= BOT_CONFIG.viewDistance && angle <= BOT_CONFIG.viewAngleDeg / 2) {
      const distanceFactor = 1 - dist / BOT_CONFIG.viewDistance;
      const visibility = Math.max(0, Math.min(1, distanceFactor * 0.3 + movementPenalty * 0.5 - camoQuality * 0.4));
      if (visibility > 0.1) { sees = true; bot.detectionMeter = Math.min(1, bot.detectionMeter + visibility * dt * BOT_CONFIG.detectionSpeed); bot.lastKnownPos = { x: playerPos.x, z: playerPos.z }; }
    }
    if (!sees) bot.detectionMeter = Math.max(0, bot.detectionMeter - BOT_CONFIG.detectionDecay * dt);
    if (bot.stunned <= 0 && dist <= 1.55 && bot.detectionMeter >= BOT_CONFIG.chaseThreshold) { triggerGameOver(); return; }

    let moving = false;
    if (bot.stunned > 0) {
      bot.stunned = Math.max(0, bot.stunned - dt); bot.dizzyTime += dt;
      bot.detectionMeter = Math.max(0, bot.detectionMeter - dt * 1.2);
      bot.el.object3D.rotation.z = Math.sin(bot.dizzyTime * 13) * 0.22;
      bot.el.object3D.rotation.y += Math.sin(bot.dizzyTime * 9) * dt * 2.5;
      const ar = bot.el.querySelector('.bot-arm-r'), al = bot.el.querySelector('.bot-arm-l');
      if (ar) ar.setAttribute('rotation', `${Math.sin(bot.dizzyTime * 16) * 75} 0 25`);
      if (al) al.setAttribute('rotation', `${-Math.sin(bot.dizzyTime * 16) * 75} 0 -25`);
      if (bot.stunned === 0) { bot.el.object3D.rotation.z = 0; bot.state = 'Procurando'; bot.waitTime = 1.2; }
      ['.bot-body', '.bot-visor', '.bot-antenna-light'].forEach(sel => { const el = bot.el.querySelector(sel); if (el) el.setAttribute('color', '#ffcc00'); });
      return;
    }
    if (bot.state === 'Patrulhando') {
      if (bot.detectionMeter >= BOT_CONFIG.chaseThreshold) bot.state = 'Perseguindo';
      else if (bot.waitTime > 0) bot.waitTime -= dt;
      else {
        moveBot(bot, bot.currentPatrolTarget, BOT_CONFIG.patrolSpeed * dt); moving = true;
        if (Math.hypot(p.x - bot.currentPatrolTarget.x, p.z - bot.currentPatrolTarget.z) < 1) { bot.currentPatrolTarget = randomWaypoint(); bot.waitTime = 0.7 + Math.random() * 1.4; }
      }
    } else if (bot.state === 'Perseguindo') {
      if (bot.detectionMeter <= 0.2) bot.state = 'Procurando';
      else { moveBot(bot, { x: playerPos.x, z: playerPos.z }, BOT_CONFIG.chaseSpeed * dt); moving = true; }
    } else if (bot.state === 'Procurando') {
      if (bot.detectionMeter >= BOT_CONFIG.chaseThreshold) bot.state = 'Perseguindo';
      else {
        moveBot(bot, bot.lastKnownPos, BOT_CONFIG.patrolSpeed * dt); moving = true;
        if (Math.hypot(p.x - bot.lastKnownPos.x, p.z - bot.lastKnownPos.z) < 1) { bot.state = 'Patrulhando'; bot.currentPatrolTarget = randomWaypoint(); }
      }
    }
    resolveBotObstacles(bot);
    p.x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, p.x)); p.z = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, p.z));
    if (moving) bot.walkTime += dt * (bot.state === 'Perseguindo' ? 12 : 8);
    animateBot(bot, moving);
    const color = bot.state === 'Perseguindo' ? '#ff00ff' : bot.state === 'Procurando' ? '#ffff00' : '#00ff00';
    ['.bot-body', '.bot-visor', '.bot-antenna-light'].forEach(sel => { const el = bot.el.querySelector(sel); if (el) el.setAttribute('color', color); });
  }

  function moveBot(bot, target, step) {
    const p = bot.el.object3D.position, dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
    if (d > 0.05) { p.x += dx / d * step; p.z += dz / d * step; bot.el.object3D.rotation.y = Math.atan2(-dx, -dz); }
  }

  function resolveBotObstacles(bot) {
    const p = bot.el.object3D.position;
    for (const spot of hidingSpots) {
      spot.object3D.getWorldPosition(tmpSpot);
      const sx = parseFloat(spot.dataset.sizex || spot.dataset.size) || 2;
      const sz = parseFloat(spot.dataset.sizez || spot.dataset.size) || 2;
      const hx = sx / 2 + 0.55, hz = sz / 2 + 0.55;
      const dx = p.x - tmpSpot.x, dz = p.z - tmpSpot.z;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        if (hx - Math.abs(dx) < hz - Math.abs(dz)) p.x += dx >= 0 ? hx - Math.abs(dx) : -(hx - Math.abs(dx));
        else p.z += dz >= 0 ? hz - Math.abs(dz) : -(hz - Math.abs(dz));
        if (bot.state === 'Patrulhando') bot.currentPatrolTarget = randomWaypoint();
      }
    }
  }

  function animateBot(bot, moving) {
    const aR = bot.el.querySelector('.bot-arm-r'), aL = bot.el.querySelector('.bot-arm-l');
    const lR = bot.el.querySelector('.bot-leg-r'), lL = bot.el.querySelector('.bot-leg-l');
    if (!aR || !aL || !lR || !lL) return;
    const n = moving ? Math.sin(bot.walkTime) * 30 : 0;
    lR.setAttribute('rotation', `${n} 0 0`); lL.setAttribute('rotation', `${-n} 0 0`);
    aR.setAttribute('rotation', `${-n * 0.8} 0 8`); aL.setAttribute('rotation', `${n * 0.8} 0 -8`);
  }

  function updateHUD(maxDetection) {
    const active = bots.filter(b => b.active).length;
    if (timeEl) timeEl.textContent = survivalTime.toFixed(1);
    if (scoreEl) scoreEl.textContent = String(score);
    if (botCountEl) botCountEl.textContent = String(active);
    if (slapEl) slapEl.textContent = String(slapCount);
    if (stunEl) stunEl.textContent = String(bots.filter(b => b.active && b.stunned > 0).length);
    if (botStatesEl) botStatesEl.innerHTML = bots.filter(b => b.active).map((b) => {
      const c = b.state === 'Perseguindo' ? '#ff5555' : b.state === 'Procurando' ? '#ffff44' : '#00ffcc';
      return `<div>Caçador ${bots.indexOf(b) + 1}: <span style="font-weight:bold;color:${c}">${b.state}</span></div>`;
    }).join('');
    if (detectionFillEl) {
      detectionFillEl.style.width = `${Math.round(maxDetection * 100)}%`;
      detectionFillEl.style.backgroundColor = `rgb(${Math.floor(maxDetection * 255)},${Math.floor((1 - maxDetection) * 255)},0)`;
    }

    if (vrHudTextEl) {
      const boostText = isBoostActive ? ` | ⚡ RAIO (${boostTimer.toFixed(1)}s)` : '';
      vrHudTextEl.setAttribute('value', `Tempo: ${survivalTime.toFixed(1)}s | Pts: ${score}${boostText}`);
    }
  }

  function triggerGameOver() {
    if (isGameOver) return;
    isGameOver = true;
    if (finalScoreEl) finalScoreEl.textContent = String(score);
    const vrFinalScore = $('vr-final-score');
    if (vrFinalScore) vrFinalScore.setAttribute('value', `Pontuação: ${score}`);
    if (gameOverModalEl) gameOverModalEl.style.display = 'block';
    if (alertEl) alertEl.style.display = 'none';

    const camPos = new THREE.Vector3(); cameraEl.object3D.getWorldPosition(camPos);
    const camForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraEl.object3D.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const panelPos = camPos.clone().add(camForward.multiplyScalar(2));
    vrPanelEl.object3D.position.copy(panelPos);
    vrPanelEl.object3D.lookAt(camPos);
    vrPanelEl.setAttribute('visible', 'true');
    playBeep(220, 0.4);
  }

  function restartGame() {
    if (alertTimeout) { clearTimeout(alertTimeout); alertTimeout = null; }
    isGameOver = false; survivalTime = 0; score = 0; slapCount = 0; movementPenalty = 0; camoQuality = 0; playerWalkTime = 0; soundTimer = 0; desktopThrust = 0; mouseSpeed = 0; slapCooldown = { left: 0, right: 0 }; handSamples.clear();
    isBoostActive = false; boostTimer = 0; removeAllPowerups();
    keys.clear();
    rigEl.object3D.position.set(0, 0, 10);
    rigEl.object3D.rotation.set(0, 0, 0);
    cameraEl.object3D.position.set(0, 1.6, 0);
    cameraEl.object3D.rotation.set(0, 0, 0);
    cameraEl.setAttribute('rotation', '0 0 0');
    bots.forEach((bot, i) => {
      bot.detectionMeter = 0; bot.currentPatrolTarget = randomWaypoint(); bot.waitTime = 0; bot.walkTime = 0; bot.stunned = 0; bot.dizzyTime = 0; bot.slapCount = 0;
      bot.lastKnownPos = { x: 0, z: 0 }; bot.el.object3D.position.set(bot.spawnPos.x, 0, bot.spawnPos.z);
      bot.el.object3D.rotation.set(0, 0, 0);
      const stars = bot.el.querySelector('.dizzy-stars');
      if (stars) stars.setAttribute('visible', 'false');
      ['.bot-body', '.bot-visor', '.bot-antenna-light'].forEach(sel => { const part = bot.el.querySelector(sel); if (part) part.setAttribute('color', '#00ff00'); });
      ['.bot-arm-r', '.bot-arm-l', '.bot-leg-r', '.bot-leg-l'].forEach(sel => { const part = bot.el.querySelector(sel); if (part) part.setAttribute('rotation', '0 0 0'); });
      bot.active = i === 0; bot.state = i === 0 ? 'Patrulhando' : 'Inativo';
      bot.el.setAttribute('visible', i === 0 ? 'true' : 'false');
    });
    if (gameOverModalEl) gameOverModalEl.style.display = 'none';
    if (vrPanelEl) vrPanelEl.setAttribute('visible', 'false');
    if (alertEl) alertEl.style.display = 'none';
    if (detectionFillEl) detectionFillEl.style.width = '0%'; if (slapEl) slapEl.textContent = '0'; if (stunEl) stunEl.textContent = '0'; lastRigPos.copy(rigEl.object3D.position);
  }

  function quitGame() {
    if (scene && scene.is('vr-mode') && scene.exitVR) scene.exitVR();
    if (gameOverModalEl) gameOverModalEl.style.display = 'none';
    if (vrPanelEl) vrPanelEl.setAttribute('visible', 'false');
    alert('Você saiu da partida. Atualize a página para jogar novamente.');
  }

  function playBeep(freq = 880, duration = 0.08) {
    if (!audioCtx) return;
    try {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = 'square'; osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.connect(gain); gain.connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + duration);
    } catch (_) { }
  }

  function handleEffects(detection, chasing, dt) {
    if (detection <= 0.05) { soundTimer = 0; return; }
    soundTimer += dt;
    const interval = Math.max(0.15, 1 - detection * 0.85);
    if (soundTimer >= interval) { soundTimer = 0; playBeep(chasing ? 1100 : 600, 0.07); }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (isGameOver || !scene.hasLoaded) return;
    const dt = Math.min((loop.lastNow ? (now - loop.lastNow) : 16.67) / 1000, 0.05);
    loop.lastNow = now;
    if (dt <= 0) return;
    survivalTime += dt;
    score = Math.floor(survivalTime * 10) + slapCount * 100;
    slapCooldown.left = Math.max(0, slapCooldown.left - dt);
    slapCooldown.right = Math.max(0, slapCooldown.right - dt);

    updateVRHandsVisibility();
    updateDesktopHand(dt);
    checkBotSpawns();
    moveDesktopPlayer(dt);
    // Locomoção VR é feita pelo componente 'vr-thumbstick-movement'

    const before = rigEl.object3D.position.clone();
    enforceVRWorldBoundsAndCollisions();

    cameraEl.object3D.getWorldPosition(tmpPlayer);
    const distance = rigEl.object3D.position.distanceTo(before);
    const speed = distance / dt;
    if (speed > 0.15) { movementPenalty = Math.min(1, movementPenalty + 2.5 * dt); playerWalkTime += dt * Math.min(speed * 8, 15); }
    else movementPenalty = Math.max(0, movementPenalty - 0.6 * dt);

    calculateCamouflage(tmpPlayer);
    detectHandSlaps(dt);

    let maxDetection = 0, anyChasing = false;
    bots.forEach(bot => {
      if (!bot.active) return;
      updateBot(bot, tmpPlayer, dt);
      maxDetection = Math.max(maxDetection, bot.detectionMeter);
      if (bot.state === 'Perseguindo') anyChasing = true;
    });

    if (anyChasing) {
      const activeBotsCount = bots.filter(b => b.active).length;
      syncPowerups(activeBotsCount);
    } else {
      removeAllPowerups();
    }

    powerupEntities.forEach(el => {
      if (el && el.object3D) el.object3D.rotation.y += dt * 3.5;
    });

    if (isBoostActive) {
      boostTimer -= dt;
      if (boostTimer <= 0) {
        isBoostActive = false;
        alertEl.textContent = '⚡ Efeito do raio acabou!';
        alertEl.style.display = 'block';
        setTimeout(() => { if (!isGameOver) alertEl.style.display = 'none'; }, 1200);
      }
    }

    checkPowerupPickup(tmpPlayer);
    handleEffects(maxDetection, anyChasing, dt);
    updateHUD(maxDetection);
    lastRigPos.copy(rigEl.object3D.position);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

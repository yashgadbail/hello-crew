// The call "set": renders a persona in their room, directs their behaviour
// (step up to the camera to talk, nod while listening, gesture while speaking,
// go to their workstation only for real research, potter about after a long
// silence), frames the camera like a video call, and supports WebXR AR.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Avatar, loadCharacter, buildShape, CHARACTER_HEIGHT } from './avatar.js';
import { SCENES } from './scenes.js';

const AR_SCALE = 0.7; // ~0.5 m tall in your room: a desk-top buddy rather than a child-sized figure
const propLoader = new GLTFLoader();
const propCache = new Map();

function loadProp(m) {
  if (!propCache.has(m)) {
    const p = propLoader.loadAsync(`models/${m}.glb`).then((g) => g.scene);
    p.catch(() => propCache.delete(m));
    propCache.set(m, p);
  }
  return propCache.get(m);
}

const rand = (a, b) => a + Math.random() * (b - a);

// Conversation staging: the character steps this far toward the camera from
// their room's home spot to talk, and the camera eases in to match.
const STEP_IN = 0.22; // metres
const CLOSE_ZOOM = 0.86; // camera distance while talking, relative to the wide shot
// With nobody talking for this long, they potter about their room; any speech brings them back.
const IDLE_WANDER_AFTER = 45; // seconds
const IDLE_WANDER_AGAIN = [60, 100];
const GESTURE_COOLDOWN = 4; // seconds between speaking gestures

/** Pick a body gesture that fits a spoken sentence, or null for none. */
function gestureFor(sentence) {
  const s = sentence.trim().toLowerCase();
  if (/^(yes|yeah|yep|sure|absolutely|exactly|right|great|perfect|of course|correct|good (job|question)|well done)\b/.test(s)) return 'emote-yes';
  if (/^(no|nope|not really|unfortunately|sadly|i'm afraid|i don't|that's not)\b/.test(s)) return 'emote-no';
  if (s.length > 50 && /\b(first|so|here's|let's|imagine|think of|for example|the key|the trick)\b/.test(s)) return Math.random() < 0.5 ? 'interact-right' : 'interact-left';
  return null;
}

export class Stage {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.xr.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 60);
    this.camLook = new THREE.Vector3(0, 0.4, 0);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a6a, 1.4);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.8);
    this.sun.position.set(1.2, 3, 2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 10 });
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);

    this.world = new THREE.Group(); // the room; hidden in AR
    this.scene.add(this.world);

    this.avatar = new Avatar();
    this.scene.add(this.avatar.group);

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }),
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    this.mode = 'idle';
    this.def = null;
    this.flames = [];
    this.lastTime = 0;
    this.running = false;

    const controller = this.renderer.xr.getController(0);
    controller.addEventListener('select', () => this._placeInAR());
    this.scene.add(controller);

    this.camDist = 2;
    this.resize(); // set the camera distance before the first frame
    new ResizeObserver(() => this.resize()).observe(container);
  }

  // -------------------------------------------------------------------------
  // Loading a persona's scene
  // -------------------------------------------------------------------------
  async load(persona) {
    // An agent you made yourself has no Kenney character or room, so it gets a
    // procedural avatar and a neutral room instead of failing to load.
    const avatar = persona.avatar || (persona.character ? { kind: 'kenney' } : { kind: 'shape' });
    const def = SCENES[persona.scene || avatar.scene] || SCENES.lounge;
    this.def = def;
    const token = (this.loadToken = (this.loadToken || 0) + 1);

    const [props] = await Promise.all([
      Promise.all(def.props.map((p) => loadProp(p.m).catch((err) => (console.warn(p.m, err), null)))),
      avatar.kind === 'kenney'
        ? this.avatar.setCharacter(avatar.character || persona.character)
        : this.avatar.setShape(avatar),
    ]);
    if (token !== this.loadToken) return;

    this.world.clear();
    this.flames = [];
    this._buildEnvironment(def.env);
    this._placeProps(def.props, props);

    this.avatar.group.scale.setScalar(1);
    this.avatar.group.position.set(def.home[0], 0, def.home[1]);
    this.avatar.group.rotation.y = 0;
    this.avatar.face(null);
    this.avatar.perform('idle');
    this.spot = 'back'; // at home in the room; greet() steps them up to the camera
    this.zoom = 1;
    this.setMode('idle');
    this.idleTimer = IDLE_WANDER_AFTER;
    this.idleAction = null;
    this.resize();
  }

  _buildEnvironment(env) {
    const mat = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...extra });
    if (env.type === 'room') {
      this.scene.background = new THREE.Color(env.wall);
      this.scene.fog = null;
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), mat(env.floor));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      this.world.add(floor);

      const back = new THREE.Mesh(new THREE.PlaneGeometry(10, 4), mat(env.wall));
      back.position.set(0, 2, -1.0);
      back.receiveShadow = true;
      this.world.add(back);
      for (const side of [-1, 1]) {
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), mat(new THREE.Color(env.wall).multiplyScalar(0.93)));
        wall.position.set(side * 2.2, 2, 2);
        wall.rotation.y = -side * Math.PI / 2;
        this.world.add(wall);
      }
      // A coloured skirting board in the persona's accent colour.
      const trim = new THREE.Mesh(new THREE.BoxGeometry(10, 0.06, 0.02), mat(env.trim || '#ffffff'));
      trim.position.set(0, 0.03, -0.99);
      this.world.add(trim);
      this.hemi.intensity = 1.4;
      this.sun.intensity = 1.6;
    } else {
      this.scene.background = new THREE.Color(env.sky);
      this.scene.fog = new THREE.Fog(env.fog || env.sky, 3.5, 12);
      const ground = new THREE.Mesh(new THREE.CircleGeometry(14, 48), mat(env.ground));
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      this.world.add(ground);
      this.hemi.intensity = env.stars ? 0.9 : 1.3;
      this.sun.intensity = env.stars ? 1.4 : 1.9;
      if (env.stars) this.world.add(this._stars());
      if (env.campfire) this._campfire(env.campfire);
    }
  }

  _stars() {
    const pts = [];
    for (let i = 0; i < 600; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.45;
      const r = 20;
      pts.push(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi) + 1, r * Math.sin(phi) * Math.sin(theta) - 5);
    }
    const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.06, fog: false }));
  }

  _campfire([x, z]) {
    const light = new THREE.PointLight(0xff8a3d, 1.5, 3, 1.5);
    light.position.set(x, 0.3, z);
    this.world.add(light);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.07, 0.22, 10),
      new THREE.MeshBasicMaterial({ color: 0xffa233, transparent: true, opacity: 0.9 }),
    );
    flame.position.set(x, 0.14, z);
    this.world.add(flame);
    this.flames.push({ light, flame });
  }

  _placeProps(defs, scenes) {
    const tops = {};
    defs.forEach((d, i) => {
      if (!scenes[i]) return;
      const obj = scenes[i].clone(true);
      obj.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      obj.scale.setScalar(d.s ?? 1);
      obj.rotation.y = THREE.MathUtils.degToRad(d.r ?? 0);
      obj.updateMatrixWorld(true);
      // Re-centre so the prop's bottom-centre sits at p.
      const box = new THREE.Box3().setFromObject(obj);
      obj.position.x -= (box.min.x + box.max.x) / 2;
      obj.position.z -= (box.min.z + box.max.z) / 2;
      obj.position.y -= box.min.y;
      const holder = new THREE.Group();
      holder.add(obj);
      const baseY = d.on ? tops[d.on] ?? 0 : 0;
      holder.position.set(d.p[0], baseY + d.p[1], d.p[2]);
      if (d.id) tops[d.id] = holder.position.y + (box.max.y - box.min.y);
      this.world.add(holder);
    });
  }

  // -------------------------------------------------------------------------
  // Direction: where the character is and what they're doing
  // -------------------------------------------------------------------------
  /** mode: 'idle' | 'listening' | 'thinking' | 'speaking' */
  setMode(mode) {
    const prev = this.mode;
    this.mode = mode;
    this.avatar.setState(mode);
    if (!this.def || this.inAR) return;
    if (mode === 'speaking' || mode === 'listening') this._goHome();
    // Stay put and face the user during a conversation; only wander off after
    // a long stretch with nobody talking. Any activity restarts the wait.
    if (mode === 'idle' && prev !== 'idle') this.idleTimer = IDLE_WANDER_AFTER;
  }

  /** Research activity from the server (web search, reading a document or textbook):
   *  go "work" at the persona's station. Ordinary replies are given in place. */
  activity() {
    if (this.mode === 'thinking') this._goWork();
  }

  /** Where they stand to talk: a step in front of their home spot, facing the camera. */
  _talkSpot() {
    return [this.def.home[0], this.def.home[1] + STEP_IN];
  }

  _goHome() {
    if (this.spot === 'home' && !this.avatar.walking) return;
    this.spot = 'home';
    this.idleAction = null;
    this.avatar.face(null);
    const [x, z] = this._talkSpot();
    this.avatar.walkTo(x, z, () => this.avatar.perform('idle'));
  }

  /** Call connected: step up to the camera and nod hello. */
  greet() {
    if (!this.def || this.inAR) return this.avatar.wave();
    this.spot = null;
    this._goHome();
    if (!this.avatar.walking) return this.avatar.wave();
    this.avatar.onArrive = () => {
      this.avatar.perform('idle');
      this.avatar.wave();
    };
  }

  /** The character starts a spoken sentence: sometimes a gesture that fits it. */
  speechGesture(sentence) {
    const now = performance.now() / 1000;
    if (now - (this.lastGesture || 0) < GESTURE_COOLDOWN) return;
    const g = gestureFor(sentence);
    if (g && this.avatar.gesture(g)) this.lastGesture = now;
  }

  /** The user is talking: an occasional small nod, like an attentive listener. */
  listenCue() {
    const now = performance.now() / 1000;
    if (now < (this.nextListenNod || 0)) return;
    this.nextListenNod = now + rand(2.5, 4.5);
    this.avatar.nod(0.6);
  }

  /** The user finished a sentence: a quick "got it" nod. */
  acknowledge() {
    this.avatar.nod(1);
  }

  _goTo(spot, name, onArrive) {
    this.spot = name;
    this.avatar.walkTo(spot.at[0], spot.at[1], () => {
      this.avatar.face(spot.face);
      onArrive?.();
    });
  }

  _goWork() {
    if (this.spot === 'work') return;
    const w = this.def.work;
    this._goTo(w, 'work', () => this.mode === 'thinking' && this.avatar.perform(w.anim));
  }

  _direct(dt) {
    if (!this.def || this.inAR) return;
    if (this.mode === 'idle') {
      if (this.idleAction) {
        this.idleAction -= dt;
        if (this.idleAction <= 0) {
          this._goHome();
          this.idleTimer = rand(IDLE_WANDER_AGAIN[0], IDLE_WANDER_AGAIN[1]);
        }
      } else if (!this.avatar.walking) {
        this.idleTimer -= dt;
        if (this.idleTimer <= 0 && this.def.idle?.length) {
          const s = this.def.idle[Math.floor(Math.random() * this.def.idle.length)];
          this.idleAction = 99; // set properly on arrival
          this._goTo(s, 'idle', () => {
            if (this.mode !== 'idle') return;
            this.avatar.perform(s.anim, { repeat: s.repeat || 0 });
            this.idleAction = rand(3.5, 5.5);
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Camera: a steady "video call" framing that follows the character
  // -------------------------------------------------------------------------
  resize() {
    if (this.renderer.xr.isPresenting) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = this.camera.aspect < 0.8 ? 52 : 40;
    this.camera.updateProjectionMatrix();
    // Far enough that ~1.3 m is visible vertically and ~1.0 m horizontally.
    const half = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = Math.max(0.68 / half, 0.5 / (half * this.camera.aspect));
    if (Number.isFinite(dist)) this.camDist = dist; // container may not be laid out yet
  }

  _updateCamera(dt, t) {
    const pos = this.avatar.group.position;
    const k = 1 - Math.exp(-dt * 1.5);
    this.camLook.x += (pos.x * 0.75 - this.camLook.x) * k;
    this.camLook.y = CHARACTER_HEIGHT * 0.5;
    this.camLook.z += (pos.z * 0.5 - this.camLook.z) * k;
    // Ease in closer while they're at their talking spot; wide shot while they potter about.
    const zoomTarget = this.spot === 'home' ? CLOSE_ZOOM : 1;
    this.zoom = (this.zoom ?? 1) + (zoomTarget - (this.zoom ?? 1)) * (1 - Math.exp(-dt * 0.8));
    const dist = this.camDist * this.zoom;
    const sway = (f, a) => Math.sin(t * f) * a;
    this.camera.position.set(
      this.camLook.x + sway(0.5, 0.012),
      this.camLook.y + dist * 0.2 + sway(0.7, 0.008),
      this.camLook.z + dist,
    );
    // Aim a little low so the character sits in the upper part of the frame, clear of the call controls.
    this.camera.lookAt(this.camLook.x, this.camLook.y - 0.12 + sway(0.4, 0.004), this.camLook.z);
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------
  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.renderer.setAnimationLoop((time, frame) => this._frame(time / 1000, frame));
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  _frame(t, frame) {
    const dt = Math.min(0.1, t - this.lastTime);
    this.lastTime = t;

    if (frame && this.hitTestSource) {
      const hits = frame.getHitTestResults(this.hitTestSource);
      const pose = hits.length ? hits[0].getPose(this.renderer.xr.getReferenceSpace()) : null;
      this.reticle.visible = !!pose;
      if (pose) this.reticle.matrix.fromArray(pose.transform.matrix);
      this.reticle.material.opacity = this.placed ? 0.35 : 1;
    }

    this._direct(dt);
    if (!this.renderer.xr.isPresenting) this._updateCamera(dt, t);
    for (const { light, flame } of this.flames) {
      const f = 0.8 + 0.2 * Math.sin(t * 13) * Math.sin(t * 7.3);
      light.intensity = 1.5 * f;
      flame.scale.set(1, f * 1.1, 1);
    }
    // In XR, three.js copies the phone's pose into `camera` each frame.
    this.avatar.update(dt, t, this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  // -------------------------------------------------------------------------
  // AR: bring the character into your room (Android Chrome + ARCore)
  // -------------------------------------------------------------------------
  static async arSupported() {
    try {
      return !!(await navigator.xr?.isSessionSupported('immersive-ar'));
    } catch {
      return false;
    }
  }

  async enterAR(overlayRoot, { onEnd, onHint } = {}) {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlayRoot },
    });
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);
    this.inAR = true;
    this.placed = false;
    this.world.visible = false;
    this.savedBackground = this.scene.background;
    this.savedFog = this.scene.fog;
    this.scene.background = null;
    this.scene.fog = null;
    this.avatar.walkTarget = null;
    this.avatar.face(null);
    this.avatar.perform('idle');
    this.avatar.group.visible = false;
    this.avatar.group.scale.setScalar(AR_SCALE);
    this.onHint = onHint;
    onHint?.('Point your phone at the floor, then tap to place them.');

    const viewer = await session.requestReferenceSpace('viewer');
    this.hitTestSource = await session.requestHitTestSource({ space: viewer });
    session.addEventListener('end', () => {
      this.hitTestSource = null;
      this.reticle.visible = false;
      this.inAR = false;
      this.world.visible = true;
      this.scene.background = this.savedBackground;
      this.scene.fog = this.savedFog;
      this.avatar.group.visible = true;
      this.avatar.group.scale.setScalar(1);
      if (this.def) {
        const [x, z] = this._talkSpot();
        this.avatar.group.position.set(x, 0, z);
      }
      this.spot = 'home';
      this.resize();
      onHint?.(null);
      onEnd?.();
    });
  }

  exitAR() {
    this.renderer.xr.getSession()?.end();
  }

  _placeInAR() {
    if (!this.inAR || !this.reticle.visible) return;
    this.avatar.group.position.setFromMatrixPosition(this.reticle.matrix);
    this.avatar.group.visible = true;
    if (!this.placed) this.avatar.wave();
    this.placed = true;
    this.onHint?.(null);
  }
}

/** Render a head-and-shoulders portrait of each persona's character (data URLs). */
export async function renderPortraits(personas, size = 320) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a6a, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(1, 2, 3);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10);
  camera.position.set(0, 0.45, 1.75);
  camera.lookAt(0, 0.37, 0);

  const out = {};
  for (const p of personas) {
    try {
      const avatar = p.avatar || (p.character ? { kind: 'kenney' } : { kind: 'shape' });
      let model;
      if (avatar.kind === 'kenney') {
        const gltf = await loadCharacter(avatar.character || p.character);
        model = SkeletonUtils.clone(gltf.scene);
        const box = new THREE.Box3().setFromObject(model);
        model.scale.setScalar(CHARACTER_HEIGHT / (box.max.y - box.min.y));
        model.position.y = -box.min.y * model.scale.y;
        const mixer = new THREE.AnimationMixer(model);
        const idle = gltf.animations.find((a) => a.name === 'idle');
        if (idle) mixer.clipAction(idle).play();
        mixer.update(0.4);
      } else {
        // Agents you made yourself: same procedural avatar the call screen uses.
        model = buildShape(avatar).model;
      }
      model.rotation.y = -0.25;
      scene.add(model);
      renderer.render(scene, camera);
      out[p.id] = renderer.domElement.toDataURL('image/png');
      scene.remove(model);
    } catch (err) {
      console.warn('portrait failed', p.id, err);
    }
  }
  renderer.dispose();
  return out;
}

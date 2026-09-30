// Animated Kenney "Mini Characters" (CC0, https://kenney.nl/assets/mini-characters).
// Plays the model's clips (idle, walk, interact, emotes…) and layers procedural
// head motion on top: looking at the viewer, tilting while listening or
// thinking, and bobbing in time with speech. Characters can walk to a spot and
// perform an action there, which the stage uses to make them live in their room.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const MODEL_DIR = 'models/kenney/';
export const CHARACTER_HEIGHT = 0.75; // metres, before any AR scaling
const FADE = 0.25;
const WALK_SPEED = 0.55; // metres per second

const loader = new GLTFLoader();
const cache = new Map(); // character name -> Promise<gltf>

export function loadCharacter(name) {
  if (!cache.has(name)) {
    const p = loader.loadAsync(`${MODEL_DIR}${name}.glb`);
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return cache.get(name);
}

const _pos = new THREE.Vector3();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

const SHAPES = {
  sphere: (R) => new THREE.SphereGeometry(R, 32, 24),
  box: (R) => new THREE.BoxGeometry(R * 1.7, R * 1.7, R * 1.7),
  cone: (R) => new THREE.ConeGeometry(R, R * 2.2, 32),
  torus: (R) => new THREE.TorusGeometry(R * 0.75, R * 0.34, 20, 40),
  capsule: (R) => new THREE.CapsuleGeometry(R * 0.72, R * 1.1, 12, 24),
};

/**
 * A procedural avatar: a coloured body with a head and two eyes, so an agent you
 * create yourself needs no 3D assets. Normalised to CHARACTER_HEIGHT on y = 0,
 * exactly like the Kenney rigs, and with its head in a node named "head" so the
 * existing look-at and talking motion drives it unchanged.
 *
 * @param {{shape?: string, color?: string}} spec
 * @returns {{ model: THREE.Group, head: THREE.Group }}
 */
export function buildShape(spec = {}) {
  const R = 0.28;
  const color = new THREE.Color(spec.color || '#6c8cff');
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d27, roughness: 0.4 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf6f7fb, roughness: 0.5 });

  const model = new THREE.Group();
  const torso = new THREE.Mesh((SHAPES[spec.shape] || SHAPES.capsule)(R), body);
  torso.castShadow = true;
  model.add(torso);

  const head = new THREE.Group();
  head.name = 'head';
  const skull = new THREE.Mesh(new THREE.SphereGeometry(R * 0.62, 28, 20), body);
  skull.castShadow = true;
  head.add(skull);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(R * 0.2, 16, 12), white);
    eye.position.set(side * R * 0.26, R * 0.08, R * 0.42);
    head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(R * 0.095, 12, 10), dark);
    pupil.position.set(side * R * 0.26, R * 0.08, R * 0.55);
    head.add(pupil);
  }
  head.position.y = new THREE.Box3().setFromObject(torso).max.y + R * 0.45;
  model.add(head);

  const box = new THREE.Box3().setFromObject(model);
  model.scale.setScalar(CHARACTER_HEIGHT / (box.max.y - box.min.y || 1));
  model.position.y = -box.min.y * model.scale.y;
  return { model, head };
}

function lerpAngle(a, b, k) {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
}

export class Avatar {
  constructor() {
    this.group = new THREE.Group();
    this.state = 'idle';
    this.speaking = false;
    this.getLevel = null; // optional () => audio RMS level, or null
    this.talk = 0;
    this.pulse = 0;
    this.headPitch = 0;
    this.headRoll = 0;
    this.lean = 0; // forward body lean, radians
    this.nodTime = Infinity;
    this.nodAmp = 0;
    this.character = null;
    this.model = null;
    this.mixer = null;
    this.actions = {};
    this.current = null;
    this.base = 'idle'; // looping clip to return to after one-shots
    this.loadToken = 0;
    this.walkTarget = null; // THREE.Vector2 on the floor (x, z)
    this.onArrive = null;
    this.facePoint = null; // THREE.Vector2 to face when not walking (null = viewer)

    // Soft contact shadow so the character looks grounded (also in AR).
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.2, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.003;
    shadow.renderOrder = 1;
    this.group.add(shadow);
  }

  /** Swap to another character (e.g. 'character-male-b'). Resolves once it's visible. */
  async setCharacter(name) {
    if (name === this.character && this.model) return;
    this.character = name;
    const token = ++this.loadToken;
    const gltf = await loadCharacter(name);
    if (token !== this.loadToken) return; // a newer request won

    const model = SkeletonUtils.clone(gltf.scene);
    model.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false; // skinned bounds are unreliable
        o.castShadow = true;
      }
    });

    // Normalise size so every character stands CHARACTER_HEIGHT tall on y = 0.
    const box = new THREE.Box3().setFromObject(model);
    const height = box.max.y - box.min.y || 1;
    model.scale.setScalar(CHARACTER_HEIGHT / height);
    model.position.y = -box.min.y * model.scale.y;

    if (this.model) {
      this.mixer.stopAllAction();
      this.group.remove(this.model);
    }
    this.model = model;
    this.group.add(model);

    this.head = model.getObjectByName('head');
    this.headRest = this.head?.quaternion.clone();
    // Some exports store a zero quaternion for the head bone's rest pose; that
    // collapses the head to nothing, so treat it as "no rotation".
    if (this.headRest && this.headRest.lengthSq() < 1e-6) this.headRest.identity();
    this.headScale = this.head?.scale.clone();
    this.headPitch = 0;
    this.headRoll = 0;
    this.talk = 0;

    this.mixer = new THREE.AnimationMixer(model);
    this.actions = Object.fromEntries(gltf.animations.map((clip) => [clip.name, this.mixer.clipAction(clip)]));
    this.mixer.addEventListener('finished', (e) => {
      if (e.action === this.current) this._play(this.walkTarget ? 'walk' : this.base);
    });
    this.current = null;
    this.base = 'idle';
    this._play('idle');
  }

  /**
   * Build a procedural avatar: a coloured body with a head and two eyes, so an
   * agent you create yourself needs no 3D assets at all.
   *
   * It carries no skeleton, so there are no walk or gesture clips. It still gets
   * an (empty) mixer and a head named the same way the Kenney rigs name theirs,
   * which means the look-at, talking and nodding motion in update() drives it
   * unchanged.
   *
   * @param {{shape?: string, color?: string, seed?: number}} spec
   */
  async setShape(spec = {}) {
    const key = `shape:${spec.shape}:${spec.color}`;
    if (key === this.character && this.model) return;
    this.character = key;
    const token = ++this.loadToken;

    const { model, head } = buildShape(spec);
    if (token !== this.loadToken) return;
    if (this.model) {
      this.mixer?.stopAllAction();
      this.group.remove(this.model);
    }
    this.model = model;
    this.group.add(model);

    this.head = head;
    this.headRest = head.quaternion.clone();
    this.headScale = head.scale.clone();
    this.headPitch = 0;
    this.headRoll = 0;

    // An empty mixer keeps update() and _play() working with no clips.
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    this.current = null;
    this.base = 'idle';
  }

  _play(name, { once = false, repetitions = 1 } = {}) {
    const next = this.actions[name];
    if (!next || (next === this.current && !once)) return;
    next.reset();
    next.setLoop(THREE.LoopRepeat, once ? repetitions : Infinity); // one-shots end with a 'finished' event
    next.clampWhenFinished = false;
    next.play();
    if (this.current && this.current !== next) next.crossFadeFrom(this.current, FADE, false);
    this.current = next;
  }

  setState(state) {
    this.state = state;
  }

  /** Nudge the head on a spoken word boundary (browser TTS). */
  syllable() {
    this.pulse = 0.6;
  }

  /** A friendly nod, e.g. when a call connects. */
  wave() {
    if (!this.walkTarget) this._play('emote-yes', { once: true });
  }

  /** A small head nod layered on top of any clip (listening, acknowledging). */
  nod(strength = 1) {
    this.nodTime = 0;
    this.nodAmp = 0.16 * strength;
  }

  /** A body gesture clip (emote-yes, emote-no, interact-right…), only while standing still. */
  gesture(name) {
    if (this.walkTarget || !this.actions[name] || this.current !== this.actions[this.base]) return false;
    this._play(name, { once: true });
    return true;
  }

  /** Play a clip: looping until changed, or `repeat` times then back to idle. */
  perform(name, { repeat = 0 } = {}) {
    if (repeat > 0) {
      this._play(name, { once: true, repetitions: repeat });
    } else {
      this.base = name;
      this._play(name);
    }
  }

  /** Walk to (x, z) on the floor, then call onArrive. */
  walkTo(x, z, onArrive = null) {
    this.base = 'idle';
    this.onArrive = onArrive;
    const pos = this.group.position;
    if (Math.hypot(x - pos.x, z - pos.z) < 0.03) {
      this.walkTarget = null;
      this._play('idle');
      onArrive?.();
      return;
    }
    this.walkTarget = new THREE.Vector2(x, z);
    this._play('walk');
  }

  /** Face a floor point, or the viewer when null. */
  face(point) {
    this.facePoint = point ? new THREE.Vector2(point[0], point[1]) : null;
  }

  get walking() {
    return !!this.walkTarget;
  }

  update(dt, t, viewerPosition) {
    if (!this.model) return;
    const k = 1 - Math.exp(-dt * 5);
    const pos = this.group.position;

    // Walking (positions are in the parent's space; the stage keeps scale 1 there).
    let yawTarget;
    if (this.walkTarget) {
      const dx = this.walkTarget.x - pos.x;
      const dz = this.walkTarget.y - pos.z;
      const dist = Math.hypot(dx, dz);
      const step = WALK_SPEED * this.group.scale.x * dt;
      if (dist <= step) {
        pos.x = this.walkTarget.x;
        pos.z = this.walkTarget.y;
        this.walkTarget = null;
        this._play(this.base);
        const cb = this.onArrive;
        this.onArrive = null;
        cb?.();
      } else {
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
        yawTarget = Math.atan2(dx, dz);
      }
    }

    this.group.getWorldPosition(_pos);
    const vdx = viewerPosition.x - _pos.x;
    const vdz = viewerPosition.z - _pos.z;
    if (yawTarget === undefined) {
      yawTarget = this.facePoint ? Math.atan2(this.facePoint.x - pos.x, this.facePoint.y - pos.z) : Math.atan2(vdx, vdz);
    }
    if (Number.isFinite(yawTarget)) {
      this.group.rotation.y = lerpAngle(this.group.rotation.y, yawTarget, this.walkTarget ? 1 - Math.exp(-dt * 10) : k);
    }

    // Reset the head before the mixer runs, so our offsets never accumulate
    // on frames where the current clip doesn't animate the head.
    if (this.head) {
      this.head.quaternion.copy(this.headRest);
      this.head.scale.copy(this.headScale);
    }
    this.mixer.update(dt);
    if (!this.head) return;

    // Talking: follow the real audio level (KittenTTS), or fake a rhythm (browser TTS).
    let talkTarget = 0;
    if (this.speaking) {
      const level = this.getLevel?.();
      talkTarget =
        level != null
          ? Math.min(1, level * 7)
          : 0.3 + 0.7 * Math.abs(Math.sin(t * 11)) * (0.6 + 0.4 * Math.sin(t * 4.3)) + this.pulse;
    }
    this.pulse = Math.max(0, this.pulse - dt * 4);
    this.talk += (talkTarget - this.talk) * (1 - Math.exp(-dt * 18));

    // Look at the viewer (unless busy with a prop), plus state-specific poses.
    const lookingAtViewer = !this.facePoint && !this.walkTarget;
    const headY = _pos.y + CHARACTER_HEIGHT * 0.8 * this.group.scale.y;
    let pitch = lookingAtViewer ? -Math.atan2(viewerPosition.y - headY, Math.hypot(vdx, vdz)) * 0.5 : 0.1;
    let roll = Math.sin(t * 0.9) * 0.03;
    if (this.state === 'thinking') {
      roll += 0.2;
      pitch -= 0.15;
    } else if (this.state === 'listening') {
      roll -= 0.12;
      pitch += 0.08;
    }
    if (!Number.isFinite(pitch)) pitch = 0; // e.g. the camera isn't placed yet
    this.headPitch += (THREE.MathUtils.clamp(pitch, -0.4, 0.4) - this.headPitch) * k;
    this.headRoll += (roll - this.headRoll) * k;
    // Smoothing feeds each frame into the next, so one bad value would stick forever.
    if (!Number.isFinite(this.headPitch)) this.headPitch = 0;
    if (!Number.isFinite(this.headRoll)) this.headRoll = 0;
    if (!Number.isFinite(this.talk)) this.talk = 0;

    // Lean in a little toward the viewer while listening (attentive) or talking.
    const leanTarget = lookingAtViewer ? { listening: 0.07, speaking: 0.035 }[this.state] || 0 : 0;
    this.lean += (leanTarget - this.lean) * (1 - Math.exp(-dt * 3));
    if (Number.isFinite(this.lean)) this.model.rotation.x = this.lean;

    // A nod: one smooth dip and back up over ~0.45 s.
    this.nodTime += dt;
    const nod = this.nodTime < 0.45 ? Math.sin((Math.PI * this.nodTime) / 0.45) * this.nodAmp : 0;

    _euler.set(this.headPitch + nod - this.talk * 0.12, 0, this.headRoll);
    this.head.quaternion.multiply(_quat.setFromEuler(_euler));
    // A small squash-and-stretch reads as "talking" on these mouthless faces.
    this.head.scale.y *= 1 + this.talk * 0.06;
    this.head.scale.x *= 1 - this.talk * 0.02;
  }
}

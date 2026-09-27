// Shared three.js world builder, used by the play page and the headless capture page.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const SIZE = 10;

const GROUNDS = {
  grass: '#6fae4f',
  meadow: '#8cc063',
  sand: '#e2cf8f',
  snow: '#f2f5f8',
  stone: '#9a9a9a',
  dirt: '#8a6a45',
  lava: '#3a2a26',
};

const SKIES = {
  day: { bg: '#bfe3ff', hemiSky: '#ffffff', hemiGround: '#8a7f6a', hemi: 1.4, sun: '#fff6e6', sunI: 2.4, sunPos: [8, 14, 6] },
  sunset: { bg: '#f6b58a', hemiSky: '#ffd2b0', hemiGround: '#5a4050', hemi: 1.1, sun: '#ff9a5a', sunI: 2.2, sunPos: [-10, 5, 3] },
  night: { bg: '#141a33', hemiSky: '#5a6aa8', hemiGround: '#1a1a22', hemi: 0.7, sun: '#b8c8ff', sunI: 0.9, sunPos: [-6, 12, -8] },
  overcast: { bg: '#c9ced3', hemiSky: '#f0f0f0', hemiGround: '#777777', hemi: 1.7, sun: '#ffffff', sunI: 0.8, sunPos: [4, 14, 4] },
};

const loader = new GLTFLoader();
const gltfCache = new Map();
function loadModel(url) {
  if (!gltfCache.has(url)) gltfCache.set(url, loader.loadAsync(url));
  return gltfCache.get(url);
}

const easeOutBack = (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);

export class World {
  constructor({ animate = true } = {}) {
    this.animate = animate;
    this.scene = new THREE.Scene();
    this.objects = new Map(); // id -> { group, data }
    this.pending = new Set();
    this.anims = [];
    this.onChange = null; // called after geometry changes (for collisions)

    this.hemi = new THREE.HemisphereLight();
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 0.5, far: 50 });
    this.sun.shadow.bias = -0.0005;
    this.sun.target.position.set(SIZE / 2, 0, SIZE / 2);
    this.scene.add(this.sun, this.sun.target);

    // Floating island: colored top layer over an earthy base.
    this.groundMat = new THREE.MeshStandardMaterial({ color: GROUNDS.grass, roughness: 0.95 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(SIZE, 0.2, SIZE), this.groundMat);
    top.position.set(SIZE / 2, -0.1, SIZE / 2);
    top.receiveShadow = true;
    top.name = 'ground';
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(SIZE, 1.2, SIZE),
      new THREE.MeshStandardMaterial({ color: '#7a5a3a', roughness: 1 }),
    );
    base.position.set(SIZE / 2, -0.8, SIZE / 2);
    this.ground = new THREE.Group();
    this.ground.add(top, base);
    this.scene.add(this.ground);

    this.objectRoot = new THREE.Group();
    this.scene.add(this.objectRoot);

    this.setEnvironment({ ground: 'grass', sky: 'day', fog: 0 });
  }

  setEnvironment(env) {
    const sky = SKIES[env.sky] || SKIES.day;
    this.scene.background = new THREE.Color(sky.bg);
    this.hemi.color.set(sky.hemiSky);
    this.hemi.groundColor.set(sky.hemiGround);
    this.hemi.intensity = sky.hemi;
    this.sun.color.set(sky.sun);
    this.sun.intensity = sky.sunI;
    this.sun.position.set(SIZE / 2 + sky.sunPos[0], sky.sunPos[1], SIZE / 2 + sky.sunPos[2]);
    this.groundMat.color.set(GROUNDS[env.ground] || GROUNDS.grass);
    this.scene.fog = env.fog > 0 ? new THREE.Fog(sky.bg, 4 + (1 - env.fog) * 30, 18 + (1 - env.fog) * 60) : null;
  }

  addObject(data, { animate = this.animate } = {}) {
    if (this.objects.has(data.id)) return;
    const group = new THREE.Group();
    group.position.set(data.x, data.y, data.z);
    group.rotation.y = (data.rotation * Math.PI) / 180;
    group.userData.id = data.id;
    const entry = { group, data };
    this.objects.set(data.id, entry);
    this.objectRoot.add(group);

    const p = loadModel(data.url).then((gltf) => {
      if (this.objects.get(data.id) !== entry) return;
      const model = gltf.scene.clone(true);
      model.scale.setScalar(data.scale);
      model.position.set(-data.pivot[0] * data.scale, -data.pivot[1] * data.scale, -data.pivot[2] * data.scale);
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      group.add(model);
      if (animate) {
        group.scale.setScalar(0.001);
        this.anims.push({ group, t: 0 });
      }
      this.onChange?.();
    });
    this.pending.add(p);
    p.catch((e) => console.error('model load failed', data.url, e)).finally(() => this.pending.delete(p));
  }

  removeObject(id) {
    const entry = this.objects.get(id);
    if (!entry) return;
    this.objects.delete(id);
    this.objectRoot.remove(entry.group);
    this.onChange?.();
  }

  clear() {
    for (const id of [...this.objects.keys()]) this.removeObject(id);
  }

  sync(snapshot) {
    // Ids repeat across worlds, so an object is only kept if it is the same placement.
    const key = (o) => [o.model, o.x, o.y, o.z, o.rotation, o.scale].join('|');
    const wanted = new Map(snapshot.objects.map((o) => [o.id, key(o)]));
    for (const [id, entry] of [...this.objects]) if (wanted.get(id) !== key(entry.data)) this.removeObject(id);
    for (const o of snapshot.objects) this.addObject(o);
    this.setEnvironment(snapshot.environment);
  }

  async whenLoaded() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  update(dt) {
    for (const a of this.anims) {
      a.t = Math.min(1, a.t + dt / 0.45);
      a.group.scale.setScalar(Math.max(0.001, easeOutBack(a.t)));
    }
    this.anims = this.anims.filter((a) => a.t < 1);
  }
}

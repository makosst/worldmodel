// Shared three.js world builder, used by the play page and the headless capture page.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

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

// Lighting moods. exposure drives ACES tone mapping; env scales the HDRI's ambient light.
const SHADING = {
  bright: { exposure: 1.0, sun: '#fff3dc', sunI: 3.0, sunPos: [8, 14, 6], env: 1.0, hemi: 0.35 },
  soft: { exposure: 0.95, sun: '#ffffff', sunI: 0.9, sunPos: [4, 16, 4], env: 1.25, hemi: 0.5 },
  golden: { exposure: 0.95, sun: '#ffb266', sunI: 2.6, sunPos: [-10, 4, 3], env: 0.9, hemi: 0.3 },
  moody: { exposure: 0.7, sun: '#c6d2e6', sunI: 1.1, sunPos: [-6, 9, -8], env: 0.6, hemi: 0.2 },
  night: { exposure: 0.55, sun: '#9db3ff', sunI: 0.45, sunPos: [-6, 12, -8], env: 0.35, hemi: 0.15 },
};

const WEATHER_FOG = {
  fog: { color: '#c3c8cc', near: 1.5, far: 16 },
  dust: { color: '#c9a877', near: 3, far: 26 },
  rain: { color: '#8e969e', near: 6, far: 45 },
  snow: { color: '#dfe5ea', near: 5, far: 40 },
};

const texLoader = new THREE.TextureLoader();
const hdrLoader = new HDRLoader();
const texCache = new Map();
function loadTexture(url, srgb) {
  if (!texCache.has(url)) {
    texCache.set(url, texLoader.loadAsync(url).then((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }));
  }
  return texCache.get(url);
}
const hdrCache = new Map();
// Flat sky color per lighting mood.
const SHADE_SKY = { bright: 'day', soft: 'overcast', golden: 'sunset', moody: 'overcast', night: 'night' };

function averageColor(tex) {
  const img = tex.image;
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, 8, 8);
  const px = g.getImageData(0, 0, 8, 8).data;
  let r = 0, gr = 0, b = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; gr += px[i + 1]; b += px[i + 2]; }
  const n = px.length / 4;
  return new THREE.Color().setRGB(r / n / 255, gr / n / 255, b / n / 255, THREE.SRGBColorSpace);
}

// Round, soft-edged sprite for snow and dust particles (square points look like confetti).
let dotTexture = null;
function softDot() {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}

const loader = new GLTFLoader();
const gltfCache = new Map();
function loadModel(url) {
  if (!gltfCache.has(url)) gltfCache.set(url, loader.loadAsync(url));
  return gltfCache.get(url);
}

// One piece of a multi-object file: clones of the given glTF nodes, keeping their
// file-space placement so the stored pivot still lines up.
function pickNodes(gltf, nodes) {
  const want = new Set(nodes);
  const out = new THREE.Group();
  gltf.scene.updateMatrixWorld(true);
  for (const [obj, ref] of gltf.parser.associations) {
    if (!obj.isObject3D || !want.has(ref?.nodes)) continue;
    const copy = obj.clone(true);
    obj.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
    out.add(copy);
  }
  return out;
}

const easeOutBack = (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);

export class World {
  // renderer is optional; with it the world can use HDRI skies (PMREM) and tone-mapped shading presets.
  constructor({ animate = true, renderer = null } = {}) {
    this.animate = animate;
    this.renderer = renderer;
    this.pmrem = renderer ? new THREE.PMREMGenerator(renderer) : null;
    this.envKey = null;
    this.scene = new THREE.Scene();
    this.objects = new Map(); // id -> { group, data }
    this.pending = new Set();
    this.anims = [];
    this.onChange = null; // called when objects are added or removed (for collisions)

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

    this.weather = null; // { kind, points, speed, drift }
    this.setEnvironment({ ground: 'grass', sky: 'day', fog: 0 });
  }

  // env: { ground, sky, fog, groundTexture?, skyHdr?, weather?, shading? }. Worlds saved before textures
  // existed only have legacy color names and render exactly as before.
  setEnvironment(env) {
    const key = JSON.stringify(env);
    if (key === this.envKey) return;
    this.envKey = key;
    const sky = SKIES[env.sky] || SKIES.day;
    const modern = !!(env.skyHdr || env.groundTexture || env.shading);
    const shade = SHADING[env.shading] || (env.skyHdr ? SHADING.soft : null);

    // Lights: legacy sky presets, or a shading preset on top of the HDRI.
    this.hemi.color.set(sky.hemiSky);
    this.hemi.groundColor.set(sky.hemiGround);
    this.hemi.intensity = shade && env.skyHdr ? shade.hemi : sky.hemi;
    this.sun.color.set(shade ? shade.sun : sky.sun);
    this.sun.intensity = shade ? shade.sunI : sky.sunI;
    const sp = shade ? shade.sunPos : sky.sunPos;
    this.sun.position.set(SIZE / 2 + sp[0], sp[1], SIZE / 2 + sp[2]);
    if (this.renderer) {
      this.renderer.toneMapping = modern ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      this.renderer.toneMappingExposure = shade ? shade.exposure : 1;
    }

    // Sky: HDRI background + image-based lighting, or a flat color.
    this.scene.background = new THREE.Color(SKIES[SHADE_SKY[env.shading]]?.bg || sky.bg);
    this.scene.environment = null;
    if (env.skyHdr && this.pmrem) {
      if (!hdrCache.has(env.skyHdr)) {
        hdrCache.set(env.skyHdr, hdrLoader.loadAsync(env.skyHdr).then((t) => {
          t.mapping = THREE.EquirectangularReflectionMapping;
          return { background: t, environment: this.pmrem.fromEquirectangular(t).texture };
        }));
      }
      const p = hdrCache.get(env.skyHdr).then(({ background, environment }) => {
        if (this.envKey !== key) return;
        // Flat single-color sky; the HDRI only lights the scene.
        this.scene.environment = environment;
        this.scene.environmentIntensity = shade ? shade.env : 1;
        this.scene.backgroundIntensity = shade ? Math.min(1, shade.env) : 1;
      });
      this.track(p, env.skyHdr);
    }

    // Ground: tiled PBR texture at its real-world tile size, or a flat color.
    const m = this.groundMat;
    if (env.groundTexture?.maps?.diff) {
      const { maps, tile = 2 } = env.groundTexture;
      const reps = SIZE / tile;
      // Flat single-color ground: the texture's average color.
      const p = loadTexture(maps.diff, true).then((d) => {
        if (this.envKey !== key) return;
        Object.assign(m, { map: null, normalMap: null, roughnessMap: null, roughness: 0.95 });
        m.color.copy(averageColor(d));
        m.needsUpdate = true;
      });
      this.track(p, maps.diff);
    } else {
      Object.assign(m, { map: null, normalMap: null, roughnessMap: null, roughness: 0.95 });
      m.color.set(GROUNDS[env.ground] || GROUNDS.grass);
      m.needsUpdate = true;
    }

    // Fog: weather preset, or the numeric fog amount.
    const wf = WEATHER_FOG[env.weather];
    if (wf) this.scene.fog = new THREE.Fog(wf.color, wf.near, wf.far);
    else this.scene.fog = env.fog > 0 ? new THREE.Fog(sky.bg, 4 + (1 - env.fog) * 30, 18 + (1 - env.fog) * 60) : null;
    this.setWeather(env.weather);
  }

  track(promise, what) {
    this.pending.add(promise);
    promise.catch((e) => console.error('environment load failed', what, e)).finally(() => this.pending.delete(promise));
  }

  // Rain streaks or snowflakes over the island (a static frame in headless captures).
  setWeather(kind) {
    if (this.weather) {
      this.scene.remove(this.weather.points);
      this.weather.points.geometry.dispose();
      this.weather.points.material.dispose();
      this.weather = null;
    }
    if (kind !== 'rain' && kind !== 'snow' && kind !== 'dust') return;
    const look = {
      rain: { color: '#b4c2d2', size: 0, opacity: 0.45, speed: 9, drift: 0.4, n: 3000 },
      snow: { color: '#ffffff', size: 0.06, opacity: 0.9, speed: 0.9, drift: 0.5, n: 2500 },
      dust: { color: '#d9bd8c', size: 0.035, opacity: 0.5, speed: 0.15, drift: 0.6, n: 1200 },
    }[kind];
    // Rain is drawn as short falling streaks (2 vertices each); snow and dust as round soft sprites.
    const per = kind === 'rain' ? 2 : 1;
    const pos = new Float32Array(look.n * per * 3);
    for (let i = 0; i < look.n; i++) {
      const x = -1 + Math.random() * (SIZE + 2), y = Math.random() * 9, z = -1 + Math.random() * (SIZE + 2);
      pos.set([x, y, z], i * per * 3);
      if (per === 2) pos.set([x + 0.02, y - 0.35, z], i * 6 + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    let points;
    if (kind === 'rain') {
      points = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: look.color, transparent: true, opacity: look.opacity, depthWrite: false }));
    } else {
      const mat = new THREE.PointsMaterial({ color: look.color, size: look.size, map: softDot(), alphaTest: 0.05, transparent: true, opacity: look.opacity, depthWrite: false });
      points = new THREE.Points(geo, mat);
    }
    points.frustumCulled = false;
    this.scene.add(points);
    this.weather = { kind, points, per, speed: look.speed, drift: look.drift, t: 0 };
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
    this.onChange?.(); // collisions use data.extent, so they don't wait for the mesh

    const p = loadModel(data.url).then((gltf) => {
      if (this.objects.get(data.id) !== entry) return;
      const model = data.nodes ? pickNodes(gltf, data.nodes) : gltf.scene.clone(true);
      model.scale.setScalar(data.scale);
      model.position.set(-data.pivot[0] * data.scale, -data.pivot[1] * data.scale, -data.pivot[2] * data.scale);
      // Turn the model about its pivot so its front faces the object's rotation (see orient-library.mjs).
      const turned = new THREE.Group();
      turned.rotation.y = ((data.yaw || 0) * Math.PI) / 180;
      turned.add(model);
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      group.add(turned);
      if (animate) {
        group.scale.setScalar(0.001);
        this.anims.push({ group, t: 0 });
      }
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
    if (this.weather) {
      const w = this.weather;
      w.t += dt;
      const a = w.points.geometry.attributes.position;
      const arr = a.array;
      const stride = 3 * w.per; // a rain streak's two vertices move together
      for (let i = 0; i < arr.length; i += stride) {
        const dx = Math.sin(w.t + i) * w.drift * dt;
        const wrap = arr[i + stride - 2] - w.speed * dt < 0 ? 9 : 0;
        for (let k = i; k < i + stride; k += 3) {
          arr[k + 1] += wrap - w.speed * dt;
          arr[k] += dx;
        }
      }
      a.needsUpdate = true;
    }
    for (const a of this.anims) {
      a.t = Math.min(1, a.t + dt / 0.45);
      a.group.scale.setScalar(Math.max(0.001, easeOutBack(a.t)));
    }
    this.anims = this.anims.filter((a) => a.t < 1);
  }
}

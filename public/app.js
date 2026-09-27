import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { World, SIZE } from './world.js';

const canvas = document.getElementById('view');
const form = document.getElementById('prompt');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const galleryEl = document.getElementById('gallery');
const homeBtn = document.getElementById('home');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 300);
const world = new World({ animate: true });
let snapshot = null;
let events = null;
let busy = false;
let currentId = null;

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- status UI ----------

function describeTool(e) {
  const i = e.input || {};
  switch (e.name) {
    case 'build_world': return 'Laying out the world…';
    case 'place_object': return `Placing ${String(i.model).replace(/-/g, ' ')}`;
    case 'remove_object': return `Removing #${i.id}`;
    case 'set_environment': return `Setting the scene${i.sky ? ` · ${i.sky}` : ''}${i.ground ? ` · ${i.ground}` : ''}`;
    case 'set_spawn': return 'Choosing where you start';
    case 'capture_scene': return 'Looking at the world…';
    case 'list_objects': return 'Checking the layout';
    default: return e.name;
  }
}

function setStatus(text, state = 'working') {
  statusEl.className = `show ${state}`;
  statusEl.innerHTML = '<span class="dot"></span>';
  statusEl.append(text);
}

function setHint(text) {
  hintEl.textContent = text;
  hintEl.classList.toggle('show', !!text);
}

function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
  input.placeholder = b ? 'Building…' : document.body.classList.contains('idle') ? 'Describe a world…' : 'Describe another world…';
}

// ---------- generation ----------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = input.value.trim();
  if (!prompt || busy) return;
  input.value = '';
  input.blur();
  document.body.classList.remove('idle');
  setBusy(true);
  setStatus('Starting Claude…');
  world.clear();
  snapshot = null;
  exitPlay();
  mode = 'orbit';
  try {
    const res = await fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, replaces: currentId }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    listen(data.id);
  } catch (err) {
    setStatus(`Failed: ${err.message}`, 'error');
    setBusy(false);
  }
});

function listen(id) {
  events?.close();
  currentId = id;
  history.replaceState(null, '', `#${id}`);
  events = new EventSource(`/api/events/${id}`);
  events.onmessage = (m) => {
    const e = JSON.parse(m.data);
    switch (e.type) {
      case 'snapshot':
        snapshot = e.world;
        world.clear();
        world.sync(snapshot);
        placeAtSpawn();
        if (e.status === 'done') finish(e.prompt);
        else if (e.status === 'generating') setBusy(true);
        break;
      case 'object_added':
        snapshot?.objects.push(e.object);
        world.addObject(e.object);
        break;
      case 'object_removed':
        if (snapshot) snapshot.objects = snapshot.objects.filter((o) => o.id !== e.id);
        world.removeObject(e.id);
        break;
      case 'environment':
        world.setEnvironment(e.environment);
        break;
      case 'spawn':
        if (snapshot) snapshot.spawn = e.spawn;
        if (mode !== 'play') placeAtSpawn();
        break;
      case 'log':
        if (e.entry.kind === 'tool') setStatus(describeTool(e.entry));
        else if (e.entry.kind === 'text') setStatus(e.entry.text.split('\n')[0]);
        else if (e.entry.kind === 'error') setStatus(e.entry.text, 'error');
        break;
      case 'status':
        if (e.status === 'done') finish();
        if (e.status === 'error') {
          setBusy(false);
          events.close();
        }
        break;
    }
  };
}

function finish(prompt) {
  setBusy(false);
  setStatus(prompt ? `${prompt} · click to walk` : 'World ready — click it to walk around', 'done');
  events?.close();
}

// ---------- gallery ----------

function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

async function loadGallery() {
  const worlds = await fetch('/api/worlds').then((r) => r.json()).catch(() => []);
  galleryEl.replaceChildren(
    ...worlds.map((w) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<img loading="lazy" alt=""><div class="p"></div><div class="m"></div>`;
      card.querySelector('img').src = `/api/worlds/${w.id}.jpg`;
      card.querySelector('.p').textContent = w.prompt;
      card.querySelector('.m').textContent = [w.model, fmtDuration(w.durationMs), `${w.objectCount} objects`].filter(Boolean).join(' · ');
      card.title = new Date(w.createdAt).toLocaleString();
      card.addEventListener('click', () => openWorld(w.id));
      return card;
    }),
  );
}

function openWorld(id) {
  document.body.classList.remove('idle');
  world.clear();
  snapshot = null;
  listen(id);
  canvas.requestPointerLock(); // still inside the click gesture, so we can drop straight in
}

homeBtn.addEventListener('click', () => {
  exitPlay();
  events?.close();
  currentId = null;
  mode = 'orbit';
  world.clear();
  statusEl.className = '';
  setHint('');
  history.replaceState(null, '', location.pathname);
  document.body.classList.add('idle');
  setBusy(false);
  loadGallery();
});

loadGallery();

// Reopen a world from the URL hash (e.g. after a reload).
if (location.hash.length > 2) {
  document.body.classList.remove('idle');
  listen(location.hash.slice(1));
}

// ---------- camera modes ----------

let mode = 'orbit'; // 'orbit' | 'play'
let testMode = false; // headless tests can't pointer-lock; window.__test.play() stands in for it
const controlling = () => document.pointerLockElement === canvas || testMode;
window.__test = {
  play() {
    testMode = true;
    mode = 'play';
    placeAtSpawn();
  },
  state: () => ({ pos: player.end.toArray().map((v) => +v.toFixed(2)), onFloor }),
};
let orbitAngle = Math.PI / 4;
const center = new THREE.Vector3(SIZE / 2, 0.5, SIZE / 2);

function updateOrbit(dt) {
  orbitAngle += dt * 0.12;
  const r = 15;
  camera.position.set(center.x + Math.sin(orbitAngle) * r, 9, center.z + Math.cos(orbitAngle) * r);
  camera.lookAt(center);
}

// ---------- first-person player ----------

const RADIUS = 0.3;
const HEIGHT = 1.7;
const GRAVITY = 25;
const JUMP = 8;
const SPEED = 4.2;
const player = new Capsule(new THREE.Vector3(), new THREE.Vector3(), RADIUS);
const velocity = new THREE.Vector3();
let onFloor = false;
let yaw = 0;
let pitch = 0;
const keys = new Set();
let octree = new Octree();
let rebuildTimer = null;

function rebuildOctree() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    octree = new Octree().fromGraphNode(world.scene);
  }, 700);
}
world.onChange = rebuildOctree;
rebuildOctree();

function placeAtSpawn() {
  const s = snapshot?.spawn || { x: SIZE / 2, z: SIZE - 0.7, facing: 180 };
  // Drop in from slightly above so we land on whatever is at the spawn point.
  const y = (s.y || 0) + 0.3;
  player.start.set(s.x, RADIUS + y, s.z);
  player.end.set(s.x, HEIGHT - RADIUS + y, s.z);
  velocity.set(0, 0, 0);
  yaw = (s.facing * Math.PI) / 180 + Math.PI;
  pitch = 0;
}
placeAtSpawn();

function enterPlay() {
  if (document.body.classList.contains('idle')) return;
  canvas.requestPointerLock();
}
function exitPlay() {
  if (document.pointerLockElement) document.exitPointerLock();
}

canvas.addEventListener('click', enterPlay);
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  document.body.classList.toggle('playing', locked);
  if (locked) {
    if (mode !== 'play') placeAtSpawn();
    mode = 'play';
    setHint('WASD to move · Space to jump · Shift to run · R to respawn · Esc to exit');
    setTimeout(() => hintEl.textContent.startsWith('WASD') && setHint(''), 4000);
  } else {
    keys.clear();
    setHint(mode === 'play' ? 'Click to keep walking' : '');
  }
});
document.addEventListener('mousemove', (e) => {
  if (!controlling()) return;
  yaw -= e.movementX * 0.0022;
  pitch = Math.max(-1.45, Math.min(1.45, pitch - e.movementY * 0.0022));
});
document.addEventListener('keydown', (e) => {
  if (!controlling()) return;
  keys.add(e.code);
  if (e.code === 'Space' && onFloor) velocity.y = JUMP;
  if (e.code === 'KeyR') placeAtSpawn();
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

const fwd = new THREE.Vector3();
const side = new THREE.Vector3();
const wish = new THREE.Vector3();

function stepPlayer(dt) {
  fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  side.set(-fwd.z, 0, fwd.x);
  wish.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(fwd);
  if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(fwd);
  if (keys.has('KeyD') || keys.has('ArrowRight')) wish.add(side);
  if (keys.has('KeyA') || keys.has('ArrowLeft')) wish.sub(side);
  if (wish.lengthSq()) wish.normalize().multiplyScalar(keys.has('ShiftLeft') ? SPEED * 1.7 : SPEED);

  const control = onFloor ? 14 : 3;
  const k = 1 - Math.exp(-control * dt);
  velocity.x += (wish.x - velocity.x) * k;
  velocity.z += (wish.z - velocity.z) * k;
  velocity.y -= GRAVITY * dt;

  player.translate(velocity.clone().multiplyScalar(dt));

  onFloor = false;
  for (let i = 0; i < 3; i++) {
    const hit = octree.capsuleIntersect(player);
    if (!hit) break;
    onFloor ||= hit.normal.y > 0.5;
    if (hit.normal.y <= 0.5 || velocity.y < 0) velocity.addScaledVector(hit.normal, -Math.min(0, hit.normal.dot(velocity)));
    player.translate(hit.normal.multiplyScalar(hit.depth));
  }
  if (player.start.y < -15) placeAtSpawn();
}

function updatePlayCamera() {
  camera.position.copy(player.end).y += RADIUS * 0.6;
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}

// ---------- loop ----------

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  world.update(dt);
  if (mode === 'play') {
    const steps = 5;
    for (let i = 0; i < steps; i++) stepPlayer(dt / steps);
    updatePlayCamera();
  } else {
    updateOrbit(dt);
  }
  renderer.render(world.scene, camera);
});

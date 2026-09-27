// Headless capture page driven by the server through Playwright.
import * as THREE from 'three';
import { World, SIZE } from './world.js';

const W = 960;
const H = 720;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const world = new World({ animate: false });
const labels = document.getElementById('labels');

const grid = new THREE.GridHelper(SIZE, SIZE, 0x222222, 0x222222);
grid.position.set(SIZE / 2, 0.02, SIZE / 2);
grid.material.transparent = true;
grid.material.opacity = 0.35;
world.scene.add(grid);

const C = new THREE.Vector3(SIZE / 2, 0.6, SIZE / 2);

function perspective(from, target = C) {
  const cam = new THREE.PerspectiveCamera(50, W / H, 0.05, 200);
  cam.position.set(...from);
  cam.lookAt(target);
  return cam;
}

function cameraFor(view, snapshot) {
  switch (view) {
    case 'top': {
      const pad = 0.9;
      const half = SIZE / 2 + pad;
      const cam = new THREE.OrthographicCamera(-half * (W / H), half * (W / H), half, -half, 0.1, 100);
      cam.position.set(SIZE / 2, 40, SIZE / 2);
      cam.up.set(0, 0, -1);
      cam.lookAt(SIZE / 2, 0, SIZE / 2);
      return cam;
    }
    case 'overview':
      return perspective([SIZE + 3.5, 8.5, SIZE + 3.5]);
    case 'south':
      return perspective([SIZE / 2, 4.5, SIZE + 7.5]);
    case 'north':
      return perspective([SIZE / 2, 4.5, -7.5]);
    case 'east':
      return perspective([SIZE + 7.5, 4.5, SIZE / 2]);
    case 'west':
      return perspective([-7.5, 4.5, SIZE / 2]);
    case 'player': {
      const s = snapshot.spawn;
      const a = (s.facing * Math.PI) / 180;
      const cam = new THREE.PerspectiveCamera(65, W / H, 0.05, 200);
      const y = (s.y || 0) + 1.6;
      cam.position.set(s.x, y, s.z);
      cam.lookAt(s.x + Math.sin(a), y - 0.1, s.z + Math.cos(a));
      return cam;
    }
    default:
      throw new Error(`unknown view ${view}`);
  }
}

function label(text, cls, pos, cam) {
  const v = pos.clone().project(cam);
  if (v.z > 1) return;
  const el = document.createElement('div');
  el.className = `l ${cls}`;
  el.textContent = text;
  el.style.left = `${((v.x + 1) / 2) * W}px`;
  el.style.top = `${((1 - v.y) / 2) * H}px`;
  labels.appendChild(el);
}

window.renderView = async (snapshot, view) => {
  world.sync(snapshot);
  await world.whenLoaded();
  const cam = cameraFor(view, snapshot);
  cam.updateMatrixWorld();
  grid.visible = view === 'top';
  labels.innerHTML = '';
  if (view === 'top') {
    for (let i = 0; i <= SIZE; i += 1) {
      label(String(i), 'axis', new THREE.Vector3(i, 0, -0.45), cam);
      label(String(i), 'axis', new THREE.Vector3(-0.45, 0, i), cam);
    }
    label('x →', 'compass', new THREE.Vector3(SIZE + 0.6, 0, -0.45), cam);
    label('z ↓', 'compass', new THREE.Vector3(-0.45, 0, SIZE + 0.6), cam);
    label('N', 'compass', new THREE.Vector3(SIZE / 2, 0, -0.8), cam);
  }
  if (view === 'top' || view === 'overview') {
    for (const o of snapshot.objects) {
      label(`#${o.id}`, 'id', new THREE.Vector3(o.x, o.y + o.extent.h, o.z), cam);
    }
    // Spawn marker
    const s = snapshot.spawn;
    label('★ spawn', 'id', new THREE.Vector3(s.x, 0, s.z), cam);
  }
  renderer.render(world.scene, cam);
  return true;
};

window.ready = true;

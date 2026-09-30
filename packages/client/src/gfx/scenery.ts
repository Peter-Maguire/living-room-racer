import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Track } from '@racer/shared';
import type { Textures } from './textures.js';

/**
 * Living-room props scattered around (and inside) the track: books, pencils,
 * mugs, cereal boxes, cushions and toy blocks. Each kind is one InstancedMesh,
 * so the whole room costs a handful of draw calls however many props there are.
 * Placement is seeded by the track id, so every client sees the same room, and
 * never overlaps the road. Props are kept low so they can't hide the track from
 * the tilted overhead camera.
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Bounds {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
}

const BOOK_COLORS = [0xb8413a, 0x3f6fb5, 0x3f8f5a, 0xd9a33b, 0x7a4fa0, 0xe2e0d6];
const BLOCK_COLORS = [0xe24a3b, 0x3b82e2, 0xf2c230, 0x3fb36a, 0xe2833b];
const CUSHION_COLORS = [0x8a6f9a, 0xc27a6a, 0x6f97a8, 0xb5a266, 0x7a9a7a];
const MUG_COLORS = [0xf2efe6, 0x4a7fb0, 0xd0643a, 0x5a9a6a];
const PENCIL_COLORS = [0xf2c230, 0xe24a3b, 0x3b82e2, 0x3fb36a];

/** One placed prop: where, how big (for spacing), and a callback to write its instance(s). */
interface Placed {
  x: number;
  z: number;
  r: number;
}

export interface Scenery {
  group: THREE.Group;
  /** Draw calls this adds, for the stats overlay. */
  meshCount: number;
}

export function buildScenery(track: Track, tex: Textures, b: Bounds, density = 1): Scenery {
  const group = new THREE.Group();
  const r = rng(hash(track.id));
  const half = track.trackHalfWidth ?? 4;
  const line = track.recoverySpline.map((p) => p.position);

  /** Distance from a point to the nearest racing-line sample. */
  const roadDist = (x: number, z: number): number => {
    let d = Infinity;
    for (const p of line) d = Math.min(d, Math.hypot(p.x - x, p.z - z));
    return d;
  };

  const placed: Placed[] = [];
  const x0 = b.centerX - (b.halfX * 1.55 + 5);
  const x1 = b.centerX + (b.halfX * 1.55 + 5);
  const z0 = b.centerZ - (b.halfZ * 1.75 + 5);
  const z1 = b.centerZ + (b.halfZ * 1.75 + 5);

  /** Find a free spot for a prop of radius `rad`, clear of the road and other props. */
  const spot = (rad: number): { x: number; z: number } | null => {
    for (let tries = 0; tries < 40; tries++) {
      const x = x0 + r() * (x1 - x0);
      const z = z0 + r() * (z1 - z0);
      if (roadDist(x, z) < half + rad + 1.6) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + rad + 0.3)) continue;
      placed.push({ x, z, r: rad });
      return { x, z };
    }
    return null;
  };

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  /** Make an InstancedMesh from prepared matrices/colours. */
  const instanced = (geom: THREE.BufferGeometry, mat: THREE.Material, items: { m: THREE.Matrix4; c?: number }[]): void => {
    if (items.length === 0) return;
    const mesh = new THREE.InstancedMesh(geom, mat, items.length);
    items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      if (it.c !== undefined) mesh.setColorAt(i, color.setHex(it.c));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  const matrix = (x: number, y: number, z: number, yaw = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(rx, yaw, rz, 'YXZ');
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    return dummy.matrix.clone();
  };
  const pick = <T,>(arr: T[]): T => arr[Math.floor(r() * arr.length)]!;
  const n = (base: number) => Math.max(0, Math.round(base * density));

  // --- books: stacks of 1-3 ---------------------------------------------------
  const books: { m: THREE.Matrix4; c: number }[] = [];
  for (let i = 0; i < n(9); i++) {
    const s = spot(1.3);
    if (!s) continue;
    const yaw = r() * Math.PI;
    let y = 0;
    for (let k = 0, stack = 1 + Math.floor(r() * 3); k < stack; k++) {
      const h = 0.22 + r() * 0.16;
      books.push({ m: matrix(s.x + (r() - 0.5) * 0.15, y + h / 2, s.z + (r() - 0.5) * 0.15, yaw + (r() - 0.5) * 0.35, 0, 0, 1, h, 1), c: pick(BOOK_COLORS) });
      y += h;
    }
  }
  instanced(new THREE.BoxGeometry(1.7, 1, 1.2), new THREE.MeshStandardMaterial({ roughness: 0.75 }), books);

  // --- pencils (hex body + sharpened tip) ---------------------------------------
  const pencils: { m: THREE.Matrix4; c: number }[] = [];
  const tips: { m: THREE.Matrix4; c: number }[] = [];
  for (let i = 0; i < n(10); i++) {
    const s = spot(1.3);
    if (!s) continue;
    const yaw = r() * Math.PI * 2;
    const len = 3.2 + r() * 0.8;
    pencils.push({ m: matrix(s.x, 0.1, s.z, yaw, 0, 0, 1, 1, len), c: pick(PENCIL_COLORS) });
    const tipAt = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(len / 2 + 0.22);
    tips.push({ m: matrix(s.x + tipAt.x, 0.1, s.z + tipAt.z, yaw, 0, 0, 1, 1, 1), c: 0xe6c9a0 });
  }
  // Geometries are built along +Y then laid down by an X rotation baked in.
  instanced(new THREE.CylinderGeometry(0.1, 0.1, 1, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 0.55 }), pencils);
  instanced(new THREE.ConeGeometry(0.1, 0.44, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 0.8 }), tips);

  // --- mugs ---------------------------------------------------------------------
  const mugs: { m: THREE.Matrix4; c: number }[] = [];
  const coffee: { m: THREE.Matrix4; c: number }[] = [];
  const handles: { m: THREE.Matrix4; c: number }[] = [];
  for (let i = 0; i < n(6); i++) {
    const s = spot(1.0);
    if (!s) continue;
    const yaw = r() * Math.PI * 2;
    const c = pick(MUG_COLORS);
    mugs.push({ m: matrix(s.x, 0.4, s.z), c });
    coffee.push({ m: matrix(s.x, 0.74, s.z), c: 0x3a2416 });
    handles.push({ m: matrix(s.x + Math.sin(yaw + Math.PI / 2) * 0.55, 0.4, s.z + Math.cos(yaw + Math.PI / 2) * 0.55, yaw), c });
  }
  instanced(new THREE.CylinderGeometry(0.52, 0.46, 0.8, 20), new THREE.MeshStandardMaterial({ roughness: 0.3 }), mugs);
  instanced(new THREE.CircleGeometry(0.44, 20).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 0.2 }), coffee);
  instanced(new THREE.TorusGeometry(0.22, 0.06, 8, 14, Math.PI).rotateZ(-Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 0.3 }), handles);

  // --- cereal boxes, lying face up ---------------------------------------------------
  const cereal: { m: THREE.Matrix4; c: number }[] = [];
  for (let i = 0; i < n(5); i++) {
    const s = spot(1.4);
    if (!s) continue;
    cereal.push({ m: matrix(s.x, 0.26, s.z, r() * Math.PI * 2, -Math.PI / 2), c: pick([0xffffff, 0xfff0d0, 0xe8f2ff, 0xffe0e0]) });
  }
  instanced(new THREE.BoxGeometry(1.4, 2.0, 0.5), new THREE.MeshStandardMaterial({ map: tex.cereal, roughness: 0.6 }), cereal);

  // --- cushions --------------------------------------------------------------------------
  const cushions: { m: THREE.Matrix4; c: number }[] = [];
  for (let i = 0; i < n(5); i++) {
    const s = spot(1.7);
    if (!s) continue;
    cushions.push({ m: matrix(s.x, 0.36, s.z, r() * Math.PI * 2, 0, (r() - 0.5) * 0.12), c: pick(CUSHION_COLORS) });
  }
  instanced(new RoundedBoxGeometry(2.4, 0.72, 2.4, 3, 0.3), new THREE.MeshStandardMaterial({ roughness: 0.95 }), cushions);

  // --- toy blocks ------------------------------------------------------------------------------
  const blocks: { m: THREE.Matrix4; c: number }[] = [];
  for (let i = 0; i < n(9); i++) {
    const s = spot(0.8);
    if (!s) continue;
    const yaw = r() * Math.PI;
    blocks.push({ m: matrix(s.x, 0.4, s.z, yaw), c: pick(BLOCK_COLORS) });
    if (r() < 0.45) blocks.push({ m: matrix(s.x + (r() - 0.5) * 0.2, 1.2, s.z + (r() - 0.5) * 0.2, yaw + (r() - 0.5)), c: pick(BLOCK_COLORS) });
  }
  instanced(new RoundedBoxGeometry(0.8, 0.8, 0.8, 2, 0.08), new THREE.MeshStandardMaterial({ roughness: 0.5 }), blocks);

  return { group, meshCount: group.children.length };
}

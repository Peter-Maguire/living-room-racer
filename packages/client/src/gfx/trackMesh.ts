import * as THREE from 'three';
import { roadTilt, type Track } from '@racer/shared';
import { TILE_METRES, type Textures } from './textures.js';

/**
 * Builds the visible road from the SAME racing-line samples the physics uses,
 * so the drawn corridor is exactly the drivable one. Road UVs are in metres
 * (divided by the texture's tile size), which keeps texture scale constant on
 * wide and narrow roads.
 */

export interface TrackMeshes {
  group: THREE.Group;
  /** Item boxes, in the same order as track.pickups. */
  pads: THREE.Mesh[];
}

interface RibbonOpts {
  /** Racing-line sample indices, in driving order. */
  rows: number[];
  /** Offsets from the centerline along the left normal; lo < hi. */
  lo: number;
  hi: number;
  /** Extra height above the road surface. */
  lift: number;
  /** Metres of road per texture repeat along the road. */
  uMetres: number;
  /** Metres per texture repeat across the road; 0 = stretch 0..1 across. */
  vMetres: number;
}

/** A strip of road between two offsets, following height and banking. */
function ribbon(track: Track, o: RibbonOpts): THREE.BufferGeometry {
  const sp = track.recoverySpline;
  const n = sp.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let arc = 0;
  let prev: { x: number; z: number } | null = null;

  o.rows.forEach((i, r) => {
    const cur = sp[i % n]!;
    const next = sp[(i + 1) % n]!;
    let tx = next.position.x - cur.position.x;
    let tz = next.position.z - cur.position.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;
    if (prev) arc += Math.hypot(cur.position.x - prev.x, cur.position.z - prev.z);
    prev = cur.position;

    const tb = Math.tan(cur.bank);
    // First vertex at the high offset, second at the low one (winding matches
    // the original road mesh).
    for (const off of [o.hi, o.lo]) {
      pos.push(
        cur.position.x + nx * off,
        cur.position.y + tb * off + o.lift,
        cur.position.z + nz * off,
      );
      uv.push(arc / o.uMetres, o.vMetres > 0 ? off / o.vMetres : off === o.hi ? 1 : 0);
    }
    if (r > 0) {
      const a = (r - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Sample indices for the whole loop, closed with a repeat of sample 0. */
function loopRows(n: number): number[] {
  return [...Array.from({ length: n }, (_, i) => i), 0];
}

/** Sample indices inside the lap-fraction range [from, to) (may wrap), closed by one more sample. */
function sectionRows(track: Track, from: number, to: number): number[] {
  const sp = track.recoverySpline;
  const n = sp.length;
  const inside = (t: number) => (from <= to ? t >= from && t < to : t >= from || t < to);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (inside(sp[i]!.t)) idx.push(i);
  if (idx.length < 2) return [];
  // Rotate so a section that wraps the start line begins at its first sample.
  const start = idx.findIndex((_, j) => (idx[j]! + 1) % n !== idx[(j + 1) % idx.length]);
  const ordered = start >= 0 ? [...idx.slice(start + 1), ...idx.slice(0, start + 1)] : idx;
  ordered.push((ordered[ordered.length - 1]! + 1) % n);
  return ordered;
}

/** Road material for a surface type. */
function surfaceMaterial(kind: string, tex: Textures): THREE.MeshStandardMaterial {
  const base = { side: THREE.DoubleSide } as const;
  switch (kind) {
    case 'tile':
      return new THREE.MeshStandardMaterial({ ...base, map: tex.tile, roughness: 0.22, metalness: 0.05 });
    case 'rug':
      return new THREE.MeshStandardMaterial({ ...base, map: tex.rug, roughness: 0.98 });
    case 'cushion':
      return new THREE.MeshStandardMaterial({ ...base, map: tex.cushion, roughness: 0.92 });
    case 'wood':
      return new THREE.MeshStandardMaterial({ ...base, map: tex.roadWood, roughness: 0.55 });
    default:
      return new THREE.MeshStandardMaterial({ ...base, map: tex.asphalt, roughness: 0.88 });
  }
}

/** Metres per texture tile for a surface type. */
function tileSize(kind: string): number {
  switch (kind) {
    case 'tile': return TILE_METRES.tile;
    case 'rug': return TILE_METRES.rug;
    case 'cushion': return TILE_METRES.cushion;
    case 'wood': return TILE_METRES.wood;
    default: return TILE_METRES.asphalt;
  }
}

export function buildTrackMeshes(track: Track, tex: Textures): TrackMeshes {
  const group = new THREE.Group();
  const sp = track.recoverySpline;
  const n = sp.length;
  const half = track.trackHalfWidth ?? 4;

  // --- the road ---------------------------------------------------------------
  const base = new THREE.Mesh(
    ribbon(track, { rows: loopRows(n), lo: -half, hi: half, lift: 0, uMetres: tileSize(track.defaultSurface), vMetres: tileSize(track.defaultSurface) }),
    surfaceMaterial(track.defaultSurface, tex),
  );
  base.receiveShadow = true;
  group.add(base);

  // --- surface sections (grip changes) ----------------------------------------
  for (const sec of track.surfaces) {
    const rows = sectionRows(track, sec.from, sec.to);
    if (rows.length < 2 || sec.surface === track.defaultSurface) continue;
    let mesh: THREE.Mesh;
    if (sec.surface === 'milk') {
      // A translucent, ragged puddle across the width (v 0..1), not a repeat.
      const mat = new THREE.MeshStandardMaterial({
        map: tex.milk,
        transparent: true,
        roughness: 0.12,
        metalness: 0.05,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      mesh = new THREE.Mesh(ribbon(track, { rows, lo: -half, hi: half, lift: 0.025, uMetres: 7, vMetres: 0 }), mat);
    } else {
      const mat = surfaceMaterial(sec.surface, tex);
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      const ts = tileSize(sec.surface);
      mesh = new THREE.Mesh(ribbon(track, { rows, lo: -half, hi: half, lift: 0.012, uMetres: ts, vMetres: ts }), mat);
    }
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // --- curbs: make the off-track boundary unmistakable --------------------------
  const curbMat = new THREE.MeshStandardMaterial({ map: tex.curb, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 });
  const curbW = 0.5;
  for (const [lo, hi] of [[half - curbW, half], [-half, -half + curbW]] as const) {
    const m = new THREE.Mesh(ribbon(track, { rows: loopRows(n), lo, hi, lift: 0.03, uMetres: 1.2, vMetres: 0 }), curbMat);
    m.receiveShadow = true;
    group.add(m);
  }

  // --- centre dashes on plain asphalt -------------------------------------------
  if (track.defaultSurface === 'floor') {
    const dashMat = new THREE.MeshBasicMaterial({ map: tex.dash, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    group.add(new THREE.Mesh(ribbon(track, { rows: loopRows(n), lo: -0.13, hi: 0.13, lift: 0.02, uMetres: 2.4, vMetres: 0 }), dashMat));
  }

  // --- solid sides under ramps and walls -------------------------------------------
  let maxEdge = 0;
  for (const p of sp) maxEdge = Math.max(maxEdge, p.position.y + Math.abs(Math.tan(p.bank)) * half);
  if (maxEdge > 0.1) {
    const rows = loopRows(n);
    const pos: number[] = [];
    const idx: number[] = [];
    for (const side of [1, -1]) {
      const start = pos.length / 3;
      rows.forEach((i, r) => {
        const cur = sp[i % n]!;
        const next = sp[(i + 1) % n]!;
        let tx = next.position.x - cur.position.x;
        let tz = next.position.z - cur.position.z;
        const len = Math.hypot(tx, tz) || 1;
        tx /= len; tz /= len;
        const off = half * side;
        const x = cur.position.x + -tz * off;
        const z = cur.position.z + tx * off;
        const yTop = cur.position.y + Math.tan(cur.bank) * off;
        pos.push(x, yTop, z, x, -0.02, z);
        if (r > 0) {
          const a = start + (r - 1) * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const skirt = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.75, side: THREE.DoubleSide }));
    skirt.castShadow = true;
    skirt.receiveShadow = true;
    group.add(skirt);
  }

  // --- start / finish line: a checkered strip ACROSS the road -------------------------
  const finish = track.checkpoints.find((c) => c.isFinish);
  if (finish) {
    const p0 = sp[0]!;
    const h = 2 * Math.atan2(p0.rotation.y, p0.rotation.w);
    const pivot = new THREE.Group();
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, 1.4),
      new THREE.MeshStandardMaterial({ map: tex.checker, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    strip.rotation.x = -Math.PI / 2;
    strip.receiveShadow = true;
    pivot.add(strip);
    const tilt = roadTilt(track, finish.center, h);
    // The strip's long axis is local +x; turn it onto the road's left normal.
    pivot.rotation.set(-tilt.pitch, h + Math.PI, tilt.roll, 'YXZ');
    pivot.position.set(p0.position.x, p0.position.y + 0.04, p0.position.z);
    // Checker cells are square at 128x32 over (2*half x 1.4): keep them square-ish.
    (strip.material as THREE.MeshStandardMaterial).map!.repeat.set(Math.max(1, Math.round(half / 2)), 1);
    group.add(pivot);
  }

  // --- item boxes ----------------------------------------------------------------------
  const boxGeom = new THREE.BoxGeometry(1.0, 1.0, 1.0);
  const boxMat = new THREE.MeshStandardMaterial({
    map: tex.itemBox,
    emissive: 0xffa633,
    emissiveMap: tex.itemBox,
    emissiveIntensity: 0.35,
    roughness: 0.4,
  });
  const pads = track.pickups.map((p) => {
    const pad = new THREE.Mesh(boxGeom, boxMat);
    pad.position.set(p.x, p.y + 0.7, p.z);
    pad.castShadow = true;
    group.add(pad);
    return pad;
  });

  return { group, pads };
}

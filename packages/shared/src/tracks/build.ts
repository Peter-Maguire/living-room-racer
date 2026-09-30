import { MAX_PLAYERS } from '../constants.js';
import { trackSchema, type SurfaceSection, type Track } from '../track.js';
import type { SurfaceType } from '../types.js';

/**
 * Track-authoring helper. A track is described by a closed loop of control
 * points (XZ, metres) plus a few numbers; everything else — drivable polygon,
 * checkpoints, recovery spline, spawn grid, pickups — is derived from that one
 * centerline so they can never disagree (the same idea the oval and figure-eight
 * use, factored out).
 *
 * Authoring rules (enforced by `scripts/validate-tracks.mjs`):
 *  - Single level: no part of the loop may come within one corridor width of a
 *    non-adjacent part, because off-track detection and recovery are XZ-only.
 *  - The loop should start on a straight at least ~14 m long, since the starting
 *    grid sits behind the start line.
 *  - List the points in driving order, beginning at the start/finish line.
 */

export type Pt = readonly [number, number];

export interface TrackSpec {
  id: string;
  name: string;
  /** Closed loop of control points in driving order; points[0] is the start line. */
  points: Pt[];
  /** Visual half-width of the road in metres. Off-track allows +1 m of grace. */
  halfWidth: number;
  checkpointCount: number;
  /** Positions of pickup pads as fractions (0..1) of the lap. */
  pickups: number[];
  /** Surface for the whole road unless a section below overrides it. */
  defaultSurface?: SurfaceType;
  /** Surface sections by lap fraction (from > to wraps the start line). */
  surfaces?: SurfaceSection[];
  /** Metres between starting-grid rows (defaults to 3.2). */
  gridRowGap?: number;
}

interface Sampled {
  x: number;
  z: number;
  /** Cumulative arc length up to this sample. */
  s: number;
}

const SUBDIVISIONS = 24;

/** Closed uniform Catmull-Rom through `pts`, densely sampled with arc length. */
function sampleLoop(pts: readonly Pt[]): { samples: Sampled[]; length: number } {
  const n = pts.length;
  const out: Sampled[] = [];
  let s = 0;
  let prev: { x: number; z: number } | null = null;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    for (let k = 0; k < SUBDIVISIONS; k++) {
      const u = k / SUBDIVISIONS;
      const x = catmull(p0[0], p1[0], p2[0], p3[0], u);
      const z = catmull(p0[1], p1[1], p2[1], p3[1], u);
      if (prev) s += Math.hypot(x - prev.x, z - prev.z);
      out.push({ x, z, s });
      prev = { x, z };
    }
  }
  const first = out[0]!;
  const length = s + Math.hypot(first.x - prev!.x, first.z - prev!.z);
  return { samples: out, length };
}

function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  );
}

export function buildTrack(spec: TrackSpec): Track {
  const { samples, length } = sampleLoop(spec.points);
  const { halfWidth } = spec;

  /** Centerline position at lap fraction t (wraps), by arc length. */
  const at = (t: number): { x: number; z: number } => {
    const s = (((t % 1) + 1) % 1) * length;
    // Binary search for the segment containing s.
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[mid]!.s <= s) lo = mid;
      else hi = mid - 1;
    }
    const a = samples[lo]!;
    const b = samples[(lo + 1) % samples.length]!;
    const segEnd = lo + 1 < samples.length ? b.s : length;
    const span = Math.max(segEnd - a.s, 1e-9);
    const f = (s - a.s) / span;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  };

  const eps = 0.5 / length;
  const heading = (t: number): number => {
    const a = at(t - eps);
    const b = at(t + eps);
    return Math.atan2(b.x - a.x, b.z - a.z);
  };
  const facing = (t: number) => {
    const h = heading(t);
    return { x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) };
  };
  /** Left-hand unit normal. */
  const normal = (t: number) => {
    const h = heading(t);
    return { nx: -Math.cos(h), nz: Math.sin(h) };
  };

  // Drivable polygon (reference/rendering): centerline offset both ways.
  const polyN = Math.max(48, Math.round(length / 1.5));
  const outer: { x: number; z: number }[] = [];
  const inner: { x: number; z: number }[] = [];
  for (let i = 0; i < polyN; i++) {
    const t = i / polyN;
    const c = at(t);
    const { nx, nz } = normal(t);
    outer.push({ x: c.x + nx * halfWidth, z: c.z + nz * halfWidth });
    inner.push({ x: c.x - nx * halfWidth, z: c.z - nz * halfWidth });
  }

  const checkpoints = [];
  for (let i = 0; i < spec.checkpointCount; i++) {
    const c = at(i / spec.checkpointCount);
    checkpoints.push({
      index: i,
      center: { x: c.x, y: 0, z: c.z },
      halfExtents: { x: halfWidth + 1, y: 3, z: halfWidth + 1 },
      isFinish: i === 0,
    });
  }

  // Recovery points about every 2.5 m; dense enough for the corridor test.
  const splineN = Math.max(40, Math.round(length / 2.5));
  const recoverySpline = [];
  for (let i = 0; i < splineN; i++) {
    const t = i / splineN;
    const c = at(t);
    recoverySpline.push({
      t,
      position: { x: c.x, y: 0, z: c.z },
      rotation: facing(t),
      checkpointIndex: Math.floor(t * spec.checkpointCount),
    });
  }

  // Two-column staggered grid following the road behind the start line.
  const rowGap = (spec.gridRowGap ?? 3.2) / length;
  const lane = halfWidth * 0.6;
  const spawnGrid = [];
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const t = 1 - 0.5 / length - (row + (col === 1 ? 0.5 : 0)) * rowGap;
    const c = at(t);
    const { nx, nz } = normal(t);
    const side = col === 0 ? -lane : lane;
    spawnGrid.push({
      position: { x: c.x + nx * side, y: 0, z: c.z + nz * side },
      rotation: facing(t),
    });
  }

  const pickups = spec.pickups.map((t) => {
    const c = at(t);
    return { x: c.x, y: 0.3, z: c.z };
  });

  return trackSchema.parse({
    id: spec.id,
    name: spec.name,
    renderMesh: `tracks/${spec.id}/render.glb`,
    collisionMesh: `tracks/${spec.id}/collision.glb`,
    drivablePolygons: [[...outer, ...inner.reverse()]],
    trackHalfWidth: halfWidth + 1,
    checkpoints,
    recoverySpline,
    spawnGrid,
    pickups,
    defaultSurface: spec.defaultSurface ?? 'floor',
    surfaces: spec.surfaces ?? [],
    fallY: -2,
  });
}

import { z } from 'zod';
import type { SurfaceType } from './types.js';

const surfaceTypeSchema = z.enum(['floor', 'wood', 'rug', 'tile', 'milk', 'cushion']);
// Compile-time check that the schema and the shared SurfaceType union agree
// (assignable both ways), so adding a surface in one place can't be forgotten.
type SchemaSurface = z.infer<typeof surfaceTypeSchema>;
const _surfacesMatch: [SchemaSurface] extends [SurfaceType]
  ? [SurfaceType] extends [SchemaSurface]
    ? true
    : never
  : never = true;
void _surfacesMatch;

/** A stretch of road, by lap fraction [from, to), with its own surface. from > to wraps the start line. */
export const surfaceSectionSchema = z.object({
  from: z.number().min(0).max(1),
  to: z.number().min(0).max(1),
  surface: surfaceTypeSchema,
});

/**
 * Track = authored content. A track defines the drivable surface, ordered
 * checkpoints, the racing-line spline used for off-track recovery, and the
 * starting grid. Both client (rendering + prediction) and server (authoritative
 * sim + recovery) load the same track definition.
 */

const vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });
const quatSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  w: z.number(),
});

/** An ordered checkpoint volume. A lap counts only when all are hit in order. */
export const checkpointSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Center of the checkpoint trigger volume. */
  center: vec3Schema,
  /** Half-extents of the axis-aligned trigger box. */
  halfExtents: vec3Schema,
  /** True for the start/finish line checkpoint. */
  isFinish: z.boolean().default(false),
});

/** A sampled point on the racing line, used as a respawn target on recovery. */
export const recoveryPointSchema = z.object({
  /** Progress along the lap 0..1, monotonic. */
  t: z.number().min(0).max(1),
  position: vec3Schema,
  /** Facing to drop the car with (aligned to the racing line). */
  rotation: quatSchema,
  /** The checkpoint index this recovery point sits at or just after. */
  checkpointIndex: z.number().int().nonnegative(),
  /**
   * Road roll in radians. Positive raises the left-normal edge (-tz, tx); the
   * road leans into the turn when the sign matches the curvature.
   */
  bank: z.number().default(0),
  /**
   * Minimum speed (m/s) needed to stay on a steep wall here; below it the car
   * slides off and is recovered. 0 = not a wall.
   */
  minSpeed: z.number().default(0),
});

export const trackSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** GLTF path for the render mesh (relative to the client asset root). */
  renderMesh: z.string(),
  /** GLTF/GLB path for the collision mesh, used by the physics engine. */
  collisionMesh: z.string(),
  /**
   * Drivable-area polygon(s) on the XZ plane, used for off-track detection.
   * A car whose center leaves all polygons is "off track". Used only when
   * `trackHalfWidth` is not set.
   */
  drivablePolygons: z.array(z.array(z.object({ x: z.number(), z: z.number() }))),
  /**
   * If set, off-track detection uses a corridor of this half-width (meters)
   * around the recovery-spline racing line instead of the polygons. This is the
   * robust default: a point is on-track when it's within this distance of any
   * spline segment. Works for any track shape.
   */
  trackHalfWidth: z.number().positive().optional(),
  checkpoints: z.array(checkpointSchema).min(2),
  recoverySpline: z.array(recoveryPointSchema).min(2),
  /** Up to MAX_PLAYERS starting-grid transforms. */
  spawnGrid: z.array(z.object({ position: vec3Schema, rotation: quatSchema })),
  /** Positions of power-up pickup pads on the track (XZ used; y for render). */
  pickups: z.array(vec3Schema).default([]),
  /** Surface everywhere not covered by a section below. */
  defaultSurface: surfaceTypeSchema.default('floor'),
  /** Surface overrides by lap fraction; later entries win on overlap. */
  surfaces: z.array(surfaceSectionSchema).default([]),
  /** World Y below which a car counts as fallen off the table. */
  fallY: z.number(),
});

export type Track = z.infer<typeof trackSchema>;
export type SurfaceSection = z.infer<typeof surfaceSectionSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type RecoveryPoint = z.infer<typeof recoveryPointSchema>;

/** True if a point is inside a checkpoint's axis-aligned trigger box. */
export function isInsideCheckpoint(
  cp: Checkpoint,
  pos: { x: number; y: number; z: number },
): boolean {
  return (
    Math.abs(pos.x - cp.center.x) <= cp.halfExtents.x &&
    Math.abs(pos.y - cp.center.y) <= cp.halfExtents.y &&
    Math.abs(pos.z - cp.center.z) <= cp.halfExtents.z
  );
}

/** The checkpoint index a car must pass next, given the last one it cleared. */
export function nextCheckpointIndex(track: Track, lastCheckpoint: number): number {
  return (lastCheckpoint + 1) % track.checkpoints.length;
}

/** Squared XZ distance between two points (cheap comparison metric). */
function distSqXZ(
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/**
 * Find the recovery point to respawn a car at. We only consider racing-line
 * samples at or behind the car's last cleared checkpoint (so recovery never
 * advances lap progress), then pick whichever of those is physically closest to
 * where the car went off. Falls back to the whole spline if progress is unknown.
 */
export function findRecoveryPoint(
  track: Track,
  lastCheckpoint: number,
  carPos: { x: number; z: number },
): RecoveryPoint {
  const eligible = track.recoverySpline.filter(
    (p) => p.checkpointIndex <= lastCheckpoint,
  );
  const pool = eligible.length > 0 ? eligible : track.recoverySpline;

  let best = pool[0]!;
  let bestDist = distSqXZ(carPos, best.position);
  for (let i = 1; i < pool.length; i++) {
    const d = distSqXZ(carPos, pool[i]!.position);
    if (d < bestDist) {
      best = pool[i]!;
      bestDist = d;
    }
  }
  return best;
}

/** Surface at a lap fraction t (0..1). */
export function surfaceAtT(track: Track, t: number): SurfaceType {
  let found: SurfaceType = track.defaultSurface;
  for (const s of track.surfaces) {
    const inside = s.from <= s.to ? t >= s.from && t < s.to : t >= s.from || t < s.to;
    if (inside) found = s.surface;
  }
  return found;
}

/**
 * Surface under a world position: the section containing the nearest racing-line
 * sample. Pure and deterministic (used inside the shared sim). Tracks with no
 * sections skip the search entirely.
 */
export function surfaceAt(track: Track, pos: { x: number; z: number }): SurfaceType {
  if (track.surfaces.length === 0) return track.defaultSurface;
  let bestT = 0;
  let bestD = Infinity;
  for (const p of track.recoverySpline) {
    const d = distSqXZ(pos, p.position);
    if (d < bestD) {
      bestD = d;
      bestT = p.t;
    }
  }
  return surfaceAtT(track, bestT);
}

// --- relief: height, banking, slope ---------------------------------------

/** Road state under a car, from the nearest piece of racing line. */
export interface TrackSample {
  /** Lap fraction of the nearest racing-line sample (for surface lookups). */
  t: number;
  /** Road surface height at the car's position (includes banking). */
  y: number;
  /** Road roll at this point, radians (see recoverySpline.bank). */
  bank: number;
  /** Rise per metre along the direction of travel. */
  slope: number;
  /** Unit tangent of the racing line (XZ). */
  tx: number;
  tz: number;
  /** Signed distance from the racing line along the left normal (-tz, tx). */
  offset: number;
  /** Minimum speed to stay on the wall here (0 = none). */
  minSpeed: number;
}

const reliefCache = new WeakMap<Track, boolean>();

/** True if the track has any height, banking or wall sections (cached). */
export function hasRelief(track: Track): boolean {
  let v = reliefCache.get(track);
  if (v === undefined) {
    v = track.recoverySpline.some(
      (p) => p.position.y !== 0 || p.bank !== 0 || p.minSpeed !== 0,
    );
    reliefCache.set(track, v);
  }
  return v;
}

/**
 * Sample the road under a world position. Finds the nearest racing-line sample,
 * projects onto the closer of its two adjoining segments, and interpolates
 * height and bank. Pure and deterministic; used inside the shared sim and by
 * the client to tilt cars to the road.
 */
export function trackSampleAt(track: Track, pos: { x: number; z: number }): TrackSample {
  const sp = track.recoverySpline;
  const n = sp.length;
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < n; i++) {
    const d = distSqXZ(pos, sp[i]!.position);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }

  const project = (ai: number, bj: number) => {
    const a = sp[ai]!;
    const b = sp[bj]!;
    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const len2 = dx * dx + dz * dz || 1e-9;
    const u = Math.max(
      0,
      Math.min(1, ((pos.x - a.position.x) * dx + (pos.z - a.position.z) * dz) / len2),
    );
    const px = a.position.x + dx * u;
    const pz = a.position.z + dz * u;
    return { a, b, u, dx, dz, len: Math.sqrt(len2), px, pz, d: distSqXZ(pos, { x: px, z: pz }) };
  };
  const before = project((bi - 1 + n) % n, bi);
  const after = project(bi, (bi + 1) % n);
  const s = after.d <= before.d ? after : before;

  const tx = s.dx / s.len;
  const tz = s.dz / s.len;
  const y = s.a.position.y + (s.b.position.y - s.a.position.y) * s.u;
  const bank = s.a.bank + (s.b.bank - s.a.bank) * s.u;
  const hw = track.trackHalfWidth ?? 4;
  const rawOffset = (pos.x - s.px) * -tz + (pos.z - s.pz) * tx;
  const offset = Math.max(-hw, Math.min(hw, rawOffset));
  return {
    t: sp[bi]!.t,
    y: y + offset * Math.tan(bank),
    bank,
    slope: (s.b.position.y - s.a.position.y) / s.len,
    tx,
    tz,
    offset,
    minSpeed: sp[bi]!.minSpeed,
  };
}

/**
 * How a car at pos with the given heading should be tilted to lie on the road:
 * pitch (nose up positive) and roll (right side up positive), radians.
 */
export function roadTilt(
  track: Track,
  pos: { x: number; z: number },
  heading: number,
): { pitch: number; roll: number } {
  if (!hasRelief(track)) return { pitch: 0, roll: 0 };
  // Gradient of the same height function the sim uses for car.y, by central
  // differences, so a car always lies on the surface it is being simulated on.
  const e = 0.4;
  const gx =
    (trackSampleAt(track, { x: pos.x + e, z: pos.z }).y -
      trackSampleAt(track, { x: pos.x - e, z: pos.z }).y) /
    (2 * e);
  const gz =
    (trackSampleAt(track, { x: pos.x, z: pos.z + e }).y -
      trackSampleAt(track, { x: pos.x, z: pos.z - e }).y) /
    (2 * e);
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  const rx = Math.cos(heading);
  const rz = -Math.sin(heading);
  // Euler order is yaw, then pitch, then roll (three.js 'YXZ'), so the roll
  // tilts the already-pitched car: tan(roll) = cross slope * cos(pitch).
  const pitch = Math.atan(gx * fx + gz * fz);
  return { pitch, roll: Math.atan((gx * rx + gz * rz) * Math.cos(pitch)) };
}

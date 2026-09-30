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

import { MAX_PLAYERS } from '../constants.js';
import { trackSchema, type Track } from '../track.js';

/**
 * "Rug Weave Eight" — a figure-eight track. The centerline is a lemniscate
 * (figure-eight curve). Built with the same pattern as the oval: everything
 * derives from a single parametric centerline so the drivable corridor,
 * checkpoints, recovery spline, spawn grid, and pickups all stay consistent.
 *
 * Note: a true figure-eight crosses itself in the middle. The corridor-based
 * off-track test treats the whole weave as drivable near the crossing, which is
 * fine for arcade play (cars pass over/under conceptually; no collision mesh at
 * the crossing yet). Proper over/under geometry is future art work.
 */

const SCALE_X = 18;
const SCALE_Z = 11;
const TRACK_HALF_WIDTH = 3;
const CHECKPOINT_COUNT = 10;
const SPLINE_SAMPLES = 40;

/** Lemniscate of Gerono-style centerline at parameter t (0..1). */
function centerline(t: number): { x: number; z: number } {
  const a = t * Math.PI * 2;
  return {
    x: Math.sin(a) * SCALE_X,
    z: Math.sin(a) * Math.cos(a) * SCALE_Z * 2,
  };
}

function facingAt(t: number): { x: number; y: number; z: number; w: number } {
  const here = centerline(t);
  const ahead = centerline((t + 0.001) % 1);
  const heading = Math.atan2(ahead.x - here.x, ahead.z - here.z);
  return { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
}

/** Left-hand normal to the centerline at t (unit, XZ plane). */
function normalAt(t: number): { nx: number; nz: number } {
  const here = centerline(t);
  const ahead = centerline((t + 0.001) % 1);
  let tx = ahead.x - here.x;
  let tz = ahead.z - here.z;
  const len = Math.hypot(tx, tz) || 1;
  tx /= len;
  tz /= len;
  return { nx: -tz, nz: tx };
}

function buildDrivablePolygon(): { x: number; z: number }[] {
  const outer: { x: number; z: number }[] = [];
  const inner: { x: number; z: number }[] = [];
  for (let i = 0; i < SPLINE_SAMPLES; i++) {
    const t = i / SPLINE_SAMPLES;
    const c = centerline(t);
    const { nx, nz } = normalAt(t);
    outer.push({ x: c.x + nx * TRACK_HALF_WIDTH, z: c.z + nz * TRACK_HALF_WIDTH });
    inner.push({ x: c.x - nx * TRACK_HALF_WIDTH, z: c.z - nz * TRACK_HALF_WIDTH });
  }
  return [...outer, ...inner.reverse()];
}

function buildCheckpoints() {
  const checkpoints = [];
  for (let i = 0; i < CHECKPOINT_COUNT; i++) {
    const t = i / CHECKPOINT_COUNT;
    const c = centerline(t);
    checkpoints.push({
      index: i,
      center: { x: c.x, y: 0, z: c.z },
      halfExtents: { x: TRACK_HALF_WIDTH + 1, y: 3, z: TRACK_HALF_WIDTH + 1 },
      isFinish: i === 0,
    });
  }
  return checkpoints;
}

function buildRecoverySpline() {
  const spline = [];
  for (let i = 0; i < SPLINE_SAMPLES; i++) {
    const t = i / SPLINE_SAMPLES;
    const c = centerline(t);
    spline.push({
      t,
      position: { x: c.x, y: 0, z: c.z },
      rotation: facingAt(t),
      checkpointIndex: Math.floor(t * CHECKPOINT_COUNT),
    });
  }
  return spline;
}

function buildSpawnGrid() {
  const grid = [];
  const laneOffset = TRACK_HALF_WIDTH * 0.6;
  const tStep = 0.014;
  const tStart = 1 - 0.01;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const tRaw = tStart - (row + (col === 1 ? 0.5 : 0)) * tStep;
    const t = ((tRaw % 1) + 1) % 1;
    const c = centerline(t);
    const { nx, nz } = normalAt(t);
    const side = col === 0 ? -laneOffset : laneOffset;
    grid.push({
      position: { x: c.x + nx * side, y: 0, z: c.z + nz * side },
      rotation: facingAt(t),
    });
  }
  return grid;
}

function buildPickups() {
  return [0.2, 0.45, 0.7, 0.95].map((t) => {
    const c = centerline(t);
    return { x: c.x, y: 0.3, z: c.z };
  });
}

export const FIGURE8_TRACK: Track = trackSchema.parse({
  id: 'rug-weave-eight',
  name: 'Rug Weave Eight',
  renderMesh: 'tracks/rug-weave-eight/render.glb',
  collisionMesh: 'tracks/rug-weave-eight/collision.glb',
  drivablePolygons: [buildDrivablePolygon()],
  trackHalfWidth: TRACK_HALF_WIDTH + 1,
  checkpoints: buildCheckpoints(),
  recoverySpline: buildRecoverySpline(),
  spawnGrid: buildSpawnGrid(),
  pickups: buildPickups(),
  fallY: -2,
});

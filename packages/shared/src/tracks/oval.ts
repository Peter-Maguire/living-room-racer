import { MAX_PLAYERS } from '../constants.js';
import { trackSchema, type Track } from '../track.js';

/**
 * "Coffee Table Oval" — the first authored track. A simple rounded rectangle
 * loop sized for the living-room scale. Built procedurally here so the geometry
 * stays consistent between the drivable polygon, checkpoints, recovery spline,
 * and spawn grid. Real art (render/collision GLBs) is swapped in later; the
 * paths below point at where those assets will live.
 *
 * Layout (top-down, XZ plane): an oval centered on origin. Cars drive
 * counter-clockwise starting near the bottom straight (+Z), passing checkpoints
 * 0..N in order. Checkpoint 0 is the start/finish line.
 */

const RADIUS_X = 16; // half-width of the oval
const RADIUS_Z = 10; // half-height of the oval
const TRACK_HALF_WIDTH = 3; // drivable margin either side of the racing line
const CHECKPOINT_COUNT = 8;

/** A point on the center racing line at parameter t (0..1) around the oval. */
function racingLinePoint(t: number): { x: number; z: number } {
  const angle = t * Math.PI * 2;
  return {
    x: Math.sin(angle) * RADIUS_X,
    z: Math.cos(angle) * RADIUS_Z,
  };
}

/** Yaw quaternion (about Y) facing along the racing line at parameter t. */
function facingAt(t: number): { x: number; y: number; z: number; w: number } {
  const ahead = racingLinePoint((t + 0.001) % 1);
  const here = racingLinePoint(t);
  const heading = Math.atan2(ahead.x - here.x, ahead.z - here.z);
  return { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
}

/** Build the outer/inner ring as a single drivable polygon band, sampled. */
function buildDrivablePolygon(): { x: number; z: number }[] {
  const samples = 48;
  const outer: { x: number; z: number }[] = [];
  const inner: { x: number; z: number }[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / samples;
    const angle = t * Math.PI * 2;
    const nx = Math.sin(angle);
    const nz = Math.cos(angle);
    outer.push({
      x: nx * (RADIUS_X + TRACK_HALF_WIDTH),
      z: nz * (RADIUS_Z + TRACK_HALF_WIDTH),
    });
    inner.push({
      x: nx * (RADIUS_X - TRACK_HALF_WIDTH),
      z: nz * (RADIUS_Z - TRACK_HALF_WIDTH),
    });
  }
  // Ring as a single simple polygon: outer forward, inner reversed.
  return [...outer, ...inner.reverse()];
}

function buildCheckpoints() {
  const checkpoints = [];
  for (let i = 0; i < CHECKPOINT_COUNT; i++) {
    const t = i / CHECKPOINT_COUNT;
    const p = racingLinePoint(t);
    checkpoints.push({
      index: i,
      center: { x: p.x, y: 0, z: p.z },
      // Wide enough to span the track width, tall enough to catch any car.
      halfExtents: { x: TRACK_HALF_WIDTH + 1, y: 3, z: TRACK_HALF_WIDTH + 1 },
      isFinish: i === 0,
    });
  }
  return checkpoints;
}

function buildRecoverySpline() {
  const samples = 32;
  const spline = [];
  for (let i = 0; i < samples; i++) {
    const t = i / samples;
    const p = racingLinePoint(t);
    spline.push({
      t,
      position: { x: p.x, y: 0, z: p.z },
      rotation: facingAt(t),
      // Map this sample to the checkpoint it sits at or just after.
      checkpointIndex: Math.floor(t * CHECKPOINT_COUNT),
    });
  }
  return spline;
}

function buildSpawnGrid() {
  // The start/finish is at t=0 -> racing line point (x=0, z=RADIUS_Z), where the
  // Classic staggered grid that FOLLOWS the curved racing line (so rear slots
  // stay inside the corridor even as the oval bends). Each slot is placed at a
  // parameter just behind the start line and offset laterally along the track's
  // local normal. Two columns; the right column sits half a step further back
  // for the diagonal race-grid look.
  const grid = [];
  const laneOffset = TRACK_HALF_WIDTH * 0.6; // lateral gap between columns
  const tStep = 0.026; // parameter gap between rows (backward around the loop)
  const tStart = 1 - 0.012; // first row just behind start/finish (wraps < 1)
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const col = i % 2; // 0 = left lane, 1 = right lane
    const row = Math.floor(i / 2);
    // Walk backward around the loop (decreasing t, wrapping into [0,1)).
    const tRaw = tStart - (row + (col === 1 ? 0.5 : 0)) * tStep;
    const t = ((tRaw % 1) + 1) % 1;
    const c = racingLinePoint(t);
    // Lateral (left-hand) normal to the racing line at this point.
    const ahead = racingLinePoint((t + 0.001) % 1);
    let tx = ahead.x - c.x;
    let tz = ahead.z - c.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;
    const side = col === 0 ? -laneOffset : laneOffset;
    grid.push({
      position: { x: c.x + nx * side, y: 0, z: c.z + nz * side },
      rotation: facingAt(t),
    });
  }
  return grid;
}

/** Pickup pads on the racing line, spaced around the far/mid parts of the lap. */
function buildPickups() {
  const ts = [0.25, 0.5, 0.75];
  return ts.map((t) => {
    const p = racingLinePoint(t);
    return { x: p.x, y: 0.3, z: p.z };
  });
}

export const OVAL_TRACK: Track = trackSchema.parse({
  id: 'coffee-table-oval',
  name: 'Coffee Table Oval',
  renderMesh: 'tracks/coffee-table-oval/render.glb',
  collisionMesh: 'tracks/coffee-table-oval/collision.glb',
  drivablePolygons: [buildDrivablePolygon()],
  // Off-track detection uses a corridor around the racing line (robust for the
  // oval shape); the polygon above is kept for rendering/reference. Slightly
  // wider than the visual half-width so grazing the edge isn't an instant reset.
  trackHalfWidth: TRACK_HALF_WIDTH + 1,
  checkpoints: buildCheckpoints(),
  recoverySpline: buildRecoverySpline(),
  spawnGrid: buildSpawnGrid(),
  pickups: buildPickups(),
  fallY: -2,
});

import {
  CAR_ACCEL,
  CAR_BRAKE,
  CAR_DRIFT_GRIP,
  CAR_MAX_SPEED,
  CAR_STEER_RATE,
  FALL_Y_THRESHOLD,
  OFF_TRACK_TICKS_BEFORE_RECOVERY,
  RACE_LAPS,
  RECOVERY_LIFT_SECONDS,
  RECOVERY_LOCKOUT_SECONDS,
} from './constants.js';
import {
  findRecoveryPoint,
  isInsideCheckpoint,
  nextCheckpointIndex,
  type Track,
} from './track.js';
import type { CarPhase, PlayerInput, Vec3 } from './types.js';

/**
 * The shared authoritative step. The SERVER runs this to produce the true world
 * state; the CLIENT runs the exact same function to predict the local car and
 * to reconcile against server snapshots. It MUST be deterministic: same inputs +
 * same starting state + same dt => same result on both sides.
 *
 * This is a skeleton. The real implementation drives a Rapier rigid body per car
 * (WASM in the browser, native/compat in Node). The car-state bookkeeping,
 * off-track detection, and recovery state machine live here so both sides agree.
 */

export interface SimCar {
  playerId: string;
  phase: CarPhase;
  position: Vec3;
  /** Yaw in radians (top-down; single-axis heading is enough for arcade feel). */
  heading: number;
  velocity: Vec3;
  speed: number;
  lastCheckpoint: number;
  lap: number;
  place: number;
  /** Ticks the car has been continuously off the drivable surface. */
  offTrackTicks: number;
  /** Seconds remaining in the current recovery sub-phase, if recovering. */
  recoveryTimer: number;
  /** Seconds of control lockout remaining after a re-drop. */
  lockoutTimer: number;
}

export interface SimWorld {
  tick: number;
  cars: Map<string, SimCar>;
}

/**
 * True if the car center is on the drivable surface (XZ plane). When the track
 * defines `trackHalfWidth`, we treat "on track" as being within that distance
 * of the racing line (a corridor around the recovery spline) — robust for any
 * shape. Otherwise we fall back to the drivable polygons.
 */
export function isOnTrack(track: Track, pos: Vec3): boolean {
  if (track.trackHalfWidth != null && track.recoverySpline.length >= 2) {
    return isInSplineCorridor(track, pos, track.trackHalfWidth);
  }
  for (const poly of track.drivablePolygons) {
    if (pointInPolygon(pos.x, pos.z, poly)) return true;
  }
  return false;
}

/** On-track if within `halfWidth` of any segment of the (looped) racing line. */
function isInSplineCorridor(track: Track, pos: Vec3, halfWidth: number): boolean {
  const spline = track.recoverySpline;
  const hwSq = halfWidth * halfWidth;
  for (let i = 0; i < spline.length; i++) {
    const a = spline[i]!.position;
    const b = spline[(i + 1) % spline.length]!.position; // wrap: closed loop
    if (distSqToSegmentXZ(pos, a, b) <= hwSq) return true;
  }
  return false;
}

/** Squared distance from point p to segment a-b, in the XZ plane. */
function distSqToSegmentXZ(
  p: { x: number; z: number },
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  const lenSq = abx * abx + abz * abz;
  let t = lenSq > 0 ? (apx * abx + apz * abz) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = apx - abx * t;
  const dz = apz - abz * t;
  return dx * dx + dz * dz;
}

function pointInPolygon(
  x: number,
  z: number,
  poly: { x: number; z: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const intersect =
      a.z > z !== b.z > z &&
      x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Advance the whole world by one fixed timestep. `inputs` maps playerId to the
 * input to apply this tick (the latest buffered input on the server; the local
 * input on the client during prediction).
 *
 * TODO(P1/P2): replace the kinematic integration below with a Rapier step.
 */
export function stepWorld(
  world: SimWorld,
  inputs: Map<string, PlayerInput>,
  track: Track,
  dt: number,
): void {
  for (const car of world.cars.values()) {
    stepCar(car, inputs.get(car.playerId), track, dt);
  }
  world.tick += 1;
}

function stepCar(
  car: SimCar,
  input: PlayerInput | undefined,
  track: Track,
  dt: number,
): void {
  // Recovery state machine takes precedence over normal driving.
  if (car.phase === 'recovering') {
    car.recoveryTimer -= dt;
    if (car.recoveryTimer <= 0) {
      const rp = findRecoveryPoint(track, car.lastCheckpoint, car.position);
      car.position = { ...rp.position };
      car.heading = headingFromQuatY(rp.rotation);
      car.velocity = { x: 0, y: 0, z: 0 };
      car.speed = 0;
      car.offTrackTicks = 0;
      car.lockoutTimer = RECOVERY_LOCKOUT_SECONDS;
      car.phase = 'racing';
    }
    return;
  }

  if (car.phase !== 'racing') return;

  // Control lockout right after a re-drop: physics settles, input ignored.
  const controllable = car.lockoutTimer <= 0;
  if (car.lockoutTimer > 0) car.lockoutTimer -= dt;

  driveCar(car, controllable ? input : undefined, dt);
  integrate(car, dt);
  updateCheckpointProgress(car, track);
  handleOffTrack(car, track);
}

/** Arcade longitudinal + steering model. Deterministic; no RNG, no wall-clock. */
function driveCar(car: SimCar, input: PlayerInput | undefined, dt: number): void {
  if (!input) {
    // Coast: apply mild rolling drag toward zero.
    car.speed = approach(car.speed, 0, CAR_ACCEL * 0.3 * dt);
    return;
  }

  if (input.brake > 0 && car.speed > 0) {
    car.speed = Math.max(0, car.speed - CAR_BRAKE * input.brake * dt);
  } else {
    car.speed += CAR_ACCEL * input.throttle * dt;
  }
  // Clamp: full forward speed, limited reverse.
  car.speed = clamp(car.speed, -CAR_MAX_SPEED * 0.4, CAR_MAX_SPEED);

  // Steering authority scales with speed (can't turn while nearly stopped) and
  // is sharper while drifting. Sign follows travel direction so reverse steers
  // intuitively. Negated so steer=+1 (D / right) turns the car right on screen.
  const speedFactor = Math.min(1, Math.abs(car.speed) / (CAR_MAX_SPEED * 0.5));
  const driftMul = input.drift ? 1 + (1 - CAR_DRIFT_GRIP) : 1;
  const dir = car.speed >= 0 ? 1 : -1;
  car.heading -= input.steer * CAR_STEER_RATE * speedFactor * driftMul * dir * dt;
}

/** Advance position from heading + speed. */
function integrate(car: SimCar, dt: number): void {
  car.velocity = {
    x: Math.sin(car.heading) * car.speed,
    y: car.velocity.y,
    z: Math.cos(car.heading) * car.speed,
  };
  car.position.x += car.velocity.x * dt;
  car.position.z += car.velocity.z * dt;
}

/**
 * Advance lap/checkpoint progress. A checkpoint only counts when it's the NEXT
 * one in order, which prevents cutting the course. Crossing the finish line
 * (index 0, wrapping from the last checkpoint) increments the lap.
 */
function updateCheckpointProgress(car: SimCar, track: Track): void {
  if (car.phase === 'finished') return;
  const nextIdx = nextCheckpointIndex(track, car.lastCheckpoint);
  const nextCp = track.checkpoints[nextIdx]!;
  if (!isInsideCheckpoint(nextCp, car.position)) return;

  // Passing the finish checkpoint (wrap back to 0) completes a lap.
  if (nextIdx === 0 && car.lastCheckpoint >= 0) {
    car.lap += 1;
    if (car.lap >= RACE_LAPS) {
      car.phase = 'finished';
    }
  }
  car.lastCheckpoint = nextIdx;
}

/** Off-track / fall detection -> enter recovery. */
function handleOffTrack(car: SimCar, track: Track): void {
  const fell = car.position.y < (track.fallY ?? FALL_Y_THRESHOLD);
  const off = !isOnTrack(track, car.position);
  if (fell) {
    enterRecovery(car);
  } else if (off) {
    car.offTrackTicks += 1;
    if (car.offTrackTicks >= OFF_TRACK_TICKS_BEFORE_RECOVERY) enterRecovery(car);
  } else {
    car.offTrackTicks = 0;
  }
}

function enterRecovery(car: SimCar): void {
  car.phase = 'recovering';
  car.recoveryTimer = RECOVERY_LIFT_SECONDS;
  car.velocity = { x: 0, y: 0, z: 0 };
  car.speed = 0;
}

// --- small deterministic helpers ------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Move `v` toward `target` by at most `maxDelta`. */
function approach(v: number, target: number, maxDelta: number): number {
  if (v > target) return Math.max(target, v - maxDelta);
  if (v < target) return Math.min(target, v + maxDelta);
  return v;
}

/** Extract the Y-axis yaw from a quaternion (assumes rotation about Y only). */
export function headingFromQuatY(q: {
  x: number;
  y: number;
  z: number;
  w: number;
}): number {
  return 2 * Math.atan2(q.y, q.w);
}

// --- client prediction helpers --------------------------------------------

/**
 * Rebuild a full SimCar from a server CarState snapshot. Fields the snapshot
 * doesn't carry (offTrackTicks, recoveryTimer, lockoutTimer) are defaulted;
 * this is fine for prediction because the client stops predicting a car while
 * it is 'recovering' (recovery is fully server-driven). Speed is recovered as
 * the signed magnitude of the planar velocity projected onto the heading.
 */
export function carStateToSimCar(state: {
  playerId: string;
  phase: CarPhase;
  position: Vec3;
  rotation: { x: number; y: number; z: number; w: number };
  linearVelocity: Vec3;
  lastCheckpoint: number;
  lap: number;
  place: number;
}): SimCar {
  const heading = headingFromQuatY(state.rotation);
  // Project velocity onto heading direction to recover signed speed.
  const forwardX = Math.sin(heading);
  const forwardZ = Math.cos(heading);
  const speed =
    state.linearVelocity.x * forwardX + state.linearVelocity.z * forwardZ;
  return {
    playerId: state.playerId,
    phase: state.phase,
    position: { ...state.position },
    heading,
    velocity: { ...state.linearVelocity },
    speed,
    lastCheckpoint: state.lastCheckpoint,
    lap: state.lap,
    place: state.place,
    offTrackTicks: 0,
    recoveryTimer: 0,
    lockoutTimer: 0,
  };
}

/** Quaternion (about Y) for a heading, matching the server's snapshot encoding. */
export function headingToQuatY(heading: number): {
  x: number;
  y: number;
  z: number;
  w: number;
} {
  return { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
}

/**
 * Step a single car by one fixed timestep with the given input, using the exact
 * same simulation the server runs. Used by client prediction/reconciliation to
 * replay buffered inputs. Wraps the car in a one-entry world so stepWorld's
 * per-car logic (driving, checkpoints, off-track) applies identically.
 */
export function stepSingleCar(
  car: SimCar,
  input: PlayerInput | undefined,
  track: Track,
  dt: number,
): void {
  const world: SimWorld = { tick: 0, cars: new Map([[car.playerId, car]]) };
  const inputs = new Map<string, PlayerInput>();
  if (input) inputs.set(car.playerId, input);
  stepWorld(world, inputs, track, dt);
}

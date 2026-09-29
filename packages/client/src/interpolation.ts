import {
  INTERPOLATION_DELAY_MS,
  type CarState,
  type Snapshot,
} from '@racer/shared';

interface TimedSnapshot {
  /** Client receive time (ms, performance.now()). */
  receivedAt: number;
  snap: Snapshot;
}

/**
 * Entity interpolation for REMOTE cars. Snapshots arrive at ~20 Hz; rendering
 * them raw looks choppy. Instead we render remote cars slightly in the past
 * (INTERPOLATION_DELAY_MS) and smoothly interpolate between the two snapshots
 * that bracket that render time. This trades a little latency for smoothness.
 */
export class Interpolator {
  private buffer: TimedSnapshot[] = [];
  private readonly maxBuffer = 30;

  /** Record a newly received snapshot. */
  push(snap: Snapshot): void {
    this.buffer.push({ receivedAt: performance.now(), snap });
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
  }

  /**
   * Interpolated remote car states as of (now - delay), excluding `localId`
   * (that car is predicted, not interpolated).
   */
  sample(now: number, localId: string | undefined): CarState[] {
    const renderTime = now - INTERPOLATION_DELAY_MS;

    // Find the two snapshots bracketing renderTime.
    let older: TimedSnapshot | null = null;
    let newer: TimedSnapshot | null = null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i]!.receivedAt <= renderTime) {
        older = this.buffer[i]!;
        newer = this.buffer[i + 1] ?? null;
        break;
      }
    }

    // Not enough history yet: fall back to the latest snapshot as-is.
    if (!older) {
      const latest = this.buffer[this.buffer.length - 1];
      if (!latest) return [];
      return latest.snap.cars.filter((c) => c.playerId !== localId);
    }
    if (!newer) {
      return older.snap.cars.filter((c) => c.playerId !== localId);
    }

    const span = newer.receivedAt - older.receivedAt;
    const alpha = span > 0 ? (renderTime - older.receivedAt) / span : 0;

    const result: CarState[] = [];
    for (const a of older.snap.cars) {
      if (a.playerId === localId) continue;
      const b = newer.snap.cars.find((c) => c.playerId === a.playerId);
      result.push(b ? lerpCar(a, b, alpha) : a);
    }
    return result;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate the transform of a car; discrete fields snap to the newer one. */
function lerpCar(a: CarState, b: CarState, t: number): CarState {
  return {
    ...b,
    position: {
      x: lerp(a.position.x, b.position.x, t),
      y: lerp(a.position.y, b.position.y, t),
      z: lerp(a.position.z, b.position.z, t),
    },
    rotation: slerpY(a.rotation, b.rotation, t),
  };
}

/**
 * Spherical-ish interpolation for a Y-only rotation. Extract yaw from each and
 * lerp the shortest angular path, then re-encode.
 */
function slerpY(
  qa: { x: number; y: number; z: number; w: number },
  qb: { x: number; y: number; z: number; w: number },
  t: number,
): { x: number; y: number; z: number; w: number } {
  const ya = 2 * Math.atan2(qa.y, qa.w);
  const yb = 2 * Math.atan2(qb.y, qb.w);
  let delta = yb - ya;
  // Wrap to [-PI, PI] for the shortest turn.
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const y = ya + delta * t;
  return { x: 0, y: Math.sin(y / 2), z: 0, w: Math.cos(y / 2) };
}

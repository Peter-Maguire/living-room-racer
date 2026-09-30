import type { EffectType, HazardType, ItemType, SurfaceType } from './types.js';

/**
 * Shared tuning constants used by BOTH the client (prediction) and the server
 * (authoritative sim). These MUST be identical on both sides or prediction and
 * reconciliation will diverge. Treat this file as part of the netcode contract.
 */

/** Authoritative simulation tick rate (Hz). Start at 30; consider 60 later. */
export const SIM_TICK_RATE = 30;
/** Fixed physics timestep in seconds, derived from the tick rate. */
export const FIXED_DT = 1 / SIM_TICK_RATE;

/** Rate at which the server broadcasts state snapshots to clients (Hz). */
export const SNAPSHOT_RATE = 20;

/** Rate at which clients sample and send input to the server (Hz). */
export const INPUT_SEND_RATE = 30;

/** How far in the past (ms) remote cars are rendered, for interpolation. */
export const INTERPOLATION_DELAY_MS = 100;

/** Max players per race. */
export const MAX_PLAYERS = 8;

/** Number of laps in a standard race. */
export const RACE_LAPS = 3;

// --- Off-track / recovery tuning ------------------------------------------

/** Ticks a car must be off the drivable surface before recovery triggers. */
export const OFF_TRACK_TICKS_BEFORE_RECOVERY = 15;
/** World Y height below which a car counts as fallen off the table. */
export const FALL_Y_THRESHOLD = -2;
/** Seconds the car is frozen/lifted before being re-dropped on the track. */
export const RECOVERY_LIFT_SECONDS = 1.2;
/** Seconds of control lockout + invulnerability after being re-dropped. */
export const RECOVERY_LOCKOUT_SECONDS = 0.75;

// --- Car handling (arcade feel) -------------------------------------------

export const CAR_MAX_SPEED = 18; // m/s
export const CAR_ACCEL = 24; // m/s^2
export const CAR_BRAKE = 30; // m/s^2
export const CAR_STEER_RATE = 2.8; // rad/s at low speed
export const CAR_DRIFT_GRIP = 0.6; // lateral grip while drifting (0..1)

/** Collision radius (m) used for car-to-car push-apart. Cars are ~1x2 boxes. */
export const CAR_COLLISION_RADIUS = 0.9;
/** How strongly car collisions transfer speed (0..1). */
export const CAR_COLLISION_RESTITUTION = 0.5;

// --- Items / power-ups ----------------------------------------------------

/** Radius (m) within which a car collects a pickup pad. */
export const PICKUP_RADIUS = 1.6;
/** Ticks a collected pickup pad stays inactive before respawning. */
export const PICKUP_RESPAWN_TICKS = SIM_TICK_RATE * 5; // ~5s
/** Speed multiplier applied to top speed + accel while boosting. */
export const BOOST_MULTIPLIER = 1.6;
/** Duration of a boost, in seconds. */
export const BOOST_SECONDS = 1.5;

// --- Surfaces (grip) --------------------------------------------------------

/**
 * How a surface changes handling. The sim is arcade-kinematic (velocity follows
 * heading), so grip is modelled as:
 *  - traction: multiplies acceleration and braking
 *  - steer:    multiplies steering authority
 *  - topSpeed: multiplies the speed cap (drag)
 *  - follow:   how fast the velocity direction catches up to the heading, per
 *              second. Infinity = locked to the heading (no sliding). Lower
 *              values let the car slide wide in corners.
 * 'floor' is all 1 / Infinity, so tracks without surface tags drive exactly as
 * they did before surfaces existed.
 */
export interface SurfaceParams {
  traction: number;
  steer: number;
  topSpeed: number;
  follow: number;
}

export const SURFACES: Record<SurfaceType, SurfaceParams> = {
  floor: { traction: 1, steer: 1, topSpeed: 1, follow: Infinity },
  wood: { traction: 1, steer: 0.95, topSpeed: 1, follow: Infinity },
  rug: { traction: 1.15, steer: 1.1, topSpeed: 0.92, follow: Infinity },
  tile: { traction: 0.75, steer: 0.7, topSpeed: 1, follow: 6 },
  milk: { traction: 0.4, steer: 0.45, topSpeed: 0.85, follow: 2.5 },
  cushion: { traction: 0.8, steer: 0.85, topSpeed: 0.7, follow: Infinity },
};

/** Steering authority gained per unit sin(bank): banked roads let you corner harder. */
export const BANK_STEER_BONUS = 0.8;
/** Traction gained per unit sin(bank). */
export const BANK_TRACTION_BONUS = 0.3;
/** m/s^2 lost per unit of uphill slope along the direction of travel. */
export const SLOPE_ACCEL = 4.9;

/** Deceleration (m/s^2) applied when a car is above the current speed cap. */
export const CAR_OVERSPEED_DECEL = 40;

// --- Power-ups ---------------------------------------------------------------

/** How long each timed effect lasts, in seconds. */
export const EFFECT_SECONDS: Record<EffectType, number> = {
  spin: 1.1, // marble hit: a full revolution with no control
  slick: 2.5, // oil: low grip
  tape: 1.6, // sticky tape: heavy slowdown
  scramble: 2.0, // static shock: steering inverted
  dust: 3.5, // dust cloud: screen obscured (client-only effect)
};

/** Oil: steering and traction multipliers, and how fast velocity chases heading. */
export const SLICK_STEER = 0.45;
export const SLICK_TRACTION = 0.5;
export const SLICK_FOLLOW = 2.5;
/** Sticky tape: top-speed and traction multipliers. */
export const TAPE_TOP_SPEED = 0.35;
export const TAPE_TRACTION = 0.6;
/** Fraction of speed a marble hit leaves the victim with. */
export const SPIN_SPEED_KEEP = 0.3;

/** Static shock reaches other cars within this distance (m). */
export const SHOCK_RADIUS = 12;

export const HAZARDS: Record<HazardType, { radius: number; ttl: number }> = {
  oil: { radius: 1.7, ttl: 12 },
  tape: { radius: 1.4, ttl: 14 },
  marble: { radius: 0.6, ttl: 2.5 },
};
/** Marble speed (m/s), fixed: it rolls straight and fast. */
export const MARBLE_SPEED = 26;
/** Seconds a dropped hazard ignores the car that dropped it. */
export const HAZARD_OWNER_GRACE = 1.0;

export type RankZone = 'front' | 'mid' | 'back';
/**
 * Item odds by race position. Leaders get defensive items that hurt whoever is
 * behind; trailing cars get catch-up items (boost, marble, shock). Relative
 * weights, not percentages. A zero means "never".
 */
export const ITEM_WEIGHTS: Record<RankZone, Record<ItemType, number>> = {
  front: { boost: 20, oil: 25, tape: 20, dust: 25, shock: 10, marble: 0 },
  mid: { boost: 25, oil: 15, tape: 10, dust: 10, shock: 20, marble: 20 },
  back: { boost: 35, oil: 0, tape: 0, dust: 0, shock: 25, marble: 40 },
};

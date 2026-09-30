/** Core shared value types for the simulation and network protocol. */

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

/** What a stretch of road is made of; sets grip (see SURFACES in constants). */
export type SurfaceType = 'floor' | 'wood' | 'rug' | 'tile' | 'milk' | 'cushion';

/** Per-car lifecycle state, authoritative on the server. */
export type CarPhase = 'countdown' | 'racing' | 'recovering' | 'finished';

/** Overall race lifecycle. */
export type RacePhase = 'lobby' | 'countdown' | 'racing' | 'finished';

/** A single frame of player input, stamped with a sequence number. */
export interface PlayerInput {
  /** Monotonic sequence number, used for reconciliation. */
  seq: number;
  /** -1..1, forward/back. */
  throttle: number;
  /** -1..1, left/right. */
  steer: number;
  /** 0..1, brake pressure. */
  brake: number;
  /** Whether the drift/handbrake button is held. */
  drift: boolean;
  /** Whether the item-use button was pressed this frame. */
  useItem: boolean;
}

/** Power-up types a car can hold and use. */
export type ItemType = 'boost' | 'shock' | 'dust' | 'oil' | 'tape' | 'marble';

/** Timed conditions on a car. Applied by the server; they tick down in the shared sim. */
export type EffectType = 'spin' | 'slick' | 'tape' | 'scramble' | 'dust';

export interface ActiveEffect {
  type: EffectType;
  /** Seconds left. */
  remaining: number;
}

/** Things that exist on the track independent of any car. */
export type HazardType = 'oil' | 'tape' | 'marble';

/** A hazard as sent to clients. Velocity lets clients extrapolate a marble between snapshots. */
export interface HazardState {
  id: number;
  type: HazardType;
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/**
 * One-off happenings for sound and visual flourishes. Carried by the snapshot of
 * the tick they occurred in, so each is delivered exactly once.
 */
export type GameEvent =
  | { kind: 'use'; item: ItemType; by: string; x: number; z: number }
  | { kind: 'hit'; cause: HazardType | 'shock'; target: string; x: number; z: number };

/** Authoritative state of a single car, sent in snapshots. */
export interface CarState {
  playerId: string;
  phase: CarPhase;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  /**
   * Signed driven speed along the heading (m/s). Differs from |linearVelocity|
   * on low-grip surfaces, where the car slides. Optional for old snapshots.
   */
  speed?: number;
  /** Index of the last checkpoint passed, in order. */
  lastCheckpoint: number;
  lap: number;
  /** Finishing place once phase === 'finished' (1-based), else 0. */
  place: number;
  /** The item the car is currently holding, or null. */
  heldItem: ItemType | null;
  /** True while a boost is active (for client VFX). */
  boosting: boolean;
  /** Active timed effects (spin-out, slick, scramble...). */
  effects: ActiveEffect[];
  /** Seconds of control lockout left after a re-drop or spin. Optional for old snapshots. */
  lockout?: number;
  /** Live race position (1 = leading), computed by the server. */
  rank?: number;
}

/** Authoritative state of a pickup pad, sent in snapshots. */
export interface PickupState {
  /** Index into the track's pickup list. */
  index: number;
  /** False while collected and on cooldown. */
  active: boolean;
}

/** A full authoritative snapshot broadcast to clients. */
export interface Snapshot {
  /** Server tick this snapshot represents. */
  tick: number;
  racePhase: RacePhase;
  /** Milliseconds remaining in the current phase (countdown), or race clock. */
  clockMs: number;
  cars: CarState[];
  /** Pickup pad states (active/cooldown). */
  pickups: PickupState[];
  /** Per-player: the last input seq the server has processed (for reconciliation). */
  ackedInputSeq: Record<string, number>;
  /** Oil, tape and marbles currently on the track. */
  hazards: HazardState[];
  /** One-off events from this tick. */
  events: GameEvent[];
}

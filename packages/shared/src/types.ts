/** Core shared value types for the simulation and network protocol. */

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

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

/** Power-up types a car can hold and use. Extend as more items are added. */
export type ItemType = 'boost';

/** Authoritative state of a single car, sent in snapshots. */
export interface CarState {
  playerId: string;
  phase: CarPhase;
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  /** Index of the last checkpoint passed, in order. */
  lastCheckpoint: number;
  lap: number;
  /** Finishing place once phase === 'finished' (1-based), else 0. */
  place: number;
  /** The item the car is currently holding, or null. */
  heldItem: ItemType | null;
  /** True while a boost is active (for client VFX). */
  boosting: boolean;
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
}

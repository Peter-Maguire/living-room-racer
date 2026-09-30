import {
  CAR_COLLISION_RADIUS,
  EFFECT_SECONDS,
  HAZARDS,
  HAZARD_OWNER_GRACE,
  ITEM_WEIGHTS,
  MARBLE_SPEED,
  SHOCK_RADIUS,
  SPIN_SPEED_KEEP,
  type RankZone,
} from './constants.js';
import type { SimCar, SimWorld } from './physics.js';
import { trackSampleAt, type Track } from './track.js';
import type { EffectType, GameEvent, HazardType, ItemType } from './types.js';

/**
 * Power-ups beyond the boost. All of the randomness and all of the hits live
 * here and only run when the world has an `authority` (the server): clients
 * predict their own driving, then receive items, effects and hazards in
 * snapshots. That keeps rolls uncheatable and means a client can never decide
 * that a hit landed.
 *
 * Nothing here costs lap progress. Effects cost time; progress is preserved.
 */

/** A hazard on the track (server-side; clients get the slimmer HazardState). */
export interface Hazard {
  id: number;
  type: HazardType;
  owner: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
  /** Seconds since it appeared. */
  age: number;
  /** Seconds remaining before it disappears. */
  ttl: number;
}

// --- race order ---------------------------------------------------------------

/**
 * Continuous race progress in laps: lap count + position within the lap. Finer
 * than (lap, checkpoint), so two cars in the same checkpoint segment still
 * order correctly. Before the start line it is negative, so the grid orders by
 * how close each car is to the line.
 */
export function raceProgress(
  track: Track,
  car: { lap: number; lastCheckpoint: number; position: { x: number; z: number } },
): number {
  const count = track.checkpoints.length;
  const t = trackSampleAt(track, car.position).t;
  if (car.lastCheckpoint < 0 && car.lap === 0) return t > 0.5 ? t - 1 : t;
  const base = car.lastCheckpoint / count;
  // Position within the current checkpoint segment, wrapped into [0, 1).
  let frac = t - base;
  frac -= Math.floor(frac);
  const seg = 1 / count;
  // The nearest sample can land just outside the segment (noise, shortcuts):
  // far behind -> start of the segment, slightly ahead -> end of it.
  if (frac > seg) frac = frac > 0.5 ? 0 : seg;
  return car.lap + base + frac;
}

/** 1-based race positions. Finished cars rank by finishing place, ahead of the rest. */
export function rankCars(world: SimWorld, track: Track): Map<string, number> {
  const entries = [...world.cars.values()].map((c) => ({
    id: c.playerId,
    finished: c.phase === 'finished',
    place: c.place,
    progress: c.phase === 'finished' ? Infinity : raceProgress(track, c),
  }));
  entries.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return a.place - b.place;
    return b.progress - a.progress || (a.id < b.id ? -1 : 1);
  });
  return new Map(entries.map((e, i) => [e.id, i + 1]));
}

// --- rolling -------------------------------------------------------------------

export function rankZone(rank: number, total: number): RankZone {
  if (total <= 1) return 'front';
  const f = (rank - 1) / (total - 1);
  return f <= 0.25 ? 'front' : f >= 0.75 ? 'back' : 'mid';
}

/** Pick an item for a car at `rank` of `total`, weighted by position. */
export function rollItem(rank: number, total: number, rng: () => number): ItemType {
  const table = ITEM_WEIGHTS[rankZone(rank, total)];
  const entries = Object.entries(table) as [ItemType, number][];
  const sum = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * sum;
  for (const [item, w] of entries) {
    if (w <= 0) continue;
    if (r < w) return item;
    r -= w;
  }
  return 'boost';
}

// --- effects -------------------------------------------------------------------

export function hasEffect(car: SimCar, type: EffectType): boolean {
  return car.effects.some((e) => e.type === type);
}

/** Count effects down and drop expired ones. */
export function tickEffects(car: SimCar, dt: number): void {
  if (car.effects.length === 0) return;
  for (const e of car.effects) e.remaining -= dt;
  car.effects = car.effects.filter((e) => e.remaining > 0);
}

/**
 * Can an item or hazard affect this car right now? Not while it is being
 * recovered or has finished, not during the post-recovery lockout (so it can't
 * be hit the instant it lands), and not mid-spin (no chain spin-outs).
 */
export function isVulnerable(car: SimCar): boolean {
  return car.phase === 'racing' && car.lockoutTimer <= 0 && !hasEffect(car, 'spin');
}

/**
 * Apply (or refresh) an effect. Returns true if the car was newly affected.
 * A spin-out also knocks most of the speed off.
 */
export function giveEffect(car: SimCar, type: EffectType): boolean {
  if (!isVulnerable(car)) return false;
  const existing = car.effects.find((e) => e.type === type);
  if (existing) {
    existing.remaining = Math.max(existing.remaining, EFFECT_SECONDS[type]);
    return false;
  }
  car.effects.push({ type, remaining: EFFECT_SECONDS[type] });
  if (type === 'spin') car.speed *= SPIN_SPEED_KEEP;
  return true;
}

// --- using items ---------------------------------------------------------------

function pushEvent(world: SimWorld, e: GameEvent): void {
  world.events?.push(e);
}

function spawnHazard(
  world: SimWorld,
  type: HazardType,
  owner: string,
  x: number,
  z: number,
  vx: number,
  vz: number,
): void {
  const spec = HAZARDS[type];
  const id = world.nextHazardId ?? 1;
  world.nextHazardId = id + 1;
  world.hazards?.push({ id, type, owner, x, z, vx, vz, radius: spec.radius, age: 0, ttl: spec.ttl });
}

/** Use the held (non-boost) item. Server only. Consumes the item. */
export function useAuthoritativeItem(car: SimCar, world: SimWorld, track: Track): void {
  const item = car.heldItem;
  if (!item || item === 'boost') return;
  car.heldItem = null;
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const { x, z } = car.position;
  pushEvent(world, { kind: 'use', item, by: car.playerId, x, z });

  switch (item) {
    case 'oil':
    case 'tape':
      // Dropped behind the car, so it hits whoever is following.
      spawnHazard(world, item, car.playerId, x - fx * 2.4, z - fz * 2.4, 0, 0);
      break;
    case 'marble':
      spawnHazard(world, 'marble', car.playerId, x + fx * 1.8, z + fz * 1.8, fx * MARBLE_SPEED, fz * MARBLE_SPEED);
      break;
    case 'shock':
      for (const other of world.cars.values()) {
        if (other === car) continue;
        if (Math.hypot(other.position.x - x, other.position.z - z) > SHOCK_RADIUS) continue;
        if (giveEffect(other, 'scramble')) {
          pushEvent(world, { kind: 'hit', cause: 'shock', target: other.playerId, x: other.position.x, z: other.position.z });
        }
      }
      break;
    case 'dust': {
      // Everyone behind you loses their view for a moment.
      const ranks = rankCars(world, track);
      const mine = ranks.get(car.playerId) ?? 1;
      for (const other of world.cars.values()) {
        if (other === car || (ranks.get(other.playerId) ?? 0) <= mine) continue;
        giveEffect(other, 'dust');
      }
      break;
    }
  }
}

// --- hazards -------------------------------------------------------------------

/**
 * Advance every hazard and apply it to cars it touches. Server only. Oil and
 * tape stay put and refresh their effect while a car is on them; a marble rolls
 * in a straight line and is used up by the first car it spins out.
 */
export function stepHazards(
  world: SimWorld,
  dt: number,
  onTrack: (pos: { x: number; y: number; z: number }) => boolean,
): void {
  const hazards = world.hazards;
  if (!hazards || hazards.length === 0) return;
  const alive: typeof hazards = [];

  for (const h of hazards) {
    h.age += dt;
    h.ttl -= dt;
    h.x += h.vx * dt;
    h.z += h.vz * dt;
    if (h.ttl <= 0) continue;
    // A marble that leaves the road is gone.
    if (h.type === 'marble' && !onTrack({ x: h.x, y: 0, z: h.z })) continue;

    let consumed = false;
    for (const car of world.cars.values()) {
      if (car.playerId === h.owner && h.age < HAZARD_OWNER_GRACE) continue;
      const reach = h.radius + CAR_COLLISION_RADIUS;
      if (Math.hypot(car.position.x - h.x, car.position.z - h.z) > reach) continue;
      const effect: EffectType = h.type === 'oil' ? 'slick' : h.type === 'tape' ? 'tape' : 'spin';
      const applied = giveEffect(car, effect);
      if (applied) {
        pushEvent(world, { kind: 'hit', cause: h.type, target: car.playerId, x: car.position.x, z: car.position.z });
      }
      // A marble is used up by the car it spins out; it rolls through cars that
      // are immune (recovering, mid-spin, just re-dropped).
      if (h.type === 'marble' && applied) {
        consumed = true;
        break;
      }
    }
    if (!consumed) alive.push(h);
  }
  world.hazards = alive;
}

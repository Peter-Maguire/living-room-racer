// Power-up behaviour, through the real shared sim.
import {
  TRACKS, stepWorld, createSimCar, FIXED_DT, rollItem, rankCars, rankZone,
  ITEM_WEIGHTS, EFFECT_SECONDS, SHOCK_RADIUS, HAZARDS, hasEffect,
} from '../dist/index.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

/** Small seeded RNG so every run is identical. */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- weighted rolls -----------------------------------------------------------
{
  const rng = mulberry32(1234);
  const counts = { front: {}, mid: {}, back: {} };
  const N = 30000;
  for (const [rank, zone] of [[1, 'front'], [4, 'mid'], [8, 'back']]) {
    check(rankZone(rank, 8) === zone, `rank ${rank}/8 is the ${zone} zone`);
    for (let i = 0; i < N; i++) {
      const item = rollItem(rank, 8, rng);
      counts[zone][item] = (counts[zone][item] ?? 0) + 1;
    }
  }
  check(!counts.front.marble, 'the leader never gets a marble');
  check(!counts.back.oil && !counts.back.tape && !counts.back.dust, 'last place never gets oil, tape or dust');
  let worst = 0;
  for (const zone of Object.keys(counts)) {
    const sum = Object.values(ITEM_WEIGHTS[zone]).reduce((a, b) => a + b, 0);
    for (const [item, w] of Object.entries(ITEM_WEIGHTS[zone])) {
      worst = Math.max(worst, Math.abs((counts[zone][item] ?? 0) / N - w / sum));
    }
  }
  check(worst < 0.012, `observed odds match the weight table (worst error ${(worst * 100).toFixed(2)} points)`);
  check(rankZone(1, 1) === 'front', 'a lone racer is in the front zone');
}

// --- scenario helpers ---------------------------------------------------------
const track = TRACKS['breakfast-bar-circuit']; // a straight start section: samples 0..6 run along +x
function carAt(id, idx, extra = {}) {
  const p = track.recoverySpline[idx];
  const car = createSimCar(id, { position: p.position, rotation: p.rotation }, 'racing');
  car.lastCheckpoint = 0;
  return Object.assign(car, extra);
}
function makeWorld(cars, { authority = true, seed = 7, forceItem } = {}) {
  const w = { tick: 0, cars: new Map(cars.map((c) => [c.playerId, c])), pickupCooldownUntil: new Map() };
  if (authority) Object.assign(w, { authority: { rng: mulberry32(seed), forceItem }, hazards: [], events: [], nextHazardId: 1 });
  return w;
}
function run(world, seconds, inputs = {}) {
  const ticks = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < ticks; i++) {
    const map = new Map();
    for (const [id, f] of Object.entries(inputs)) map.set(id, { seq: world.tick, throttle: 0, steer: 0, brake: 0, drift: false, useItem: false, ...(typeof f === 'function' ? f(world, i) : f) });
    stepWorld(world, map, track, FIXED_DT);
  }
}
const use = { useItem: true };

// --- clients never decide items ------------------------------------------------
{
  const pad = track.pickups[0];
  const c = createSimCar('me', { position: { x: pad.x, y: 0, z: pad.z }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, 'racing');
  const w = makeWorld([c], { authority: false });
  run(w, 0.3, { me: {} });
  check(c.heldItem === null, 'prediction (no authority) never grants an item from a pad');

  const d = carAt('me', 2, { heldItem: 'oil' });
  const w2 = makeWorld([d], { authority: false });
  run(w2, 0.3, { me: use });
  check(d.heldItem === 'oil' && !w2.hazards, 'prediction never consumes or spawns a non-boost item');

  const e = createSimCar('me', { position: { x: pad.x, y: 0, z: pad.z }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, 'racing');
  const w3 = makeWorld([e], { seed: 3 });
  run(w3, 0.2, { me: {} });
  check(e.heldItem !== null && w3.pickupCooldownUntil.size === 1, `the server grants a rolled item and starts the pad cooldown (got ${e.heldItem})`);

  const f = createSimCar('me', { position: { x: pad.x, y: 0, z: pad.z }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, 'racing');
  const w4 = makeWorld([f], { forceItem: 'marble' });
  run(w4, 0.2, { me: {} });
  check(f.heldItem === 'marble', 'FORCE_ITEM overrides the roll (for testing)');
}

// --- race order -------------------------------------------------------------------
{
  const a = carAt('a', 5), b = carAt('b', 3), c = carAt('c', 1);
  const ranks = rankCars(makeWorld([c, a, b]), track);
  check(ranks.get('a') === 1 && ranks.get('b') === 2 && ranks.get('c') === 3, 'ranks follow distance along the track, finer than checkpoints');
  const x = carAt('x', 1, { lap: 1 }), y = carAt('y', 5);
  const r2 = rankCars(makeWorld([x, y]), track);
  check(r2.get('x') === 1, 'a car a lap up outranks one further along the current lap');
  const done = carAt('d', 0, { phase: 'finished', place: 1 });
  const r3 = rankCars(makeWorld([carAt('p', 5), done]), track);
  check(r3.get('d') === 1, 'finished cars rank ahead by finishing place');
}

// --- effects in the sim ---------------------------------------------------------------
function turnAfter(effect, seconds = 0.5, steer = 1) {
  const car = carAt('t', 2, { speed: 10 });
  if (effect) car.effects.push({ type: effect, remaining: 99 });
  const w = makeWorld([car], { authority: false });
  const h0 = car.heading;
  run(w, seconds, { t: { throttle: 1, steer } });
  return { dh: car.heading - h0, speed: car.speed, car };
}
{
  const base = turnAfter(null), scr = turnAfter('scramble'), slick = turnAfter('slick');
  check(base.dh !== 0 && Math.sign(scr.dh) === -Math.sign(base.dh), 'scramble inverts steering');
  check(Math.abs(slick.dh) < Math.abs(base.dh) * 0.6, `slick cuts steering authority (${(Math.abs(slick.dh) / Math.abs(base.dh) * 100).toFixed(0)}% of normal)`);
  const taped = turnAfter('tape', 2, 0);
  check(taped.speed < 18 * 0.4, `tape caps top speed (${taped.speed.toFixed(1)} m/s)`);
  const dusty = turnAfter('dust'), none = turnAfter(null);
  check(dusty.dh === none.dh && dusty.speed === none.speed, 'dust has no effect on the physics (screen only)');

  // Spin: input ignored, one full revolution, speed knocked down.
  const car = carAt('s', 2, { speed: 14 });
  const w = makeWorld([car], { authority: false });
  const h0 = car.heading;
  car.effects.push({ type: 'spin', remaining: EFFECT_SECONDS.spin });
  run(w, 0.5, { s: { throttle: 1, steer: 1 } });
  const half = Math.abs(car.heading - h0);
  run(w, 0.8, { s: { throttle: 1, steer: 1 } });
  check(half > 2 && Math.abs(Math.abs(car.heading - h0) - 2 * Math.PI) < 0.6 && !hasEffect(car, 'spin'), 'spin turns the car about one revolution then ends');
}

// --- oil ----------------------------------------------------------------------------------
function oilScenario(seed) {
  const a = carAt('a', 4, { heldItem: 'oil' });
  const b = carAt('b', 1);
  const w = makeWorld([a, b], { seed });
  run(w, 0.05, { a: use, b: { throttle: 1 } });
  return { a, b, w };
}
{
  const { a, b, w } = oilScenario(1);
  check(a.heldItem === null && w.hazards.length === 1 && w.hazards[0].type === 'oil', 'using oil drops a hazard and consumes the item');
  check(w.hazards[0].x < a.position.x, 'oil is dropped behind the car');
  check(!hasEffect(a, 'slick'), "the dropper isn't slicked inside the grace period");
  run(w, 0.7, { b: { throttle: 1 } });
  check(hasEffect(b, 'slick'), 'a car driving into the oil is slicked');
  check(w.events.some((e) => e.kind === 'hit' && e.cause === 'oil' && e.target === 'b'), 'the hit raises an event');
  const cp = b.lastCheckpoint, lap = b.lap;
  run(w, 1, { b: { throttle: 1 } });
  check(b.lastCheckpoint >= cp && b.lap >= lap, 'being hit never costs checkpoint or lap progress');
  run(w, HAZARDS.oil.ttl + 1, {});
  check(w.hazards.length === 0, 'oil disappears after its lifetime');
}

// --- sticky tape ------------------------------------------------------------------------------
{
  const a = carAt('a', 4, { heldItem: 'tape' }), b = carAt('b', 1);
  const w = makeWorld([a, b]);
  run(w, 0.05, { a: use, b: { throttle: 1 } });
  run(w, 0.8, { b: { throttle: 1 } });
  check(hasEffect(b, 'tape'), 'driving over tape sticks the car');
}

// --- marble ---------------------------------------------------------------------------------------
{
  const a = carAt('a', 1, { heldItem: 'marble' }), b = carAt('b', 5, { speed: 0 });
  const w = makeWorld([a, b]);
  run(w, 0.05, { a: use });
  check(w.hazards.length === 1 && w.hazards[0].type === 'marble', 'a marble is launched');
  run(w, 0.6, {});
  check(hasEffect(b, 'spin') && w.hazards.length === 0, 'the marble spins out the car it hits and is used up');
  check(!hasEffect(a, 'spin'), "the thrower isn't hit by their own marble");

  // Immune cars (just re-dropped) are rolled through; the next car is hit.
  const a2 = carAt('a', 1, { heldItem: 'marble' }), b2 = carAt('b', 3, { lockoutTimer: 1 }), c2 = carAt('c', 6);
  const w2 = makeWorld([a2, b2, c2]);
  run(w2, 0.05, { a: use });
  run(w2, 0.6, { b: {}, c: {} });
  check(!hasEffect(b2, 'spin') && hasEffect(c2, 'spin'), 'a marble passes through a car in its post-recovery lockout and hits the next');

  // Leaving the road removes it.
  const a3 = carAt('a', 1, { heldItem: 'marble' });
  a3.heading += Math.PI / 2;
  const w3 = makeWorld([a3]);
  run(w3, 0.05, { a: use });
  run(w3, 1.2, { a: {} });
  check(w3.hazards.length === 0, 'a marble that leaves the road is removed');
}

// --- static shock ------------------------------------------------------------------------------------
{
  const a = carAt('a', 3, { heldItem: 'shock' }), near = carAt('n', 1), far = carAt('f', 14);
  const w = makeWorld([a, near, far]);
  const d = Math.hypot(near.position.x - a.position.x, near.position.z - a.position.z);
  const dFar = Math.hypot(far.position.x - a.position.x, far.position.z - a.position.z);
  run(w, 0.05, { a: use });
  check(d < SHOCK_RADIUS && dFar > SHOCK_RADIUS, `(setup: nearby car ${d.toFixed(0)} m, distant car ${dFar.toFixed(0)} m, radius ${SHOCK_RADIUS} m)`);
  check(hasEffect(near, 'scramble') && !hasEffect(far, 'scramble') && !hasEffect(a, 'scramble'), 'shock scrambles nearby rivals only, not the user or distant cars');
}

// --- dust cloud ----------------------------------------------------------------------------------------
{
  const a = carAt('a', 4, { heldItem: 'dust' }), behind = carAt('b', 1), ahead = carAt('c', 6);
  const w = makeWorld([a, behind, ahead]);
  run(w, 0.05, { a: use });
  check(hasEffect(behind, 'dust') && !hasEffect(ahead, 'dust') && !hasEffect(a, 'dust'), 'dust hits only the cars behind the user');
}

// --- immunity ----------------------------------------------------------------------------------------------
{
  const a = carAt('a', 4, { heldItem: 'shock' });
  const fresh = carAt('n', 2, { lockoutTimer: 0.5 });
  const dead = carAt('r', 3, { phase: 'recovering', recoveryTimer: 1 });
  const done = carAt('f', 1, { phase: 'finished', place: 1 });
  const w = makeWorld([a, fresh, dead, done]);
  run(w, 0.05, { a: use });
  check(![fresh, dead, done].some((c) => hasEffect(c, 'scramble')), 'cars in post-recovery lockout, being recovered, or finished are immune');
}

// --- determinism & serialisation ------------------------------------------------------------------------------
{
  const s1 = JSON.stringify(oilScenario(5).w.hazards) + JSON.stringify(oilScenario(5).b);
  const s2 = JSON.stringify(oilScenario(5).w.hazards) + JSON.stringify(oilScenario(5).b);
  check(s1 === s2, 'same seed and inputs give identical results');
  const { w } = oilScenario(2);
  run(w, 0.5, {});
  check(!/Infinity|NaN|null/.test(JSON.stringify(w.hazards.map((h) => ({ x: h.x, z: h.z, vx: h.vx, vz: h.vz })))), 'hazard state serialises cleanly');
}

if (failures) process.exit(1);

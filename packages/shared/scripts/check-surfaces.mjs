// Surface physics invariants, run through the real shared step.
import { buildTrack, stepWorld, FIXED_DT, CAR_MAX_SPEED } from '../dist/index.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// A long straight-ish oval lets a car carry speed on one uniform surface.
const pts = [[0, 30], [30, 30], [60, 30], [70, 20], [70, -20], [60, -30], [30, -30], [0, -30], [-30, -30], [-60, -30], [-70, -20], [-70, 20], [-60, 30], [-30, 30]];
const trackFor = (surface) => buildTrack({ id: `t-${surface}`, name: surface, points: pts, halfWidth: 12, checkpointCount: 8, pickups: [], defaultSurface: surface });

/** Accelerate to cruise, then hold full steer; report sideways slip and speed. */
function run(surface) {
  const track = trackFor(surface);
  const sp = track.spawnGrid[0];
  const heading = 2 * Math.atan2(sp.rotation.y, sp.rotation.w);
  const car = { playerId: 'c', phase: 'racing', position: { ...sp.position }, heading, velocity: { x: 0, y: 0, z: 0 }, speed: 0, lastCheckpoint: -1, lap: 0, place: 0, offTrackTicks: 0, recoveryTimer: 0, lockoutTimer: 0, heldItem: null, boostTimer: 0, effects: [] };
  const world = { tick: 0, cars: new Map([['c', car]]), pickupCooldownUntil: new Map() };
  const step = (steer) => stepWorld(world, new Map([['c', { seq: world.tick, throttle: 1, steer, brake: 0, drift: false, useItem: false }]]), track, FIXED_DT);
  for (let i = 0; i < 40; i++) step(0);
  const cruise = car.speed;
  const lateral = () => car.velocity.x * Math.cos(car.heading) - car.velocity.z * Math.sin(car.heading);
  let maxSlip = 0;
  for (let i = 0; i < 12; i++) {
    step(1);
    maxSlip = Math.max(maxSlip, Math.abs(lateral()));
  }
  // Release the wheel: how long until the car stops sliding sideways?
  let settle = 0;
  while (Math.abs(lateral()) > 0.3 && settle < 300) { step(0); settle++; }
  return { cruise, maxSlip, settle, sim: JSON.stringify(car) };
}

const r = Object.fromEntries(['floor', 'rug', 'tile', 'milk'].map((s) => [s, run(s)]));
for (const [s, v] of Object.entries(r)) console.log(`     ${s}: cruise ${v.cruise.toFixed(1)} m/s, max sideways slip ${v.maxSlip.toFixed(2)} m/s, slide lasts ${v.settle} ticks after release`);

check(r.floor.maxSlip < 1e-9, 'floor never slides');
check(r.rug.maxSlip < 1e-9, 'rug never slides');
check(r.tile.maxSlip > 0.5, 'tile slides in a hard turn');
check(r.milk.settle > r.tile.settle, 'milk slide lasts longer than tile');
check(r.tile.settle > 0 && r.floor.settle === 0, 'floor recovers instantly, tile does not');
check(r.rug.cruise < r.floor.cruise, 'rug caps top speed below floor');
check(Math.abs(r.floor.cruise - CAR_MAX_SPEED) < 0.01, 'floor reaches the standard top speed');
check(run('milk').sim === r.milk.sim, 'simulation is deterministic');

if (failures) process.exit(1);

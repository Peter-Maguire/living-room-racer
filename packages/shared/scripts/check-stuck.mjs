// "Stuck loop" check: park a stationary car at points around every track and
// leave it alone. It may be recovered once (e.g. it was left on a steep wall),
// but it must then come to rest on the road and stay there: never a recovery
// loop.
import { TRACKS, stepWorld, FIXED_DT, headingFromQuatY } from '../dist/index.js';

let failures = 0;
const SECONDS = 10;

for (const track of Object.values(TRACKS)) {
  const sp = track.recoverySpline;
  let worst = 0, worstAt = -1, stuck = 0, tested = 0;
  const hw = track.trackHalfWidth;
  // Centerline, both road edges, and just outside the road on either side.
  const offsets = [0, -0.85 * hw, 0.85 * hw, 1.4 * hw, -1.4 * hw];
  for (let i = 0; i < sp.length * offsets.length; i++) {
    const p = sp[i % sp.length];
    const h0 = headingFromQuatY(p.rotation);
    const off = offsets[Math.floor(i / sp.length)];
    const car = {
      playerId: 'c', phase: 'racing',
      position: { x: p.position.x - Math.cos(h0) * off, y: p.position.y, z: p.position.z + Math.sin(h0) * off }, heading: h0,
      velocity: { x: 0, y: 0, z: 0 }, speed: 0,
      lastCheckpoint: p.checkpointIndex, lap: 0, place: 0,
      offTrackTicks: 0, recoveryTimer: 0, lockoutTimer: 0, heldItem: null, boostTimer: 0,
    };
    const world = { tick: 0, cars: new Map([['c', car]]), pickupCooldownUntil: new Map() };
    let recoveries = 0, prev = 'racing';
    for (let t = 0; t < SECONDS / FIXED_DT; t++) {
      stepWorld(world, new Map(), track, FIXED_DT);
      if (car.phase === 'recovering' && prev !== 'recovering') recoveries++;
      prev = car.phase;
    }
    tested++;
    if (recoveries > worst) { worst = recoveries; worstAt = i % sp.length; }
    if (recoveries > 1 || car.phase !== 'racing') stuck++;
  }
  const ok = stuck === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${track.name}: ${tested} parked positions (centre, edges, off-road), worst ${worst} recoveries in ${SECONDS}s${ok ? '' : ` (${stuck} stuck; e.g. sample ${worstAt}, t=${sp[worstAt].t.toFixed(2)}, bank ${(sp[worstAt].bank * 180 / Math.PI).toFixed(0)}°)`}`);
}
if (failures) process.exit(1);

// --- and it can always get going again ---------------------------------------
// From every parked position, a driver who then floors it (following the road)
// must make real progress and not be recovered more than once more. The driver
// holds a moderate speed (above the wall minimum, below what slick tiles allow).
const CRUISE = 11;
console.log('');
let failures2 = 0;
for (const track of Object.values(TRACKS)) {
  const sp = track.recoverySpline;
  const line = sp.map((s) => s.position);
  const n = line.length;
  let bad = 0, worstRec = 0, badAt = -1;
  for (let i = 0; i < n; i++) {
    const p = sp[i];
    const car = {
      playerId: 'c', phase: 'racing',
      position: { ...p.position }, heading: headingFromQuatY(p.rotation),
      velocity: { x: 0, y: 0, z: 0 }, speed: 0,
      lastCheckpoint: p.checkpointIndex, lap: 0, place: 0,
      offTrackTicks: 0, recoveryTimer: 0, lockoutTimer: 0, heldItem: null, boostTimer: 0,
    };
    const world = { tick: 0, cars: new Map([['c', car]]), pickupCooldownUntil: new Map() };
    let idx = i, recoveries = 0, prev = 'racing';
    const start = { cp: car.lastCheckpoint, lap: 0 };
    for (let t = 0; t < 25 / FIXED_DT; t++) {
      let best = Infinity, bi = idx;
      for (let k = -4; k <= 4; k++) { const j = (idx + k + n) % n; const d = Math.hypot(line[j].x - car.position.x, line[j].z - car.position.z); if (d < best) { best = d; bi = j; } }
      if (best > 10) line.forEach((q, j) => { const d = Math.hypot(q.x - car.position.x, q.z - car.position.z); if (d < best) { best = d; bi = j; } });
      idx = bi;
      const tg = line[(idx + 3) % n];
      let e = Math.atan2(tg.x - car.position.x, tg.z - car.position.z) - car.heading;
      e = Math.atan2(Math.sin(e), Math.cos(e));
      stepWorld(world, new Map([['c', { seq: t, steer: Math.max(-1, Math.min(1, -e * 2.2)), throttle: car.speed < CRUISE ? 1 : 0, brake: car.speed > CRUISE + 0.5 ? 1 : 0, drift: false, useItem: false }]]), track, FIXED_DT);
      if (car.phase === 'recovering' && prev !== 'recovering') recoveries++;
      prev = car.phase;
    }
    const progressed = car.lap > start.lap || car.lastCheckpoint !== start.cp || car.phase === 'finished';
    worstRec = Math.max(worstRec, recoveries);
    if (!progressed || recoveries > 1) { bad++; badAt = i; }
  }
  const ok = bad === 0;
  if (!ok) failures2++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${track.name}: restarts from ${n} parked positions, worst ${worstRec} recoveries${ok ? '' : ` (${bad} failed; e.g. sample ${badAt}, t=${sp[badAt].t.toFixed(2)})`}`);
}
if (failures2) process.exit(1);

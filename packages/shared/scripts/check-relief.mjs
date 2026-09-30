// Relief invariants: height/bank data is sane, banks lean into their turns, and
// steep walls really do drop slow cars while letting fast ones through.
import { TRACKS, stepWorld, FIXED_DT, headingFromQuatY, trackSampleAt, roadTilt } from '../dist/index.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

// --- data sanity, every track -------------------------------------------------
for (const track of Object.values(TRACKS)) {
  const sp = track.recoverySpline;
  const n = sp.length;
  let maxBank = 0, maxStep = 0, minY = Infinity, walls = 0;
  for (let i = 0; i < n; i++) {
    maxBank = Math.max(maxBank, Math.abs(sp[i].bank));
    maxStep = Math.max(maxStep, Math.abs(sp[(i + 1) % n].position.y - sp[i].position.y));
    minY = Math.min(minY, sp[i].position.y);
    if (sp[i].minSpeed > 0) walls++;
  }
  if (maxBank === 0 && maxStep === 0) continue; // flat track: nothing to check
  console.log(`${track.name}: max bank ${(maxBank * 180 / Math.PI).toFixed(0)}°, max height step ${maxStep.toFixed(2)} m/sample, ${walls} wall samples`);
  check(maxBank < (72 * Math.PI) / 180, `${track.id}: bank under 72°`);
  check(maxStep < 2.4, `${track.id}: no height jumps (${maxStep.toFixed(2)} m between samples)`);
  check(minY > -0.001, `${track.id}: road never dips under the floor at its centreline`);

  // Banks must lean into the turn: the raised edge is the outside of the curve.
  let wrong = 0, banked = 0;
  for (let i = 0; i < n; i++) {
    const b = sp[i].bank;
    if (Math.abs(b) < 0.05) continue;
    banked++;
    const h = (k) => headingFromQuatY(sp[(k + n) % n].rotation);
    let dh = h(i + 1) - h(i - 1);
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    if (Math.abs(dh) > 0.08 && Math.sign(dh) !== Math.sign(b)) wrong++;
  }
  check(wrong === 0, `${track.id}: ${banked} banked samples all lean into the turn${wrong ? ` (${wrong} wrong)` : ''}`);

  // The car's height must follow the road surface across its width.
  const mid = sp.findIndex((p) => Math.abs(p.bank) > 0.3) ;
  if (mid >= 0) {
    const p = sp[mid].position;
    const nx = -Math.cos(headingFromQuatY(sp[mid].rotation)), nz = Math.sin(headingFromQuatY(sp[mid].rotation));
    const lo = trackSampleAt(track, { x: p.x - nx * 2, z: p.z - nz * 2 }).y;
    const hi = trackSampleAt(track, { x: p.x + nx * 2, z: p.z + nz * 2 }).y;
    check(Math.abs(hi - lo) > 1, `${track.id}: road surface is visibly tilted across its width (${(hi - lo).toFixed(1)} m over 4 m)`);
  }
}

// --- the wall bites ----------------------------------------------------------
const laundry = TRACKS['laundry-basket-loop'];
function driveAt(track, targetSpeed) {
  const spawn = track.spawnGrid[0];
  const car = { playerId: 'c', phase: 'racing', position: { ...spawn.position }, heading: headingFromQuatY(spawn.rotation), velocity: { x: 0, y: 0, z: 0 }, speed: 0, lastCheckpoint: -1, lap: 0, place: 0, offTrackTicks: 0, recoveryTimer: 0, lockoutTimer: 0, heldItem: null, boostTimer: 0, effects: [] };
  const world = { tick: 0, cars: new Map([['c', car]]), pickupCooldownUntil: new Map() };
  const line = track.recoverySpline.map((s) => s.position);
  const n = line.length;
  let idx = 0, recoveries = 0, prev = 'racing', maxY = 0;
  for (let tick = 0; tick < 30 * 40 && car.lap < 1; tick++) {
    let best = Infinity, bi = idx;
    for (let k = -4; k <= 4; k++) { const i = (idx + k + n) % n; const d = Math.hypot(line[i].x - car.position.x, line[i].z - car.position.z); if (d < best) { best = d; bi = i; } }
    if (best > 10) line.forEach((p, i) => { const d = Math.hypot(p.x - car.position.x, p.z - car.position.z); if (d < best) { best = d; bi = i; } });
    idx = bi;
    const t = line[(idx + 3) % n];
    let e = Math.atan2(t.x - car.position.x, t.z - car.position.z) - car.heading;
    e = Math.atan2(Math.sin(e), Math.cos(e));
    // Hold a constant speed (throttle up to it, brake above it).
    const over = car.speed - targetSpeed;
    const input = { seq: tick, steer: Math.max(-1, Math.min(1, -e * 2.2)), throttle: over < 0 ? 1 : 0, brake: over > 0.3 ? 1 : 0, drift: false, useItem: false };
    stepWorld(world, new Map([['c', input]]), track, FIXED_DT);
    maxY = Math.max(maxY, car.position.y);
    if (car.phase === 'recovering' && prev !== 'recovering') recoveries++;
    prev = car.phase;
  }
  return { recoveries, maxY, lap: car.lap };
}
const slow = driveAt(laundry, 6);
const fast = driveAt(laundry, 14);
console.log(`     slow (6 m/s): ${slow.recoveries} recoveries; fast (14 m/s): ${fast.recoveries} recoveries, climbs to y=${fast.maxY.toFixed(1)} m`);
check(slow.recoveries >= 1, 'a slow car slides off the wall');
check(fast.recoveries === 0 && fast.lap >= 1, 'a fast car holds the wall and completes the lap');
check(fast.maxY > 4, 'the car actually climbs the wall');

// --- tilt helper --------------------------------------------------------------
const wallT = laundry.recoverySpline.find((p) => Math.abs(p.bank) > 0.9);
const tilt = roadTilt(laundry, wallT.position, headingFromQuatY(wallT.rotation));
check(Math.abs(tilt.roll) > 0.7, `cars roll to lie on the wall (${(tilt.roll * 180 / Math.PI).toFixed(0)}°)`);

if (failures) process.exit(1);

// --- car tilt matches the road surface ---------------------------------------
// Independent of roadTilt's internals: take the road normal from finite
// differences of trackSampleAt().y, and the car's up vector from the renderer's
// rotation (three.js Euler 'YXZ' with x=-pitch, y=yaw, z=roll), and compare.
function carUp(pitch, yaw, roll) {
  const ax = -pitch, az = roll;
  // Rz(az) applied to (0,1,0), then Rx(ax), then Ry(yaw).
  let [x, y, z] = [-Math.sin(az), Math.cos(az), 0];
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  [x, z] = [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
  return [x, y, z];
}
for (const id of ['laundry-basket-loop', 'sofa-cushion-canyon']) {
  const track = TRACKS[id];
  let worst = 0, tested = 0;
  for (const p of track.recoverySpline) {
    if (Math.abs(p.bank) < 0.1 && Math.abs(p.position.y) < 0.3) continue;
    for (const yawOff of [0, 0.5, -0.7]) {
      const yaw = headingFromQuatY(p.rotation) + yawOff;
      const pos = p.position;
      const { pitch, roll } = roadTilt(track, pos, yaw);
      const up = carUp(pitch, yaw, roll);
      const e = 0.05;
      const gx = (trackSampleAt(track, { x: pos.x + e, z: pos.z }).y - trackSampleAt(track, { x: pos.x - e, z: pos.z }).y) / (2 * e);
      const gz = (trackSampleAt(track, { x: pos.x, z: pos.z + e }).y - trackSampleAt(track, { x: pos.x, z: pos.z - e }).y) / (2 * e);
      const len = Math.hypot(gx, 1, gz);
      const n = [-gx / len, 1 / len, -gz / len];
      const dot = up[0] * n[0] + up[1] * n[1] + up[2] * n[2];
      worst = Math.max(worst, Math.acos(Math.min(1, dot)));
      tested++;
    }
  }
  check(worst < 0.12, `${id}: car up-vector follows the road normal in ${tested} poses (worst error ${(worst * 180 / Math.PI).toFixed(1)}°)`);
}
if (failures) process.exit(1);

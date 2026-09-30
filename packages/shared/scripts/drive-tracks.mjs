// Headless drivability check: a pure-pursuit autopilot drives each track
// through the real shared sim and must finish the race with few recoveries.
import { TRACKS, stepWorld, FIXED_DT, RACE_LAPS, headingFromQuatY } from '../dist/index.js';

const MAX_SECONDS = 180;
const MAX_RECOVERIES = 2;
let failures = 0;

for (const track of Object.values(TRACKS)) {
  const spawn = track.spawnGrid[0];
  const car = {
    playerId: 'bot', phase: 'racing',
    position: { ...spawn.position }, heading: headingFromQuatY(spawn.rotation),
    velocity: { x: 0, y: 0, z: 0 }, speed: 0, lastCheckpoint: -1, lap: 0, place: 0,
    offTrackTicks: 0, recoveryTimer: 0, lockoutTimer: 0, heldItem: null, boostTimer: 0,
  };
  const world = { tick: 0, cars: new Map([['bot', car]]), pickupCooldownUntil: new Map() };
  const line = track.recoverySpline.map((s) => s.position);
  const n = line.length;
  let spacing = 0;
  for (let i = 0; i < n; i++) spacing += Math.hypot(line[(i + 1) % n].x - line[i].x, line[(i + 1) % n].z - line[i].z);
  spacing /= n;

  let idx = 0, recoveries = 0, prevPhase = 'racing', finishedAt = null;
  const errTo = (k) => {
    const t = line[(idx + k) % n];
    const e = Math.atan2(t.x - car.position.x, t.z - car.position.z) - car.heading;
    return Math.atan2(Math.sin(e), Math.cos(e));
  };
  const ticks = Math.round(MAX_SECONDS / FIXED_DT);
  for (let tick = 0; tick < ticks; tick++) {
    // Track nearest sample with continuity (window), falling back to global.
    let best = Infinity, bi = idx;
    for (let k = -4; k <= 4; k++) {
      const i = (idx + k + n) % n;
      const d = Math.hypot(line[i].x - car.position.x, line[i].z - car.position.z);
      if (d < best) { best = d; bi = i; }
    }
    if (best > 10) line.forEach((p, i) => { const d = Math.hypot(p.x - car.position.x, p.z - car.position.z); if (d < best) { best = d; bi = i; } });
    idx = bi;
    const near = Math.max(2, Math.round((3 + Math.abs(car.speed) * 0.45) / spacing));
    const far = near + Math.round(8 / spacing);
    const eNear = errTo(near), eFar = errTo(far);
    const input = {
      seq: tick, steer: Math.max(-1, Math.min(1, -eNear * 2.2)),
      throttle: Math.abs(eFar) > 0.9 ? 0.25 : Math.abs(eFar) > 0.5 ? 0.6 : 1,
      brake: 0, drift: false, useItem: false,
    };
    stepWorld(world, new Map([['bot', input]]), track, FIXED_DT);
    if (car.phase === 'recovering' && prevPhase !== 'recovering') recoveries++;
    prevPhase = car.phase;
    if (car.phase === 'finished') { finishedAt = world.tick * FIXED_DT; break; }
  }
  const ok = finishedAt != null && recoveries <= MAX_RECOVERIES;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${track.name}: ${finishedAt != null ? `${RACE_LAPS} laps in ${finishedAt.toFixed(1)}s` : `not finished (lap ${car.lap}, cp ${car.lastCheckpoint})`}, ${recoveries} recoveries`);
  if (!ok) failures++;
}
if (failures) process.exit(1);

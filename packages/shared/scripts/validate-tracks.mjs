// Authoring-rule checks for every track. Run after building shared:
//   pnpm --filter @racer/shared build && pnpm --filter @racer/shared validate
import { TRACKS, MAX_PLAYERS } from '../dist/index.js';

/** Tracks that deliberately cross themselves (skip the single-level check). */
const ALLOWED_CROSSINGS = new Set(['rug-weave-eight']);

let failures = 0;
const fail = (id, msg) => { failures++; console.error(`  FAIL [${id}] ${msg}`); };

function segDist(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

for (const track of Object.values(TRACKS)) {
  const id = track.id;
  const line = track.recoverySpline.map((s) => s.position);
  const n = line.length;
  const corridor = track.trackHalfWidth;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = line[i], b = line[(i + 1) % n];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const spacing = length / n;
  console.log(`${track.name} (${id}): ${length.toFixed(0)} m, corridor ±${corridor} m, ${n} samples`);

  // Loop closure: samples are evenly spaced, so the wrap gap must match.
  const wrap = Math.hypot(line[0].x - line[n - 1].x, line[0].z - line[n - 1].z);
  if (wrap > spacing * 1.6) fail(id, `loop does not close (gap ${wrap.toFixed(1)} m)`);

  // Single level: distant parts of the loop must not share a corridor.
  if (!ALLOWED_CROSSINGS.has(id)) {
    const minArc = Math.max(20, corridor * 6);
    let worst = Infinity, at = '';
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const arc = Math.min(j - i, n - (j - i)) * spacing;
        if (arc < minArc) continue;
        const d = Math.hypot(line[i].x - line[j].x, line[i].z - line[j].z);
        if (d < worst) { worst = d; at = `${i}/${j}`; }
      }
    }
    if (worst < corridor * 2) fail(id, `corridors overlap: ${worst.toFixed(1)} m apart at samples ${at}, need >= ${corridor * 2}`);
    else console.log(`  min separation between distant sections: ${worst.toFixed(1)} m (need >= ${corridor * 2})`);
  }

  // Spawn grid: all slots on-road and not overlapping.
  if (track.spawnGrid.length < MAX_PLAYERS) fail(id, `only ${track.spawnGrid.length} spawn slots`);
  track.spawnGrid.forEach((s, i) => {
    let best = Infinity;
    for (let k = 0; k < n; k++) best = Math.min(best, segDist(s.position, line[k], line[(k + 1) % n]));
    if (best > track.trackHalfWidth - 0.5) fail(id, `spawn ${i} is ${best.toFixed(1)} m from centerline (corridor ${corridor})`);
    for (let j = 0; j < i; j++) {
      const o = track.spawnGrid[j].position;
      if (Math.hypot(s.position.x - o.x, s.position.z - o.z) < 1.8) fail(id, `spawns ${i} and ${j} overlap`);
    }
  });

  // Checkpoints: a box must not already contain the next checkpoint's centre.
  const cps = track.checkpoints;
  cps.forEach((c, i) => {
    const nx = cps[(i + 1) % cps.length];
    if (Math.abs(nx.center.x - c.center.x) <= c.halfExtents.x && Math.abs(nx.center.z - c.center.z) <= c.halfExtents.z)
      fail(id, `checkpoint ${i} overlaps checkpoint ${(i + 1) % cps.length} (skippable)`);
  });

  // Pickups sit on the road.
  track.pickups.forEach((p, i) => {
    let best = Infinity;
    for (let k = 0; k < n; k++) best = Math.min(best, segDist(p, line[k], line[(k + 1) % n]));
    if (best > 1) fail(id, `pickup ${i} is ${best.toFixed(1)} m off the centerline`);
  });
}

if (failures) { console.error(`\n${failures} problem(s).`); process.exit(1); }
console.log('\nAll tracks OK.');

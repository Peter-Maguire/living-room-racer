// End-to-end item test over the real socket protocol.
//
// For each item, starts a fresh game server with FORCE_ITEM=<item>, connects two
// bot clients (one slow and ahead, one fast and behind), races them, and checks
// that the item works end to end: rolled on the server, visible in snapshots,
// used, and landing the right effect on the right car.
//
//   pnpm --filter @racer/client e2e:items
import { spawn, execSync } from 'node:child_process';
import { startBot } from './bot.mjs';

const PORT = 3010;
const URL = `http://localhost:${PORT}`;
const RACE_SECONDS = 45;

/** What we expect to observe for each item (victim effect and/or hazard/event). */
const EXPECT = {
  oil: { effect: 'slick', hazard: 'oil', cause: 'oil' },
  tape: { effect: 'tape', hazard: 'tape', cause: 'tape' },
  // (No hazard check: at point-blank range a marble hits in the tick it is created,
  // so it never appears in a snapshot. Its flight is covered by check-items.)
  marble: { effect: 'spin', cause: 'marble' },
  shock: { effect: 'scramble', cause: 'shock' },
  dust: { effect: 'dust' },
};

function startServer(item) {
  const child = spawn('pnpm', ['--filter', '@racer/server', 'exec', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), FORCE_ITEM: item, CLIENT_ORIGIN: '*' },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 30000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('listening')) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', (d) => process.env.DEBUG_E2E && process.stderr.write(d));
  });
}

function stopServer(child) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const ONLY = process.env.ONLY;
for (const item of Object.keys(EXPECT)) {
  if (ONLY && ONLY !== item) continue;
  console.log(`\n${item}:`);
  const server = await startServer(item);
  // Similar speeds keep them together, so each gets chances to hit the other.
  const lead = startBot('Lead', 9, URL);
  const chase = startBot('Chase', 11, URL);
  const exp = EXPECT[item];
  const all = [lead, chase];
  const done = () => {
    const ef = new Set(all.flatMap((b) => [...b.seen.effects]));
    const hz = new Set(all.flatMap((b) => [...b.seen.hazards]));
    const ht = all.flatMap((b) => b.seen.hits);
    return ef.has(exp.effect) && (!exp.hazard || hz.has(exp.hazard)) && (!exp.cause || ht.some((e) => e.cause === exp.cause));
  };
  // Finish as soon as the expected thing has happened; give up after the time limit.
  for (let t = 0; t < RACE_SECONDS * 2 && !done(); t++) await new Promise((r) => setTimeout(r, 500));
  const effects = new Set(all.flatMap((b) => [...b.seen.effects]));
  const hazards = new Set(all.flatMap((b) => [...b.seen.hazards]));
  const hits = all.flatMap((b) => b.seen.hits);
  const uses = all.flatMap((b) => b.seen.uses);
  const held = new Set(all.flatMap((b) => [...b.seen.heldItems]));

  check(held.has(item), `server rolled and granted ${item} (saw held items: ${[...held].join(', ') || 'none'})`);
  check(uses.some((e) => e.item === item), `a "use ${item}" event was delivered`);
  if (exp.hazard) check(hazards.has(exp.hazard), `a ${exp.hazard} hazard appeared in snapshots`);
  check(effects.has(exp.effect), `a car received the "${exp.effect}" effect (saw: ${[...effects].join(', ') || 'none'})`);
  if (exp.cause) check(hits.some((e) => e.cause === exp.cause), `a "hit by ${exp.cause}" event was delivered`);

  if (process.env.DEBUG_E2E) {
    console.log('  uses:', JSON.stringify(uses.map((e) => ({ by: e.by.slice(0, 4), item: e.item }))));
    console.log('  hits:', JSON.stringify(hits.map((e) => ({ t: e.target.slice(0, 4), c: e.cause }))));
    console.log('  ids:', lead.socket.id?.slice(0, 4), chase.socket.id?.slice(0, 4));
  }
  lead.stop(); chase.stop();
  stopServer(server);
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll item end-to-end checks passed.');
process.exit(failures ? 1 : 0);

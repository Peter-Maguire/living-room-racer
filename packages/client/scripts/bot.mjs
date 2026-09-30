// A scripted racing opponent for testing: connects over the real socket protocol,
// readies up, follows the racing line at a set speed, and uses items by simple
// rules (drop oil/tape/dust, zap nearby rivals, fire marbles at cars ahead).
import { io } from 'socket.io-client';
import { getTrack, SocketEvents, headingFromQuatY } from '@racer/shared';

/** A bot: follows the racing line at a set speed and uses items by simple rules. */
export function startBot(name, cruise, url) {
  const socket = io(url, { transports: ['websocket'] });
  let track = null, seq = 0, idx = 0, me = null, snap = null, ready = false;
  const seen = { effects: new Set(), hazards: new Set(), hits: [], uses: [], heldItems: new Set() };

  socket.on('connect', () => socket.emit(SocketEvents.JoinMatch, { playerSessionId: `bot-${name}`, displayName: name, carSkin: 'default' }));
  socket.on(SocketEvents.LobbyState, (l) => {
    track = getTrack(l.activeTrackId);
    if (!ready) { ready = true; socket.emit(SocketEvents.PlayerReady, { ready: true }); }
  });
  socket.on(SocketEvents.Snapshot, (s) => {
    snap = s;
    me = s.cars.find((c) => c.playerId === socket.id);
    for (const h of s.hazards ?? []) seen.hazards.add(h.type);
    for (const e of s.events ?? []) { (e.kind === 'hit' ? seen.hits : seen.uses).push(e); }
    if (me) {
      for (const e of me.effects ?? []) seen.effects.add(e.type);
      if (me.heldItem) seen.heldItems.add(me.heldItem);
    }
  });

  const timer = setInterval(() => {
    if (!snap || !me || !track || snap.racePhase !== 'racing' || me.phase !== 'racing') return;
    const line = track.recoverySpline, n = line.length;
    let best = Infinity, bi = idx;
    for (let k = -4; k <= 4; k++) {
      const i = (idx + k + n) % n;
      const d = Math.hypot(line[i].position.x - me.position.x, line[i].position.z - me.position.z);
      if (d < best) { best = d; bi = i; }
    }
    if (best > 10) line.forEach((p, i) => { const d = Math.hypot(p.position.x - me.position.x, p.position.z - me.position.z); if (d < best) { best = d; bi = i; } });
    idx = bi;
    const tg = line[(idx + 3) % n].position;
    const heading = headingFromQuatY(me.rotation);
    let err = Math.atan2(tg.x - me.position.x, tg.z - me.position.z) - heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const speed = Math.hypot(me.linearVelocity.x, me.linearVelocity.z);

    // Item rules: drop/launch/zap when it will land on someone.
    let useItem = false;
    if (me.heldItem) {
      const others = snap.cars.filter((c) => c.playerId !== me.playerId && c.phase === 'racing');
      const rel = (c) => {
        const dx = c.position.x - me.position.x, dz = c.position.z - me.position.z;
        const ahead = dx * Math.sin(heading) + dz * Math.cos(heading);
        return { dist: Math.hypot(dx, dz), ahead };
      };
      switch (me.heldItem) {
        case 'oil': case 'tape': case 'boost': useItem = true; break;
        // Dust only hits cars behind you, so wait until someone is.
        case 'dust': useItem = others.some((c) => rel(c).ahead < -2); break;
        case 'shock': useItem = others.some((c) => rel(c).dist < 8); break;
        case 'marble': useItem = others.some((c) => { const r = rel(c); return r.ahead > 0.5 && r.ahead < 18 && Math.sqrt(Math.max(0, r.dist * r.dist - r.ahead * r.ahead)) < 3.5; }); break;
        default: useItem = false;
      }
    }
    if (process.env.DEBUG_E2E && seq % 30 === 0) {
      const o = snap.cars.find((c) => c.playerId !== me.playerId);
      if (o) { const dx = o.position.x - me.position.x, dz = o.position.z - me.position.z; const ahead = dx * Math.sin(heading) + dz * Math.cos(heading); console.log('   ', name, 'held', me.heldItem, 'lap', me.lap, 'other: ahead', ahead.toFixed(1), 'lateral', Math.sqrt(Math.max(0, dx * dx + dz * dz - ahead * ahead)).toFixed(1)); }
    }
    socket.emit(SocketEvents.Input, {
      seq: ++seq,
      steer: Math.max(-1, Math.min(1, -err * 2.2)),
      throttle: speed < cruise ? 1 : 0,
      brake: 0, drift: false, useItem,
    });
  }, 1000 / 30);

  return { socket, seen, stop: () => { clearInterval(timer); socket.close(); } };
}


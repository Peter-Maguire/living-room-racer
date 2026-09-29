import {
  INPUT_SEND_RATE,
  OVAL_TRACK,
  RACE_LAPS,
  headingToQuatY,
  type RaceFinished,
  type RacePhase,
  type Snapshot,
} from '@racer/shared';
import { loadClientConfig } from './config.js';
import { InputSampler } from './input.js';
import { Interpolator } from './interpolation.js';
import { resolveConnection } from './matchmaking.js';
import { NetworkClient } from './network.js';
import { Overlay } from './overlay.js';
import { Predictor } from './prediction.js';
import { Renderer, type RenderCar } from './renderer.js';

/**
 * Client entry point. Wires renderer, network, input, prediction,
 * interpolation, and the lobby/results overlays into a phase-driven loop.
 *
 *  - Lobby: overlay shown, ready-up toggles readiness; no input sent.
 *  - Countdown: overlay shows the countdown; still no input.
 *  - Racing: overlay hidden, input predicted + sent, HUD shown.
 *  - Finished: results overlay shown; "back to lobby" clears ready + rematches.
 */
function main(): void {
  const config = loadClientConfig();
  const app = document.getElementById('app');
  const hud = document.getElementById('hud');
  if (!app) throw new Error('#app container missing');

  const track = OVAL_TRACK;
  const renderer = new Renderer(app);
  renderer.buildTrack(track);
  const net = new NetworkClient();
  const input = new InputSampler();
  const interpolator = new Interpolator();
  const overlay = new Overlay(
    app,
    (ready) => net.sendReady(ready),
    () => net.sendReady(false), // "back to lobby": drop ready, server returns us
  );

  // The predictor needs our playerId (socket id), known only after connect.
  let predictor: Predictor | null = null;
  let phase: RacePhase = 'lobby';
  let lastResult: RaceFinished | null = null;

  let predictorId: string | undefined;

  net.onSnapshot((snap: Snapshot) => {
    const playerId = net.getPlayerId();
    // (Re)create the predictor whenever our socket id is known or changes
    // (e.g. after a reconnect, where socket.io assigns a new id). Without this,
    // a stale predictor keyed to an old id would never match our car and we'd
    // be stuck spectating.
    if (playerId && playerId !== predictorId) {
      predictor = new Predictor(playerId, track);
      predictorId = playerId;
    }
    predictor?.reconcile(snap);
    interpolator.push(snap);
    if (snap.racePhase !== phase) setPhase(snap.racePhase);
  });

  net.onLobby((lobby) => {
    overlay.updateLobby(lobby, net.getPlayerId());
  });

  net.onFinished((result) => {
    lastResult = result;
  });

  function setPhase(next: RacePhase): void {
    phase = next;
    if (next === 'racing') {
      overlay.showRace();
    } else if (next === 'finished') {
      if (lastResult) overlay.showResults(lastResult, net.getPlayerId());
    } else {
      // lobby or countdown: lobby overlay (countdown shown within it).
      overlay.showLobby();
    }
  }

  overlay.showLobby();

  // Resolve where to connect: local dev connects straight to the game server;
  // a deployed client runs the matchmaking flow (ticket -> poll -> connection
  // info). A stable per-browser id keys matchmaking + doubles as a display name.
  const localPlayerId = getOrCreateLocalPlayerId();
  void resolveConnection(config, localPlayerId)
    .then((conn) => {
      net.connect(conn.url, {
        playerSessionId: conn.playerSessionId,
        displayName: `Racer-${localPlayerId.slice(0, 4)}`,
        carSkin: 'default',
      });
    })
    .catch((err) => {
      console.error('[matchmaking] failed to find a match:', err);
    });

  // Input tick: only while racing. Sample, predict locally, and send.
  setInterval(() => {
    if (phase !== 'racing') return;
    const sample = input.sample();
    predictor?.predict(sample);
    net.sendInput(sample);
  }, 1000 / INPUT_SEND_RATE);

  function frame(): void {
    const now = performance.now();
    const playerId = net.getPlayerId();
    const cars: RenderCar[] = [];

    // Local car: predicted.
    const local = predictor?.getCar();
    if (local) {
      cars.push({
        playerId: local.playerId,
        position: local.position,
        rotation: headingToQuatY(local.heading),
        phase: local.phase,
        isLocal: true,
      });
    }

    // Remote cars: interpolated ~100ms in the past.
    for (const c of interpolator.sample(now, playerId)) {
      cars.push({
        playerId: c.playerId,
        position: c.position,
        rotation: c.rotation,
        phase: c.phase,
        isLocal: false,
      });
    }

    renderer.setCars(cars);
    renderer.render();

    const snap = net.getLatestSnapshot();
    if (hud) {
      hud.textContent =
        phase === 'racing' && snap ? buildHud(snap, playerId) : '';
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Compose the HUD line: lap, position, and race clock for the local car. */
function buildHud(snap: Snapshot, playerId: string | undefined): string {
  const seconds = (snap.clockMs / 1000).toFixed(1);
  const me = snap.cars.find((c) => c.playerId === playerId);
  if (!me) {
    return `${snap.racePhase} · ${snap.cars.length} cars · ${seconds}s`;
  }
  const total = snap.cars.length;
  const lap = Math.min(me.lap + 1, RACE_LAPS);
  const status =
    me.phase === 'recovering'
      ? 'RECOVERING'
      : me.phase === 'finished'
        ? `FINISHED P${me.place}`
        : `P${positionOf(snap, me.playerId)}/${total}`;
  return `Lap ${lap}/${RACE_LAPS} · ${status} · ${seconds}s`;
}

/** A stable per-browser player id, persisted in localStorage. */
function getOrCreateLocalPlayerId(): string {
  const key = 'racer.playerId';
  let id = localStorage.getItem(key);
  if (!id) {
    id = `p_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

/** Rough live position: rank by lap then last checkpoint cleared. */
function positionOf(snap: Snapshot, playerId: string): number {
  const ranked = [...snap.cars].sort(
    (a, b) => b.lap - a.lap || b.lastCheckpoint - a.lastCheckpoint,
  );
  return ranked.findIndex((c) => c.playerId === playerId) + 1;
}

main();

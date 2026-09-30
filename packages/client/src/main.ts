import {
  CAR_MAX_SPEED,
  INPUT_SEND_RATE,
  OVAL_TRACK,
  carColor,
  getTrack,
  headingToQuatY,
  randomRacerName,
  type RaceFinished,
  type RacePhase,
  type Snapshot,
} from '@racer/shared';
import { AudioEngine } from './audio.js';
import { loadClientConfig } from './config.js';
import { Hud } from './hud.js';
import { Minimap } from './minimap.js';
import { InputSampler } from './input.js';
import { Interpolator } from './interpolation.js';
import { resolveConnection } from './matchmaking.js';
import { NetworkClient } from './network.js';
import { Overlay, type PlayerMeta } from './overlay.js';
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

  // The active track can change in the lobby; it starts as the oval and is
  // reconciled to whatever the server reports via lobby state.
  let track = OVAL_TRACK;
  const renderer = new Renderer(app);
  renderer.buildTrack(track);
  const net = new NetworkClient();
  const input = new InputSampler();
  const interpolator = new Interpolator();
  const audio = new AudioEngine();
  const overlay = new Overlay(
    app,
    (ready) => {
      audio.resume(); // First user gesture: unlock audio.
      net.sendReady(ready);
    },
    () => net.sendReady(false), // "back to lobby": drop ready, server returns us
    (trackId) => net.sendSelectTrack(trackId),
    () => void beginMatchmaking(), // retry button on the matchmaking screen
  );

  const hudPanel = hud ? new Hud(hud) : null;
  const minimap = new Minimap(app);
  minimap.setTrack(track);

  /**
   * Per-player identity from lobby state: display name + server-assigned car
   * colour index. The server is the only assigner, so every client renders a
   * given player in the same colour. Snapshots deliberately don't carry colour
   * (it never changes mid-race), so this map is the render loop's colour source.
   */
  const playerMeta = new Map<string, PlayerMeta>();
  const colorHexFor = (playerId: string): number =>
    carColor(playerMeta.get(playerId)?.colorIndex ?? 0).hex;

  // Track item/boost state to fire one-shot sfx on transitions.
  let prevBoosting = false;
  let prevHeldItem: string | null = null;

  // The predictor needs our playerId (socket id), known only after connect.
  let predictor: Predictor | null = null;
  let phase: RacePhase = 'lobby';
  /** True once the first snapshot arrives, i.e. we're actually in the match. */
  let joinedMatch = false;
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
    // The first snapshot means we're in the match: leave the matchmaking screen
    // even if the phase happens to equal our initial value (setPhase only fires
    // on a *change*, so without this the overlay could stay up forever).
    if (!joinedMatch) {
      joinedMatch = true;
      setPhase(snap.racePhase);
    } else if (snap.racePhase !== phase) {
      setPhase(snap.racePhase);
    }
  });

  net.onLobby((lobby) => {
    // Refresh the colour/name map before anything renders from it. Rebuilt
    // wholesale so a player who left stops occupying their old colour locally.
    playerMeta.clear();
    for (const p of lobby.players) {
      playerMeta.set(p.playerId, {
        displayName: p.displayName,
        colorIndex: p.colorIndex,
      });
    }
    overlay.updateLobby(lobby, net.getPlayerId());
    // Rebuild the rendered track (and force the predictor to re-create with the
    // new track) when the server's active track changes.
    if (lobby.activeTrackId !== track.id) {
      track = getTrack(lobby.activeTrackId);
      renderer.buildTrack(track);
      minimap.setTrack(track);
      predictorId = undefined; // triggers predictor rebuild on next snapshot
    }
  });

  net.onFinished((result) => {
    lastResult = result;
  });

  function setPhase(next: RacePhase): void {
    phase = next;
    // The HUD is only meaningful while racing.
    hudPanel?.setVisible(next === 'racing');
    minimap.setVisible(next === 'racing');
    if (next === 'racing') {
      overlay.showRace();
    } else if (next === 'finished') {
      if (lastResult) {
        overlay.showResults(lastResult, net.getPlayerId(), playerMeta, track.id);
      } else {
        // Joined after the race ended, so we never got its results: the lobby
        // (where ready-up restarts the match) is the only useful screen.
        overlay.showLobby();
      }
    } else {
      // lobby or countdown: lobby overlay (countdown shown within it).
      overlay.showLobby();
    }
  }

  // Resolve where to connect: local dev connects straight to the game server;
  // a deployed client runs the matchmaking flow (ticket -> poll -> connection
  // info). A stable per-browser id keys matchmaking + doubles as a display name.
  const localPlayerId = getOrCreateLocalPlayerId();
  const displayName = getOrCreateRacerName();

  /**
   * Run the matchmaking flow, reporting progress on the matchmaking overlay so
   * the player always sees state (searching / elapsed / failed+retry) rather
   * than a lobby that looks frozen. The lobby only appears once we're connected
   * and the server sends its first snapshot.
   */
  async function beginMatchmaking(): Promise<void> {
    // Reset join state so a retry doesn't inherit the previous attempt's.
    joinedMatch = false;
    net.disconnect();
    overlay.showMatchmaking('Starting up…');
    try {
      const conn = await resolveConnection(config, localPlayerId, (s) => {
        overlay.showMatchmaking(s.message, s.elapsedSeconds, s.phase === 'failed');
      });
      net.connect(
        conn.url,
        {
          playerSessionId: conn.playerSessionId,
          displayName,
          carSkin: 'default',
        },
        conn.path,
      );
      overlay.showMatchmaking('Connecting to the race…');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[matchmaking] failed:', msg);
      // Show the failure with a retry button.
      overlay.showMatchmaking(msg, undefined, true);
    }
  }

  void beginMatchmaking();
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

    const snap = net.getLatestSnapshot();
    const me = snap?.cars.find((c) => c.playerId === playerId);

    // Local car: predicted. Boost state comes from the authoritative snapshot.
    const local = predictor?.getCar();
    if (local) {
      cars.push({
        playerId: local.playerId,
        position: local.position,
        rotation: headingToQuatY(local.heading),
        phase: local.phase,
        isLocal: true,
        boosting: me?.boosting ?? false,
        color: colorHexFor(local.playerId),
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
        boosting: c.boosting,
        color: colorHexFor(c.playerId),
      });
    }

    renderer.setCars(cars);
    if (snap) renderer.setPickups(snap.pickups.map((p) => p.active), now);
    renderer.render();

    // Audio: engine tone from local speed; one-shot sfx on item transitions.
    renderer.setSpeedFx(
      local && phase === 'racing' ? Math.abs(local.speed) / CAR_MAX_SPEED : 0,
      phase === 'racing' && (me?.boosting ?? false),
    );
    if (local && phase === 'racing') {
      audio.setEngineSpeed(Math.abs(local.speed) / CAR_MAX_SPEED);
    } else {
      audio.setEngineSpeed(0);
    }
    if (me) {
      if (me.boosting && !prevBoosting) audio.boost();
      if (me.heldItem && me.heldItem !== prevHeldItem) audio.pickup();
      prevBoosting = me.boosting;
      prevHeldItem = me.heldItem;
    }

    if (hudPanel && phase === 'racing' && snap) {
      hudPanel.update(
        snap,
        playerId,
        carColor(playerId ? (playerMeta.get(playerId)?.colorIndex ?? 0) : 0).css,
      );
    }
    if (phase === 'racing' && snap) {
      minimap.draw(snap, playerId, (id) => carColor(playerMeta.get(id)?.colorIndex ?? 0).css);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * A stable per-TAB racer name (e.g. "ChrisSpeed"), persisted for the tab's
 * lifetime. sessionStorage (not localStorage) is deliberate: localStorage is
 * shared across every tab of the same browser, so two tabs joining the same
 * match would read back one identity and show the same name. sessionStorage is
 * scoped per tab, which keeps names distinct while still surviving reloads.
 */
function getOrCreateRacerName(): string {
  const key = 'racer.name';
  let name = sessionStorage.getItem(key);
  if (!name) {
    name = randomRacerName();
    sessionStorage.setItem(key, name);
  }
  return name;
}

/**
 * A stable per-TAB player id. Per-tab for the same reason as the name above:
 * matchmaking keys off this id, so sharing it across tabs would make two
 * players look like one returning player.
 */
function getOrCreateLocalPlayerId(): string {
  const key = 'racer.playerId';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `p_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}

main();

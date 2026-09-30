import {
  CAR_MAX_SPEED,
  INPUT_SEND_RATE,
  RACE_LAPS,
  OVAL_TRACK,
  carColor,
  roadTilt,
  surfaceAt,
  getTrack,
  headingToQuatY,
  randomRacerName,
  type RaceFinished,
  type RacePhase,
  type Snapshot,
} from '@racer/shared';
import { AudioEngine } from './audio.js';
import { Music } from './music.js';
import { loadClientConfig } from './config.js';
import { Hud, positionOf } from './hud.js';
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

  const music = new Music(audio);
  const hudPanel = hud ? new Hud(hud) : null;
  if (hudPanel) hudPanel.onEvent = (e) => music.stinger(e);
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
  let prevMePhase: string | null = null;
  let prevLocalSpeed = 0;
  let lastImpactAt = 0;
  let lastThrottle = 0;
  let lastCountdownSec: number | null = null;
  createAudioControls(app, audio);

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
    // Countdown beeps, synced to the server's clock: one per whole second.
    if (lobby.countdownMs != null) {
      const secs = Math.ceil(lobby.countdownMs / 1000);
      if (secs !== lastCountdownSec && secs > 0) audio.tick();
      lastCountdownSec = secs;
    } else {
      lastCountdownSec = null;
    }
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
    const starting = next === 'racing' && phase === 'countdown';
    if (starting) audio.go();
    phase = next;
    music.setTrack(next === 'racing' ? 'race' : next === 'finished' ? 'results' : 'lobby');
    if (starting) music.stinger('start');
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

  void beginMatchmaking();  // Input tick: only while racing. Sample, predict locally, and send.
  setInterval(() => {
    if (phase !== 'racing') return;
    const sample = input.sample();
    lastThrottle = sample.throttle;
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
        ...roadTilt(track, local.position, local.heading),
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
        ...roadTilt(track, c.position, 2 * Math.atan2(c.rotation.y, c.rotation.w)),
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
    const racing = phase === 'racing';
    audio.setLocalEngine(
      local && racing ? Math.abs(local.speed) / CAR_MAX_SPEED : 0,
      lastThrottle,
      racing && me?.phase === 'racing',
    );
    audio.setRemoteCars(
      cars.filter((c) => !c.isLocal).map((c) => ({
        playerId: c.playerId,
        x: c.position.x,
        z: c.position.z,
      })),
      local ? { x: local.position.x, z: local.position.z } : null,
      racing,
      CAR_MAX_SPEED,
    );
    if (local && racing) {
      // Tyre noise tracks sideways slip: velocity component across the heading.
      const lateral =
        local.velocity.x * Math.cos(local.heading) - local.velocity.z * Math.sin(local.heading);
      audio.setTyre(
        Math.min(1, (Math.abs(lateral) / CAR_MAX_SPEED) * 3),
        surfaceAt(track, local.position),
      );
      // Collision: a sudden loss of speed in one frame. Car-vs-car if a rival is
      // close, otherwise scenery (walls, props).
      const drop = prevLocalSpeed - Math.abs(local.speed);
      if (drop > CAR_MAX_SPEED * 0.12 && now - lastImpactAt > 250) {
        lastImpactAt = now;
        const nearRival = cars.some(
          (c) =>
            !c.isLocal &&
            Math.hypot(c.position.x - local.position.x, c.position.z - local.position.z) < 3,
        );
        audio.impact(drop / (CAR_MAX_SPEED * 0.5), nearRival ? 'car' : 'scenery');
      }
      prevLocalSpeed = Math.abs(local.speed);
    } else {
      audio.setTyre(0, 'floor');
      prevLocalSpeed = 0;
    }
    if (me) {
      if (me.phase === 'recovering' && prevMePhase !== 'recovering') audio.recoveryStart();
      if (prevMePhase === 'recovering' && me.phase !== 'recovering') audio.recoveryEnd();
      if (me.phase === 'finished' && prevMePhase !== 'finished') music.stinger('finish');
      prevMePhase = me.phase;
      if (me.boosting && !prevBoosting) audio.boost();
      if (me.heldItem && me.heldItem !== prevHeldItem) audio.pickup();
      prevBoosting = me.boosting;
      prevHeldItem = me.heldItem;
    }

    if (racing && snap && me) {
      const rank = positionOf(snap, me.playerId);
      const podium = snap.cars.length > 1 && rank <= 3;
      music.setIntensity(
        (me.lap >= 1 ? 1 : 0) + (podium ? 1 : 0) + (me.lap + 1 >= RACE_LAPS ? 1 : 0),
        me.boosting,
      );
    }
    // Beat-synced UI: CSS reads --beat (1 on the beat, decaying to 0).
    document.documentElement.style.setProperty('--beat', music.beatPulse().toFixed(3));

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

/** Small mute button + volume slider, top right. Both persist via AudioEngine. */
function createAudioControls(container: HTMLElement, audio: AudioEngine): void {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:absolute;top:12px;right:12px;z-index:20;display:flex;gap:8px;align-items:center;' +
    'background:rgba(10,12,18,0.55);border-radius:10px;padding:6px 10px;color:#fff;font-size:16px;';
  const btn = document.createElement('button');
  btn.style.cssText = 'background:none;border:0;color:inherit;cursor:pointer;font-size:16px;padding:0;';
  btn.setAttribute('aria-label', 'Toggle sound (M)');
  const musicBtn = document.createElement('button');
  musicBtn.style.cssText = btn.style.cssText;
  musicBtn.setAttribute('aria-label', 'Toggle music (N)');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.05';
  slider.value = String(audio.getVolume());
  slider.style.width = '70px';
  slider.setAttribute('aria-label', 'Volume');
  const paint = () => {
    btn.textContent = audio.isMuted() ? '🔇' : '🔊';
  };
  const paintMusic = () => {
    musicBtn.textContent = '♪';
    musicBtn.style.opacity = audio.isMusicMuted() ? '0.35' : '1';
    musicBtn.style.textDecoration = audio.isMusicMuted() ? 'line-through' : 'none';
  };
  const toggleMusic = () => {
    audio.resume();
    audio.setMusicMuted(!audio.isMusicMuted());
    paintMusic();
  };
  musicBtn.addEventListener('click', toggleMusic);
  const toggle = () => {
    audio.resume();
    audio.toggleMute();
    paint();
  };
  btn.addEventListener('click', toggle);
  slider.addEventListener('input', () => {
    audio.resume();
    audio.setVolume(Number(slider.value));
    if (audio.isMuted()) {
      audio.setMuted(false);
      paint();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !e.repeat) toggle();
    if (e.code === 'KeyN' && !e.repeat) toggleMusic();
  });
  paint();
  paintMusic();
  wrap.append(btn, musicBtn, slider);
  container.appendChild(wrap);
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

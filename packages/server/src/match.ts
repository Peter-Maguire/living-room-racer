import {
  FIXED_DT,
  MAX_PLAYERS,
  SIM_TICK_RATE,
  TRACK_LIST,
  getTrack,
  headingFromQuatY,
  stepWorld,
  type LobbyState,
  type PlayerInput,
  type RaceFinished,
  type RacePhase,
  type SimCar,
  type SimWorld,
  type Snapshot,
  type Track,
} from '@racer/shared';

/** How long the pre-race countdown runs, in milliseconds. */
const COUNTDOWN_MS = 3000;

/** Lobby-side metadata for a connected player, separate from their sim car. */
interface Player {
  playerId: string;
  displayName: string;
  carSkin: string;
  /**
   * Stable slot 0..MAX_PLAYERS-1, claimed on join and held for the session.
   * Doubles as the starting-grid index and the car-colour palette index, so a
   * player's colour matches their grid position and never changes mid-session.
   */
  slot: number;
  ready: boolean;
  /** Tick at which each completed lap finished, for best-lap computation. */
  lapTicks: number[];
}

/**
 * A single match: owns the authoritative simulation, the connected players,
 * their buffered inputs, and the full race lifecycle
 * (lobby -> countdown -> racing -> finished). One Match instance corresponds to
 * one socket.io room and (in production) one GameLift game session.
 */
export class Match {
  private world: SimWorld = {
    tick: 0,
    cars: new Map(),
    pickupCooldownUntil: new Map(),
  };
  private players = new Map<string, Player>();
  private latestInput = new Map<string, PlayerInput>();
  private ackedInputSeq = new Map<string, number>();
  private loopHandle: NodeJS.Timeout | null = null;

  private phase: RacePhase = 'lobby';
  private countdownEndsAtTick: number | null = null;
  private raceStartTick = 0;
  private nextPlace = 1;
  private finished = new Set<string>();

  constructor(
    private track: Track,
    private readonly emitSnapshot: (snap: Snapshot) => void,
    private readonly emitLobby: (lobby: LobbyState) => void,
    private readonly emitFinished: (result: RaceFinished) => void,
  ) {}

  addPlayer(playerId: string, displayName: string, carSkin: string): void {
    const slot = this.claimFreeSlot();
    if (slot == null) return; // Match is full.
    const spawn = this.track.spawnGrid[slot];
    this.players.set(playerId, {
      playerId,
      displayName,
      carSkin,
      slot,
      ready: false,
      lapTicks: [],
    });
    this.world.cars.set(playerId, {
      playerId,
      phase: this.phase === 'racing' ? 'racing' : 'countdown',
      position: spawn ? { ...spawn.position } : { x: 0, y: 0, z: 0 },
      // Face along the track using the spawn's authored rotation.
      heading: spawn ? headingFromQuatY(spawn.rotation) : 0,
      velocity: { x: 0, y: 0, z: 0 },
      speed: 0,
      lastCheckpoint: -1,
      lap: 0,
      place: 0,
      offTrackTicks: 0,
      recoveryTimer: 0,
      lockoutTimer: 0,
      heldItem: null,
      boostTimer: 0,
    });
    this.ackedInputSeq.set(playerId, 0);
    this.broadcastLobby();
  }

  /**
   * Lowest slot not currently held by a player, or null when the match is full.
   * A free-list (rather than `players.size`) matters because a mid-lobby
   * leave/join would otherwise hand the newcomer a slot that's still in use,
   * duplicating both a grid position and a car colour.
   */
  private claimFreeSlot(): number | null {
    const taken = new Set([...this.players.values()].map((p) => p.slot));
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!taken.has(i)) return i;
    }
    return null;
  }

  /** Number of players currently connected to this match. */
  getPlayerCount(): number {
    return this.players.size;
  }

  removePlayer(playerId: string): void {
    this.players.delete(playerId);
    this.world.cars.delete(playerId);
    this.latestInput.delete(playerId);
    this.ackedInputSeq.delete(playerId);
    if (this.phase === 'lobby' || this.phase === 'countdown') {
      this.reevaluateCountdown();
      this.broadcastLobby();
    }
  }

  /** Change the track for the next race. Only allowed in the lobby. */
  setTrack(trackId: string): void {
    if (this.phase !== 'lobby') return;
    const next = getTrack(trackId);
    if (next.id === this.track.id) return;
    this.track = next;
    // Re-seat every car on the new track's grid and reset progress. Seating is
    // by the player's stable slot, so grid order (and colour) stays consistent.
    this.world.pickupCooldownUntil.clear();
    for (const p of this.players.values()) {
      p.lapTicks = [];
      const car = this.world.cars.get(p.playerId);
      if (car) this.resetCarToSpawn(car, p.slot);
    }
    this.broadcastLobby();
  }

  /** Set a player's ready flag; when everyone is ready, begin the countdown. */
  setReady(playerId: string, ready: boolean): void {
    const p = this.players.get(playerId);
    if (!p) return;
    // After a race, any ready interaction returns the match to the lobby so
    // players can re-ready for a rematch.
    if (this.phase === 'finished') {
      this.resetToLobby();
      return;
    }
    if (this.phase === 'racing') return;
    p.ready = ready;
    this.reevaluateCountdown();
    this.broadcastLobby();
  }

  /** Reset race state back to a fresh lobby (rematch). */
  private resetToLobby(): void {
    this.phase = 'lobby';
    this.countdownEndsAtTick = null;
    this.raceStartTick = 0;
    this.nextPlace = 1;
    this.finished.clear();
    this.latestInput.clear();
    this.world.pickupCooldownUntil.clear();
    for (const p of this.players.values()) {
      p.ready = false;
      p.lapTicks = [];
      const car = this.world.cars.get(p.playerId);
      if (car) this.resetCarToSpawn(car, p.slot);
    }
    this.broadcastLobby();
  }

  /** Place a car on grid slot `index` and clear all its race progress. */
  private resetCarToSpawn(car: SimCar, index: number): void {
    const spawn = this.track.spawnGrid[index];
    car.phase = 'countdown';
    car.position = spawn ? { ...spawn.position } : { x: 0, y: 0, z: 0 };
    car.heading = spawn ? headingFromQuatY(spawn.rotation) : 0;
    car.velocity = { x: 0, y: 0, z: 0 };
    car.speed = 0;
    car.lastCheckpoint = -1;
    car.lap = 0;
    car.place = 0;
    car.offTrackTicks = 0;
    car.recoveryTimer = 0;
    car.lockoutTimer = 0;
    car.heldItem = null;
    car.boostTimer = 0;
  }

  /** Buffer the newest input for a player; the sim consumes it each tick. */
  applyInput(playerId: string, input: PlayerInput): void {
    const prev = this.ackedInputSeq.get(playerId) ?? 0;
    if (input.seq <= prev) return; // Ignore stale/duplicate inputs.
    this.latestInput.set(playerId, input);
  }

  /** Start the fixed-timestep loop. Runs continuously across all phases. */
  start(): void {
    if (this.loopHandle) return;
    this.loopHandle = setInterval(() => this.tick(), 1000 / SIM_TICK_RATE);
  }

  stop(): void {
    if (this.loopHandle) clearInterval(this.loopHandle);
    this.loopHandle = null;
  }

  // --- lifecycle ----------------------------------------------------------

  /** Begin/cancel the countdown based on whether all players are ready. */
  private reevaluateCountdown(): void {
    if (this.phase !== 'lobby' && this.phase !== 'countdown') return;
    const all = [...this.players.values()];
    const everyoneReady = all.length > 0 && all.every((p) => p.ready);
    if (everyoneReady && this.phase === 'lobby') {
      this.phase = 'countdown';
      this.countdownEndsAtTick =
        this.world.tick + Math.round((COUNTDOWN_MS / 1000) * SIM_TICK_RATE);
    } else if (!everyoneReady && this.phase === 'countdown') {
      // Someone unreadied (or left) mid-countdown: back to lobby.
      this.phase = 'lobby';
      this.countdownEndsAtTick = null;
    }
  }

  private beginRace(): void {
    this.phase = 'racing';
    this.countdownEndsAtTick = null;
    this.raceStartTick = this.world.tick;
    for (const car of this.world.cars.values()) car.phase = 'racing';
  }

  private countdownMs(): number | null {
    if (this.phase !== 'countdown' || this.countdownEndsAtTick == null) {
      return null;
    }
    return ((this.countdownEndsAtTick - this.world.tick) * 1000) / SIM_TICK_RATE;
  }

  private tick(): void {
    // Countdown -> racing transition.
    if (
      this.phase === 'countdown' &&
      this.countdownEndsAtTick != null &&
      this.world.tick >= this.countdownEndsAtTick
    ) {
      this.beginRace();
    }

    // Keep clients' countdown display ticking down while counting down.
    if (this.phase === 'countdown') {
      this.broadcastLobby();
    }

    if (this.phase === 'racing') {
      for (const [playerId, input] of this.latestInput) {
        this.ackedInputSeq.set(playerId, input.seq);
      }
      const prevLaps = new Map(
        [...this.world.cars].map(([id, c]) => [id, c.lap]),
      );
      stepWorld(this.world, this.latestInput, this.track, FIXED_DT);

      for (const car of this.world.cars.values()) {
        // Timestamp completed laps for best-lap computation.
        if (car.lap > (prevLaps.get(car.playerId) ?? 0)) {
          this.players.get(car.playerId)?.lapTicks.push(this.world.tick);
        }
        // Assign finishing places in crossing order.
        if (car.phase === 'finished' && !this.finished.has(car.playerId)) {
          this.finished.add(car.playerId);
          car.place = this.nextPlace++;
        }
      }

      if (this.isRaceOver()) {
        this.phase = 'finished';
        this.emitFinished(this.buildResults());
      }
    } else {
      // Advance the world tick even outside racing so timers progress.
      this.world.tick += 1;
    }

    this.emitSnapshot(this.snapshot());
  }

  /** True once every car has finished the race. */
  private isRaceOver(): boolean {
    if (this.world.cars.size === 0) return false;
    return [...this.world.cars.values()].every((c) => c.phase === 'finished');
  }

  private buildResults(): RaceFinished {
    const results = [...this.players.values()]
      .map((p) => {
        const car = this.world.cars.get(p.playerId);
        return {
          playerId: p.playerId,
          place: car?.place ?? 0,
          bestLapMs: this.bestLapMs(p),
          totalMs: this.totalMs(p),
        };
      })
      .filter((r) => r.place > 0)
      .sort((a, b) => a.place - b.place);
    return { results };
  }

  /** Fastest single lap (ms) from recorded lap-completion ticks. */
  private bestLapMs(p: Player): number {
    let best = Infinity;
    let prev = this.raceStartTick;
    for (const t of p.lapTicks) {
      const lapMs = ((t - prev) * 1000) / SIM_TICK_RATE;
      if (lapMs < best) best = lapMs;
      prev = t;
    }
    return best === Infinity ? 0 : best;
  }

  private totalMs(p: Player): number {
    const last = p.lapTicks[p.lapTicks.length - 1];
    if (last == null) return 0;
    return ((last - this.raceStartTick) * 1000) / SIM_TICK_RATE;
  }

  private clockMs(): number {
    if (this.phase !== 'racing' && this.phase !== 'finished') return 0;
    return ((this.world.tick - this.raceStartTick) * 1000) / SIM_TICK_RATE;
  }

  private broadcastLobby(): void {
    this.emitLobby(this.lobbyState());
  }

  private lobbyState(): LobbyState {
    return {
      players: [...this.players.values()].map((p) => ({
        playerId: p.playerId,
        displayName: p.displayName,
        carSkin: p.carSkin,
        colorIndex: p.slot,
        ready: p.ready,
      })),
      countdownMs: this.countdownMs(),
      activeTrackId: this.track.id,
      availableTracks: TRACK_LIST,
    };
  }

  private snapshot(): Snapshot {
    return {
      tick: this.world.tick,
      racePhase: this.phase,
      clockMs: this.clockMs(),
      cars: [...this.world.cars.values()].map((c) => ({
        playerId: c.playerId,
        phase: c.phase,
        position: c.position,
        rotation: { x: 0, y: Math.sin(c.heading / 2), z: 0, w: Math.cos(c.heading / 2) },
        linearVelocity: c.velocity,
        lastCheckpoint: c.lastCheckpoint,
        lap: c.lap,
        place: c.place,
        heldItem: c.heldItem,
        boosting: c.boostTimer > 0,
      })),
      pickups: this.track.pickups.map((_, index) => ({
        index,
        active: this.world.tick >= (this.world.pickupCooldownUntil.get(index) ?? 0),
      })),
      ackedInputSeq: Object.fromEntries(this.ackedInputSeq),
    };
  }
}

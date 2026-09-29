import {
  carStateToSimCar,
  stepSingleCar,
  FIXED_DT,
  type PlayerInput,
  type SimCar,
  type Snapshot,
  type Track,
} from '@racer/shared';

/**
 * Client-side prediction + server reconciliation for the LOCAL car.
 *
 * Flow:
 *  - Each input tick, `predict()` applies the input immediately to a local
 *    SimCar (so steering feels instant) and buffers the input by seq.
 *  - When a snapshot arrives, `reconcile()` snaps the local car to the
 *    server's authoritative state (as of the last input the server processed),
 *    drops now-acked inputs, and replays the still-unacked inputs through the
 *    exact same shared step. Because client and server run identical physics,
 *    the corrected state matches what the player already sees, with tiny nudges.
 *
 * Recovery is server-driven: while the server says the car is 'recovering' or
 * 'finished', we stop predicting and just follow the server state.
 */
export class Predictor {
  private car: SimCar | null = null;
  /** Unacked inputs, oldest first, awaiting server acknowledgement. */
  private pending: PlayerInput[] = [];

  constructor(
    private readonly playerId: string,
    private readonly track: Track,
  ) {}

  /** Apply a freshly sampled input locally and buffer it for reconciliation. */
  predict(input: PlayerInput): void {
    this.pending.push(input);
    if (this.car && this.isControllable(this.car)) {
      stepSingleCar(this.car, input, this.track, FIXED_DT);
    }
  }

  /**
   * Reconcile against an authoritative snapshot. Returns true if a local car
   * exists to render afterward.
   */
  reconcile(snap: Snapshot): boolean {
    const serverCar = snap.cars.find((c) => c.playerId === this.playerId);
    if (!serverCar) {
      // We're not in the snapshot (not yet spawned or removed): clear state.
      this.car = null;
      this.pending = [];
      return false;
    }

    // Adopt the authoritative state as the new base for prediction.
    this.car = carStateToSimCar(serverCar);

    // Drop inputs the server has already processed.
    const acked = snap.ackedInputSeq[this.playerId] ?? 0;
    this.pending = this.pending.filter((i) => i.seq > acked);

    // Replay the still-unacked inputs on top of the authoritative base so the
    // predicted car ends up where the player's recent inputs should place it.
    if (this.isControllable(this.car)) {
      for (const input of this.pending) {
        stepSingleCar(this.car, input, this.track, FIXED_DT);
      }
    } else {
      // Server owns the car right now (recovering/finished): trust it fully.
      this.pending = [];
    }
    return true;
  }

  /** The current predicted local car, or null if not spawned. */
  getCar(): SimCar | null {
    return this.car;
  }

  private isControllable(car: SimCar): boolean {
    return car.phase === 'racing';
  }
}

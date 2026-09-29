import type { InputMessage } from '@racer/shared';

/**
 * Samples keyboard input into a PlayerInput each tick. WASD / arrows to drive,
 * space to drift, shift to use item. Each sampled input gets a monotonic seq
 * used for server reconciliation (P2).
 */
export class InputSampler {
  private keys = new Set<string>();
  private seq = 0;

  constructor() {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  sample(): InputMessage {
    const up = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const down = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');

    // Ctrl brakes, Space drifts/handbrakes, Shift uses an item.
    const braking = this.keys.has('ControlLeft') || this.keys.has('ControlRight');

    return {
      seq: ++this.seq,
      throttle: (up ? 1 : 0) - (down ? 1 : 0),
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      brake: braking ? 1 : 0,
      drift: this.keys.has('Space'),
      useItem: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
    };
  }
}

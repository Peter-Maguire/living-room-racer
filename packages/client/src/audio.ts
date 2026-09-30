/**
 * Lightweight procedural audio via the Web Audio API — no asset files or
 * external deps. An engine drone whose pitch tracks speed, plus one-shot blips
 * for boost, pickup, and the countdown/go. Kept intentionally simple; swap in
 * sampled sfx (howler.js) later without changing the call sites.
 *
 * Browsers require a user gesture before audio starts, so call resume() from a
 * click/keypress (the lobby "ready" button is a good spot).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private enabled = false;

  /** Start the audio context (must be called from a user gesture). */
  resume(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.enabled = true;

    // Continuous engine drone; frequency modulated by speed each frame.
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 60;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineOsc.connect(this.engineGain).connect(this.ctx.destination);
    this.engineOsc.start();
  }

  /** Update the engine tone from a normalized speed (0..1). */
  setEngineSpeed(norm: number): void {
    if (!this.ctx || !this.engineOsc || !this.engineGain) return;
    const n = Math.max(0, Math.min(1, norm));
    this.engineOsc.frequency.setTargetAtTime(60 + n * 160, this.ctx.currentTime, 0.05);
    this.engineGain.gain.setTargetAtTime(0.02 + n * 0.06, this.ctx.currentTime, 0.05);
  }

  boost(): void {
    this.blip(220, 660, 0.35, 'square');
  }

  pickup(): void {
    this.blip(520, 880, 0.15, 'sine');
  }

  go(): void {
    this.blip(440, 880, 0.25, 'triangle');
  }

  /** A short pitch-swept tone. */
  private blip(
    fromHz: number,
    toHz: number,
    dur: number,
    type: OscillatorType,
  ): void {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, t);
    osc.frequency.exponentialRampToValueAtTime(toHz, t + dur);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }
}

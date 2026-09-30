/**
 * Procedural audio via the Web Audio API — no asset files or external deps.
 *
 * Signal flow:
 *
 *   engine voices ─► engineBus ─┐
 *   tyre / impacts / sfx ─► sfxBus ─┼─► master ─► destination
 *   (reserved for music) ─► musicBus ┘
 *
 * Every category has its own bus so it can be mixed, ducked, or muted on its
 * own; `master` carries the persisted volume/mute. Remote cars each get a
 * positional engine voice, so a rival is heard coming up the inside.
 *
 * Browsers require a user gesture before audio starts, so call resume() from a
 * click/keypress (the lobby "ready" button is a good spot).
 */

const VOLUME_KEY = 'racer.audio.volume';
const MUTED_KEY = 'racer.audio.muted';

export type Surface = 'floor' | 'rug' | 'wood' | 'cushion';

/** Tyre-noise voicing per surface: band centre (Hz), resonance, loudness. */
const SURFACES: Record<Surface, { freq: number; q: number; gain: number }> = {
  floor: { freq: 1800, q: 0.9, gain: 1 },
  wood: { freq: 2600, q: 1.3, gain: 0.9 },
  rug: { freq: 700, q: 0.6, gain: 0.6 },
  cushion: { freq: 380, q: 0.5, gain: 0.45 },
};

/** A continuous engine note: layered oscillators + noise through a lowpass. */
interface EngineVoice {
  /** speedNorm 0..1, throttle -1..1 (load), level 0..1 output multiplier. */
  update(speedNorm: number, throttle: number, level: number): void;
  stop(): void;
}

interface RemoteVoice {
  voice: EngineVoice;
  panner: PannerNode;
  lastX: number;
  lastZ: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  private localVoice: EngineVoice | null = null;
  private remoteVoices = new Map<string, RemoteVoice>();
  private tyre: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private lastRemoteUpdate = 0;

  private volume = readNumber(VOLUME_KEY, 0.8);
  private muted = readFlag(MUTED_KEY);

  // --- lifecycle ----------------------------------------------------------

  /** Start the audio context (must be called from a user gesture). */
  resume(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.engineBus = this.bus(0.9);
    this.sfxBus = this.bus(1);
    this.musicBus = this.bus(0.6);
    this.applyMaster();

    this.noise = makeNoise(ctx);
    this.localVoice = this.createEngine(this.engineBus, 1);

    // Tyre noise: looping noise through a surface-voiced bandpass.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.sfxBus);
    src.start();
    this.tyre = { gain, filter };
    this.setTyre(0, 'floor');
  }

  /** Bus for the soundtrack (15.5), so music mixes/mutes independently. */
  getMusicBus(): { ctx: AudioContext; bus: GainNode } | null {
    return this.ctx && this.musicBus ? { ctx: this.ctx, bus: this.musicBus } : null;
  }

  // --- mix: volume / mute -------------------------------------------------

  getVolume(): number {
    return this.volume;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    writeStore(VOLUME_KEY, String(this.volume));
    this.applyMaster();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    writeStore(MUTED_KEY, m ? '1' : '0');
    this.applyMaster();
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private applyMaster(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(
      this.muted ? 0 : this.volume,
      this.ctx.currentTime,
      0.03,
    );
  }

  private bus(gain: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = gain;
    g.connect(this.master!);
    return g;
  }

  /** Briefly pull the engine bus down so an important one-shot reads clearly. */
  private duck(amount: number, seconds: number): void {
    if (!this.ctx || !this.engineBus) return;
    const t = this.ctx.currentTime;
    const g = this.engineBus.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.9 * (1 - amount), t, 0.02);
    g.setTargetAtTime(0.9, t + seconds, 0.15);
  }

  // --- engine -------------------------------------------------------------

  /**
   * The local car's engine. `active` is false outside a race, where it fades to
   * silence. `throttle` (-1..1) is the load: accelerating sounds brighter and
   * fuller than coasting at the same speed.
   */
  setLocalEngine(speedNorm: number, throttle: number, active: boolean): void {
    this.localVoice?.update(speedNorm, throttle, active ? 1 : 0);
  }

  /**
   * Positional engine voices for the other cars. Positions are world XZ; the
   * listener sits on the local car. Voices are created/removed to match the
   * car list, and speed is inferred from movement between calls.
   */
  setRemoteCars(
    cars: { playerId: string; x: number; z: number }[],
    listener: { x: number; z: number } | null,
    active: boolean,
    maxSpeed: number,
  ): void {
    if (!this.ctx || !this.engineBus) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dt = Math.max(1 / 240, now - this.lastRemoteUpdate);
    this.lastRemoteUpdate = now;

    if (listener) {
      const l = ctx.listener;
      if (l.positionX) {
        l.positionX.value = listener.x;
        l.positionY.value = 0;
        l.positionZ.value = listener.z;
      } else {
        l.setPosition(listener.x, 0, listener.z);
      }
    }

    const seen = new Set<string>();
    for (const c of cars) {
      seen.add(c.playerId);
      let rv = this.remoteVoices.get(c.playerId);
      if (!rv) {
        const panner = ctx.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'inverse';
        // Loud and clear within a few metres, fading across the room.
        panner.refDistance = 5;
        panner.rolloffFactor = 1.3;
        panner.connect(this.engineBus);
        rv = {
          voice: this.createEngine(panner, 0.7),
          panner,
          lastX: c.x,
          lastZ: c.z,
        };
        this.remoteVoices.set(c.playerId, rv);
      }
      const speed = Math.hypot(c.x - rv.lastX, c.z - rv.lastZ) / dt;
      rv.lastX = c.x;
      rv.lastZ = c.z;
      rv.panner.positionX.value = c.x;
      rv.panner.positionY.value = 0;
      rv.panner.positionZ.value = c.z;
      // Remote throttle is unknown; assume load roughly tracks speed.
      const norm = Math.min(1, speed / maxSpeed);
      rv.voice.update(norm, norm > 0.05 ? 0.6 : 0, active ? 1 : 0);
    }
    for (const [id, rv] of this.remoteVoices) {
      if (seen.has(id)) continue;
      rv.voice.stop();
      rv.panner.disconnect();
      this.remoteVoices.delete(id);
    }
  }

  /**
   * One engine: two detuned saws + a square sub for body, plus a noise layer
   * for mechanical texture, through a lowpass whose cutoff opens with speed
   * and throttle. Near top speed the level flutters like a rev limiter.
   */
  private createEngine(output: AudioNode, baseLevel: number): EngineVoice {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2;
    filter.connect(out).connect(output);

    const saw1 = ctx.createOscillator();
    saw1.type = 'sawtooth';
    const saw2 = ctx.createOscillator();
    saw2.type = 'sawtooth';
    saw2.detune.value = 14;
    const sub = ctx.createOscillator();
    sub.type = 'square';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.5;
    saw1.connect(oscGain);
    saw2.connect(oscGain);
    sub.connect(subGain).connect(oscGain);
    oscGain.connect(filter);

    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noise;
    hiss.loop = true;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 900;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.08;
    hiss.connect(hissFilter).connect(hissGain).connect(filter);

    for (const o of [saw1, saw2, sub, hiss]) o.start();

    return {
      update: (speedNorm, throttle, level) => {
        const t = ctx.currentTime;
        const n = clamp01(speedNorm);
        const load = clamp01(throttle);
        const f = 52 + n * 150;
        saw1.frequency.setTargetAtTime(f, t, 0.05);
        saw2.frequency.setTargetAtTime(f, t, 0.05);
        sub.frequency.setTargetAtTime(f / 2, t, 0.05);
        filter.frequency.setTargetAtTime(380 + n * 700 + load * 1500, t, 0.08);
        hissGain.gain.setTargetAtTime(0.04 + load * 0.08, t, 0.1);
        // Rev limiter: amplitude flutter once near the top of the range.
        const flutter =
          n > 0.94 ? 1 - 0.22 * (Math.sin(t * Math.PI * 2 * 17) > 0 ? 1 : 0) : 1;
        const vol = (0.03 + n * 0.07 + load * 0.03) * baseLevel * flutter * level;
        out.gain.setTargetAtTime(vol, t, 0.04);
      },
      stop: () => {
        const t = ctx.currentTime;
        out.gain.setTargetAtTime(0, t, 0.05);
        for (const o of [saw1, saw2, sub, hiss]) o.stop(t + 0.3);
      },
    };
  }

  // --- tyres --------------------------------------------------------------

  /**
   * Tyre squeal/scrub. `slip` (0..1) is how far the car is sliding sideways;
   * `surface` re-voices the noise (cushions muffled, tile bright). Tracks don't
   * carry surface tags yet, so callers pass 'floor'; the hook is ready for them.
   */
  setTyre(slip: number, surface: Surface): void {
    if (!this.ctx || !this.tyre) return;
    const s = SURFACES[surface];
    const t = this.ctx.currentTime;
    this.tyre.filter.frequency.setTargetAtTime(s.freq, t, 0.05);
    this.tyre.filter.Q.value = s.q;
    this.tyre.gain.gain.setTargetAtTime(clamp01(slip) * 0.16 * s.gain, t, 0.04);
  }

  // --- one-shots ----------------------------------------------------------

  /** Collision thump scaled by impact strength (0..1). */
  impact(strength: number, kind: 'car' | 'scenery'): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus) return;
    const s = clamp01(strength);
    const t = ctx.currentTime;
    if (kind === 'scenery') {
      this.thump(t, 95, 0.22 + s * 0.3, 0.22);
      this.noiseBurst(t, 'lowpass', 500 + s * 500, 0.14, 0.12 + s * 0.25);
    } else {
      // Plastic clack: a short bright click over a light thump.
      this.thump(t, 190, 0.15 + s * 0.2, 0.1);
      this.noiseBurst(t, 'bandpass', 2200, 0.07, 0.15 + s * 0.3);
    }
    this.duck(0.35 * (0.4 + s), 0.25);
  }

  /** The off-track "uh-oh": two descending notes. */
  recoveryStart(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 520, 400, 0.16, 'triangle', 0.09);
    this.tone(t + 0.17, 400, 250, 0.3, 'triangle', 0.09);
    // The claw's whirr starts once the car is lifted.
    this.whirr(t + 0.45, 1.3);
    this.duck(0.6, 1.6);
  }

  /** The re-drop: a thud as the car lands back on the track. */
  recoveryEnd(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.thump(t, 80, 0.3, 0.25);
    this.noiseBurst(t, 'lowpass', 700, 0.12, 0.25);
  }

  boost(): void {
    this.blip(220, 660, 0.35, 'square');
  }

  pickup(): void {
    this.blip(520, 880, 0.15, 'sine');
  }

  /** Countdown tick (3, 2, 1). */
  tick(): void {
    this.blip(660, 660, 0.12, 'sine');
  }

  go(): void {
    this.blip(440, 880, 0.3, 'triangle');
  }

  // --- primitives ---------------------------------------------------------

  /** A short pitch-swept tone. */
  private blip(
    fromHz: number,
    toHz: number,
    dur: number,
    type: OscillatorType,
  ): void {
    if (!this.ctx) return;
    this.tone(this.ctx.currentTime, fromHz, toHz, dur, type, 0.12);
  }

  private tone(
    t: number,
    fromHz: number,
    toHz: number,
    dur: number,
    type: OscillatorType,
    peak: number,
  ): void {
    if (!this.ctx || !this.sfxBus) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, t);
    if (toHz !== fromHz) osc.frequency.exponentialRampToValueAtTime(toHz, t + dur);
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur);
  }

  /** Low sine drop: the body of a thud. */
  private thump(t: number, hz: number, peak: number, dur: number): void {
    if (!this.ctx || !this.sfxBus) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.setValueAtTime(hz * 1.6, t);
    osc.frequency.exponentialRampToValueAtTime(hz * 0.6, t + dur);
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur);
  }

  private noiseBurst(
    t: number,
    type: BiquadFilterType,
    freq: number,
    dur: number,
    peak: number,
  ): void {
    if (!this.ctx || !this.sfxBus || !this.noise) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(gain).connect(this.sfxBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur);
  }

  /** Claw motor: a rising saw with vibrato, swelling then fading. */
  private whirr(t: number, dur: number): void {
    if (!this.ctx || !this.sfxBus) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.linearRampToValueAtTime(240, t + dur);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 22;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 14;
    lfo.connect(lfoGain).connect(osc.frequency);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(500, t);
    filter.frequency.linearRampToValueAtTime(1100, t + dur);
    filter.Q.value = 3;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.1, t + dur * 0.3);
    gain.gain.linearRampToValueAtTime(0.0001, t + dur);
    osc.connect(filter).connect(gain).connect(this.sfxBus);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur);
    lfo.stop(t + dur);
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Two seconds of white noise, shared by every noise source. */
function makeNoise(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// localStorage can throw (private windows, blocked storage); audio must not.
function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* non-fatal: the setting just won't persist */
  }
}

function readNumber(key: string, fallback: number): number {
  const v = Number(readStore(key));
  return readStore(key) != null && Number.isFinite(v) ? clamp01(v) : fallback;
}

function readFlag(key: string): boolean {
  return readStore(key) === '1';
}

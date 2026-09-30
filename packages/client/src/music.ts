import type { AudioEngine } from './audio.js';

/**
 * Procedural soundtrack: an original, synthesised loop set with no audio files
 * (so no licensing or streaming concerns; a recorded score can replace it later
 * behind the same API).
 *
 * Each track is a small step sequencer (16 steps per bar, a 4-bar chord loop)
 * split into STEMS — drums, bass, pads, lead, extra hats — each on its own gain.
 * Race intensity fades stems in and out rather than switching songs, so the
 * music builds without abrupt cuts. Phase changes crossfade between tracks.
 *
 * Stingers are chord-tone arpeggios quantised to the next 16th of the running
 * track, so they land in key and on the grid. `beatPulse()` exposes the beat
 * position for beat-synced UI.
 */

export type MusicTrack = 'lobby' | 'race' | 'results';
type Stem = 'drums' | 'bass' | 'pads' | 'lead' | 'hats16';
type Step = number | null;

interface TrackDef {
  bpm: number;
  /** Bass root (MIDI note) per bar. */
  roots: number[];
  /** Chord tones (MIDI) per bar; arp indexes >= 3 wrap up an octave. */
  chords: number[][];
  kick: number[];
  snare: number[];
  hat: number[];
  /** Per 16th: semitone offset from the bar root, or null for a rest. */
  bass: Step[];
  /** Per 16th: chord-tone index, or null for a rest. */
  arp: Step[];
}

const N = null;

// A minor feel: i - VI - III - VII (Am F C G).
const MINOR = {
  roots: [45, 41, 48, 43],
  chords: [
    [57, 60, 64],
    [53, 57, 60],
    [55, 60, 64],
    [55, 59, 62],
  ],
};

const TRACKS: Record<MusicTrack, TrackDef> = {
  lobby: {
    bpm: 96,
    ...MINOR,
    kick: [0, 8],
    snare: [],
    hat: [4, 12],
    bass: [0, N, N, N, N, N, N, N, 7, N, N, N, N, N, N, N],
    arp: [0, N, N, 1, N, N, 2, N, N, 1, N, N, 2, N, 1, N],
  },
  race: {
    bpm: 140,
    ...MINOR,
    kick: [0, 4, 8, 12],
    snare: [4, 12],
    hat: [2, 6, 10, 14],
    bass: [0, N, 0, N, 12, N, 0, N, 0, N, 0, N, 12, N, 7, N],
    arp: [0, 1, 2, 1, 2, 1, 2, 3, 0, 1, 2, 1, 2, 3, 4, 3],
  },
  // Relative major (C G Am F): same notes as the race key, but resolved and calm.
  results: {
    bpm: 88,
    roots: [48, 43, 45, 41],
    chords: [
      [60, 64, 67],
      [55, 59, 62],
      [57, 60, 64],
      [53, 57, 60],
    ],
    kick: [0, 10],
    snare: [],
    hat: [4, 12],
    bass: [0, N, N, N, N, N, N, N, 7, N, N, N, N, N, N, N],
    arp: [0, N, 2, N, 1, N, 2, N, 4, N, 2, N, 1, N, 0, N],
  },
};

const STEMS: Stem[] = ['drums', 'bass', 'pads', 'lead', 'hats16'];
const CROSSFADE_S = 1.2;
const LOOKAHEAD_S = 0.15;
const TIMER_MS = 30;

interface Sequencer {
  track: MusicTrack;
  def: TrackDef;
  out: GainNode;
  stems: Record<Stem, GainNode>;
  on: Record<Stem, boolean>;
  /** Audio-clock time of step 0. Beat position derives from this. */
  t0: number;
  nextTime: number;
  step: number;
  timer: number;
}

export class Music {
  private current: Sequencer | null = null;
  private wanted: MusicTrack | null = null;
  private noise: AudioBuffer | null = null;
  private level = 0;
  private boosting = false;

  constructor(private readonly audio: AudioEngine) {
    // The AudioContext only exists after the first gesture; start whatever was
    // requested before that as soon as it does.
    audio.onReady(() => this.apply());
  }

  /** Switch tracks (crossfading). Safe to call before audio is unlocked. */
  setTrack(track: MusicTrack | null): void {
    this.wanted = track;
    this.apply();
  }

  /**
   * Race intensity 0..3: 0 drums+bass, 1 +pads, 2 +lead, 3 +extra hats.
   * Boosting forces the full mix for its duration.
   */
  setIntensity(level: number, boosting: boolean): void {
    this.level = Math.max(0, Math.min(3, Math.round(level)));
    this.boosting = boosting;
    this.applyStems();
  }

  /** 1 on the beat, decaying to ~0 between beats. For beat-synced UI. */
  beatPulse(): number {
    const b = this.audio.getMusicBus();
    const seq = this.current;
    if (!b || !seq) return 0;
    const beat = 60 / seq.def.bpm;
    const phase = (((b.ctx.currentTime - seq.t0) / beat) % 1 + 1) % 1;
    return Math.exp(-phase * 6);
  }

  /** A short chord-tone flourish, quantised to the next 16th of the track. */
  stinger(kind: 'start' | 'overtake' | 'finalLap' | 'finish'): void {
    const b = this.audio.getMusicBus();
    const seq = this.current;
    if (!b || !seq) return;
    const bar = Math.floor(seq.step / 16) % seq.def.chords.length;
    const chord = seq.def.chords[bar]!;
    const tone = (i: number) => chord[i % 3]! + 12 * (1 + Math.floor(i / 3));
    const plan: Record<typeof kind, { idx: number[]; gap: number; dur: number }> = {
      start: { idx: [0, 2, 3], gap: 0.07, dur: 0.3 },
      overtake: { idx: [1, 2, 3], gap: 0.055, dur: 0.16 },
      finalLap: { idx: [0, 1, 2, 3, 5], gap: 0.09, dur: 0.32 },
      finish: { idx: [0, 2, 3, 5], gap: 0.13, dur: 0.9 },
    };
    const p = plan[kind];
    const t = Math.max(seq.nextTime, b.ctx.currentTime + 0.02);
    p.idx.forEach((i, n) => {
      this.note(b.ctx, b.bus, t + n * p.gap, tone(i), p.dur, 'square', 0.12, 3200);
    });
    // Dip the running track so the stinger reads clearly.
    const g = seq.out.gain;
    g.cancelScheduledValues(b.ctx.currentTime);
    g.setTargetAtTime(0.55, b.ctx.currentTime, 0.02);
    g.setTargetAtTime(1, t + p.idx.length * p.gap + 0.25, 0.2);
  }

  // --- sequencer ----------------------------------------------------------

  private apply(): void {
    const b = this.audio.getMusicBus();
    if (!b) return;
    if (!this.noise) this.noise = makeNoise(b.ctx);
    if (this.current?.track === this.wanted) return;
    const old = this.current;
    if (old) this.fadeOut(old, b.ctx);
    this.current = this.wanted ? this.startSeq(this.wanted, b.ctx, b.bus) : null;
    this.applyStems();
  }

  private startSeq(track: MusicTrack, ctx: AudioContext, bus: GainNode): Sequencer {
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, ctx.currentTime);
    out.gain.linearRampToValueAtTime(1, ctx.currentTime + CROSSFADE_S);
    out.connect(bus);
    const stems = {} as Record<Stem, GainNode>;
    for (const s of STEMS) {
      stems[s] = ctx.createGain();
      stems[s].gain.value = 0;
      stems[s].connect(out);
    }
    const t0 = ctx.currentTime + 0.08;
    const seq: Sequencer = {
      track,
      def: TRACKS[track],
      out,
      stems,
      on: { drums: false, bass: false, pads: false, lead: false, hats16: false },
      t0,
      nextTime: t0,
      step: 0,
      timer: 0,
    };
    seq.timer = window.setInterval(() => this.schedule(seq, ctx), TIMER_MS);
    return seq;
  }

  private fadeOut(seq: Sequencer, ctx: AudioContext): void {
    const t = ctx.currentTime;
    seq.out.gain.cancelScheduledValues(t);
    seq.out.gain.setValueAtTime(seq.out.gain.value, t);
    seq.out.gain.linearRampToValueAtTime(0, t + CROSSFADE_S);
    window.setTimeout(() => {
      clearInterval(seq.timer);
      seq.out.disconnect();
    }, CROSSFADE_S * 1000 + 100);
  }

  /** Fade stems in/out to match the track (fixed) or race intensity. */
  private applyStems(): void {
    const seq = this.current;
    const b = this.audio.getMusicBus();
    if (!seq || !b) return;
    const full = seq.track !== 'race';
    const lvl = this.boosting ? 3 : this.level;
    const want: Record<Stem, boolean> = {
      drums: true,
      bass: true,
      pads: full || lvl >= 1,
      lead: full || lvl >= 2,
      hats16: !full && lvl >= 3,
    };
    const gain: Record<Stem, number> = {
      drums: 0.9,
      bass: 0.8,
      pads: 0.5,
      lead: 0.55,
      hats16: 0.35,
    };
    for (const s of STEMS) {
      seq.on[s] = want[s];
      seq.stems[s].gain.setTargetAtTime(want[s] ? gain[s] : 0, b.ctx.currentTime, 0.25);
    }
  }

  private schedule(seq: Sequencer, ctx: AudioContext): void {
    const stepDur = 60 / seq.def.bpm / 4;
    while (seq.nextTime < ctx.currentTime + LOOKAHEAD_S) {
      this.playStep(seq, ctx, seq.nextTime, seq.step, stepDur);
      seq.nextTime += stepDur;
      seq.step += 1;
    }
  }

  private playStep(
    seq: Sequencer,
    ctx: AudioContext,
    t: number,
    step: number,
    stepDur: number,
  ): void {
    const d = seq.def;
    const s = step % 16;
    const bar = Math.floor(step / 16) % d.roots.length;

    if (seq.on.drums) {
      const out = seq.stems.drums;
      if (d.kick.includes(s)) this.kick(ctx, out, t);
      if (d.snare.includes(s)) this.snare(ctx, out, t);
      if (d.hat.includes(s)) this.hat(ctx, out, t, 0.5);
    }
    if (seq.on.hats16 && s % 2 === 1) this.hat(ctx, seq.stems.hats16, t, 0.3);

    const bassOff = d.bass[s];
    if (seq.on.bass && bassOff != null) {
      this.note(ctx, seq.stems.bass, t, d.roots[bar]! + bassOff, stepDur * 1.8, 'sawtooth', 0.22, 600);
    }

    const arp = d.arp[s];
    if (seq.on.lead && arp != null) {
      const chord = d.chords[bar]!;
      const midi = chord[arp % 3]! + 12 * (1 + Math.floor(arp / 3));
      this.note(ctx, seq.stems.lead, t, midi, stepDur * 1.5, 'square', 0.1, 2400);
    }

    // Pads: one sustained chord per bar, started on the downbeat.
    if (seq.on.pads && s === 0) {
      for (const m of d.chords[bar]!) {
        this.pad(ctx, seq.stems.pads, t, m, stepDur * 16);
      }
    }
  }

  // --- voices -------------------------------------------------------------

  private kick(ctx: AudioContext, out: AudioNode, t: number): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  private snare(ctx: AudioContext, out: AudioNode, t: number): void {
    this.noiseHit(ctx, out, t, 'bandpass', 1800, 0.14, 0.5);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  private hat(ctx: AudioContext, out: AudioNode, t: number, peak: number): void {
    this.noiseHit(ctx, out, t, 'highpass', 7000, 0.04, peak);
  }

  private noiseHit(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    type: BiquadFilterType,
    freq: number,
    dur: number,
    peak: number,
  ): void {
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur);
  }

  /** A plucked/blown note through a lowpass, with a fast attack. */
  private note(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    midi: number,
    dur: number,
    type: OscillatorType,
    peak: number,
    cutoff: number,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = midiToHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.3), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(f).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Slow-attack detuned saw pair: the harmonic bed. */
  private pad(ctx: AudioContext, out: AudioNode, t: number, midi: number, dur: number): void {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + dur * 0.25);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1100;
    f.connect(g).connect(out);
    for (const detune of [-7, 7]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToHz(midi);
      osc.detune.value = detune;
      osc.connect(f);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }
}

function midiToHz(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

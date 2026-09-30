import { RACE_LAPS, type Snapshot } from '@racer/shared';

/**
 * In-race HUD. Replaces the original single-line text readout with discrete
 * elements so each piece of information can be styled, sized, and animated
 * independently (lap, live position, race clock, item slot, car state).
 *
 * Purely presentational: every value comes from the authoritative snapshot.
 */
export class Hud {
  private root: HTMLElement;
  private lapEl: HTMLDivElement;
  private posEl: HTMLDivElement;
  private clockEl: HTMLDivElement;
  private itemEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private accentEl: HTMLDivElement;
  private speedEl: HTMLSpanElement;
  private toastsEl: HTMLDivElement;
  private splitEl: HTMLDivElement;
  private vignetteEl: HTMLDivElement;

  /** Lap timing, derived from lap transitions in the authoritative snapshots. */
  private prevLapIdx = -1;
  private lapStartMs = 0;
  private bestLapMs = Infinity;
  private splitTimeout: number | undefined;
  /** True when we joined mid-lap, so the first lap's start time is unknown. */
  private partialFirstLap = false;

  /** Previous-snapshot values, used to detect events worth a toast. */
  private lastPos = 0;
  private lastPhase: string | null = null;
  private lastHeld: string | null = null;

  /** Last rendered lap, so the final-lap emphasis only re-triggers on change. */
  private lastLap = -1;

  constructor(container: HTMLElement) {
    this.root = container;
    this.injectStyles();
    container.classList.add('hud-root');
    container.innerHTML = `
      <div class="hud-panel">
        <div class="hud-accent"></div>
        <div class="hud-main">
          <div class="hud-row">
            <div class="hud-stat hud-lap"><span class="hud-label">LAP</span><span class="hud-value">-</span></div>
            <div class="hud-stat hud-pos"><span class="hud-label">POS</span><span class="hud-value">-</span></div>
            <div class="hud-stat hud-clock"><span class="hud-label">TIME</span><span class="hud-value">0.0</span></div>
          </div>
          <div class="hud-item">Item: —</div>
          <div class="hud-speed"><span class="hud-speed-val">0</span> <span class="hud-speed-unit">km/h</span></div>
          <div class="hud-status"></div>
        </div>
      </div>
    `;
    this.accentEl = container.querySelector('.hud-accent')!;
    this.lapEl = container.querySelector('.hud-lap .hud-value')!;
    this.posEl = container.querySelector('.hud-pos .hud-value')!;
    this.clockEl = container.querySelector('.hud-clock .hud-value')!;
    this.itemEl = container.querySelector('.hud-item')!;
    this.statusEl = container.querySelector('.hud-status')!;
    this.speedEl = container.querySelector('.hud-speed-val')!;
    this.toastsEl = document.createElement('div');
    this.toastsEl.className = 'hud-toasts';
    container.appendChild(this.toastsEl);
    this.splitEl = document.createElement('div');
    this.splitEl.className = 'hud-split';
    container.appendChild(this.splitEl);
    this.vignetteEl = document.createElement('div');
    this.vignetteEl.className = 'hud-vignette';
    container.appendChild(this.vignetteEl);
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? 'block' : 'none';
  }

  /** Refresh from the latest snapshot. `colorCss` tints the accent stripe. */
  update(snap: Snapshot, playerId: string | undefined, colorCss: string): void {
    this.accentEl.style.background = colorCss;
    this.clockEl.textContent = (snap.clockMs / 1000).toFixed(1);

    const me = snap.cars.find((c) => c.playerId === playerId);
    if (!me) {
      // Spectating (not yet spawned, or removed from the sim).
      this.lapEl.textContent = '—';
      this.posEl.textContent = `${snap.cars.length} cars`;
      this.itemEl.textContent = 'Spectating';
      this.statusEl.textContent = '';
      this.statusEl.className = 'hud-status';
      return;
    }

    this.trackLapSplit(snap.clockMs, me.lap);
    // Vignette: faint at speed, strong while boosting.
    const speed = Math.hypot(me.linearVelocity.x, me.linearVelocity.z);
    this.vignetteEl.style.opacity = me.boosting ? '1' : String(Math.min(0.35, speed / 120));
    this.vignetteEl.classList.toggle('is-boost', me.boosting);

    const lap = Math.min(me.lap + 1, RACE_LAPS);
    this.lapEl.textContent = `${lap}/${RACE_LAPS}`;
    const finalLap = lap === RACE_LAPS;
    this.lapEl.parentElement?.classList.toggle('is-final', finalLap);
    if (lap !== this.lastLap) {
      if (finalLap && this.lastLap !== -1) this.toast('FINAL LAP!', 'final');
      // Restart the pop animation by removing and re-adding the class.
      this.lapEl.parentElement?.classList.remove('just-changed');
      void this.lapEl.parentElement?.offsetWidth; // force reflow
      this.lapEl.parentElement?.classList.add('just-changed');
      this.lastLap = lap;
    }

    const pos = positionOf(snap, me.playerId);
    this.posEl.textContent = `${ordinal(pos)}/${snap.cars.length}`;
    if (this.lastPos !== 0 && pos !== this.lastPos) {
      const gained = pos < this.lastPos;
      if (gained) this.toast(`Overtake! ${ordinal(pos)} place`, 'good');
      const el = this.posEl.parentElement;
      el?.classList.remove('gain', 'loss');
      void el?.offsetWidth;
      el?.classList.add(gained ? 'gain' : 'loss');
    }
    this.lastPos = pos;

    // Display-only scaling of sim m/s to a toy-car km/h figure.
    const v = me.linearVelocity;
    this.speedEl.textContent = String(Math.round(Math.hypot(v.x, v.z) * 3.6));

    if (me.phase === 'recovering' && this.lastPhase !== 'recovering') {
      this.toast('Nice save!', 'warn');
    }
    if (me.heldItem && me.heldItem !== this.lastHeld) {
      this.toast(`Got ${me.heldItem}!`, 'good');
    }
    this.lastPhase = me.phase;
    this.lastHeld = me.heldItem;

    this.itemEl.textContent = me.boosting
      ? 'BOOSTING!'
      : me.heldItem
        ? `${me.heldItem.toUpperCase()} — press Shift`
        : 'Item: —';
    this.itemEl.classList.toggle('is-armed', !me.boosting && me.heldItem != null);
    this.itemEl.classList.toggle('is-active', me.boosting);

    if (me.phase === 'recovering') {
      this.statusEl.textContent = 'RECOVERING';
      this.statusEl.className = 'hud-status is-warn';
    } else if (me.phase === 'finished') {
      this.statusEl.textContent = `FINISHED ${ordinal(me.place)}`;
      this.statusEl.className = 'hud-status is-good';
    } else {
      this.statusEl.textContent = '';
      this.statusEl.className = 'hud-status';
    }
  }

  /** Detect a completed lap and show its time against the best so far. */
  private trackLapSplit(clockMs: number, lapIdx: number): void {
    // A backwards clock or lap means a new race started: reset timing.
    if (clockMs < this.lapStartMs || lapIdx < this.prevLapIdx) {
      this.prevLapIdx = -1;
      this.lapStartMs = 0;
      this.bestLapMs = Infinity;
    }
    if (this.prevLapIdx === -1) {
      // Joined (or reloaded) mid-race: don't time a lap we only saw the end of.
      this.partialFirstLap = clockMs >= 1500;
      this.lapStartMs = this.partialFirstLap ? clockMs : 0;
    }
    if (this.prevLapIdx >= 0 && lapIdx > this.prevLapIdx && lapIdx <= RACE_LAPS) {
      if (this.partialFirstLap) {
        this.partialFirstLap = false;
        this.lapStartMs = clockMs;
        this.prevLapIdx = lapIdx;
        return;
      }
      const lapMs = clockMs - this.lapStartMs;
      const first = !Number.isFinite(this.bestLapMs);
      const delta = lapMs - this.bestLapMs;
      const faster = !first && delta < 0;
      this.splitEl.textContent = first
        ? `Lap ${(lapMs / 1000).toFixed(2)}s`
        : `${(lapMs / 1000).toFixed(2)}s  ${delta < 0 ? '−' : '+'}${(Math.abs(delta) / 1000).toFixed(2)}`;
      this.splitEl.className = `hud-split is-shown ${first ? '' : faster ? 'is-faster' : 'is-slower'}`;
      clearTimeout(this.splitTimeout);
      this.splitTimeout = window.setTimeout(() => this.splitEl.classList.remove('is-shown'), 3500);
      if (lapMs < this.bestLapMs) this.bestLapMs = lapMs;
      this.lapStartMs = clockMs;
    }
    this.prevLapIdx = lapIdx;
  }

  /** Show a transient message that fades itself out. */
  private toast(text: string, kind: 'good' | 'warn' | 'final'): void {
    const el = document.createElement('div');
    el.className = `hud-toast is-${kind}`;
    el.textContent = text;
    this.toastsEl.appendChild(el);
    // Cap the stack so a burst of events can't fill the screen.
    while (this.toastsEl.children.length > 3) this.toastsEl.firstElementChild?.remove();
    setTimeout(() => el.remove(), 2200);
  }

  private injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      .hud-root { pointer-events: none; }
      .hud-panel {
        display: flex; align-items: stretch; gap: 10px;
        background: rgba(10, 12, 18, 0.55);
        border-radius: 12px; padding: 10px 14px 10px 10px;
        backdrop-filter: blur(6px);
      }
      .hud-accent { width: 6px; border-radius: 3px; background: #fff; }
      .hud-main { display: flex; flex-direction: column; gap: 6px; }
      .hud-row { display: flex; gap: 18px; align-items: flex-end; }
      .hud-stat { display: flex; flex-direction: column; line-height: 1; }
      .hud-label {
        font-size: 10px; letter-spacing: 0.14em; opacity: 0.65; margin-bottom: 3px;
      }
      .hud-value { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .hud-clock .hud-value { font-size: 20px; font-weight: 600; opacity: 0.9; }
      .hud-lap.is-final .hud-value { color: #ffd75e; }
      .hud-stat.just-changed .hud-value { animation: hud-pop 360ms ease-out; }
      @keyframes hud-pop {
        0% { transform: scale(1.5); }
        100% { transform: scale(1); }
      }
      .hud-item {
        font-size: 13px; opacity: 0.85;
        padding: 3px 8px; border-radius: 6px; align-self: flex-start;
        background: rgba(255,255,255,0.08);
      }
      .hud-item.is-armed { background: rgba(255, 204, 51, 0.22); color: #ffd75e; opacity: 1; }
      .hud-item.is-active {
        background: rgba(51, 204, 255, 0.28); color: #9fe8ff; opacity: 1;
        animation: hud-glow 700ms ease-in-out infinite;
      }
      @keyframes hud-glow {
        0%, 100% { filter: brightness(1); }
        50% { filter: brightness(1.45); }
      }
      .hud-speed { font-variant-numeric: tabular-nums; font-size: 18px; font-weight: 700; }
      .hud-speed-unit { font-size: 10px; letter-spacing: 0.14em; opacity: 0.65; font-weight: 400; }
      .hud-stat.gain .hud-value { animation: hud-gain 700ms ease-out; }
      .hud-stat.loss .hud-value { animation: hud-loss 700ms ease-out; }
      @keyframes hud-gain { 0% { color: #8df5a0; transform: scale(1.4); } 100% { transform: scale(1); } }
      @keyframes hud-loss { 0% { color: #ff9a5e; transform: scale(0.8); } 100% { transform: scale(1); } }
      .hud-split {
        position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
        padding: 6px 14px; border-radius: 10px; font-weight: 700; font-variant-numeric: tabular-nums;
        background: rgba(10,12,18,0.7); opacity: 0; transition: opacity 250ms;
      }
      .hud-split.is-shown { opacity: 1; }
      .hud-split.is-faster { color: #8df5a0; }
      .hud-split.is-slower { color: #ff9a5e; }
      .hud-vignette {
        position: fixed; inset: 0; opacity: 0; transition: opacity 200ms;
        background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%);
      }
      .hud-vignette.is-boost {
        background: radial-gradient(ellipse at center, transparent 45%, rgba(51,204,255,0.4) 100%);
      }
      .hud-toasts {
        position: fixed; top: 18%; left: 50%; transform: translateX(-50%);
        display: flex; flex-direction: column; align-items: center; gap: 6px;
      }
      .hud-toast {
        padding: 6px 16px; border-radius: 999px; font-weight: 800; letter-spacing: 0.06em;
        background: rgba(10,12,18,0.7); animation: toast-in 2200ms ease-out forwards;
      }
      .hud-toast.is-good { color: #8df5a0; }
      .hud-toast.is-warn { color: #ff9a5e; }
      .hud-toast.is-final { color: #ffd75e; font-size: 26px; }
      @keyframes toast-in {
        0% { opacity: 0; transform: translateY(10px) scale(0.85); }
        10% { opacity: 1; transform: translateY(0) scale(1.05); }
        15%, 80% { opacity: 1; transform: scale(1); }
        100% { opacity: 0; transform: translateY(-8px); }
      }
      .hud-status { font-size: 13px; font-weight: 700; letter-spacing: 0.08em; min-height: 16px; }
      .hud-status.is-warn { color: #ff9a5e; }
      .hud-status.is-good { color: #8df5a0; }

      @media (prefers-reduced-motion: reduce) {
        .hud-stat.just-changed .hud-value,
        .hud-item.is-active,
        .hud-stat.gain .hud-value, .hud-stat.loss .hud-value,
        .hud-toast { animation: none; }
      }
    `;
    document.head.appendChild(style);
  }
}

/** Rough live position: rank by lap then last checkpoint cleared. */
function positionOf(snap: Snapshot, playerId: string): number {
  const ranked = [...snap.cars].sort(
    (a, b) => b.lap - a.lap || b.lastCheckpoint - a.lastCheckpoint,
  );
  return ranked.findIndex((c) => c.playerId === playerId) + 1;
}

/** 1 -> "1st", 2 -> "2nd", ... for places and positions. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

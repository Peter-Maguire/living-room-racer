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

    const lap = Math.min(me.lap + 1, RACE_LAPS);
    this.lapEl.textContent = `${lap}/${RACE_LAPS}`;
    const finalLap = lap === RACE_LAPS;
    this.lapEl.parentElement?.classList.toggle('is-final', finalLap);
    if (lap !== this.lastLap) {
      // Restart the pop animation by removing and re-adding the class.
      this.lapEl.parentElement?.classList.remove('just-changed');
      void this.lapEl.parentElement?.offsetWidth; // force reflow
      this.lapEl.parentElement?.classList.add('just-changed');
      this.lastLap = lap;
    }

    this.posEl.textContent = `${ordinal(positionOf(snap, me.playerId))}/${snap.cars.length}`;

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
      .hud-status { font-size: 13px; font-weight: 700; letter-spacing: 0.08em; min-height: 16px; }
      .hud-status.is-warn { color: #ff9a5e; }
      .hud-status.is-good { color: #8df5a0; }

      @media (prefers-reduced-motion: reduce) {
        .hud-stat.just-changed .hud-value,
        .hud-item.is-active { animation: none; }
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

import { carColor, type LobbyState, type RaceFinished } from '@racer/shared';
import { ordinal } from './hud.js';

/** Identity bits needed to render a player on the results screen. */
export interface PlayerMeta {
  displayName: string;
  colorIndex: number;
}

/**
 * DOM overlays for the pre-race lobby and the post-race results screen. These
 * sit above the three.js canvas and are shown/hidden by the client state
 * machine in main.ts based on the race phase.
 */
export class Overlay {
  private lobbyEl: HTMLDivElement;
  private resultsEl: HTMLDivElement;
  private readyBtn: HTMLButtonElement;
  private playerListEl: HTMLDivElement;
  private countdownEl: HTMLDivElement;
  private resultsBodyEl: HTMLDivElement;
  private trackSelectEl: HTMLSelectElement;
  private matchmakingEl: HTMLDivElement;
  private mmMessageEl: HTMLDivElement;
  private mmElapsedEl: HTMLDivElement;
  private mmRetryBtn: HTMLButtonElement;
  private mmSpinnerEl: HTMLDivElement;
  private ready = false;
  /** Last whole second shown, so the countdown animation retriggers once each. */
  private lastCountdownSec: number | null = null;

  constructor(
    container: HTMLElement,
    private readonly onReadyToggle: (ready: boolean) => void,
    private readonly onRematch: () => void,
    private readonly onSelectTrack: (trackId: string) => void,
    private readonly onRetryMatchmaking: () => void = () => {},
  ) {
    this.lobbyEl = document.createElement('div');
    this.lobbyEl.className = 'overlay lobby';
    this.lobbyEl.innerHTML = `
      <h1>Living-Room Racer</h1>
      <h2>Lobby</h2>
      <div class="player-list"></div>
      <label class="track-pick">Track: <select class="track-select"></select></label>
      <div class="countdown"></div>
      <button class="ready-btn">Ready up</button>
    `;
    this.playerListEl = this.lobbyEl.querySelector('.player-list')!;
    this.countdownEl = this.lobbyEl.querySelector('.countdown')!;
    this.readyBtn = this.lobbyEl.querySelector('.ready-btn')!;
    this.trackSelectEl = this.lobbyEl.querySelector('.track-select')!;
    this.trackSelectEl.addEventListener('change', () => {
      this.onSelectTrack(this.trackSelectEl.value);
    });
    this.readyBtn.addEventListener('click', () => {
      this.ready = !this.ready;
      this.readyBtn.textContent = this.ready ? 'Cancel ready' : 'Ready up';
      this.readyBtn.classList.toggle('is-ready', this.ready);
      this.onReadyToggle(this.ready);
    });

    this.resultsEl = document.createElement('div');
    this.resultsEl.className = 'overlay results';
    this.resultsEl.style.display = 'none';
    this.resultsEl.innerHTML = `
      <h1>Race Results</h1>
      <div class="results-body"></div>
      <button class="rematch-btn">Back to lobby</button>
    `;
    this.resultsBodyEl = this.resultsEl.querySelector('.results-body')!;
    this.resultsEl
      .querySelector('.rematch-btn')!
      .addEventListener('click', () => {
        this.ready = false;
        this.readyBtn.textContent = 'Ready up';
        this.readyBtn.classList.remove('is-ready');
        this.onRematch();
      });

    // Matchmaking screen: shown from page load until we're connected to a game
    // server, so the player always sees what's happening instead of a lobby
    // that looks frozen.
    this.matchmakingEl = document.createElement('div');
    this.matchmakingEl.className = 'overlay matchmaking';
    this.matchmakingEl.innerHTML = `
      <h1>Living-Room Racer</h1>
      <div class="mm-spinner"></div>
      <div class="mm-message">Starting up…</div>
      <div class="mm-elapsed"></div>
      <button class="mm-retry-btn" style="display:none">Try again</button>
    `;
    this.mmMessageEl = this.matchmakingEl.querySelector('.mm-message')!;
    this.mmElapsedEl = this.matchmakingEl.querySelector('.mm-elapsed')!;
    this.mmRetryBtn = this.matchmakingEl.querySelector('.mm-retry-btn')!;
    this.mmSpinnerEl = this.matchmakingEl.querySelector('.mm-spinner')!;
    this.mmRetryBtn.addEventListener('click', () => {
      this.mmRetryBtn.style.display = 'none';
      this.onRetryMatchmaking();
    });

    this.injectStyles();
    container.appendChild(this.matchmakingEl);
    container.appendChild(this.lobbyEl);
    container.appendChild(this.resultsEl);
  }

  /** Show matchmaking progress. `canRetry` reveals the retry button on failure. */
  showMatchmaking(
    message: string,
    elapsedSeconds?: number,
    canRetry = false,
  ): void {
    this.matchmakingEl.style.display = 'flex';
    this.lobbyEl.style.display = 'none';
    this.resultsEl.style.display = 'none';
    this.mmMessageEl.textContent = message;
    this.mmElapsedEl.textContent =
      elapsedSeconds != null && elapsedSeconds > 0 ? `${elapsedSeconds}s` : '';
    this.mmRetryBtn.style.display = canRetry ? '' : 'none';
    // Hide the spinner once we've stopped waiting on something.
    this.mmSpinnerEl.style.visibility = canRetry ? 'hidden' : 'visible';
  }

  showLobby(): void {
    this.matchmakingEl.style.display = 'none';
    this.lobbyEl.style.display = 'flex';
    this.resultsEl.style.display = 'none';
  }

  showRace(): void {
    this.matchmakingEl.style.display = 'none';
    this.lobbyEl.style.display = 'none';
    this.resultsEl.style.display = 'none';
  }

  showResults(
    result: RaceFinished,
    localId: string | undefined,
    meta: Map<string, PlayerMeta>,
  ): void {
    this.matchmakingEl.style.display = 'none';
    this.lobbyEl.style.display = 'none';
    this.resultsEl.style.display = 'flex';
    this.resultsBodyEl.innerHTML = result.results
      .map((r, i) => {
        const m = meta.get(r.playerId);
        const color = carColor(m?.colorIndex ?? 0).css;
        const name = m?.displayName ?? 'Racer';
        const you = r.playerId === localId ? ' (you)' : '';
        const best = r.bestLapMs > 0 ? `${(r.bestLapMs / 1000).toFixed(2)}s` : '—';
        const total = r.totalMs > 0 ? `${(r.totalMs / 1000).toFixed(2)}s` : '—';
        // Staggered entrance so rows land in finishing order.
        return `
          <div class="result-row${r.playerId === localId ? ' is-you' : ''}" style="animation-delay:${i * 90}ms">
            <span class="place">${ordinal(r.place)}</span>
            <span class="swatch" style="background:${color}"></span>
            <span class="who">${escapeHtml(name)}${you}</span>
            <span class="times"><span class="t-best">best ${best}</span><span class="t-total">total ${total}</span></span>
          </div>`;
      })
      .join('');
  }

  updateLobby(lobby: LobbyState, localId: string | undefined): void {
    this.playerListEl.innerHTML = lobby.players
      .map((p) => {
        const color = carColor(p.colorIndex);
        const you = p.playerId === localId ? ' (you)' : '';
        const badge = p.ready ? '✓ ready' : '… not ready';
        return `
          <div class="player-row${p.playerId === localId ? ' is-you' : ''}">
            <span class="swatch" style="background:${color.css}"></span>
            <span class="who">${escapeHtml(p.displayName)}${you}</span>
            <span class="color-name">${color.name}</span>
            <span class="badge${p.ready ? ' is-ready' : ''}">${badge}</span>
          </div>`;
      })
      .join('');

    // Populate the track picker once (options are stable), then reflect the
    // server's active track without clobbering an in-progress selection.
    if (this.trackSelectEl.options.length !== lobby.availableTracks.length) {
      this.trackSelectEl.innerHTML = lobby.availableTracks
        .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
        .join('');
    }
    if (document.activeElement !== this.trackSelectEl) {
      this.trackSelectEl.value = lobby.activeTrackId;
    }

    if (lobby.countdownMs != null) {
      const secs = Math.ceil(lobby.countdownMs / 1000);
      const label = secs > 0 ? String(secs) : 'GO!';
      // Only rewrite (and so restart the pop animation) when the digit changes;
      // lobby state arrives every tick during the countdown.
      if (secs !== this.lastCountdownSec) {
        this.countdownEl.innerHTML = `<span class="count-num${secs <= 0 ? ' is-go' : ''}">${label}</span>`;
        this.lastCountdownSec = secs;
      }
      this.countdownEl.classList.add('is-active');
    } else {
      if (this.lastCountdownSec !== null) {
        this.countdownEl.innerHTML = '';
        this.lastCountdownSec = null;
      }
      this.countdownEl.classList.remove('is-active');
    }
  }

  private injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      .overlay {
        position: absolute; inset: 0; z-index: 10;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 12px; color: #fff; background: rgba(10, 12, 18, 0.82);
        font-family: system-ui, sans-serif; text-align: center;
      }
      .overlay h1 { margin: 0; font-size: 32px; }
      .overlay h2 { margin: 0; font-weight: 400; opacity: 0.8; }
      .player-list, .results-body { min-width: 340px; display: flex; flex-direction: column; gap: 6px; }
      .player-row, .result-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 14px; background: rgba(255,255,255,0.08); border-radius: 8px;
      }
      .player-row.is-you, .result-row.is-you {
        background: rgba(255,255,255,0.16);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25);
      }
      /* Car colour chip: the link between a name here and a car on the track. */
      .swatch {
        width: 14px; height: 14px; border-radius: 4px; flex: 0 0 auto;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 0 8px rgba(255,255,255,0.15);
      }
      .who { flex: 1 1 auto; text-align: left; }
      .color-name { font-size: 11px; opacity: 0.5; letter-spacing: 0.06em; }
      .badge { font-size: 12px; opacity: 0.7; min-width: 78px; text-align: right; }
      .badge.is-ready { color: #8df5a0; opacity: 1; }

      .result-row { animation: row-in 320ms ease-out both; }
      @keyframes row-in {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .result-row .place { font-weight: 700; min-width: 42px; text-align: left; }
      .result-row .times { display: flex; flex-direction: column; font-size: 11px; opacity: 0.75; text-align: right; }

      /* --- matchmaking screen --- */
      .mm-message { font-size: 18px; opacity: 0.95; max-width: 30rem; line-height: 1.45; }
      .mm-elapsed { font-size: 14px; opacity: 0.6; min-height: 20px; font-variant-numeric: tabular-nums; }
      .mm-spinner {
        width: 34px; height: 34px; border-radius: 50%;
        border: 3px solid rgba(255,255,255,0.18);
        border-top-color: #ffd75e;
        animation: mm-spin 0.9s linear infinite;
      }
      @keyframes mm-spin { to { transform: rotate(360deg); } }

      .countdown { min-height: 64px; display: flex; align-items: center; justify-content: center; }
      .count-num {
        display: inline-block; font-size: 56px; font-weight: 800; color: #ffd75e;
        text-shadow: 0 2px 18px rgba(255, 215, 94, 0.5);
        animation: count-pop 420ms ease-out;
      }
      .count-num.is-go { color: #8df5a0; text-shadow: 0 2px 22px rgba(141, 245, 160, 0.6); }
      @keyframes count-pop {
        0% { transform: scale(1.8); opacity: 0.2; }
        100% { transform: scale(1); opacity: 1; }
      }

      .track-pick { font-size: 15px; opacity: 0.9; }
      .track-select {
        margin-left: 6px; padding: 6px 10px; border-radius: 8px;
        border: 0; background: rgba(255,255,255,0.12); color: #fff; font-size: 15px;
      }
      /*
       * The native dropdown popup is rendered by the OS and does NOT inherit the
       * translucent background above -- it falls back to white, leaving white
       * text on white. Give the options an explicit opaque dark background.
       */
      .track-select option { background: #1a1d26; color: #fff; }
      .overlay button {
        margin-top: 8px; padding: 12px 28px; font-size: 16px; cursor: pointer;
        border: 0; border-radius: 10px; background: #3388ff; color: #fff;
        transition: background 140ms ease, transform 140ms ease;
      }
      .overlay button:hover { background: #4a97ff; transform: translateY(-1px); }
      .overlay button.is-ready { background: #2fa84f; }
      .overlay button.is-ready:hover { background: #38c25d; }

      @media (prefers-reduced-motion: reduce) {
        .count-num, .result-row { animation: none; }
        .overlay button:hover { transform: none; }
      }
    `;
    document.head.appendChild(style);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

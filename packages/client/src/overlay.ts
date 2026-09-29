import type { LobbyState, RaceFinished } from '@racer/shared';

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
  private ready = false;

  constructor(
    container: HTMLElement,
    private readonly onReadyToggle: (ready: boolean) => void,
    private readonly onRematch: () => void,
  ) {
    this.lobbyEl = document.createElement('div');
    this.lobbyEl.className = 'overlay lobby';
    this.lobbyEl.innerHTML = `
      <h1>Living-Room Racer</h1>
      <h2>Lobby</h2>
      <div class="player-list"></div>
      <div class="countdown"></div>
      <button class="ready-btn">Ready up</button>
    `;
    this.playerListEl = this.lobbyEl.querySelector('.player-list')!;
    this.countdownEl = this.lobbyEl.querySelector('.countdown')!;
    this.readyBtn = this.lobbyEl.querySelector('.ready-btn')!;
    this.readyBtn.addEventListener('click', () => {
      this.ready = !this.ready;
      this.readyBtn.textContent = this.ready ? 'Cancel ready' : 'Ready up';
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
        this.onRematch();
      });

    this.injectStyles();
    container.appendChild(this.lobbyEl);
    container.appendChild(this.resultsEl);
  }

  showLobby(): void {
    this.lobbyEl.style.display = 'flex';
    this.resultsEl.style.display = 'none';
  }

  showRace(): void {
    this.lobbyEl.style.display = 'none';
    this.resultsEl.style.display = 'none';
  }

  showResults(result: RaceFinished, localId: string | undefined): void {
    this.lobbyEl.style.display = 'none';
    this.resultsEl.style.display = 'flex';
    this.resultsBodyEl.innerHTML = result.results
      .map((r) => {
        const you = r.playerId === localId ? ' (you)' : '';
        const best = r.bestLapMs > 0 ? `${(r.bestLapMs / 1000).toFixed(2)}s` : '—';
        return `<div class="result-row"><span>P${r.place}${you}</span><span>best ${best}</span></div>`;
      })
      .join('');
  }

  updateLobby(lobby: LobbyState, localId: string | undefined): void {
    this.playerListEl.innerHTML = lobby.players
      .map((p) => {
        const you = p.playerId === localId ? ' (you)' : '';
        const badge = p.ready ? '✓ ready' : '… not ready';
        return `<div class="player-row"><span>${escapeHtml(p.displayName)}${you}</span><span>${badge}</span></div>`;
      })
      .join('');

    if (lobby.countdownMs != null) {
      const secs = Math.ceil(lobby.countdownMs / 1000);
      this.countdownEl.textContent = secs > 0 ? `Starting in ${secs}…` : 'GO!';
    } else {
      this.countdownEl.textContent = '';
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
      .player-list, .results-body { min-width: 280px; display: flex; flex-direction: column; gap: 6px; }
      .player-row, .result-row {
        display: flex; justify-content: space-between;
        padding: 8px 14px; background: rgba(255,255,255,0.08); border-radius: 8px;
      }
      .countdown { min-height: 22px; font-size: 20px; color: #ffd75e; }
      .overlay button {
        margin-top: 8px; padding: 12px 28px; font-size: 16px; cursor: pointer;
        border: 0; border-radius: 10px; background: #3388ff; color: #fff;
      }
      .overlay button:hover { background: #4a97ff; }
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

import type { Snapshot, Track } from '@racer/shared';

const SIZE = 170;
const PAD = 12;

/**
 * Top-down minimap drawn on a 2D canvas. The outline is the track's recovery
 * spline (the same centerline the physics uses), and each car is a dot in its
 * server-assigned palette colour, so a dot maps to a car by colour alone.
 */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private outline: Path2D | null = null;
  private lineWidth = 8;
  private scale = 1;
  private offX = 0;
  private offZ = 0;

  constructor(container: HTMLElement) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE * dpr;
    this.canvas.height = SIZE * dpr;
    this.canvas.style.cssText = `
      position:absolute; right:12px; bottom:12px; z-index:5;
      width:${SIZE}px; height:${SIZE}px; pointer-events:none;
      background:rgba(10,12,18,0.55); border-radius:12px;
      backdrop-filter:blur(6px);`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unsupported');
    ctx.scale(dpr, dpr);
    this.ctx = ctx;
    container.appendChild(this.canvas);
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? 'block' : 'none';
  }

  /** Fit the track's spline into the canvas and cache its outline path. */
  setTrack(track: Track): void {
    const pts = track.recoverySpline.map((p) => p.position);
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    // A fixed, thin stroke: drawing the true corridor width at this scale would
    // be wide enough to clip at the canvas edge and fill in tight loops.
    this.lineWidth = 7;
    const pad = PAD + this.lineWidth / 2;
    const inner = SIZE - pad * 2;
    this.scale = inner / Math.max(maxX - minX, maxZ - minZ, 1);
    // Centre the shorter axis within the square.
    this.offX = pad + (inner - (maxX - minX) * this.scale) / 2 - minX * this.scale;
    this.offZ = pad + (inner - (maxZ - minZ) * this.scale) / 2 - minZ * this.scale;

    const path = new Path2D();
    pts.forEach((p, i) => {
      const [x, y] = this.project(p.x, p.z);
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
    this.outline = path;
  }

  private project(x: number, z: number): [number, number] {
    return [x * this.scale + this.offX, z * this.scale + this.offZ];
  }

  draw(
    snap: Snapshot,
    localId: string | undefined,
    colorFor: (playerId: string) => string,
  ): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (this.outline) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = this.lineWidth;
      ctx.stroke(this.outline);
    }
    // Draw the local car last so it's never hidden under a rival.
    const cars = [...snap.cars].sort(
      (a, b) => Number(a.playerId === localId) - Number(b.playerId === localId),
    );
    for (const c of cars) {
      const [x, y] = this.project(c.position.x, c.position.z);
      const local = c.playerId === localId;
      ctx.beginPath();
      ctx.arc(x, y, local ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = colorFor(c.playerId);
      ctx.globalAlpha = c.phase === 'recovering' ? 0.4 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (local) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    }
  }
}

/**
 * Self-contained top-down SVG of a track's centerline, for the lobby's track
 * preview. Same projection idea as the minimap, but emitted as markup.
 */
export function trackPreviewSvg(track: Track, size = 120): string {
  const pts = track.recoverySpline.map((p) => p.position);
  const xs = pts.map((p) => p.x);
  const zs = pts.map((p) => p.z);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...zs) - minZ, 1);
  const pad = 10;
  const s = (size - pad * 2) / span;
  const w = (Math.max(...xs) - minX) * s;
  const h = (Math.max(...zs) - minZ) * s;
  const d = pts
    .map((p, i) => {
      const x = pad + (size - pad * 2 - w) / 2 + (p.x - minX) * s;
      const y = pad + (size - pad * 2 - h) / 2 + (p.z - minZ) * s;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><path d="${d}Z" fill="none" stroke="rgba(255,255,255,0.75)" stroke-width="6" stroke-linejoin="round"/></svg>`;
}

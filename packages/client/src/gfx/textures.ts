import * as THREE from 'three';

/**
 * Procedural textures, drawn once on 2D canvases. There is no art pipeline yet,
 * so everything the game needs to look like a real living room (floorboards,
 * carpet, tile, fabric...) is generated here. All textures are deterministic
 * (seeded) and tile seamlessly where they are meant to repeat.
 *
 * World-scale convention: road textures cover a fixed number of metres per tile
 * (see TILE_METRES) and the road mesh UVs are in metres / tile size, so texel
 * density is the same on a wide road and a narrow one.
 */

/** Seeded RNG so every client generates identical textures. */
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;

export interface TexOpts {
  /** Repeat in both directions (default true). */
  repeat?: boolean;
  /** Colour data (sRGB) vs. data (linear). Default sRGB. */
  srgb?: boolean;
  anisotropy?: number;
}

function canvasTexture(w: number, h: number, draw: (ctx: Ctx, w: number, h: number) => void, opts: TexOpts = {}): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unsupported');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  if (opts.srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat !== false) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = opts.anisotropy ?? 4;
  tex.needsUpdate = true;
  return tex;
}

/** Fill the canvas with random speckles, wrapping at the edges so it tiles. */
function speckle(ctx: Ctx, w: number, h: number, r: () => number, count: number, colors: string[], maxSize = 2): void {
  for (let i = 0; i < count; i++) {
    const x = r() * w;
    const y = r() * h;
    const s = 0.5 + r() * maxSize;
    ctx.fillStyle = colors[Math.floor(r() * colors.length)]!;
    for (const dx of [0, -w, w]) {
      for (const dy of [0, -h, h]) ctx.fillRect(x + dx, y + dy, s, s);
    }
  }
}

/** Metres of road covered by one road texture tile. */
export const TILE_METRES = { asphalt: 4, tile: 2, rug: 2.5, cushion: 3, wood: 3 } as const;

/** Dark grippy play-mat asphalt. */
export function asphaltTexture(): THREE.CanvasTexture {
  const r = rng(11);
  return canvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#4b4c56';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, r, 9000, ['#3e3f47', '#555660', '#5c5d67', '#45464e'], 2.2);
    speckle(ctx, w, h, r, 500, ['#5a5b63', '#25262c'], 3);
  });
}

/** Glossy bathroom/kitchen tile with grout. */
export function tileTexture(): THREE.CanvasTexture {
  const r = rng(23);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#9ba6b6';
    ctx.fillRect(0, 0, w, h);
    const n = 2; // 2x2 tiles per texture
    const s = w / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const shade = 168 + Math.floor(r() * 26);
        ctx.fillStyle = `rgb(${shade - 12},${shade},${shade + 14})`;
        ctx.fillRect(i * s + 3, j * s + 3, s - 6, s - 6);
        // soft highlight corner, like a glazed tile
        const g = ctx.createLinearGradient(i * s, j * s, i * s + s, j * s + s);
        g.addColorStop(0, 'rgba(255,255,255,0.28)');
        g.addColorStop(0.5, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(i * s + 3, j * s + 3, s - 6, s - 6);
      }
    }
    ctx.strokeStyle = '#6d7785'; // grout
    ctx.lineWidth = 6;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath(); ctx.moveTo(i * s, 0); ctx.lineTo(i * s, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * s); ctx.lineTo(w, i * s); ctx.stroke();
    }
  });
}

/** Woven bathmat / rug. */
export function rugTexture(): THREE.CanvasTexture {
  const r = rng(37);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#9a4a3a';
    ctx.fillRect(0, 0, w, h);
    // Weave: alternating over/under threads.
    const step = 8;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const over = ((x / step + y / step) & 1) === 0;
        const base = over ? 140 : 104;
        const v = base + Math.floor(r() * 26);
        ctx.fillStyle = `rgb(${v + 50},${Math.floor(v * 0.45)},${Math.floor(v * 0.36)})`;
        if (over) ctx.fillRect(x, y + 1, step, step - 2);
        else ctx.fillRect(x + 1, y, step - 2, step);
      }
    }
    // A woven stripe motif so the pattern reads as a rug at a glance.
    ctx.fillStyle = 'rgba(245,225,190,0.35)';
    ctx.fillRect(0, 0, w, 12);
    ctx.fillRect(0, h / 2 - 6, w, 12);
  });
}

/** Quilted sofa fabric. */
export function cushionTexture(): THREE.CanvasTexture {
  const r = rng(41);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#6b567a';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, r, 4500, ['#5d4a6c', '#7a6589', '#66517a'], 2);
    // Diamond quilting stitches.
    ctx.strokeStyle = 'rgba(30,20,40,0.55)';
    ctx.lineWidth = 2.5;
    const s = 64;
    for (let i = -h; i < w + h; i += s) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(i, h); ctx.lineTo(i + h, 0); ctx.stroke();
    }
    // Puffiness: a soft highlight at each diamond centre.
    for (let i = 0; i < w; i += s) {
      for (let j = 0; j < h; j += s) {
        const g = ctx.createRadialGradient(i + s / 2, j + s / 2, 2, i + s / 2, j + s / 2, s / 2);
        g.addColorStop(0, 'rgba(255,255,255,0.12)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(i, j, s, s);
      }
    }
  });
}

/** Wooden planks (used for a road surface and, scaled up, the room floor). */
export function woodTexture(planks = 4, seed = 53, dark = false): THREE.CanvasTexture {
  const r = rng(seed);
  const size = 512;
  return canvasTexture(size, size, (ctx, w, h) => {
    const ph = h / planks;
    for (let p = 0; p < planks; p++) {
      // Each row is made of 2 boards with a staggered seam.
      const seam = Math.floor(r() * w * 0.6 + w * 0.2);
      for (const [x0, x1] of [[0, seam], [seam, w]] as const) {
        const tone = (dark ? 84 : 118) + Math.floor(r() * 30);
        ctx.fillStyle = `rgb(${tone + 22},${Math.floor(tone * 0.8)},${Math.floor(tone * 0.58)})`;
        ctx.fillRect(x0, p * ph, x1 - x0, ph);
        // grain
        for (let g = 0; g < 26; g++) {
          const gy = p * ph + r() * ph;
          ctx.strokeStyle = `rgba(${40 + r() * 30},${20 + r() * 20},10,${0.08 + r() * 0.14})`;
          ctx.lineWidth = 0.6 + r() * 1.6;
          ctx.beginPath();
          ctx.moveTo(x0, gy);
          ctx.bezierCurveTo(x0 + (x1 - x0) * 0.3, gy + (r() - 0.5) * 5, x0 + (x1 - x0) * 0.7, gy + (r() - 0.5) * 5, x1, gy + (r() - 0.5) * 3);
          ctx.stroke();
        }
        // the occasional knot
        if (r() < 0.35) {
          const kx = x0 + r() * (x1 - x0);
          const ky = p * ph + ph * (0.3 + r() * 0.4);
          const kg = ctx.createRadialGradient(kx, ky, 1, kx, ky, 9);
          kg.addColorStop(0, 'rgba(50,25,10,0.8)');
          kg.addColorStop(1, 'rgba(50,25,10,0)');
          ctx.fillStyle = kg;
          ctx.fillRect(kx - 10, ky - 10, 20, 20);
        }
      }
      // board edges
      ctx.fillStyle = "rgba(20,10,5,0.4)";
      ctx.fillRect(0, p * ph, w, 2);
      ctx.fillRect(seam - 1, p * ph, 2, ph);
    }
  });
}

/** Spilled milk: ragged white splatter with soft alpha, for the milk slick overlay. */
export function milkTexture(): THREE.CanvasTexture {
  const r = rng(67);
  return canvasTexture(512, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    // Many overlapping translucent blobs form an irregular pool.
    for (let i = 0; i < 160; i++) {
      const x = r() * w;
      const y = h * (0.12 + r() * 0.76);
      const rad = 14 + r() * 34;
      const g = ctx.createRadialGradient(x, y, 1, x, y, rad);
      g.addColorStop(0, 'rgba(250,248,240,0.55)');
      g.addColorStop(0.7, 'rgba(250,248,240,0.35)');
      g.addColorStop(1, 'rgba(250,248,240,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // Glossy highlights.
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(r() * w, h * (0.2 + r() * 0.6), 5 + r() * 14, 2 + r() * 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }, { repeat: false });
}

/** Red/white rumble-strip stripes for the road edge (1 stripe pair along U). */
export function curbTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 32, (ctx, w, h) => {
    ctx.fillStyle = '#e8e8ec';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#d2382f';
    ctx.fillRect(w / 2, 0, w / 2, h);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, h - 4, w, 4);
  });
}

/** Dashed centre line, for floor-surface tracks. */
export function dashTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 16, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(235,235,240,0.55)';
    ctx.fillRect(0, 3, w / 2, h - 6);
  });
}

/** Black-and-white checkerboard for the start/finish line. */
export function checkerTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 32, (ctx, w, h) => {
    const cell = 16;
    for (let x = 0; x < w / cell; x++) {
      for (let y = 0; y < h / cell; y++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#f4f4f6' : '#15151a';
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }, { repeat: false });
}

/** A "?" item box face. */
export function itemBoxTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#ffd45a');
    g.addColorStop(1, '#e89a1e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(120,60,0,0.6)';
    ctx.lineWidth = 6;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.fillStyle = '#fff8e0';
    ctx.strokeStyle = '#8a4a00';
    ctx.lineWidth = 5;
    ctx.font = 'bold 92px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText('?', w / 2, h / 2 + 6);
    ctx.fillText('?', w / 2, h / 2 + 6);
  }, { repeat: false });
}

/** Colourful cereal-box front: bands and a sunburst, tinted per instance. */
export function cerealTexture(): THREE.CanvasTexture {
  const r = rng(79);
  return canvasTexture(128, 192, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f2c14e';
    ctx.fillRect(0, 0, w, 34);
    ctx.fillStyle = '#d94f3d';
    ctx.fillRect(0, h - 26, w, 26);
    // sunburst
    ctx.translate(w / 2, h * 0.5);
    for (let i = 0; i < 14; i++) {
      ctx.rotate((Math.PI * 2) / 14);
      ctx.fillStyle = i % 2 ? '#ffe9a8' : '#ffb347';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-10, -52); ctx.lineTo(10, -52); ctx.closePath(); ctx.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // "cereal" bits
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = ['#8a5a2b', '#c88a3e', '#e3b162'][Math.floor(r() * 3)]!;
      ctx.beginPath(); ctx.arc(r() * w, h * 0.5 + (r() - 0.5) * 80, 3 + r() * 4, 0, Math.PI * 2); ctx.fill();
    }
  }, { repeat: false });
}

/** Soft round shadow for under cars. */
export function blobShadowTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }, { repeat: false, srgb: false });
}

/** Soft round puff, for smoke and sparks. */
export function puffTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }, { repeat: false });
}

/** Dark rubber streak for skid marks (alpha across the width fades at the edges). */
export function skidTexture(): THREE.CanvasTexture {
  return canvasTexture(16, 16, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(10,10,12,0)');
    g.addColorStop(0.5, 'rgba(10,10,12,0.75)');
    g.addColorStop(1, 'rgba(10,10,12,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }, { repeat: false, srgb: false });
}

/** Everything the scene needs, built once. */
export interface Textures {
  asphalt: THREE.Texture;
  tile: THREE.Texture;
  rug: THREE.Texture;
  cushion: THREE.Texture;
  roadWood: THREE.Texture;
  floorWood: THREE.Texture;
  milk: THREE.Texture;
  curb: THREE.Texture;
  dash: THREE.Texture;
  checker: THREE.Texture;
  itemBox: THREE.Texture;
  cereal: THREE.Texture;
  blob: THREE.Texture;
  puff: THREE.Texture;
  skid: THREE.Texture;
}

export function buildTextures(maxAnisotropy = 4): Textures {
  const t: Textures = {
    asphalt: asphaltTexture(),
    tile: tileTexture(),
    rug: rugTexture(),
    cushion: cushionTexture(),
    roadWood: woodTexture(4, 53, false),
    floorWood: woodTexture(4, 91, false),
    milk: milkTexture(),
    curb: curbTexture(),
    dash: dashTexture(),
    checker: checkerTexture(),
    itemBox: itemBoxTexture(),
    cereal: cerealTexture(),
    blob: blobShadowTexture(),
    puff: puffTexture(),
    skid: skidTexture(),
  };
  for (const tex of Object.values(t)) tex.anisotropy = Math.min(maxAnisotropy, 8);
  return t;
}

export function disposeTextures(t: Textures): void {
  for (const tex of Object.values(t)) tex.dispose();
}

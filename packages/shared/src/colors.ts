/**
 * The car colour palette. Lives in `shared` because the SERVER assigns colours
 * (authoritatively, so every client agrees on who is who) while the CLIENT
 * renders them — both sides must index the same list.
 *
 * Selection criteria:
 *  - Distinguishable from each other at small on-screen size, since cars are
 *    only a couple of metres long under a steep top-down camera.
 *  - Distinguishable from the scene: the floor is green and the track ribbon is
 *    dark grey, so no greens and nothing near-black.
 *  - Colour-blind aware: no pairing that relies on red-vs-green alone to tell
 *    two cars apart (red and orange are separated by several slots, and differ
 *    in brightness as well as hue).
 */

export interface CarColor {
  /** Packed RGB for three.js materials. */
  hex: number;
  /** CSS colour for DOM swatches in the lobby/results/HUD. */
  css: string;
  /** Human-readable name, usable in UI and callouts ("the Mint car"). */
  name: string;
}

/**
 * Palette entries, one per grid slot. Exactly MAX_PLAYERS long so a full race
 * never repeats a colour.
 */
export const CAR_COLORS: readonly CarColor[] = [
  { hex: 0x3d9bff, css: '#3d9bff', name: 'Sky' },
  { hex: 0xff8c1a, css: '#ff8c1a', name: 'Tangerine' },
  { hex: 0x21d0c3, css: '#21d0c3', name: 'Mint' },
  { hex: 0xff4fa3, css: '#ff4fa3', name: 'Bubblegum' },
  { hex: 0xffd93d, css: '#ffd93d', name: 'Sunbeam' },
  { hex: 0xa56bff, css: '#a56bff', name: 'Grape' },
  { hex: 0xff4d4d, css: '#ff4d4d', name: 'Cherry' },
  { hex: 0xe8eaf0, css: '#e8eaf0', name: 'Chalk' },
];

/**
 * Resolve a palette entry by index, wrapping if the index is out of range.
 * Wrapping (rather than throwing) keeps a bad/legacy index from breaking
 * rendering — worst case two cars share a colour.
 */
export function carColor(index: number): CarColor {
  const n = CAR_COLORS.length;
  const i = ((Math.trunc(index) % n) + n) % n;
  return CAR_COLORS[i]!;
}

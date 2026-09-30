import { buildTrack, type Pt } from './build.js';

/**
 * "Kitchen Tile Sprint" — a squared-off circuit on a glossy tile floor, with a
 * spilled-milk slick across the second corner. The whole road is mildly
 * slippery (tile), so braking early and smooth steering pay off; the milk turns
 * that up to a full slide. First track to use surface grip.
 */
const POINTS: Pt[] = [
  [4, 10], [10, 10], [14, 10], [18.2, 8.2], [20, 4], // start straight, corner 1
  [20, -4], [18.2, -8.2], [14, -10], // right side, corner 2 (the milk)
  [6, -10], [-6, -10], [-14, -10], [-18.2, -8.2], [-20, -4], // top straight, corner 3
  [-20, 4], [-18.2, 8.2], [-14, 10], // left side, corner 4
  [-6, 10],
];

export const KITCHEN_TILE_TRACK = buildTrack({
  id: 'kitchen-tile-sprint',
  name: 'Kitchen Tile Sprint',
  points: POINTS,
  halfWidth: 3,
  checkpointCount: 10,
  pickups: [0.15, 0.5, 0.8],
  defaultSurface: 'tile',
  surfaces: [{ from: 0.25, to: 0.37, surface: 'milk' }],
});

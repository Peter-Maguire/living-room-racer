import { buildTrack, type Pt } from './build.js';

/**
 * "Bathmat Rally" — surface transitions are the whole gimmick. The road
 * alternates between a grippy (but draggy) bathmat and slick bathroom tile, so
 * the car's behaviour changes mid-corner: rug is slower but bites, tile is fast
 * but slides. Learn where the changes are and set up before them.
 */
const POINTS: Pt[] = [
  [0, 11], [8, 11], [16, 11], [23.8, 7.8], [27, 0], [23.8, -7.8],
  [16, -11], [8, -11], [0, -8], [-8, -11], [-16, -11],
  [-23.8, -7.8], [-27, 0], [-23.8, 7.8], [-16, 11], [-8, 11],
];

export const BATHMAT_TRACK = buildTrack({
  id: 'bathmat-rally',
  name: 'Bathmat Rally',
  points: POINTS,
  halfWidth: 3,
  checkpointCount: 10,
  pickups: [0.12, 0.38, 0.62, 0.88],
  defaultSurface: 'tile',
  surfaces: [
    { from: 0.95, to: 0.2, surface: 'rug' }, // start line through the first bend
    { from: 0.5, to: 0.7, surface: 'rug' }, // the far hairpin
  ],
});

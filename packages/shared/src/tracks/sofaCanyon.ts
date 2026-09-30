import { buildTrack, type Pt } from './build.js';

/**
 * "Sofa Cushion Canyon" — a valley between the cushions. The road is fabric
 * (a little draggy), the two end caps and the pair of S-bends on the back leg
 * are banked so you can carry speed through them, and the backs of the seat
 * rise and dip gently underneath. The edges are soft: a wheel on the armrest
 * fabric is forgiven far longer than on the hard tracks.
 */
const POINTS: Pt[] = [
  [0, 12], [8, 12], [16, 12], // start/finish straight (heading +x)
  [24.5, 8.5], [28, 0], [24.5, -8.5], // right end cap (banked)
  [16, -12, 0.3], [8, -9, 0.9], [0, -12, 0.3], [-8, -15, 0.9], [-16, -12, 0.3], // the back seat, with S-bends
  [-24.5, -8.5], [-28, 0], [-24.5, 8.5], // left end cap (banked)
  [-16, 12], [-8, 12],
];

export const SOFA_CANYON_TRACK = buildTrack({
  id: 'sofa-cushion-canyon',
  name: 'Sofa Cushion Canyon',
  points: POINTS,
  halfWidth: 3.2,
  edgeGrace: 2.2, // soft fabric edges
  checkpointCount: 10,
  pickups: [0.13, 0.4, 0.62, 0.88],
  defaultSurface: 'cushion',
  banks: [
    { from: 0.11, to: 0.37, deg: 28 },
    { from: 0.42, to: 0.5, deg: 14 },
    { from: 0.51, to: 0.59, deg: 14 },
    { from: 0.63, to: 0.89, deg: 28 },
  ],
});

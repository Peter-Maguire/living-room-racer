import { buildTrack, type Pt } from './build.js';

/**
 * "Toy Box Scramble" — technical and low-speed. Building blocks form a
 * wiggling top row, then the road switches back and forth down the left side.
 * Narrower than the tabletop tracks, with the tightest turns in the set.
 */
const POINTS: Pt[] = [
  [6, 14], [14, 14], [21, 11], [24, 4], [22, -4], [17, -10], // out and up the right
  [9, -14], [2, -10], [-5, -14], [-12, -10], [-18, -10], // block chicanes on top
  [-24, -5], [-14, 0.5], [-24, 6], [-17, 11], // switchbacks down the left
  [-12, 14], [-4, 14], // run-in to the start line
];

export const TOY_BOX_TRACK = buildTrack({
  id: 'toy-box-scramble',
  name: 'Toy Box Scramble',
  points: POINTS,
  halfWidth: 2.6,
  checkpointCount: 12,
  pickups: [0.1, 0.3, 0.5, 0.7, 0.9],
});

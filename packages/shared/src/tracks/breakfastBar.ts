import { buildTrack, type Pt } from './build.js';

/**
 * "Breakfast Bar Circuit" — top-speed track. A long flat-out straight down the
 * counter, a wide hairpin around the fruit bowl, a flicked chicane between the
 * plates, and a second hairpin back onto the straight. Rewards holding boost.
 */
const POINTS: Pt[] = [
  [2, 12], [10, 12], [18, 12], // start/finish straight (heading +x)
  [22.2, 10.2], [24, 6], [22.2, 1.8], [18, 0], // right hairpin
  [10, -0.5], [3, -3.5], [-4, 0.5], [-10, -0.5], // chicane between the plates
  [-14, 0], [-18.2, 1.8], [-20, 6], [-18.2, 10.2], [-14, 12], // left hairpin
  [-6, 12],
];

export const BREAKFAST_BAR_TRACK = buildTrack({
  id: 'breakfast-bar-circuit',
  name: 'Breakfast Bar Circuit',
  points: POINTS,
  halfWidth: 3,
  checkpointCount: 10,
  pickups: [0.12, 0.4, 0.62, 0.85],
});

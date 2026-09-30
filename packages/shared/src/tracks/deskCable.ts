import { buildTrack, type Pt } from './build.js';

/**
 * "Desk Cable Run" — the narrowest road in the set. A flat start straight, then
 * a long weave between mugs and pen pots on the return leg. Precision over
 * speed: the corridor is 4 m wide, so sloppy lines mean a trip to the claw.
 */
const R = 11; // end-cap radius
const CAP_X = 16; // x of each end-cap centre

const POINTS: Pt[] = [
  [0, R], [8, R], [CAP_X, R], // start/finish straight (heading +x)
  [CAP_X + 7.8, 7.8], [CAP_X + R, 0], [CAP_X + 7.8, -7.8], // right end cap
  // Weaving return leg, one wave per 16 m.
  [16, -11], [12, -8.5], [8, -11], [4, -13.5], [0, -11], [-4, -8.5], [-8, -11], [-12, -13.5],
  [-16, -11],
  [-CAP_X - 7.8, -7.8], [-CAP_X - R, 0], [-CAP_X - 7.8, 7.8], // left end cap
  [-16, R], [-8, R],
];

export const DESK_CABLE_TRACK = buildTrack({
  id: 'desk-cable-run',
  name: 'Desk Cable Run',
  points: POINTS,
  halfWidth: 2,
  checkpointCount: 10,
  pickups: [0.2, 0.45, 0.7, 0.92],
});

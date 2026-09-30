import { buildTrack, type Pt } from './build.js';

/**
 * "Laundry Basket Loop" — a stadium whose two ends are upturned laundry
 * baskets. Each straight climbs a ramp into a steeply banked wall-ride hairpin
 * and drops back out the other side. The walls are steep enough that you have to
 * arrive with speed: drop below the minimum on the wall and the car slides off
 * and goes to the claw. The straights in between are plain floor, so the whole
 * skill is in the entries. Single level: the ramps and walls never overlap the
 * road in plan view.
 */
const H = 2.5; // height of the basket rims above the floor

const POINTS: Pt[] = [
  [6, 8, 0], [10, 8, 0], [14, 8, H * 0.5], [18, 8, H], // start straight, ramp up
  [23.7, 5.7, H], [26, 0, H], [23.7, -5.7, H], // right basket (wall)
  [18, -8, H], [13, -8, H * 0.5], [8, -8, 0], [0, -8, 0], [-8, -8, 0], [-13, -8, H * 0.5], // ramp down, flat, ramp up
  [-18, -8, H],
  [-23.7, -5.7, H], [-26, 0, H], [-23.7, 5.7, H], // left basket (wall)
  [-18, 8, H], [-13, 8, H * 0.5], [-8, 8, 0], [0, 8, 0], // ramp down, run-in
];

export const LAUNDRY_BASKET_TRACK = buildTrack({
  id: 'laundry-basket-loop',
  name: 'Laundry Basket Loop',
  points: POINTS,
  halfWidth: 3,
  checkpointCount: 10,
  pickups: [0.06, 0.35, 0.56, 0.85],
  banks: [
    { from: 0.09, to: 0.31, deg: 52, minSpeed: 9 },
    { from: 0.59, to: 0.81, deg: 52, minSpeed: 9 },
  ],
});

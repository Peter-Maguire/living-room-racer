/**
 * Random racer-name generator. Combines a first name with a racing-flavored
 * suffix, e.g. "ChrisSpeed", "NovaDrift", "AceNitro". Used as the default
 * display name so players get a fun identity without typing one.
 */

const FIRST_NAMES = [
  'Chris', 'Nova', 'Ace', 'Max', 'Rex', 'Zoe', 'Jax', 'Kai', 'Vic', 'Dash',
  'Luna', 'Bolt', 'Fin', 'Rio', 'Sky', 'Blaze', 'Neo', 'Cleo', 'Duke', 'Ivy',
];

const SUFFIXES = [
  'Speed', 'Drift', 'Nitro', 'Turbo', 'Blaze', 'Bolt', 'Racer', 'Vega',
  'Storm', 'Flash', 'Zoom', 'Rev', 'Dash', 'Fury', 'Boost', 'Slick',
];

/**
 * Generate a random racer name like "ChrisSpeed". Optionally pass a random
 * function for deterministic tests; defaults to Math.random.
 */
export function randomRacerName(rand: () => number = Math.random): string {
  const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)]!;
  const suffix = SUFFIXES[Math.floor(rand() * SUFFIXES.length)]!;
  return `${first}${suffix}`;
}

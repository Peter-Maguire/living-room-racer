import type { Track } from '../track.js';
import { OVAL_TRACK } from './oval.js';
import { FIGURE8_TRACK } from './figure8.js';

export { OVAL_TRACK } from './oval.js';
export { FIGURE8_TRACK } from './figure8.js';

/** All authored tracks, keyed by id. */
export const TRACKS: Record<string, Track> = {
  [OVAL_TRACK.id]: OVAL_TRACK,
  [FIGURE8_TRACK.id]: FIGURE8_TRACK,
};

/** Lightweight track listing for menus. */
export const TRACK_LIST = Object.values(TRACKS).map((t) => ({
  id: t.id,
  name: t.name,
}));

/** Resolve a track by id, falling back to the oval. */
export function getTrack(id: string | undefined): Track {
  return (id && TRACKS[id]) || OVAL_TRACK;
}

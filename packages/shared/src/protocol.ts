import { z } from 'zod';

/**
 * socket.io event names and payload schemas. The same schemas validate on both
 * ends. Client->server messages carry only INPUT and intent; the server is
 * authoritative for all world state.
 */

export const SocketEvents = {
  // client -> server
  JoinMatch: 'join_match',
  PlayerReady: 'player_ready',
  Input: 'input',
  // server -> client
  LobbyState: 'lobby_state',
  RaceStart: 'race_start',
  Snapshot: 'snapshot',
  RaceFinished: 'race_finished',
  Error: 'error_msg',
} as const;

/** Client presents its GameLift player session id when joining. */
export const joinMatchSchema = z.object({
  playerSessionId: z.string(),
  displayName: z.string().min(1).max(24),
  carSkin: z.string().default('default'),
});

export const playerReadySchema = z.object({ ready: z.boolean() });

export const inputSchema = z.object({
  seq: z.number().int().nonnegative(),
  throttle: z.number().min(-1).max(1),
  steer: z.number().min(-1).max(1),
  brake: z.number().min(0).max(1),
  drift: z.boolean(),
  useItem: z.boolean(),
});

export const lobbyStateSchema = z.object({
  players: z.array(
    z.object({
      playerId: z.string(),
      displayName: z.string(),
      carSkin: z.string(),
      ready: z.boolean(),
    }),
  ),
  countdownMs: z.number().nullable(),
});

export const raceFinishedSchema = z.object({
  results: z.array(
    z.object({
      playerId: z.string(),
      place: z.number().int().positive(),
      bestLapMs: z.number(),
      totalMs: z.number(),
    }),
  ),
});

export type JoinMatch = z.infer<typeof joinMatchSchema>;
export type PlayerReady = z.infer<typeof playerReadySchema>;
export type InputMessage = z.infer<typeof inputSchema>;
export type LobbyState = z.infer<typeof lobbyStateSchema>;
export type RaceFinished = z.infer<typeof raceFinishedSchema>;

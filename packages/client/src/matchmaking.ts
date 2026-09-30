import type { ClientConfig } from './config.js';

/** Where to connect a socket + the player session id to present on join. */
export interface GameConnection {
  /** socket.io URL, e.g. http://1.2.3.4:3001 */
  url: string;
  /** GameLift player session id the server validates, or a local placeholder. */
  playerSessionId: string;
}

/** Coarse phases of the matchmaking flow, for UI feedback. */
export type MatchmakingPhase =
  | 'requesting'
  | 'searching'
  | 'placing'
  | 'connecting'
  | 'failed';

export interface MatchmakingStatus {
  phase: MatchmakingPhase;
  /** Human-readable line to show the player. */
  message: string;
  /** Seconds spent searching so far. */
  elapsedSeconds?: number;
  /** Raw FlexMatch ticket status, when known (SEARCHING, PLACING, ...). */
  ticketStatus?: string;
}

export type StatusListener = (s: MatchmakingStatus) => void;

interface StatusResponse {
  status: string;
  connection: {
    ipAddress?: string;
    port?: number;
    dnsName?: string;
    playerSessionId?: string;
  } | null;
}

const POLL_INTERVAL_MS = 1500;
/**
 * Give up a bit after the server-side ticket timeout (60s) so we surface the
 * server's own TIMED_OUT status rather than our own generic timeout.
 */
const POLL_TIMEOUT_MS = 75_000;

/**
 * Resolve where to connect. Local dev connects straight to the configured game
 * server; a deployed client requests a FlexMatch ticket and polls until the
 * match is placed, then returns the game-session connection info.
 *
 * `onStatus` is called throughout so the UI can show progress instead of an
 * apparently-frozen lobby.
 */
export async function resolveConnection(
  config: ClientConfig,
  playerId: string,
  onStatus: StatusListener = () => {},
): Promise<GameConnection> {
  if (!config.useMatchmaking) {
    onStatus({ phase: 'connecting', message: 'Connecting to local server…' });
    return { url: config.gameServerUrl, playerSessionId: 'local-dev' };
  }
  return startMatchmaking(config.apiUrl, playerId, onStatus);
}

async function startMatchmaking(
  apiUrl: string,
  playerId: string,
  onStatus: StatusListener,
): Promise<GameConnection> {
  onStatus({ phase: 'requesting', message: 'Requesting a match…' });

  const startRes = await fetch(`${apiUrl}/matchmaking/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId }),
  });
  if (!startRes.ok) {
    // Surface the server's message (e.g. matchmaking not configured) verbatim.
    let detail = `HTTP ${startRes.status}`;
    try {
      const body = (await startRes.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch {
      /* keep the status-code fallback */
    }
    onStatus({ phase: 'failed', message: detail });
    throw new Error(detail);
  }

  const { ticketId } = (await startRes.json()) as { ticketId?: string };
  if (!ticketId) {
    const msg = 'Matchmaker did not return a ticket.';
    onStatus({ phase: 'failed', message: msg });
    throw new Error(msg);
  }

  const startedAt = Date.now();
  const deadline = startedAt + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

    const res = await fetch(
      `${apiUrl}/matchmaking/status?ticketId=${encodeURIComponent(ticketId)}`,
    );
    if (!res.ok) {
      onStatus({
        phase: 'searching',
        message: 'Looking for a race…',
        elapsedSeconds,
      });
      continue;
    }
    const data = (await res.json()) as StatusResponse;

    if (data.status === 'COMPLETED' && data.connection) {
      const { ipAddress, dnsName, port, playerSessionId } = data.connection;
      const host = dnsName ?? ipAddress;
      if (host && port && playerSessionId) {
        onStatus({ phase: 'connecting', message: 'Match found — connecting…' });
        return { url: `http://${host}:${port}`, playerSessionId };
      }
    }

    if (
      data.status === 'FAILED' ||
      data.status === 'CANCELLED' ||
      data.status === 'TIMED_OUT'
    ) {
      const msg =
        data.status === 'TIMED_OUT'
          ? 'No race found in time. Try again — or open a second browser so two players can match.'
          : `Matchmaking ${data.status.toLowerCase()}.`;
      onStatus({ phase: 'failed', message: msg, ticketStatus: data.status });
      throw new Error(msg);
    }

    onStatus({
      phase: data.status === 'PLACING' ? 'placing' : 'searching',
      message:
        data.status === 'PLACING'
          ? 'Match found — starting a game server…'
          : 'Looking for a race…',
      elapsedSeconds,
      ticketStatus: data.status,
    });
  }

  const msg = 'Matchmaking timed out. Try again.';
  onStatus({ phase: 'failed', message: msg });
  throw new Error(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

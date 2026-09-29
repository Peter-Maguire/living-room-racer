import type { ClientConfig } from './config.js';

/** Where to connect a socket + the player session id to present on join. */
export interface GameConnection {
  /** socket.io URL, e.g. http://1.2.3.4:3001 */
  url: string;
  /** GameLift player session id the server validates, or a local placeholder. */
  playerSessionId: string;
}

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
const POLL_TIMEOUT_MS = 60_000;

/**
 * Resolve where to connect. Local dev connects straight to the configured game
 * server; a deployed client requests a FlexMatch ticket and polls until the
 * match is placed, then returns the game-session connection info.
 */
export async function resolveConnection(
  config: ClientConfig,
  playerId: string,
): Promise<GameConnection> {
  if (!config.useMatchmaking) {
    return { url: config.gameServerUrl, playerSessionId: 'local-dev' };
  }
  return startMatchmaking(config.apiUrl, playerId);
}

async function startMatchmaking(
  apiUrl: string,
  playerId: string,
): Promise<GameConnection> {
  const startRes = await fetch(`${apiUrl}/matchmaking/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId }),
  });
  if (!startRes.ok) {
    throw new Error(`matchmaking start failed: ${startRes.status}`);
  }
  const { ticketId } = (await startRes.json()) as { ticketId?: string };
  if (!ticketId) throw new Error('no ticket id returned');

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(
      `${apiUrl}/matchmaking/status?ticketId=${encodeURIComponent(ticketId)}`,
    );
    if (!res.ok) continue;
    const data = (await res.json()) as StatusResponse;

    if (data.status === 'COMPLETED' && data.connection) {
      const { ipAddress, dnsName, port, playerSessionId } = data.connection;
      const host = dnsName ?? ipAddress;
      if (host && port && playerSessionId) {
        return { url: `http://${host}:${port}`, playerSessionId };
      }
    }
    if (data.status === 'FAILED' || data.status === 'CANCELLED' || data.status === 'TIMED_OUT') {
      throw new Error(`matchmaking ${data.status.toLowerCase()}`);
    }
  }
  throw new Error('matchmaking timed out');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Server runtime configuration, from CLI args then environment variables.
 *
 * `--port <n>` is supported because the Amazon GameLift Servers game server
 * wrapper launches the game server with the assigned port as a CLI argument
 * (see the wrapper's game-server-args config). CLI takes precedence over env.
 */

import type { ItemType } from '@racer/shared';

export interface ServerConfig {
  /** Port the game server listens on for socket.io connections. */
  port: number;
  /** When true, run under GameLift (wrapper-managed) rather than local dev. */
  useGameLift: boolean;
  /** Allowed CORS origin for the client (e.g. the CloudFront domain). */
  clientOrigin: string;
  /** Debug: every pickup pad gives this item (FORCE_ITEM=oil). Null = normal random rolls. */
  forceItem: ItemType | null;
}

/** Parse `--port 1234` or `--port=1234` from argv, if present. */
function portFromArgv(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n)) return n;
    }
    if (a.startsWith('--port=')) {
      const n = Number(a.slice('--port='.length));
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

export function loadConfig(): ServerConfig {
  const argvPort = portFromArgv(process.argv.slice(2));
  return {
    port: argvPort ?? Number(process.env.PORT ?? 3001),
    useGameLift: (process.env.USE_GAMELIFT ?? 'false') === 'true',
    clientOrigin: process.env.CLIENT_ORIGIN ?? '*',
    forceItem: parseForcedItem(process.env.FORCE_ITEM),
  };
}

const ITEMS: readonly string[] = ['boost', 'shock', 'dust', 'oil', 'tape', 'marble'];

/** FORCE_ITEM=oil etc. Unknown values are ignored (with a warning) rather than crashing. */
function parseForcedItem(raw: string | undefined): ItemType | null {
  if (!raw) return null;
  if (ITEMS.includes(raw)) return raw as ItemType;
  console.warn('[server] ignoring unknown FORCE_ITEM "' + raw + '" (expected one of ' + ITEMS.join(', ') + ')');
  return null;
}

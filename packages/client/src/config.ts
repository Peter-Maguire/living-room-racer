/** Client config, read from Vite env vars (VITE_*). Populated by infra outputs. */

export interface ClientConfig {
  /** Base URL of the HTTP API (matchmaking, auth, profiles). */
  apiUrl: string;
  /**
   * Direct game-server URL for LOCAL dev. Empty in deployed environments, where
   * the connection info comes from matchmaking instead (see useMatchmaking).
   */
  gameServerUrl: string;
  /**
   * When true, connect via the matchmaking flow (ticket -> poll -> connect).
   * When false (local dev), connect straight to gameServerUrl. Derived from
   * whether a direct game-server URL was provided.
   */
  useMatchmaking: boolean;
}

export function loadClientConfig(): ClientConfig {
  const gameServerUrl = import.meta.env.VITE_GAME_SERVER_URL ?? 'http://localhost:3001';
  return {
    apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:3000',
    gameServerUrl,
    // No direct server URL => rely on matchmaking (deployed env).
    useMatchmaking: gameServerUrl.trim() === '',
  };
}

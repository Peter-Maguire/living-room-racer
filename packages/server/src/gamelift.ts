/**
 * GameLift integration boundary.
 *
 * IMPORTANT ARCHITECTURE NOTE
 * ---------------------------
 * AWS does not publish a Node.js/JavaScript GameLift server SDK (the official
 * server SDKs are C++, C# and Go). So this Node game server cannot call
 * InitSDK/ProcessReady itself.
 *
 * Instead we deploy using the official Amazon GameLift Servers *game server
 * wrapper* (a Go binary). The wrapper owns the entire GameLift lifecycle —
 * InitSDK, ProcessReady, ActivateGameSession, health checks, termination — and
 * launches this Node process as a child, passing the assigned port via
 * `--port`. From this process's point of view there is nothing GameLift-specific
 * to do: it just listens and serves.
 *
 * CONSEQUENCE / KNOWN GAP: the wrapper does not support player session
 * management, so we cannot call AcceptPlayerSession to validate that a
 * connecting client holds a real matchmaking-issued player session. Player
 * session ids are therefore accepted without server-side verification. That is
 * a deliberate, documented tradeoff of the wrapper approach; closing it
 * requires a full server-SDK integration (i.e. a non-Node server process, or an
 * SDK sidecar).
 */

export interface GameLiftHooks {
  onStartGameSession: (session: { gameSessionId: string }) => void;
  onProcessTerminate: () => void;
}

export interface GameLiftAdapter {
  ready(port: number, hooks: GameLiftHooks): Promise<void>;
  acceptPlayerSession(playerSessionId: string): Promise<boolean>;
  removePlayerSession(playerSessionId: string): Promise<void>;
  endGameSession(): Promise<void>;
}

/**
 * Adapter used both locally and under the GameLift wrapper. In both cases this
 * process is simply a game server: the session is considered live as soon as we
 * are up, and player sessions are accepted without SDK validation (see note
 * above). SIGTERM is forwarded to the shutdown hook so the wrapper can drain us.
 */
export class WrappedGameLiftAdapter implements GameLiftAdapter {
  async ready(_port: number, hooks: GameLiftHooks): Promise<void> {
    // The wrapper has already told GameLift we're ready/active by the time our
    // process is launched, so start the match immediately.
    hooks.onStartGameSession({ gameSessionId: process.env.GAMELIFT_GAME_SESSION_ID ?? 'session' });

    // Let the wrapper (or a local Ctrl+C) shut us down cleanly.
    const shutdown = (): void => hooks.onProcessTerminate();
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  async acceptPlayerSession(_playerSessionId: string): Promise<boolean> {
    // Cannot be validated under the wrapper; accept and rely on the rest of the
    // server being authoritative for gameplay.
    return true;
  }

  async removePlayerSession(_playerSessionId: string): Promise<void> {}

  async endGameSession(): Promise<void> {}
}

/**
 * Both local dev and GameLift-hosted runs use the same adapter; the difference
 * is only who launches the process. Kept as a factory so callers don't change.
 */
export function createGameLiftAdapter(_useGameLift: boolean): GameLiftAdapter {
  return new WrappedGameLiftAdapter();
}

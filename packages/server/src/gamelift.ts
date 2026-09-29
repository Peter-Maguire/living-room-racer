/**
 * Thin adapter around the AWS GameLift Server SDK lifecycle, isolated so the
 * rest of the server never depends on GameLift directly. During local dev
 * (USE_GAMELIFT=false) a no-op implementation is used; with GameLift Anywhere
 * or a managed fleet, the real SDK integration lives here.
 *
 * Real integration (P4) wires: InitSDK -> ProcessReady({ port, callbacks }) ->
 * onStartGameSession -> ActivateGameSession; AcceptPlayerSession on connect;
 * RemovePlayerSession on disconnect; TerminateGameSession + ProcessEnding at end.
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

/** No-op adapter for local development without GameLift. */
export class LocalGameLiftAdapter implements GameLiftAdapter {
  async ready(_port: number, hooks: GameLiftHooks): Promise<void> {
    // Locally we immediately "start" a single session so devs can connect.
    hooks.onStartGameSession({ gameSessionId: 'local-session' });
  }
  async acceptPlayerSession(_playerSessionId: string): Promise<boolean> {
    return true; // Accept everyone locally.
  }
  async removePlayerSession(_playerSessionId: string): Promise<void> {}
  async endGameSession(): Promise<void> {}
}

/**
 * Minimal shape of the GameLift Server SDK 5.x (JavaScript) we depend on. The
 * real SDK is a downloadable package installed into the fleet build image, not
 * a plain public npm dependency, so we import it dynamically and type it
 * structurally. This keeps local dev (USE_GAMELIFT=false) building and running
 * without the SDK present, while the managed/Anywhere path uses the real one.
 */
interface GameLiftServerSdk {
  initSdk(params?: unknown): Promise<void>;
  processReady(params: {
    port: number;
    logParameters?: { logPaths: string[] };
    onStartGameSession: (session: { gameSessionId: string }) => void;
    onProcessTerminate: () => void;
    onHealthCheck: () => Promise<boolean>;
  }): Promise<void>;
  acceptPlayerSession(playerSessionId: string): Promise<void>;
  removePlayerSession(playerSessionId: string): Promise<void>;
  activateGameSession(): Promise<void>;
  terminateGameSession(): Promise<void>;
  processEnding(): Promise<void>;
  destroy?(): Promise<void>;
}

/**
 * The npm module id of the installed Server SDK. Kept in an env var so the
 * fleet build can point at whatever the downloaded package registers as,
 * without a hard compile-time dependency. Defaults to the common id.
 */
const SDK_MODULE = process.env.GAMELIFT_SDK_MODULE ?? '@aws/gamelift-server-sdk';

/**
 * Real GameLift integration. Lifecycle:
 *   initSdk() -> processReady({ port, callbacks }) -> (on prompt)
 *   onStartGameSession -> activateGameSession(); acceptPlayerSession on connect;
 *   removePlayerSession on disconnect; terminateGameSession + processEnding at
 *   end. onHealthCheck reports healthy while the process is up.
 */
export class AwsGameLiftAdapter implements GameLiftAdapter {
  private sdk: GameLiftServerSdk | null = null;
  private healthy = true;

  async ready(port: number, hooks: GameLiftHooks): Promise<void> {
    // Dynamic import so a missing SDK doesn't break local builds/runs.
    const mod = (await import(SDK_MODULE)) as
      | GameLiftServerSdk
      | { default: GameLiftServerSdk };
    this.sdk = 'initSdk' in mod ? mod : mod.default;

    await this.sdk.initSdk();
    await this.sdk.processReady({
      port,
      logParameters: { logPaths: ['/local/game/logs'] },
      onStartGameSession: async (session) => {
        // Let the match set up, then tell GameLift the session is live.
        hooks.onStartGameSession({ gameSessionId: session.gameSessionId });
        await this.sdk?.activateGameSession();
      },
      onProcessTerminate: async () => {
        this.healthy = false;
        hooks.onProcessTerminate();
        await this.endGameSession();
      },
      onHealthCheck: async () => this.healthy,
    });
  }

  async acceptPlayerSession(playerSessionId: string): Promise<boolean> {
    if (!this.sdk) return false;
    try {
      await this.sdk.acceptPlayerSession(playerSessionId);
      return true;
    } catch {
      // Unknown/expired/duplicate session id: reject the connection.
      return false;
    }
  }

  async removePlayerSession(playerSessionId: string): Promise<void> {
    try {
      await this.sdk?.removePlayerSession(playerSessionId);
    } catch {
      // Best-effort on disconnect.
    }
  }

  async endGameSession(): Promise<void> {
    if (!this.sdk) return;
    try {
      await this.sdk.terminateGameSession();
      await this.sdk.processEnding();
      await this.sdk.destroy?.();
    } catch {
      // Best-effort teardown.
    } finally {
      this.sdk = null;
    }
  }
}

export function createGameLiftAdapter(useGameLift: boolean): GameLiftAdapter {
  return useGameLift ? new AwsGameLiftAdapter() : new LocalGameLiftAdapter();
}

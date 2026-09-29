/** Server runtime configuration, sourced from environment variables. */

export interface ServerConfig {
  /** Port the game server listens on for socket.io connections. */
  port: number;
  /** When true, integrate the GameLift Server SDK lifecycle. */
  useGameLift: boolean;
  /** Allowed CORS origin for the client (e.g. the CloudFront domain). */
  clientOrigin: string;
}

export function loadConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT ?? 3001),
    useGameLift: (process.env.USE_GAMELIFT ?? 'false') === 'true',
    clientOrigin: process.env.CLIENT_ORIGIN ?? '*',
  };
}

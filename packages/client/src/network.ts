import { io, type Socket } from 'socket.io-client';
import {
  SocketEvents,
  type InputMessage,
  type JoinMatch,
  type LobbyState,
  type RaceFinished,
  type Snapshot,
} from '@racer/shared';

/**
 * Wraps the socket.io connection to a game server. Sends only input + intent;
 * receives authoritative snapshots, lobby state, and race results. Prediction/
 * reconciliation read the latest snapshot from here.
 */
export class NetworkClient {
  private socket: Socket | null = null;
  private latestSnapshot: Snapshot | null = null;
  private snapshotHandlers: ((snap: Snapshot) => void)[] = [];
  private lobbyHandlers: ((lobby: LobbyState) => void)[] = [];
  private finishedHandlers: ((result: RaceFinished) => void)[] = [];

  // The socket URL is not known until matchmaking resolves it, so the socket is
  // created in connect(), and event handlers can be registered beforehand.

  /** Subscribe to every snapshot as it arrives (for prediction/interpolation). */
  onSnapshot(handler: (snap: Snapshot) => void): void {
    this.snapshotHandlers.push(handler);
  }

  onLobby(handler: (lobby: LobbyState) => void): void {
    this.lobbyHandlers.push(handler);
  }

  onFinished(handler: (result: RaceFinished) => void): void {
    this.finishedHandlers.push(handler);
  }

  /** Connect to the resolved game-server URL and join with the given identity. */
  connect(url: string, join: JoinMatch): void {
    const socket = io(url, { autoConnect: false });
    this.socket = socket;

    socket.on(SocketEvents.Snapshot, (snap: Snapshot) => {
      this.latestSnapshot = snap;
      for (const h of this.snapshotHandlers) h(snap);
    });
    socket.on(SocketEvents.LobbyState, (lobby: LobbyState) => {
      for (const h of this.lobbyHandlers) h(lobby);
    });
    socket.on(SocketEvents.RaceFinished, (result: RaceFinished) => {
      for (const h of this.finishedHandlers) h(result);
    });
    socket.on(SocketEvents.Error, (err: { message: string }) => {
      console.error('[net] server error:', err.message);
    });

    // Register the connect handler BEFORE connecting so we never miss the
    // event (on localhost the socket can connect before a later-attached
    // listener runs). Re-emitting on every 'connect' also re-joins after a
    // reconnect, where socket.io assigns a new socket id.
    socket.on('connect', () => {
      socket.emit(SocketEvents.JoinMatch, join);
    });
    socket.connect();
  }

  sendInput(input: InputMessage): void {
    this.socket?.emit(SocketEvents.Input, input);
  }

  /** Toggle this player's ready state in the lobby. */
  sendReady(ready: boolean): void {
    this.socket?.emit(SocketEvents.PlayerReady, { ready });
  }

  getLatestSnapshot(): Snapshot | null {
    return this.latestSnapshot;
  }

  /** This client's socket id, which the server uses as the car's playerId. */
  getPlayerId(): string | undefined {
    return this.socket?.id;
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}

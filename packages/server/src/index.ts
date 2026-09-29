import { createServer } from 'node:http';
import { Server } from 'socket.io';
import {
  OVAL_TRACK,
  SocketEvents,
  inputSchema,
  joinMatchSchema,
  playerReadySchema,
  type LobbyState,
  type RaceFinished,
  type Snapshot,
} from '@racer/shared';
import { loadConfig } from './config.js';
import { createGameLiftAdapter } from './gamelift.js';
import { Match } from './match.js';

const config = loadConfig();

// The starter track, authored in the shared package so client and server agree.
const track = OVAL_TRACK;

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: config.clientOrigin, methods: ['GET', 'POST'] },
});

const gamelift = createGameLiftAdapter(config.useGameLift);

const match = new Match(
  track,
  (snap: Snapshot) => io.to('match').emit(SocketEvents.Snapshot, snap),
  (lobby: LobbyState) => io.to('match').emit(SocketEvents.LobbyState, lobby),
  (result: RaceFinished) => io.to('match').emit(SocketEvents.RaceFinished, result),
);

io.on('connection', (socket) => {
  socket.on(SocketEvents.JoinMatch, async (raw: unknown) => {
    const parsed = joinMatchSchema.safeParse(raw);
    if (!parsed.success) {
      socket.emit(SocketEvents.Error, { message: 'invalid join payload' });
      return;
    }
    const accepted = await gamelift.acceptPlayerSession(parsed.data.playerSessionId);
    if (!accepted) {
      socket.emit(SocketEvents.Error, { message: 'player session rejected' });
      socket.disconnect(true);
      return;
    }
    await socket.join('match');
    match.addPlayer(socket.id, parsed.data.displayName, parsed.data.carSkin);
  });

  socket.on(SocketEvents.PlayerReady, (raw: unknown) => {
    const parsed = playerReadySchema.safeParse(raw);
    if (!parsed.success) return;
    match.setReady(socket.id, parsed.data.ready);
  });

  socket.on(SocketEvents.Input, (raw: unknown) => {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return; // Silently drop malformed input.
    match.applyInput(socket.id, parsed.data);
  });

  socket.on('disconnect', async () => {
    match.removePlayer(socket.id);
    await gamelift.removePlayerSession(socket.id);
  });
});

async function main(): Promise<void> {
  await gamelift.ready(config.port, {
    onStartGameSession: () => {
      // Start the sim loop; it runs the lobby and gates the race on ready-up.
      match.start();
    },
    onProcessTerminate: () => {
      match.stop();
      httpServer.close();
    },
  });

  httpServer.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (gamelift=${config.useGameLift})`);
  });
}

void main();

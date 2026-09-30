import { createServer } from 'node:http';
import { Server } from 'socket.io';
import {
  OVAL_TRACK,
  SocketEvents,
  inputSchema,
  joinMatchSchema,
  playerReadySchema,
  selectTrackSchema,
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
    // Someone is here: stop any pending idle/empty shutdown.
    cancelScheduledShutdown();
  });

  socket.on(SocketEvents.PlayerReady, (raw: unknown) => {
    const parsed = playerReadySchema.safeParse(raw);
    if (!parsed.success) return;
    match.setReady(socket.id, parsed.data.ready);
  });

  socket.on(SocketEvents.SelectTrack, (raw: unknown) => {
    const parsed = selectTrackSchema.safeParse(raw);
    if (!parsed.success) return;
    match.setTrack(parsed.data.trackId);
  });

  socket.on(SocketEvents.Input, (raw: unknown) => {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return; // Silently drop malformed input.
    match.applyInput(socket.id, parsed.data);
  });

  socket.on('disconnect', async () => {
    match.removePlayer(socket.id);
    await gamelift.removePlayerSession(socket.id);
    scheduleShutdownIfEmpty();
  });
});

// --- game session lifecycle -------------------------------------------------
//
// A hosted game session occupies one of the fleet's limited container-group
// slots. If the process never exits, the session stays ACTIVE forever, the
// fleet fills up, and every later matchmaking ticket fails placement and TIMES
// OUT. So we must end the session once it's no longer in use.
//
// Under the GameLift wrapper we don't call the server SDK ourselves: the wrapper
// owns the lifecycle and reports the session as ended when our child process
// exits. Exiting is therefore the correct way to release the slot.
//
// Only active when hosted; locally we keep running so closing a browser tab
// doesn't kill your dev server.

/** Grace period after the last player leaves, to tolerate quick reconnects. */
const EMPTY_SHUTDOWN_MS = 30_000;
/** Safety net: if nobody ever joins, don't hold the slot forever. */
const NEVER_JOINED_TIMEOUT_MS = 5 * 60_000;

let shutdownTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function cancelScheduledShutdown(): void {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

function scheduleShutdownIfEmpty(): void {
  if (!config.useGameLift || shuttingDown) return;
  if (match.getPlayerCount() > 0) {
    cancelScheduledShutdown();
    return;
  }
  cancelScheduledShutdown();
  shutdownTimer = setTimeout(() => {
    if (match.getPlayerCount() === 0) {
      void shutdown('no players remaining');
    }
  }, EMPTY_SHUTDOWN_MS);
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  cancelScheduledShutdown();
  console.log(`[server] ending game session: ${reason}`);
  match.stop();
  await gamelift.endGameSession();
  httpServer.close();
  // Exiting releases the fleet's container-group slot for the next match.
  process.exit(0);
}

async function main(): Promise<void> {
  await gamelift.ready(config.port, {
    onStartGameSession: () => {
      // Start the sim loop; it runs the lobby and gates the race on ready-up.
      match.start();
      // Don't hold a slot indefinitely if the matched player never connects.
      if (config.useGameLift) {
        cancelScheduledShutdown();
        shutdownTimer = setTimeout(() => {
          if (match.getPlayerCount() === 0) {
            void shutdown('nobody joined the session');
          }
        }, NEVER_JOINED_TIMEOUT_MS);
      }
    },
    onProcessTerminate: () => {
      void shutdown('process terminate requested');
    },
  });

  httpServer.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (gamelift=${config.useGameLift})`);
  });
}

void main();

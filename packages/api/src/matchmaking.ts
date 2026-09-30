import {
  GameLiftClient,
  StartMatchmakingCommand,
  DescribeMatchmakingCommand,
} from '@aws-sdk/client-gamelift';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { badRequest, json, serverError } from './http.js';

/**
 * POST /matchmaking/start
 *
 * Creates a FlexMatch matchmaking ticket for the caller and returns the ticket
 * id. The client then polls (GET /matchmaking/status?ticketId=...) until the
 * match is placed, at which point it receives the game-session connection info
 * and a player session id to present to the game server.
 *
 * Body: { playerId: string, latencyMs?: Record<region, ms>, skill?: number }
 */
const client = new GameLiftClient({});
const CONFIG_NAME = process.env.MATCHMAKING_CONFIG ?? '';

interface StartBody {
  playerId: string;
  latencyMs?: Record<string, number>;
  skill?: number;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  // GameLift/FlexMatch is optional: the stacks are skipped when no real build id
  // is supplied. Report that clearly instead of failing as a server error.
  if (!CONFIG_NAME) {
    return json(503, {
      message:
        'Matchmaking is not configured in this environment (GameLift fleet not deployed). Play locally, or deploy with a GameLift build id.',
    });
  }

  // GET = status poll (uses query params, no body).
  if (event.requestContext.http.method === 'GET') {
    return describe(event);
  }

  let body: StartBody;
  try {
    body = JSON.parse(event.body ?? '{}') as StartBody;
  } catch {
    return badRequest('invalid JSON body');
  }
  if (!body.playerId) return badRequest('playerId required');

  try {
    const res = await client.send(
      new StartMatchmakingCommand({
        ConfigurationName: CONFIG_NAME,
        Players: [
          {
            PlayerId: body.playerId,
            PlayerAttributes:
              body.skill != null ? { skill: { N: body.skill } } : undefined,
            LatencyInMs: body.latencyMs,
          },
        ],
      }),
    );
    return json(202, {
      ticketId: res.MatchmakingTicket?.TicketId,
      status: res.MatchmakingTicket?.Status,
    });
  } catch (err) {
    return serverError(`matchmaking failed: ${(err as Error).message}`);
  }
}

/** GET /matchmaking/status?ticketId=... -> ticket status + connection info. */
async function describe(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const ticketId = event.queryStringParameters?.ticketId;
  if (!ticketId) return badRequest('ticketId required');

  try {
    const res = await client.send(
      new DescribeMatchmakingCommand({ TicketIds: [ticketId] }),
    );
    const ticket = res.TicketList?.[0];
    if (!ticket) return json(404, { message: 'ticket not found' });

    const conn = ticket.GameSessionConnectionInfo;
    return json(200, {
      status: ticket.Status,
      connection: conn
        ? {
            ipAddress: conn.IpAddress,
            port: conn.Port,
            dnsName: conn.DnsName,
            // The player session id this caller should present to the server.
            playerSessionId: conn.MatchedPlayerSessions?.[0]?.PlayerSessionId,
          }
        : null,
    });
  } catch (err) {
    return serverError(`status failed: ${(err as Error).message}`);
  }
}

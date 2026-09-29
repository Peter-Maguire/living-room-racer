import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { badRequest, json, serverError } from './http.js';

/**
 * GET /profile?playerId=...  -> the player's profile (created on first read).
 *
 * A minimal profile store over the Players DynamoDB table. Cosmetics and MMR
 * grow from here in P5. Player identity is trusted from Cognito at the gateway;
 * this handler treats playerId as authoritative input.
 */
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.PLAYERS_TABLE ?? '';

interface Profile {
  playerId: string;
  displayName: string;
  createdAt: string;
  wins: number;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  if (!TABLE) return serverError('players table not configured');

  const playerId = event.queryStringParameters?.playerId;
  if (!playerId) return badRequest('playerId required');

  try {
    const existing = await doc.send(
      new GetCommand({ TableName: TABLE, Key: { playerId } }),
    );
    if (existing.Item) {
      return json(200, existing.Item);
    }

    // First-seen player: create a default profile.
    const profile: Profile = {
      playerId,
      displayName: `Racer-${playerId.slice(0, 6)}`,
      createdAt: new Date().toISOString(),
      wins: 0,
    };
    await doc.send(new PutCommand({ TableName: TABLE, Item: profile }));
    return json(201, profile);
  } catch (err) {
    return serverError(`profile failed: ${(err as Error).message}`);
  }
}

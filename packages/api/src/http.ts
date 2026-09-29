import type { APIGatewayProxyResultV2 } from 'aws-lambda';

/** JSON response helper with permissive CORS (tightened at the gateway). */
export function json(
  statusCode: number,
  body: unknown,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify(body),
  };
}

export function badRequest(message: string): APIGatewayProxyResultV2 {
  return json(400, { message });
}

export function serverError(message: string): APIGatewayProxyResultV2 {
  return json(500, { message });
}

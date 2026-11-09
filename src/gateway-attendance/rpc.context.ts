import type { Response } from 'express';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ProblemException, responseHeaders } from '../http/problem';

export interface GatewayRpcContext {
  requestId: string;
  accessToken: string;
}

export function gatewayRpcContext(
  request: AuthenticatedRequest,
  response: Response,
): GatewayRpcContext {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');

  if (!match || match[1].length > 4096) {
    throw new ProblemException(401, 'TOKEN_INVALID', 'Invalid access token');
  }

  return {
    requestId: responseHeaders(request, response),
    accessToken: match[1],
  };
}

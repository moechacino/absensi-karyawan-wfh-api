import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemException } from '../http/problem';
import { AccessTokenService } from './access-token.service';
import type { Actor } from './access-token.service';

export type AuthenticatedRequest = Request & { actor: Actor };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: AccessTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header) {
      throw new ProblemException(
        401,
        'AUTHENTICATION_REQUIRED',
        'Authentication required',
      );
    }

    const match = /^Bearer ([^\s]+)$/i.exec(header);

    if (!match || match[1].length > 4096) {
      throw new ProblemException(401, 'TOKEN_INVALID', 'Invalid access token');
    }

    request.actor = await this.tokens.verify(match[1]);

    return true;
  }
}

@Injectable()
export class JsonBodyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (
      !request.is('application/json') ||
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body)
    ) {
      throw new ProblemException(
        400,
        'INVALID_REQUEST',
        'A JSON object body is required',
      );
    }

    return true;
  }
}

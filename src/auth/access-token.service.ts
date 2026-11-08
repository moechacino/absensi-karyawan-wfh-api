import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Clock } from '../runtime/clock';
import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { ProblemException } from '../http/problem';

import type { AccessGrant } from './auth.types';

export interface Actor {
  id: string;
  role: 'EMPLOYEE' | 'HRD';
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly clock: Clock,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  async issue(actor: Actor): Promise<AccessGrant> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const exp = iat + this.config.jwt.accessTtlSeconds;
    const accessToken = await this.jwt.signAsync(
      { role: actor.role, purpose: 'access', status: 'ACTIVE', iat, exp },
      {
        secret: this.config.jwt.secret,
        algorithm: this.config.jwt.algorithm,
        issuer: this.config.jwt.issuer,
        audience: this.config.jwt.audience,
        subject: actor.id,
        jwtid: randomUUID(),
      },
    );

    return {
      accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: this.config.jwt.accessTtlSeconds,
      expiresAt: new Date(exp * 1000).toISOString(),
      serverNow: new Date(iat * 1000).toISOString(),
    };
  }

  async verify(token: string): Promise<Actor> {
    try {
      const claims = await this.jwt.verifyAsync<Record<string, unknown>>(
        token,
        {
          secret: this.config.jwt.secret,
          algorithms: [this.config.jwt.algorithm],
          issuer: this.config.jwt.issuer,
          audience: this.config.jwt.audience,
          clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
        },
      );

      if (
        typeof claims.sub !== 'string' ||
        !uuid.test(claims.sub) ||
        typeof claims.jti !== 'string' ||
        !uuid.test(claims.jti) ||
        claims.purpose !== 'access' ||
        claims.status !== 'ACTIVE' ||
        (claims.role !== 'EMPLOYEE' && claims.role !== 'HRD') ||
        typeof claims.iat !== 'number' ||
        !Number.isInteger(claims.iat) ||
        typeof claims.exp !== 'number' ||
        !Number.isInteger(claims.exp) ||
        claims.exp - claims.iat !== this.config.jwt.accessTtlSeconds ||
        claims.iat > Math.floor(this.clock.now().getTime() / 1000)
      ) {
        throw new Error('Invalid claims');
      }

      return { id: claims.sub, role: claims.role as Actor['role'] };
    } catch (error) {
      const expired =
        error instanceof Error && error.name === 'TokenExpiredError';

      throw new ProblemException(
        401,
        expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
        'Access token invalid or expired',
      );
    }
  }
}

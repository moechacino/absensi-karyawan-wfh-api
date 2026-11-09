import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest } from './auth.guard';
import type { Actor } from './access-token.service';

import { ProblemException } from '../http/problem';

export function requireHr(actor: Actor): void {
  if (actor.role !== 'HRD') {
    throw new ProblemException(403, 'FORBIDDEN', 'HRD permission required');
  }
}

@Injectable()
export class HrGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    requireHr(context.switchToHttp().getRequest<AuthenticatedRequest>().actor);

    return true;
  }
}

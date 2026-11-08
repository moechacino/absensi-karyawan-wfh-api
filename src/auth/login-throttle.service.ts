import { Injectable } from '@nestjs/common';
import { Clock } from '../runtime/clock';
import { ProblemException } from '../http/problem';

@Injectable()
export class LoginThrottle {
  private readonly buckets = new Map<
    string,
    { count: number; until: number }
  >();

  constructor(private readonly clock: Clock) {}

  check(ip: string, email: string): void {
    const now = this.clock.now().getTime();

    for (const [key, bucket] of this.buckets) {
      if (bucket.until <= now) {
        this.buckets.delete(key);
      }
    }

    for (const [key, limit] of [
      [JSON.stringify([ip]), 30],
      [JSON.stringify([ip, email]), 10],
    ] as const) {
      let bucket = this.buckets.get(key);

      if (!bucket) {
        if (this.buckets.size >= 10000) {
          throw new ProblemException(
            429,
            'RATE_LIMITED',
            'Too many login attempts',
            { retryAfter: 60 },
          );
        }

        bucket = { count: 0, until: now + 60000 };
        this.buckets.set(key, bucket);
      }

      bucket.count++;

      if (bucket.count > limit) {
        throw new ProblemException(
          429,
          'RATE_LIMITED',
          'Too many login attempts',
          { retryAfter: Math.max(1, Math.ceil((bucket.until - now) / 1000)) },
        );
      }
    }
  }
}

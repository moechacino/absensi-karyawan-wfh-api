import { Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { ProblemException } from '../http/problem';

@Injectable()
export class EmptyCheckInPipe implements PipeTransform {
  transform(value: unknown): Record<string, never> {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length
    ) {
      throw new ProblemException(
        400,
        'VALIDATION_FAILED',
        'Check-in accepts only the photo',
      );
    }

    return {};
  }
}

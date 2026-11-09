import { ProblemException } from '../http/problem';

export type CalendarInstant = Date | string;

export function instant(value: CalendarInstant): Temporal.Instant {
  try {
    return value instanceof Date
      ? Temporal.Instant.fromEpochMilliseconds(value.getTime())
      : Temporal.Instant.from(value);
  } catch {
    throw new ProblemException(
      400,
      'VALIDATION_FAILED',
      'An explicit valid instant is required',
    );
  }
}

export function isoInstant(value: CalendarInstant): string {
  return instant(value).toString({ fractionalSecondDigits: 3 });
}

export function plainDate(value: string): Temporal.PlainDate {
  try {
    if (
      value.length !== 10 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value.startsWith('0000')
    ) {
      throw new RangeError();
    }

    return Temporal.PlainDate.from(value, { overflow: 'reject' });
  } catch {
    throw new ProblemException(
      400,
      'VALIDATION_FAILED',
      'A valid ISO date is required',
    );
  }
}

export function timeMinutes(value: string): number {
  if (value.length !== 5 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new ProblemException(
      400,
      'VALIDATION_FAILED',
      'A valid HH:mm time is required',
    );
  }

  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

export function supportedTimeZone(value: string): string {
  try {
    if (!/^[A-Za-z][A-Za-z0-9_+./-]{0,99}$/.test(value)) {
      throw new RangeError();
    }

    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    throw new ProblemException(
      422,
      'TIME_ZONE_INVALID',
      'Unsupported time zone',
    );
  }
}

export function dateAt(value: CalendarInstant, timeZone: string): string {
  return instant(value)
    .toZonedDateTimeISO(supportedTimeZone(timeZone))
    .toPlainDate()
    .toString();
}

export function addDate(value: string, days: number): string {
  return plainDate(plainDate(value).add({ days }).toString()).toString();
}

export function localInstant(
  date: string,
  time: string,
  timeZone: string,
): string {
  const day = plainDate(date);
  const zone = supportedTimeZone(timeZone);
  timeMinutes(time);

  try {
    return day
      .toPlainDateTime(time)
      .toZonedDateTime(zone, { disambiguation: 'reject' })
      .toInstant()
      .toString({ fractionalSecondDigits: 3 });
  } catch {
    throw new ProblemException(
      422,
      'INVALID_LOCAL_TIME',
      'Local time is ambiguous or does not exist',
    );
  }
}

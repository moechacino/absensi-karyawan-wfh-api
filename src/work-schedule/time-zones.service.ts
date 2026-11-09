import { Injectable } from '@nestjs/common';

import { Clock } from '../runtime/clock';
import type { TimeZoneChoices } from '../attendance-rpc/rpc.responses';
import type { TimeZonesInput } from '../attendance-rpc/rpc.inputs';
import { plainDate } from '../work-calendar/calendar-time';

@Injectable()
export class TimeZonesService {
  constructor(private readonly clock: Clock) {}

  list(input: TimeZonesInput): TimeZoneChoices {
    const date = input.atDate
      ? plainDate(input.atDate).toString()
      : this.clock.now().toISOString().slice(0, 10);
    const reference = Temporal.Instant.from(`${date}T12:00:00Z`);
    const q = input.q?.trim().toLowerCase().replaceAll('_', ' ') ?? '';
    const ids = [
      ...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']),
    ].sort();
    const items: TimeZoneChoices['items'] = [];

    for (const id of ids) {
      if (!id.toLowerCase().replaceAll('_', ' ').includes(q)) {
        continue;
      }

      const zoned = reference.toZonedDateTimeISO(id);
      const offsetMinutes = zoned.offsetNanoseconds / 60000000000;

      // The public display DTO cannot represent historical second-level/>14h offsets.

      if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840) {
        continue;
      }

      items.push({
        id,
        label: `${id.replaceAll('_', ' ')} (UTC${zoned.offset})`,
        offsetMinutes,
        referenceAt: reference.toString({ fractionalSecondDigits: 3 }),
      });
    }

    return { items };
  }
}

import type { ChangeImpact, Holiday } from '../attendance-rpc/rpc.responses';

export interface HolidayBatch {
  readonly year: number;
  readonly expectedVersion: number;
  readonly upsert: readonly Holiday[];
  readonly remove: readonly string[];
}

export function holidayCommand(input: HolidayBatch) {
  return {
    year: input.year,
    expectedVersion: input.expectedVersion,
    upsert: input.upsert
      .map(({ date, name, category }) => ({ date, name, category }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    remove: [...input.remove].sort(),
  };
}

export function holidayIssues(
  input: HolidayBatch,
  version: number,
  cutoff: string,
): ChangeImpact {
  const issues: ChangeImpact['issues'] = [];

  if (input.expectedVersion !== version) {
    issues.push({
      code: 'VERSION_CONFLICT',
      field: 'expectedVersion',
      message: 'Reload the holiday calendar before saving.',
    });
  }

  if (!input.upsert.length && !input.remove.length) {
    issues.push({
      code: 'HOLIDAY_BATCH_INVALID',
      field: 'upsert',
      message: 'Supply at least one change.',
    });
  }

  const seen = new Set<string>();

  for (const [field, dates] of [
    ['upsert', input.upsert.map((item) => item.date)],
    ['remove', input.remove],
  ] as const) {
    for (const [index, date] of dates.entries()) {
      const path =
        field === 'upsert' ? `upsert.${index}.date` : `remove.${index}`;

      if (seen.has(date)) {
        issues.push({
          code: 'DUPLICATE_DATE',
          field: path,
          message: 'Each date must appear only once across the batch.',
        });
      }

      seen.add(date);

      if (Number(date.slice(0, 4)) !== input.year) {
        issues.push({
          code: 'HOLIDAY_BATCH_INVALID',
          field: path,
          message: 'Date must belong to the requested year.',
        });
      }

      if (date < cutoff) {
        issues.push({
          code: 'PAST_DATE_IMMUTABLE',
          field: path,
          message: 'Past holiday dates cannot be changed.',
        });
      }
    }
  }

  return { canApply: issues.length === 0, issues };
}

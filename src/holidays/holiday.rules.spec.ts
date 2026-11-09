import { holidayCommand, holidayIssues } from './holiday.rules';
import type { HolidayBatch } from './holiday.rules';

const today = '2026-11-09';
const holiday = {
  date: today,
  name: 'Company day',
  category: 'COMPANY' as const,
};
const batch: HolidayBatch = {
  year: 2026,
  expectedVersion: 0,
  upsert: [holiday],
  remove: [],
};

describe('holiday batch rules', () => {
  it('allows today and future changes', () => {
    expect(
      holidayIssues({ ...batch, remove: ['2026-12-31'] }, 0, today),
    ).toEqual({ canApply: true, issues: [] });
  });

  it.each([
    [{ ...batch, upsert: [] }, 'HOLIDAY_BATCH_INVALID'],
    [{ ...batch, year: 2027 }, 'HOLIDAY_BATCH_INVALID'],
    [{ ...batch, upsert: [holiday, holiday] }, 'DUPLICATE_DATE'],
    [{ ...batch, remove: [today] }, 'DUPLICATE_DATE'],
    [{ ...batch, remove: ['2026-12-31', '2026-12-31'] }, 'DUPLICATE_DATE'],
    [
      { ...batch, upsert: [{ ...holiday, date: '2026-11-08' }] },
      'PAST_DATE_IMMUTABLE',
    ],
    [{ ...batch, remove: ['2026-11-08'] }, 'PAST_DATE_IMMUTABLE'],
    [{ ...batch, expectedVersion: 1 }, 'VERSION_CONFLICT'],
  ])('reports an advisory issue for %j', (input, code) => {
    expect(holidayIssues(input, 0, today)).toMatchObject({
      canApply: false,
      issues: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  it('canonicalizes order without mutating inputs or ignoring changed values', () => {
    const input = {
      ...batch,
      upsert: [{ ...holiday, date: '2026-12-01' }, holiday],
      remove: ['2026-12-31', '2026-12-30'],
    };
    const before = structuredClone(input);
    expect(holidayCommand(input)).toEqual(
      holidayCommand({
        ...input,
        upsert: input.upsert.toReversed(),
        remove: input.remove.toReversed(),
      }),
    );
    expect(input).toEqual(before);
    expect(holidayCommand(input)).not.toEqual(
      holidayCommand({ ...input, upsert: [{ ...holiday, name: 'Changed' }] }),
    );
  });
});

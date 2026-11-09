import {
  addDate,
  dateAt,
  instant,
  isoInstant,
  localInstant,
  plainDate,
  supportedTimeZone,
  timeMinutes,
} from './calendar-time';

describe('explicit calendar dates, instants and IANA zones', () => {
  it.each(['2024-02-29', '2000-02-29', '2026-12-31'])(
    'preserves a real date %s',
    (date) => {
      expect(plainDate(date).toString()).toBe(date);
    },
  );

  it.each([
    '2026-02-29',
    '1900-02-29',
    '2100-02-29',
    '2026-04-31',
    '2026-2-01',
    '2026-01-01T00:00:00Z',
    '0000-01-01',
  ])('rejects invalid/noncanonical dates %s', (date) => {
    expect(() => plainDate(date)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('does calendar arithmetic across leap, month and year boundaries', () => {
    expect(addDate('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDate('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDate('2027-01-01', -1)).toBe('2026-12-31');
  });

  it.each(['00:00', '08:00', '23:59'])(
    'uses strict HH:mm wall-clock times %s',
    (time) => {
      expect(timeMinutes(time)).toBe(
        Number(time.slice(0, 2)) * 60 + Number(time.slice(3)),
      );
    },
  );

  it.each(['24:00', '8:00', '08:60', '08:00:00', '08:00Z', '08:00\n'])(
    'rejects invalid wall-clock times %s',
    (time) => {
      expect(() => timeMinutes(time)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    },
  );

  it.each(['+07:00', '-08:00', 'UTC+7', 'Unsupported/Zone', ''])(
    'rejects offsets or unsupported zone identifiers %s',
    (zone) => {
      expect(() => supportedTimeZone(zone)).toThrow(
        expect.objectContaining({ code: 'TIME_ZONE_INVALID' }),
      );
    },
  );

  it('resolves Jakarta/Makassar explicitly and canonicalizes a supported alias', () => {
    expect(localInstant('2026-11-09', '08:00', 'Asia/Jakarta')).toBe(
      '2026-11-09T01:00:00.000Z',
    );
    expect(localInstant('2026-11-09', '08:00', 'Asia/Makassar')).toBe(
      '2026-11-09T00:00:00.000Z',
    );
    expect(supportedTimeZone('asia/jakarta')).toBe('Asia/Jakarta');
    expect(supportedTimeZone('UTC')).toBe('UTC');
    expect(dateAt('2026-11-08T16:30:00Z', 'Asia/Jakarta')).toBe('2026-11-08');
    expect(dateAt('2026-11-08T16:30:00Z', 'Asia/Makassar')).toBe('2026-11-09');
  });

  it.each([
    ['2026-03-08', '02:30', 'America/New_York'],
    ['2026-11-01', '01:30', 'America/New_York'],
    ['2026-10-04', '02:15', 'Australia/Lord_Howe'],
    ['2026-04-05', '01:45', 'Australia/Lord_Howe'],
    ['2011-12-30', '12:00', 'Pacific/Apia'],
    ['2018-11-04', '00:00', 'America/Sao_Paulo'],
  ])('rejects a gap/fold/skipped date at %s %s in %s', (date, time, zone) => {
    expect(() => localInstant(date, time, zone)).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCAL_TIME' }),
    );
  });

  it('requires explicit instant offsets and preserves millisecond precision', () => {
    expect(isoInstant('2026-11-09T08:00:00.001+07:00')).toBe(
      '2026-11-09T01:00:00.001Z',
    );
    expect(isoInstant(new Date('2026-11-09T01:00:00.999Z'))).toBe(
      '2026-11-09T01:00:00.999Z',
    );
    expect(() => instant('2026-11-09T08:00:00')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
    expect(() => instant(new Date(NaN))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});

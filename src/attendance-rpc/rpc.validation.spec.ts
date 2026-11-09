import { randomUUID } from 'node:crypto';

import { RpcException } from '@nestjs/microservices';

import { RpcValidationPipe } from './rpc.validation';
import {
  AttendanceDaysInput,
  EmptyInput,
  HolidayChangeInput,
  PageInput,
  ScheduleInput,
  TimeZonesInput,
} from './rpc.inputs';
import { validateEnvelope } from './rpc.guard';
import { boundedResponse } from './rpc.transport';
import { RPC_REQUEST_BYTES, RPC_RESPONSE_BYTES } from './rpc.config';

const pipe = new RpcValidationPipe();

const envelope = () => ({
  version: 1,
  requestId: randomUUID(),
  serviceCredential: 'a'.repeat(32),
  accessToken: 'jwt',
  input: {},
});

const validate = (value: unknown, metatype: typeof EmptyInput) =>
  pipe.transform(value, { type: 'body', metatype, data: 'input' });

describe('RPC boundary helpers', () => {
  it('rejects unsupported versions before a handler can run', () => {
    expect(() =>
      validateEnvelope({ ...envelope(), version: 2 }, 'attendance.v1.home.get'),
    ).toThrow(RpcException);
  });

  it('requires write keys without accepting them for reads', () => {
    expect(() =>
      validateEnvelope(envelope(), 'attendance.v1.schedule.change'),
    ).toThrow(RpcException);

    const write = { ...envelope(), idempotencyKey: randomUUID() };

    expect(validateEnvelope(write, 'attendance.v1.schedule.change')).toBe(
      write,
    );
    expect(() => validateEnvelope(write, 'attendance.v1.home.get')).toThrow(
      RpcException,
    );
  });

  it.each([
    null,
    [],
    'payload',
    { ...envelope(), actor: { role: 'HRD' } },
    { ...envelope(), requestId: 'bad' },
    { ...envelope(), input: [] },
  ])('rejects malformed or injected transport fields', (data) => {
    expect(() => validateEnvelope(data, 'attendance.v1.home.get')).toThrow(
      RpcException,
    );
  });

  it('bounds UTF-8 bytes in addition to the transport character cap', () => {
    expect(() =>
      validateEnvelope(
        { ...envelope(), input: { q: '漢'.repeat(RPC_REQUEST_BYTES / 2) } },
        'attendance.v1.time-zones.list',
      ),
    ).toThrow(RpcException);
  });

  it('permits only an empty object for empty inputs', async () => {
    await expect(validate({}, EmptyInput)).resolves.toEqual({});

    for (const input of [null, [], { injected: true }]) {
      await expect(validate(input, EmptyInput)).rejects.toThrow(RpcException);
    }
  });

  it('validates query scalars without implicit coercion, nulls or unknown fields', async () => {
    await expect(
      validate({ page: 2, pageSize: 100 }, PageInput),
    ).resolves.toMatchObject({ page: 2 });

    for (const input of [
      { page: '2' },
      { page: null },
      { page: 0 },
      { pageSize: 101 },
      { filesystemPath: '/private' },
    ]) {
      await expect(validate(input, PageInput)).rejects.toThrow(RpcException);
    }
  });

  it('enforces real date-only strings and search bounds', async () => {
    await expect(
      validate({ atDate: '2026-02-28', q: 'Asia' }, TimeZonesInput),
    ).resolves.toMatchObject({ q: 'Asia' });

    for (const atDate of ['2026-02-29', '2026-11-09T00:00:00Z', 'invalid']) {
      await expect(validate({ atDate }, TimeZonesInput)).rejects.toThrow(
        RpcException,
      );
    }

    await expect(
      validate({ from: '2026-02-30' }, AttendanceDaysInput),
    ).rejects.toThrow(RpcException);
    await expect(
      validate({ q: 'a'.repeat(161) }, TimeZonesInput),
    ).rejects.toThrow(RpcException);
  });

  it('validates schedule structure and nested holiday DTOs', async () => {
    const schedule = {
      expectedVersion: 0,
      workingDays: [1, 2],
      startTime: '08:00',
      endTime: '16:00',
      endDayOffset: 0,
      timeZone: 'Asia/Jakarta',
      effectiveFrom: '2026-11-10',
    };

    await expect(validate(schedule, ScheduleInput)).resolves.toMatchObject(
      schedule,
    );
    await expect(
      validate({ ...schedule, workingDays: [1, 1] }, ScheduleInput),
    ).rejects.toThrow(RpcException);

    const holiday = {
      year: 2026,
      expectedVersion: 0,
      upsert: [{ date: '2026-12-25', name: 'Holiday', category: 'PUBLIC' }],
      remove: [],
    };

    await expect(validate(holiday, HolidayChangeInput)).resolves.toMatchObject(
      holiday,
    );
    await expect(
      validate(
        { ...holiday, upsert: [{ ...holiday.upsert[0], path: '/private' }] },
        HolidayChangeInput,
      ),
    ).rejects.toThrow(RpcException);
  });

  it('returns a bounded fault instead of oversized or unserializable responses', () => {
    const normal = { id: 'request', response: { items: [] } };

    expect(boundedResponse(normal)).toBe(normal);
    expect(
      boundedResponse({
        id: 'request',
        response: 'a'.repeat(RPC_RESPONSE_BYTES),
      }),
    ).toMatchObject({
      id: 'request',
      err: { code: 'RPC_RESPONSE_TOO_LARGE' },
      isDisposed: true,
    });
    expect(boundedResponse({ id: 'request', response: 1n })).toMatchObject({
      err: { code: 'RPC_INTERNAL_ERROR' },
    });
  });
});

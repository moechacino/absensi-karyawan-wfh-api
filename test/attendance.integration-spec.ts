import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { AttendanceEntity, FileObjectEntity } from '../src/database/entities';
import { fingerprint } from '../src/idempotency/fingerprint';
import { createHash } from 'node:crypto';
import { attendanceApps, control } from './attendance-fixture';
import type { AttendanceApps, AttendanceWritten } from './attendance-fixture';
import { processMessage } from './file-handoff.helpers';

describe('production attendance HTTP → separate TCP process → MySQL', () => {
  let apps: AttendanceApps;

  beforeAll(async () => {
    apps = await attendanceApps();
  });
  beforeEach(async () => {
    await apps.reset();
  });
  afterEach(async () => {
    await apps.clean();
  });
  afterAll(async () => {
    await apps?.close();
  });

  it('serves advisory home, commits a photo-backed check-in, then closes and replays checkout', async () => {
    expect(apps.attendance.pid).not.toBe(apps.gateway.pid);
    expect((await apps.home()).body.day).toMatchObject({
      status: 'NOT_CHECKED_IN',
      canCheckIn: true,
    });
    const first = await apps
      .checkIn()
      .expect(201)
      .expect('Idempotency-Replayed', 'false');
    apps.captures.push({ schema: 'Attendance', body: first.body });
    expect(first.body).toMatchObject({
      employeeId: apps.ids.employee,
      state: 'WORKING',
      checkInAt: '2026-11-09T01:00:00.001Z',
      lateSeconds: 1,
      punctuality: 'LATE',
      version: 1,
    });
    expect(await apps.snapshotCounts()).toEqual({
      records: 1,
      receipts: 1,
      files: 2,
    });
    expect((await apps.home()).body.day).toMatchObject({
      status: 'WORKING',
      canCheckOut: true,
      canCheckIn: false,
    });
    const bytes = await request(apps.base)
      .get(first.body.photo.contentPath)
      .set('Authorization', apps.owner)
      .expect(200);
    expect(bytes.body).toEqual(apps.png);
    await apps.setTime('2026-11-09T01:00:02.000Z');
    const key = randomUUID();
    const closed = await apps.checkOut(first.body.id, 1, key).expect(200);
    apps.captures.push({ schema: 'Attendance', body: closed.body });
    expect(closed.body).toMatchObject({
      state: 'COMPLETED',
      durationSeconds: 1,
      version: 2,
      schedule: first.body.schedule,
      photo: first.body.photo,
    });
    expect((await apps.home()).body.day).toMatchObject({
      status: 'COMPLETED',
      canCheckOut: false,
      canCheckIn: false,
    });
    await apps.setTime('2026-11-09T01:00:03.000Z');
    const replay = await apps
      .checkOut(first.body.id, 1, key)
      .expect(200)
      .expect('Idempotency-Replayed', 'true');
    expect(replay.body).toEqual(closed.body);
    await apps.checkOut(first.body.id, 1, key, apps.other).expect(404);
    await apps
      .checkOut(first.body.id, 2)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('ALREADY_CHECKED_OUT'));
    expect(await apps.snapshotCounts()).toEqual({
      records: 1,
      receipts: 2,
      files: 2,
    });
  });

  it('replays check-in using the original photo/time even after checkout and rejects changed image bytes', async () => {
    const key = randomUUID();
    const first = await apps.checkIn(key).expect(201);
    await apps.setTime('2026-11-09T01:00:05.000Z');
    await apps.checkOut(first.body.id).expect(200);
    await apps
      .checkIn(key)
      .expect(201)
      .expect('Idempotency-Replayed', 'true')
      .expect(({ body }) => expect(body).toEqual(first.body));
    await apps
      .checkIn(key, apps.differentPng)
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED'));
    await apps
      .checkIn()
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('ALREADY_CHECKED_IN'));
    expect(await readdir(apps.root)).toEqual([first.body.photo.id + '.png']);
    expect(await apps.snapshotCounts()).toEqual({
      records: 1,
      receipts: 2,
      files: 2,
    });
  });

  it('serializes duplicate fresh keys and competing checkout versions against real MySQL', async () => {
    const attempts = await Promise.all([apps.checkIn(), apps.checkIn()]);
    expect(
      attempts
        .map((result) => result.status)
        .sort((left, right) => left - right),
    ).toEqual([201, 409]);
    const first = attempts.find((result) => result.status === 201)!;
    const closes = await Promise.all([
      apps.checkOut(first.body.id),
      apps.checkOut(first.body.id),
    ]);
    expect(
      closes.map((result) => result.status).sort((left, right) => left - right),
    ).toEqual([200, 409]);
    expect(await apps.snapshotCounts()).toEqual({
      records: 1,
      receipts: 2,
      files: 2,
    });
    expect(await readdir(apps.root)).toEqual([first.body.photo.id + '.png']);
  });

  it('coordinates checkout of yesterday with a fresh check-in without two open records', async () => {
    const first = await apps.checkIn().expect(201);
    await apps.setTime('2026-11-10T01:00:00.001Z');
    const [closed, attempted] = await Promise.all([
      apps.checkOut(first.body.id),
      apps.checkIn(),
    ]);
    expect(closed.status).toBe(200);
    expect([201, 409]).toContain(attempted.status);

    if (attempted.status === 409) {
      await apps.checkIn().expect(201);
    }

    expect(
      await apps.source.manager.countBy(AttendanceEntity, {
        openEmployeeId: apps.ids.employee,
      }),
    ).toBe(1);
    expect(await apps.snapshotCounts()).toEqual({
      records: 2,
      receipts: 3,
      files: 3,
    });
    expect(await readdir(apps.root)).toHaveLength(2);
  });

  it('recovers a committed check-in after its TCP reply is lost', async () => {
    const key = randomUUID();
    await control(apps.attendance, { dropReply: true });
    await apps
      .checkIn(key)
      .expect(503)
      .expect(({ body }) =>
        expect(body.code).toBe('ATTENDANCE_OUTCOME_UNKNOWN'),
      );
    const row = await apps.source.manager.findOneByOrFail(AttendanceEntity, {
      employeeId: apps.ids.employee,
    });
    expect(await readFile(join(apps.root, row.photoFileId + '.png'))).toEqual(
      apps.png,
    );
    await apps.setTime('2026-11-09T01:00:05.000Z');
    await apps
      .checkIn(key)
      .expect(201)
      .expect('Idempotency-Replayed', 'true')
      .expect(({ body }) =>
        expect(body.checkInAt).toBe(row.checkInAt.toISOString()),
      );
    expect(await apps.snapshotCounts()).toEqual({
      records: 1,
      receipts: 1,
      files: 2,
    });
    expect(await readdir(apps.root)).toEqual([row.photoFileId + '.png']);
  });

  it('retains a timed-out in-flight photo; UNKNOWN is not rollback and replay preserves the pre-close upload receipt', async () => {
    await apps.setTime('2026-11-09T08:59:59.999Z');
    const token = await apps.token();
    const key = randomUUID();
    await control(apps.attendance, { hold: true });
    const written = processMessage<AttendanceWritten>(
      apps.attendance,
      'attendance-written',
      (message) => message.employeeId === apps.ids.employee,
    );
    const pending = apps.checkIn(key, apps.png, token).expect(503);
    const result = pending.then((reply) => reply);
    const uncommitted = await written;
    await result;
    expect(
      await apps.source.manager.countBy(FileObjectEntity, {
        id: uncommitted.fileId,
      }),
    ).toBe(0);
    expect(
      await readFile(join(apps.root, uncommitted.fileId + '.png')),
    ).toEqual(apps.png);
    const client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: {
        host: '127.0.0.1',
        port: Number(apps.env.ATTENDANCE_RPC_PORT),
      },
    });

    try {
      const outcome = await firstValueFrom(
        client
          .send('attendance.v1.command-outcome', {
            version: 1,
            requestId: randomUUID(),
            serviceCredential: process.env.ATTENDANCE_RPC_CREDENTIAL,
            accessToken: token.slice(7),
            input: {
              operation: 'checkIn',
              key,
              fingerprint: fingerprint({}, [
                {
                  field: 'photo',
                  sha256: createHash('sha256').update(apps.png).digest('hex'),
                },
              ]),
            },
          })
          .pipe(timeout(2000)),
      );
      expect(outcome).toEqual({ state: 'UNKNOWN' });
    } finally {
      client.close();
    }

    await apps.setTime('2026-11-09T09:00:00.001Z');
    await control(apps.attendance, { hold: false });
    const deadline = Date.now() + 4000;

    while (
      (await apps.source.manager.countBy(AttendanceEntity, {
        id: uncommitted.id,
      })) === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await apps
      .checkIn(key, apps.png, token)
      .expect(201)
      .expect('Idempotency-Replayed', 'true')
      .expect(({ body }) =>
        expect(body.checkInAt).toBe('2026-11-09T08:59:59.999Z'),
      );
    expect(
      await readFile(join(apps.root, uncommitted.fileId + '.png')),
    ).toEqual(apps.png);
    expect(await apps.snapshotCounts()).toEqual({
      records: 1,
      receipts: 1,
      files: 2,
    });
  });

  it('rejects malformed fields, missing keys, missing/oversized/malformed photos and wrong checkout ownership', async () => {
    await request(apps.base)
      .post('/api/v1/me/attendances/check-in')
      .set('Authorization', apps.owner)
      .attach('photo', apps.png, 'photo.png')
      .expect(400);
    await apps.checkIn('invalid-key').expect(400);
    await request(apps.base)
      .post('/api/v1/me/attendances/check-in')
      .set('Authorization', apps.owner)
      .set('Idempotency-Key', randomUUID())
      .field('employeeId', apps.ids.otherEmployee)
      .attach('photo', apps.png, 'photo.png')
      .expect(400);
    await request(apps.base)
      .post('/api/v1/me/attendances/check-in')
      .set('Authorization', apps.owner)
      .set('Idempotency-Key', randomUUID())
      .field('checkInAt', '2020-01-01T00:00Z')
      .expect(400);
    await request(apps.base)
      .post('/api/v1/me/attendances/check-in')
      .set('Authorization', apps.owner)
      .set('Idempotency-Key', randomUUID())
      .set('Content-Type', 'multipart/form-data; boundary=empty')
      .send('--empty--\r\n')
      .expect(422);
    await apps.checkIn(randomUUID(), Buffer.from('invalid')).expect(422);
    await apps.checkIn(randomUUID(), Buffer.alloc(5242881)).expect(413);
    await request(apps.base)
      .post('/api/v1/me/attendances/check-in')
      .set('Authorization', apps.owner)
      .send({})
      .expect(415);
    expect(await readdir(apps.root)).toEqual([]);
    expect(await apps.snapshotCounts()).toEqual({
      records: 0,
      receipts: 0,
      files: 1,
    });
    const first = await apps.checkIn().expect(201);
    await apps.checkOut(first.body.id, 1, randomUUID(), apps.hr).expect(404);
    await apps
      .checkOut(first.body.id, 0)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('VERSION_CONFLICT'));
    await request(apps.base)
      .post(`/api/v1/me/attendances/${first.body.id}/check-out`)
      .set('Authorization', apps.owner)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedVersion: '1' })
      .expect(400);
    await request(apps.base)
      .post(`/api/v1/me/attendances/${first.body.id}/check-out`)
      .set('Authorization', apps.owner)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedVersion: 1, checkOutAt: 'client-time' })
      .expect(400);
    expect(await apps.snapshotCounts()).toEqual({
      records: 1,
      receipts: 1,
      files: 2,
    });
  });
});

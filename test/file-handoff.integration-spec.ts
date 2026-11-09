import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JwtService } from '@nestjs/jwt';
import { In } from 'typeorm';
import type { DataSource } from 'typeorm';
import sharp from 'sharp';
import request from 'supertest';
import { SystemClock } from '../src/runtime/clock';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import { AccessTokenService } from '../src/auth/access-token.service';
import { StorageService } from '../src/files/storage.service';
import { ImageService } from '../src/files/image.service';
import { stageImage } from '../src/files/stage-image';
import { fingerprint } from '../src/idempotency/fingerprint';
import { checkInCommand } from '../src/attendance-rpc/check-in.command';
import { ATTENDANCE_PATTERNS as patterns } from '../src/attendance-rpc/rpc.contract';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  AttendanceEntity,
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
  FileObjectEntity,
  IdempotencyOperationEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';
import { insertFixture, prepareTestDatabase } from './mysql-fixture';
import {
  queryCounts,
  freePort,
  processMessage,
  startProcess,
  stopProcess,
} from './file-handoff.helpers';
import type { WrittenImage } from './file-handoff.helpers';

// Actual OS processes, real TCP, MySQL and decoded image files. Check-in business rules remain task 018.
describe('cross-process private image handoff', () => {
  let source: DataSource;
  let attendance: ChildProcess;
  let gateway: ChildProcess;
  let env: NodeJS.ProcessEnv;
  let root: string;
  let base: string;
  let png: Buffer;
  let ids: Awaited<ReturnType<typeof insertFixture>>;
  let owner: string;
  let other: string;
  let hr: string;
  let storage: StorageService;
  let images: ImageService;
  const tokens = new AccessTokenService(
    new JwtService(),
    new SystemClock(),
    loadRuntimeConfig(),
  );

  beforeAll(async () => {
    source = await prepareTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'wfh-handoff-'));
    const [httpPort, rpcPort] = await Promise.all([freePort(), freePort()]);
    env = {
      PORT: String(httpPort),
      STORAGE_ROOT: root,
      ATTENDANCE_RPC_PORT: String(rpcPort),
      ATTENDANCE_RPC_DEADLINE_MS: '500',
    };
    base = `http://127.0.0.1:${httpPort}`;
    const config = {
      ...loadRuntimeConfig(),
      storage: { ...loadRuntimeConfig().storage, root },
    };
    storage = new StorageService(config);
    images = new ImageService(config);
    png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    attendance = await startProcess('attendance', env);
    gateway = await startProcess('gateway', env);
    expect(attendance.pid).not.toBe(gateway.pid);
    expect(gateway.pid).not.toBe(process.pid);
  });

  afterAll(async () => {
    expect(queryCounts(gateway).attendanceReads).toBe(0);
    await Promise.all([stopProcess(gateway), stopProcess(attendance)]);
    await source?.destroy();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (attendance.exitCode !== null || attendance.signalCode !== null) {
      attendance = await startProcess('attendance', env);
    }

    ids = await source.transaction(insertFixture);
    [owner, other, hr] = await Promise.all([
      tokens.issue({ id: ids.employee, role: 'EMPLOYEE' }),
      tokens.issue({ id: ids.otherEmployee, role: 'EMPLOYEE' }),
      tokens.issue({ id: ids.otherEmployee, role: 'HRD' }),
    ]).then((grants) => grants.map((grant) => 'Bearer ' + grant.accessToken));
  });

  afterEach(async () => {
    await stopProcess(attendance);
    await source.manager.delete(IdempotencyOperationEntity, {
      actorId: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(AttendanceEntity, { employeeId: ids.employee });
    await source.manager.update(
      EmployeeEntity,
      { id: In([ids.employee, ids.otherEmployee]) },
      { photoFileId: null },
    );
    await source.manager.delete(FileObjectEntity, {
      ownerEmployeeId: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(ScheduleVersionEntity, { id: ids.schedule });
    await source.manager.delete(EmployeeEntity, {
      id: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(PositionEntity, { id: ids.position });
    await source.manager.delete(DivisionEntity, { id: ids.division });

    for (const name of await readdir(root)) {
      await unlink(join(root, name));
    }
  });

  function upload(key: string, name = 'photo.png') {
    return request(base)
      .post('/api/v1/__handoff/check-in')
      .set('Authorization', owner)
      .set('Idempotency-Key', key)
      .attach('photo', png, { filename: name, contentType: 'image/png' });
  }

  function outcome(
    key: string,
    digest: string,
    token = owner,
    operation = 'checkIn',
  ) {
    return request(base)
      .post('/api/v1/__handoff/outcome')
      .set('Authorization', token)
      .send({
        key,
        operation,
        fingerprint: fingerprint({}, [{ field: 'photo', sha256: digest }]),
      });
  }

  async function records(): Promise<void> {
    expect(
      await source.manager.countBy(AttendanceEntity, {
        employeeId: ids.employee,
      }),
    ).toBe(1);
    expect(
      await source.manager.countBy(IdempotencyOperationEntity, {
        actorId: ids.employee,
        state: 'COMPLETED',
      }),
    ).toBe(1);
    expect(
      await source.manager.countBy(FileObjectEntity, {
        ownerEmployeeId: ids.employee,
      }),
    ).toBe(2); // original fixture plus committed candidate
  }

  it('commits metadata/parent/receipt together; streams owner/HR evidence and rejects others/unbound IDs', async () => {
    const reply = await upload(randomUUID()).expect(201);
    const id = reply.body.body.photo.id;
    await records();
    const gatewayBefore = queryCounts(gateway);
    const attendanceBefore = queryCounts(attendance);
    const bytes = await request(base)
      .get('/api/v1/files/' + id)
      .set('Authorization', owner)
      .expect(200);
    expect(bytes.body).toEqual(png);
    expect(queryCounts(gateway).fileReads - gatewayBefore.fileReads).toBe(1);
    expect(
      queryCounts(attendance).attendanceReads -
        attendanceBefore.attendanceReads,
    ).toBe(1);
    expect(bytes.headers['cache-control']).toBe('private, no-store');
    expect(bytes.headers['x-content-type-options']).toBe('nosniff');
    expect(bytes.headers['content-disposition']).not.toContain(root);
    await request(base)
      .head('/api/v1/files/' + id)
      .set('Authorization', hr)
      .expect(200)
      .expect('Content-Length', String(png.length));
    await request(base)
      .get('/api/v1/files/' + id)
      .set('Authorization', other)
      .expect(404);
    await request(base)
      .get('/api/v1/files/' + ids.file)
      .set('Authorization', owner)
      .expect(404);
    await request(base)
      .get('/api/v1/files/' + randomUUID())
      .set('Authorization', owner)
      .expect(404);
  });

  it.each(['loss.png', 'sql-unknown.png'])(
    'retains a committed photo after %s, resolves scoped outcome, and cleans a fresh replay candidate',
    async (name) => {
      const key = randomUUID();
      const written = processMessage<WrittenImage>(
        attendance,
        'written',
        (value) => value.image.ownerEmployeeId === ids.employee,
      );
      await upload(key, name)
        .expect(503)
        .expect(({ body }) =>
          expect(body.code).toBe('ATTENDANCE_OUTCOME_UNKNOWN'),
        );
      const first = await written;
      expect(await readFile(join(root, first.image.objectKey))).toEqual(png);
      const recovered = await outcome(key, first.image.sha256).expect(201);
      expect(recovered.body).toMatchObject({
        state: 'COMMITTED',
        body: { photo: { id: first.image.id }, checkInAt: first.receivedAt },
      });
      await outcome(key, 'b'.repeat(64))
        .expect(201)
        .expect(({ body }) => expect(body.state).toBe('UNKNOWN'));
      await outcome(key, first.image.sha256, other)
        .expect(201)
        .expect(({ body }) => expect(body.state).toBe('UNKNOWN'));
      const replay = await upload(key).expect(201);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.body).toEqual(recovered.body.body);
      expect(await readdir(root)).toEqual([first.image.objectKey]);
      await records();
    },
  );

  it('keeps bytes while a timed-out SQL transaction is still in flight, then replays original receipt/time', async () => {
    const key = randomUUID();
    const written = processMessage<WrittenImage>(
      attendance,
      'written',
      (value) => value.image.ownerEmployeeId === ids.employee,
    );
    await upload(key, 'delay.png').expect(503);
    const first = await written;
    expect(
      await source.manager.countBy(FileObjectEntity, { id: first.image.id }),
    ).toBe(0);
    await outcome(key, first.image.sha256)
      .expect(201)
      .expect(({ body }) => expect(body.state).toBe('UNKNOWN'));
    await upload(key)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('OPERATION_IN_PROGRESS'));
    expect(await readFile(join(root, first.image.objectKey))).toEqual(png);
    const deadline = Date.now() + 4000;
    let recovered;

    do {
      recovered = await outcome(key, first.image.sha256).expect(201);

      if (recovered.body.state === 'COMMITTED') {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);

    expect(recovered.body.state).toBe('COMMITTED');
    const replay = await upload(key).expect(201);
    expect(replay.body.body.checkInAt).toBe(first.receivedAt);
    expect(replay.body.body.photo.id).toBe(first.image.id);
    expect(await readFile(join(root, first.image.objectKey))).toEqual(png);
    await records();
  });

  it('cleans only a confirmed rollback and leaves no metadata/parent/receipt', async () => {
    await upload(randomUUID(), 'rollback.png').expect(400);
    expect(await readdir(root)).toEqual([]);
    expect(
      await source.manager.countBy(AttendanceEntity, {
        employeeId: ids.employee,
      }),
    ).toBe(0);
    expect(
      await source.manager.countBy(IdempotencyOperationEntity, {
        actorId: ids.employee,
      }),
    ).toBe(0);
    expect(
      await source.manager.countBy(FileObjectEntity, {
        ownerEmployeeId: ids.employee,
      }),
    ).toBe(1);
  });

  it('retains an uncertain crash candidate, then safely retries after the service restarts', async () => {
    const key = randomUUID();
    const written = processMessage<WrittenImage>(
      attendance,
      'written',
      (value) => value.image.ownerEmployeeId === ids.employee,
    );
    await upload(key, 'crash.png').expect(503);
    const first = await written;
    expect(await readFile(join(root, first.image.objectKey))).toEqual(png);
    attendance = await startProcess('attendance', env);
    await outcome(key, first.image.sha256)
      .expect(201)
      .expect(({ body }) => expect(body.state).toBe('UNKNOWN'));
    const result = await upload(key).expect(201);
    expect(result.body.replayed).toBe(false);
    expect(result.body.body.photo.id).not.toBe(first.image.id);
    expect(await readFile(join(root, first.image.objectKey))).toEqual(png); // manual orphan recovery, never guess
    await records();
  });

  it('fails evidence closed during service outage while profile reads remain local; preserves historical evidence', async () => {
    const result = await upload(randomUUID()).expect(201);
    const evidenceId = result.body.body.photo.id;
    const profile = await stageImage(
      {
        input: { bytes: png, mimeType: 'image/png', fileName: 'profile.png' },
        ownerEmployeeId: ids.employee,
        purpose: 'EMPLOYEE_PROFILE_PHOTO',
      },
      images,
      storage,
    );
    await source.transaction(async (manager) => {
      await manager.insert(FileObjectEntity, { ...profile, state: 'ATTACHED' });
      await manager.update(
        EmployeeEntity,
        { id: ids.employee },
        { photoFileId: profile.id },
      );
    });
    await stopProcess(attendance);
    await request(base)
      .get('/api/v1/files/' + evidenceId)
      .set('Authorization', owner)
      .expect(503);
    const response = await request(base)
      .get('/api/v1/files/' + profile.id)
      .set('Authorization', owner)
      .expect(200);
    expect(response.body).toEqual(png);
    attendance = await startProcess('attendance', env);
    await request(base)
      .get('/api/v1/files/' + evidenceId)
      .set('Authorization', hr)
      .expect(200);
    await unlink(join(root, evidenceId + '.png'));
    await symlink('/etc/passwd', join(root, evidenceId + '.png'));
    await request(base)
      .get('/api/v1/files/' + evidenceId)
      .set('Authorization', owner)
      .expect(503);
  });

  it('validates descriptors, JWT expiry, service trust and outcome operation scope before execution', async () => {
    const image = await stageImage(
      {
        input: { bytes: png, mimeType: 'image/png', fileName: 'probe.png' },
        ownerEmployeeId: ids.employee,
        purpose: 'CHECK_IN_PHOTO',
      },
      images,
      storage,
    );
    const stagedImage = { ...image, stagedAt: new Date().toISOString() };
    const command = checkInCommand(
      ids.employee,
      randomUUID(),
      stagedImage,
      stagedImage.stagedAt,
    );
    const client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: Number(env.ATTENDANCE_RPC_PORT) },
    });
    const envelope = {
      version: 1,
      requestId: randomUUID(),
      serviceCredential: process.env.ATTENDANCE_RPC_CREDENTIAL,
      accessToken: owner.slice(7),
      input: {},
      idempotencyKey: command.key,
      fullUploadReceivedAt: stagedImage.stagedAt,
      stagedImage,
    };
    const send = (changes: object) =>
      firstValueFrom(
        client
          .send(patterns.checkIn, { ...envelope, ...changes })
          .pipe(timeout(2000)),
      );

    try {
      await expect(
        send({ serviceCredential: 'invalid-service-credential' }),
      ).rejects.toMatchObject({ code: 'RPC_UNAUTHORIZED' });
      await expect(
        send({
          stagedImage: { ...stagedImage, ownerEmployeeId: ids.otherEmployee },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(
        send({ stagedImage: { ...stagedImage, objectKey: '../outside.png' } }),
      ).rejects.toMatchObject({ code: 'INVALID_FILE' });
      await expect(
        send({ stagedImage: { ...stagedImage, sha256: 'b'.repeat(64) } }),
      ).rejects.toMatchObject({ code: 'INVALID_FILE' });
      await expect(
        send({
          stagedImage: { ...stagedImage, bytes: png.toString('base64') },
        }),
      ).rejects.toMatchObject({ code: 'RPC_VALIDATION_FAILED' });
      const past = new SystemClock();
      jest.spyOn(past, 'now').mockReturnValue(new Date(Date.now() - 7200000));
      const expired = await new AccessTokenService(
        new JwtService(),
        past,
        loadRuntimeConfig(),
      ).issue({ id: ids.employee, role: 'EMPLOYEE' });
      await expect(
        send({ accessToken: expired.accessToken }),
      ).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
      await request(base)
        .get('/api/v1/files/' + ids.file)
        .set('Authorization', 'Bearer ' + expired.accessToken)
        .expect(401);
      await outcome(
        randomUUID(),
        image.sha256,
        owner,
        'changeWorkSchedule',
      ).expect(403);
      expect(
        await source.manager.countBy(AttendanceEntity, {
          employeeId: ids.employee,
        }),
      ).toBe(0);
    } finally {
      client.close();
    }
  });
});

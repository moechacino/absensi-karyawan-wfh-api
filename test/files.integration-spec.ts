import type { INestMicroservice } from '@nestjs/common';
import { AttendanceAppModule } from '../src/attendance-app.module';
import { AttendanceFileService } from '../src/attendance-files/attendance-file.service';
import { attendanceTcpOptions } from '../src/attendance-rpc/rpc.transport';
import { RPC_CONFIG, loadRpcConfig } from '../src/attendance-rpc/rpc.config';
import { ImageService } from '../src/files/image.service';
import { stageImage } from '../src/files/stage-image';
import {
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DataSource, In } from 'typeorm';
import sharp from 'sharp';
import request from 'supertest';
import { readdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { AuthModule } from '../src/auth/auth.module';
import { AuthGuard } from '../src/auth/auth.guard';
import type { AuthenticatedRequest } from '../src/auth/auth.guard';
import { AccessTokenService } from '../src/auth/access-token.service';
import { FileModule } from '../src/files/file.module';
import { FileService } from '../src/files/file.service';
import { StorageService } from '../src/files/storage.service';
import { configureHttp } from '../src/http/configure-http';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import {
  EmployeeEntity,
  DivisionEntity,
  PositionEntity,
  FileObjectEntity,
  AttendanceEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';
import { insertFixture, prepareTestDatabase } from './mysql-fixture';
import { freePort } from './file-handoff.helpers';

// Test-only parent command proves multipart integration without adding an upload API to production.
@Controller('__file-parent-fixture')
@UseGuards(AuthGuard)
class ParentFixtureController {
  constructor(
    private readonly files: FileService,
    private readonly source: DataSource,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('photo'))
  save(
    @UploadedFile()
    photo: { buffer: Buffer; mimetype: string; originalname: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.files.withStagedImage(
      {
        bytes: photo?.buffer,
        mimeType: photo?.mimetype,
        fileName: photo?.originalname,
      },
      req.actor.id,
      'EMPLOYEE_PROFILE_PHOTO',
      (file) =>
        this.source.transaction(async (manager) => {
          await this.files.attach(manager, file);
          await manager.update(
            EmployeeEntity,
            { id: req.actor.id },
            { photoFileId: file.id },
          );

          return { id: file.id };
        }),
    );
  }
}

describe('private files HTTP and parent transactions with native MySQL', () => {
  let app: NestExpressApplication;
  let attendance: INestMicroservice;
  let source: DataSource;
  let files: FileService;
  let storage: StorageService;
  let ids: Awaited<ReturnType<typeof insertFixture>>;
  let owner: string;
  let other: string;
  let hr: string;
  let png: Buffer;
  const config = loadRuntimeConfig();

  beforeAll(async () => {
    const prepared = await prepareTestDatabase();
    await prepared.destroy();
    const rpc = {
      ...loadRpcConfig(),
      host: '127.0.0.1' as const,
      port: await freePort(),
    };
    const attendanceModule = await Test.createTestingModule({
      imports: [AttendanceAppModule],
    })
      .overrideProvider(RPC_CONFIG)
      .useValue(rpc)
      .compile();
    attendance = attendanceModule.createNestMicroservice({
      ...attendanceTcpOptions(rpc),
      logger: false,
    });
    await attendance.listen();
    const module = await Test.createTestingModule({
      imports: [AppModule, FileModule, AuthModule],
      controllers: [ParentFixtureController],
    })
      .overrideProvider(RPC_CONFIG)
      .useValue(rpc)
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureHttp(app, config);
    await app.init();
    source = app.get(DataSource);
    files = app.get(FileService);
    storage = app.get(StorageService);
    png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await attendance?.close();
    }
  });

  beforeEach(async () => {
    ids = await source.transaction(insertFixture);
    const tokens = app.get(AccessTokenService);
    owner =
      'Bearer ' +
      (await tokens.issue({ id: ids.employee, role: 'EMPLOYEE' })).accessToken;
    other =
      'Bearer ' +
      (await tokens.issue({ id: ids.otherEmployee, role: 'EMPLOYEE' }))
        .accessToken;
    hr =
      'Bearer ' +
      (await tokens.issue({ id: ids.otherEmployee, role: 'HRD' })).accessToken;
  });

  afterEach(async () => {
    if (!source?.isInitialized || !ids) return;

    await source.manager.delete(AttendanceEntity, {
      employeeId: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.update(
      EmployeeEntity,
      { id: In([ids.employee, ids.otherEmployee]) },
      { photoFileId: null },
    );
    const rows = await source
      .getRepository(FileObjectEntity)
      .createQueryBuilder('file')
      .addSelect('file.objectKey')
      .where({ ownerEmployeeId: In([ids.employee, ids.otherEmployee]) })
      .getMany();
    await source.manager.delete(FileObjectEntity, {
      ownerEmployeeId: In([ids.employee, ids.otherEmployee]),
    });

    for (const row of rows) {
      await storage.delete(row.objectKey);
    }

    await source.manager.delete(ScheduleVersionEntity, { id: ids.schedule });
    await source.manager.delete(EmployeeEntity, {
      id: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(PositionEntity, { id: ids.position });
    await source.manager.delete(DivisionEntity, { id: ids.division });
  });

  async function upload(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/__file-parent-fixture')
      .set('Authorization', owner)
      .attach('photo', png, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);

    return response.body.id;
  }

  it('serves exact committed multipart bytes with private headers and identical HEAD authorization', async () => {
    const id = await upload();
    const response = await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', owner)
      .expect(200);
    expect(response.body).toEqual(png);
    expect(response.headers['content-type']).toBe('image/png');
    expect(Number(response.headers['content-length'])).toBe(png.length);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toContain(
      "filename*=UTF-8''photo.png",
    );
    const head = await request(app.getHttpServer())
      .head('/api/v1/files/' + id)
      .set('Authorization', owner)
      .expect(200);
    expect(Number(head.headers['content-length'])).toBe(png.length);
    await request(app.getHttpServer())
      .head('/api/v1/files/' + id)
      .set('Authorization', other)
      .expect(404);
  });

  it('requires issued claims and an actual matching parent association', async () => {
    const id = await upload();
    await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', other)
      .expect(404);
    await source.manager.update(
      EmployeeEntity,
      { id: ids.otherEmployee },
      { role: 'EMPLOYEE', status: 'INACTIVE' },
    );
    await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', hr)
      .expect(200);
    await source.manager.update(
      EmployeeEntity,
      { id: ids.employee },
      { status: 'INACTIVE' },
    );
    await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', owner)
      .expect(200);
    await source.manager.update(
      EmployeeEntity,
      { id: ids.employee },
      { photoFileId: null },
    );
    await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', owner)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/files/' + ids.file)
      .set('Authorization', hr)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/files/not-a-uuid')
      .set('Authorization', owner)
      .expect(400);
  });

  it('returns a safe 503 for missing or symlinked bytes', async () => {
    const id = await upload();
    const path = join(config.storage.root, id + '.png');
    await unlink(path);
    const missing = await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', owner)
      .expect(503);
    expect(missing.body.code).toBe('FILE_CONTENT_UNAVAILABLE');
    await symlink('/etc/passwd', path);
    const linked = await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', owner)
      .expect(503);
    expect(JSON.stringify(linked.body)).not.toContain('/etc/passwd');
  });

  it('rolls back metadata and removes written bytes when a parent transaction fails', async () => {
    const before = await readdir(config.storage.root);
    const error = new Error('Parent mutation failed');
    await expect(
      files.withStagedImage(
        { bytes: png, mimeType: 'image/png', fileName: 'photo.png' },
        ids.employee,
        'EMPLOYEE_PROFILE_PHOTO',
        (file) =>
          source.transaction(async (manager) => {
            await files.attach(manager, file);
            await manager.update(
              EmployeeEntity,
              { id: ids.employee },
              { photoFileId: file.id },
            );

            throw error;
          }),
      ),
    ).rejects.toBe(error);
    expect(await readdir(config.storage.root)).toEqual(before);
    expect(
      await source.manager.countBy(FileObjectEntity, {
        ownerEmployeeId: ids.employee,
      }),
    ).toBe(1);
    expect(
      (
        await source.manager.findOneByOrFail(EmployeeEntity, {
          id: ids.employee,
        })
      ).photoFileId,
    ).toBeNull();
  });

  it('deletes replaced profile bytes only after unlinking the old parent', async () => {
    const old = await upload();
    const current = await upload();
    await files.deleteReplaced(old);
    expect(await readdir(config.storage.root)).not.toContain(old + '.png');
    await request(app.getHttpServer())
      .get('/api/v1/files/' + old)
      .set('Authorization', owner)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/files/' + current)
      .set('Authorization', owner)
      .expect(200);
  });

  it('keeps historical attendance evidence and allows its owner/HR to read it', async () => {
    const file = {
      ...(await stageImage(
        {
          input: { bytes: png, mimeType: 'image/png', fileName: 'checkin.png' },
          ownerEmployeeId: ids.employee,
          purpose: 'CHECK_IN_PHOTO',
        },
        app.get(ImageService),
        storage,
      )),
      purpose: 'CHECK_IN_PHOTO' as const,
      stagedAt: new Date().toISOString(),
    };
    const id = await source.transaction(async (manager) => {
      await attendance.get(AttendanceFileService).attach(manager, file);
      await manager.insert(AttendanceEntity, {
        id: randomUUID(),
        employeeId: ids.employee,
        workDate: '2026-11-08',
        scheduleVersionId: ids.schedule,
        timeZone: 'Asia/Jakarta',
        plannedStartAt: new Date('2026-11-08T01:00Z'),
        plannedEndAt: new Date('2026-11-08T09:00Z'),
        checkInAt: new Date('2026-11-08T01:00Z'),
        punctuality: 'ON_TIME',
        photoFileId: file.id,
      });

      return file.id;
    });
    await files.deleteReplaced(id);
    await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', owner)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', hr)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/files/' + id)
      .set('Authorization', other)
      .expect(404);
  });

  it('rejects invalid multipart images before persisting anything', async () => {
    const before = await readdir(config.storage.root);

    for (const [bytes, mimeType, status] of [
      [Buffer.alloc(0), 'image/png', 422],
      [Buffer.from('not an image'), 'image/png', 422],
      [png, 'image/jpeg', 422],
      [Buffer.alloc(5242881), 'image/png', 413],
    ] as const) {
      await request(app.getHttpServer())
        .post('/api/v1/__file-parent-fixture')
        .set('Authorization', owner)
        .attach('photo', bytes, {
          filename: 'photo.png',
          contentType: mimeType,
        })
        .expect(status);
    }

    expect(await readdir(config.storage.root)).toEqual(before);
    expect(
      await source.manager.countBy(FileObjectEntity, {
        ownerEmployeeId: ids.employee,
      }),
    ).toBe(1);
  });
});

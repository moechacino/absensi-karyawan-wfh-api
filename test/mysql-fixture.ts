import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import {
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
  FileObjectEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';

export async function prepareTestDatabase() {
  const config = loadRuntimeConfig();
  if (!config.database.name.endsWith('_test'))
    throw new Error(
      'Integration requires a dedicated empty database whose name ends in _test.',
    );
  const source = createDataSource(config);
  await source.initialize();
  try {
    await source.runMigrations();
    return source;
  } catch (error) {
    await source.destroy();
    throw error;
  }
}

// Metadata only: file bytes and command workflows belong to later tasks.
export async function insertFixture(manager: EntityManager) {
  const ids = Object.fromEntries(
    [
      'division',
      'position',
      'employee',
      'otherEmployee',
      'file',
      'schedule',
    ].map((key) => [key, randomUUID()]),
  );
  await manager.insert(DivisionEntity, {
    id: ids.division,
    code: ids.division.slice(0, 8),
    name: 'Fixture division',
  });
  await manager.insert(PositionEntity, {
    id: ids.position,
    divisionId: ids.division,
    code: ids.position.slice(0, 8),
    name: 'Fixture position',
  });
  for (const employee of [ids.employee, ids.otherEmployee]) {
    await manager.insert(EmployeeEntity, {
      id: employee,
      fullName: 'Fixture employee',
      email: employee + '@example.test',
      divisionId: ids.division,
      positionId: ids.position,
      hasPasswordChanged: false,
      initialPassword: 'Fictional-Initial-Password-Only',
      passwordHash: null,
    });
  }
  await manager.insert(FileObjectEntity, {
    id: ids.file,
    ownerEmployeeId: ids.employee,
    objectKey: ids.file + '.jpg',
    fileName: 'fixture.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 256,
    sha256: 'a'.repeat(64),
    purpose: 'CHECK_IN_PHOTO',
    state: 'ATTACHED',
  });
  await manager.insert(ScheduleVersionEntity, {
    id: ids.schedule,
    workingDays: [1, 2, 3, 4, 5, 6, 7],
    startTime: '08:00',
    endTime: '16:00',
    endDayOffset: 0,
    timeZone: 'Asia/Jakarta',
    effectiveFrom: '2026-11-01',
    effectiveAt: new Date('2026-10-31T17:00:00.000Z'),
    createdBy: ids.employee,
  });
  return ids;
}

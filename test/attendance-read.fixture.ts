import { randomUUID } from 'node:crypto';
import { In } from 'typeorm';
import request from 'supertest';
import {
  DivisionEntity,
  EmployeeEntity,
  PositionEntity,
} from '../src/database/entities';
import { attendanceApps } from './attendance-fixture';
import type { AttendanceApps } from './attendance-fixture';

export async function attendanceReadApps() {
  const apps = await attendanceApps();
  const extras: string[] = [];
  const divisions: string[] = [];
  const positions: string[] = [];

  async function reset(): Promise<void> {
    await apps.reset();
    await apps.source.manager.update(
      EmployeeEntity,
      { id: In([apps.ids.employee, apps.ids.otherEmployee]) },
      { createdAt: new Date('2026-10-01T00:00:00.000Z') },
    );
  }

  async function department(): Promise<{
    divisionId: string;
    positionId: string;
  }> {
    const divisionId = randomUUID();
    const positionId = randomUUID();
    await apps.source.manager.insert(DivisionEntity, {
      id: divisionId,
      code: divisionId.slice(0, 8),
      name: 'Other division',
    });
    await apps.source.manager.insert(PositionEntity, {
      id: positionId,
      divisionId,
      code: positionId.slice(0, 8),
      name: 'Other position',
    });
    divisions.push(divisionId);
    positions.push(positionId);

    return { divisionId, positionId };
  }

  async function employees(
    names: string[],
    refs: { divisionId: string; positionId: string } = {
      divisionId: apps.ids.division,
      positionId: apps.ids.position,
    },
  ): Promise<string[]> {
    const rows = names.map((fullName) => ({
      id: randomUUID(),
      fullName,
      email: randomUUID() + '@example.test',
      ...refs,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      initialPassword: 'Fixture-Initial-Password-Only',
      hasPasswordChanged: false,
    }));
    await apps.source.manager.insert(EmployeeEntity, rows);
    const ids = rows.map((row) => row.id);
    extras.push(...ids);

    return ids;
  }

  async function clean(): Promise<void> {
    if (extras.length) {
      await apps.source.manager.delete(EmployeeEntity, { id: In(extras) });
      extras.length = 0;
    }

    await apps.clean();

    if (positions.length) {
      await apps.source.manager.delete(PositionEntity, { id: In(positions) });
      await apps.source.manager.delete(DivisionEntity, { id: In(divisions) });
      positions.length = 0;
      divisions.length = 0;
    }
  }

  function history(
    query = 'from=2026-11-09&to=2026-11-09',
    token = apps.owner,
  ) {
    return request(apps.base)
      .get('/api/v1/me/attendance-days?' + query)
      .set('Authorization', token);
  }

  function monitor(query = 'date=2026-11-09', token = apps.hr) {
    return request(apps.base)
      .get('/api/v1/hr/attendance-days?' + query)
      .set('Authorization', token);
  }

  function detail(id: string, hr = false, token = hr ? apps.hr : apps.owner) {
    return request(apps.base)
      .get(`/api/v1/${hr ? 'hr' : 'me'}/attendances/${id}`)
      .set('Authorization', token);
  }

  function capture(
    schema: 'AttendanceDayPage' | 'MonitoringPage' | 'Attendance',
    body: unknown,
  ): void {
    apps.captures.push({ schema, body });
  }

  return {
    apps,
    reset,
    clean,
    department,
    employees,
    history,
    monitor,
    detail,
    capture,
  };
}

export type AttendanceReadApps = Awaited<ReturnType<typeof attendanceReadApps>>;
export type { AttendanceApps };

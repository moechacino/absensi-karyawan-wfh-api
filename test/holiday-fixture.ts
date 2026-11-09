import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { scheduleApps } from './schedule-fixture';

export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

export function batchHoliday() {
  return { date: '2026-11-09', name: 'Company day', category: 'COMPANY' };
}

export function holidayRequests(
  apps: () => Awaited<ReturnType<typeof scheduleApps>>,
  tokenValue: () => string,
) {
  function batch(extra: object = {}) {
    return {
      year: 2026,
      expectedVersion: 0,
      upsert: [
        { date: '2026-11-09', name: 'Company day', category: 'COMPANY' },
      ],
      remove: [],
      ...extra,
    };
  }

  function get(query = '?year=2026', token = tokenValue()) {
    return request(apps().gateway.getHttpServer())
      .get('/api/v1/holidays' + query)
      .set('Authorization', `Bearer ${token}`);
  }

  function post(
    path: 'preview' | 'changes',
    input = batch(),
    key = randomUUID(),
    token = tokenValue(),
  ) {
    return request(apps().gateway.getHttpServer())
      .post('/api/v1/hr/holidays/' + path)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(input);
  }

  function schedule(extra: object = {}) {
    return request(apps().gateway.getHttpServer())
      .put('/api/v1/hr/work-schedule')
      .set('Authorization', `Bearer ${tokenValue()}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedVersion: 0,
        workingDays: [1, 2, 3, 4, 5],
        startTime: '08:00',
        endTime: '16:00',
        endDayOffset: 0,
        timeZone: 'Asia/Jakarta',
        effectiveFrom: '2026-11-09',
        ...extra,
      });
  }

  return { batch, get, post, schedule };
}

import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { RpcGuard } from '../attendance-rpc/rpc.guard';
import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import type { AccessTokenService } from '../auth/access-token.service';
import type { AttendanceRepository } from './attendance.repository';
import { AttendanceOwnerGuard } from './attendance-owner.guard';

const actor = { id: randomUUID(), role: 'HRD' as const };
const config = {
  host: '127.0.0.1' as const,
  port: 4001,
  serviceCredential: 'fixture-service-credential-not-for-production',
  deadlineMs: 1000,
};

async function setup(id: unknown, owned: boolean) {
  const tcp = { getPattern: () => patterns.checkOut };
  const input = { attendanceId: id, expectedVersion: 1 };
  const context = {
    switchToRpc: () => ({
      getContext: () => tcp,
      getData: () => ({
        version: 1,
        requestId: randomUUID(),
        serviceCredential: config.serviceCredential,
        accessToken: 'token',
        input,
        idempotencyKey: randomUUID(),
      }),
    }),
  } as unknown as ExecutionContext;
  const tokens = { verify: jest.fn().mockResolvedValue(actor) };
  await new RpcGuard(
    config,
    tokens as unknown as AccessTokenService,
  ).canActivate(context);
  const repository = { owned: jest.fn().mockResolvedValue(owned) };

  return {
    guard: new AttendanceOwnerGuard(
      repository as unknown as AttendanceRepository,
    ),
    context,
    repository,
  };
}

describe('AttendanceOwnerGuard', () => {
  it('checks issued subject ownership before entering the runner, including HRD and replays', async () => {
    const id = randomUUID();
    const { guard, context, repository } = await setup(id, true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(repository.owned).toHaveBeenCalledWith(id, actor.id);
  });

  it('hides a missing or other-owned record from HRD too', async () => {
    const { guard, context } = await setup(randomUUID(), false);
    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it.each([undefined, null, '', 'invalid'])(
    'never queries with unsafe ID %s',
    async (id) => {
      const { guard, context, repository } = await setup(id, true);
      await expect(guard.canActivate(context)).rejects.toThrow();
      expect(repository.owned).not.toHaveBeenCalled();
    },
  );
});

import type { EntityManager } from 'typeorm';
import { DivisionEntity, PositionEntity } from '../database/entities';
import { OrganizationService } from './organization.service';
import type { OrganizationRepository } from './organization.repository';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'HRD' as const,
};
const otherDivision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('OrganizationService', () => {
  const manager = {} as EntityManager;

  function setup() {
    const division = Object.assign(new DivisionEntity(), {
      id: actor.id,
      code: 'D',
      name: 'Division',
      description: null,
      status: 'ACTIVE' as const,
      version: 3,
    });
    const position = Object.assign(new PositionEntity(), {
      id: actor.id,
      code: 'P',
      name: 'Position',
      divisionId: division.id,
      status: 'ACTIVE' as const,
      version: 2,
    });
    const repository = {
      transaction: jest.fn(
        async (work: (manager: EntityManager) => Promise<unknown>) =>
          work(manager),
      ),
      division: jest.fn().mockResolvedValue(division),
      position: jest.fn().mockResolvedValue(position),
      positionHasEmployees: jest.fn().mockResolvedValue(false),
      insertDivision: jest.fn().mockResolvedValue(division),
      insertPosition: jest.fn().mockResolvedValue(position),
      updateDivision: jest.fn().mockResolvedValue(division),
      updatePosition: jest.fn().mockResolvedValue(position),
      listDivisions: jest.fn().mockResolvedValue([[division], 1]),
      listPositions: jest.fn().mockResolvedValue([[position], 1]),
      divisions: jest.fn().mockResolvedValue([division]),
    };
    const service = new OrganizationService(
      repository as unknown as OrganizationRepository,
    );

    return { service, repository, division, position, manager };
  }

  it('maps list responses and pagination without leaking entity timestamps', async () => {
    const { service } = setup();
    const query = { page: 1, pageSize: 20 };
    const divisions = await service.listDivisions(query);
    const positions = await service.listPositions(query);
    expect(divisions.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 1,
      totalPages: 1,
    });
    expect(divisions.items[0]).not.toHaveProperty('createdAt');
    expect(positions.items[0].division).toEqual({
      id: actor.id,
      code: 'D',
      name: 'Division',
    });
  });

  it('creates a division using the scoped manager and defaults its description to null', async () => {
    const { service, repository, manager } = setup();
    await service.createDivision(
      {
        code: 'D',
        name: 'Division',
        status: 'ACTIVE',
      },
      manager,
    );
    expect(repository.insertDivision).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ description: null }),
    );
  });

  it('rejects stale division edits and reports the current version', async () => {
    const { service, repository } = setup();
    await expect(
      service.updateDivision(actor.id, {
        expectedVersion: 2,
        name: 'New',
      }),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      publicOptions: { details: { currentVersion: 3, resourceId: actor.id } },
    });
    expect(repository.updateDivision).not.toHaveBeenCalled();
  });

  it('preserves omission and explicitly clears nullable descriptions', async () => {
    const { service, repository, manager } = setup();
    await service.updateDivision(actor.id, {
      expectedVersion: 3,
      description: null,
    });
    expect(repository.updateDivision).toHaveBeenCalledWith(manager, actor.id, {
      description: null,
      version: 4,
    });
  });

  it('rejects empty PATCH bodies without entering a transaction', () => {
    const { service, repository } = setup();
    expect(() =>
      service.updateDivision(actor.id, { expectedVersion: 3 }),
    ).toThrow('editable field');
    expect(() =>
      service.updatePosition(actor.id, { expectedVersion: 2 }),
    ).toThrow('editable field');
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it.each(['missing', 'inactive'])(
    'rejects a %s division for new positions',
    async (scenario) => {
      const { service, repository, division } = setup();
      repository.division.mockResolvedValue(
        scenario === 'missing'
          ? null
          : Object.assign(new DivisionEntity(), division, {
              status: 'INACTIVE',
            }),
      );
      await expect(
        service.createPosition(
          {
            code: 'P',
            name: 'Position',
            divisionId: actor.id,
            status: 'ACTIVE',
          },
          manager,
        ),
      ).rejects.toMatchObject({
        code:
          scenario === 'missing' ? 'DIVISION_NOT_FOUND' : 'DIVISION_INACTIVE',
      });
      expect(repository.insertPosition).not.toHaveBeenCalled();
    },
  );

  it('blocks moving a position with any employee references', async () => {
    const { service, repository } = setup();
    repository.positionHasEmployees.mockResolvedValue(true);
    await expect(
      service.updatePosition(actor.id, {
        expectedVersion: 2,
        divisionId: otherDivision,
      }),
    ).rejects.toMatchObject({ code: 'POSITION_IN_USE' });
    expect(repository.updatePosition).not.toHaveBeenCalled();
  });

  it('checks an active destination when moving an unused position', async () => {
    const { service, repository, division, manager } = setup();
    repository.division.mockResolvedValue(
      Object.assign(new DivisionEntity(), division, { id: otherDivision }),
    );
    await service.updatePosition(actor.id, {
      expectedVersion: 2,
      divisionId: otherDivision,
    });
    expect(repository.division).toHaveBeenCalledWith(
      manager,
      otherDivision,
      true,
    );
    expect(repository.updatePosition).toHaveBeenCalledWith(manager, actor.id, {
      divisionId: otherDivision,
      version: 3,
    });
  });

  it('allows deactivation while preserving an inactive historical division reference', async () => {
    const { service, repository, division } = setup();
    repository.division.mockResolvedValue(
      Object.assign(new DivisionEntity(), division, { status: 'INACTIVE' }),
    );
    await expect(
      service.updatePosition(actor.id, {
        expectedVersion: 2,
        status: 'INACTIVE',
      }),
    ).resolves.toHaveProperty('id', actor.id);
    expect(repository.positionHasEmployees).not.toHaveBeenCalled();
  });

  it('blocks reactivating a position under an inactive division', async () => {
    const { service, repository, position, division } = setup();
    position.status = 'INACTIVE' as any;
    division.status = 'INACTIVE' as any;
    await expect(
      service.updatePosition(actor.id, {
        expectedVersion: 2,
        status: 'ACTIVE',
      }),
    ).rejects.toMatchObject({ code: 'DIVISION_INACTIVE' });
    expect(repository.updatePosition).not.toHaveBeenCalled();
  });

  it('maps unique-code conflicts without exposing SQL errors', async () => {
    const { service, repository } = setup();
    repository.insertDivision.mockRejectedValue({
      driverError: { code: 'ER_DUP_ENTRY', sql: 'private SQL' },
    });
    await expect(
      service.createDivision(
        {
          code: 'D',
          name: 'Division',
          status: 'ACTIVE',
        },
        manager,
      ),
    ).rejects.toMatchObject({ code: 'CODE_ALREADY_EXISTS' });
  });

  it('returns stable not-found results for missing edit targets', async () => {
    const { service, repository } = setup();
    repository.division.mockResolvedValue(null);
    repository.position.mockResolvedValue(null);
    await expect(
      service.updateDivision(actor.id, {
        expectedVersion: 0,
        name: 'New',
      }),
    ).rejects.toMatchObject({ code: 'DIVISION_NOT_FOUND' });
    await expect(
      service.updatePosition(actor.id, {
        expectedVersion: 0,
        name: 'New',
      }),
    ).rejects.toMatchObject({ code: 'POSITION_NOT_FOUND' });
  });
});

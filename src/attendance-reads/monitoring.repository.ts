import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import type { EntityManager, SelectQueryBuilder } from 'typeorm';
import { AttendanceEntity, EmployeeEntity } from '../database/entities';
import type { MonitoringInput } from '../attendance-rpc/rpc.inputs';
import type { DatedContext, StatusTotal } from './attendance-read.rules';

const dayStatus = `CASE WHEN attendance.id IS NULL THEN :projectedStatus WHEN attendance.checkOutAt IS NULL THEN 'WORKING' ELSE 'COMPLETED' END`;

@Injectable()
export class MonitoringRepository {
  private filtered(
    input: MonitoringInput,
    context: DatedContext,
    manager: EntityManager,
  ): SelectQueryBuilder<EmployeeEntity> {
    const query = manager
      .createQueryBuilder(EmployeeEntity, 'employee')
      .leftJoin(
        AttendanceEntity,
        'attendance',
        'attendance.employeeId = employee.id AND attendance.workDate = :date',
        { date: input.date },
      )
      .where(
        '(attendance.id IS NOT NULL OR (employee.status = :active AND employee.createdAt < :cutoff))',
        { active: 'ACTIVE', cutoff: context.creationCutoff },
      )
      .setParameter('projectedStatus', context.status);

    if (input.divisionId) {
      query.andWhere('employee.divisionId = :divisionId', {
        divisionId: input.divisionId,
      });
    }

    if (input.q) {
      const pattern = '%' + input.q.replace(/[!%_]/g, '!$&') + '%';
      query.andWhere(
        "(employee.id LIKE :pattern ESCAPE '!' OR employee.fullName LIKE :pattern ESCAPE '!')",
        { pattern },
      );
    }

    if (input.status) {
      query.andWhere(`${dayStatus} = :dayStatus`, { dayStatus: input.status });
    }

    if (input.punctuality) {
      query.andWhere('attendance.punctuality = :punctuality', {
        punctuality: input.punctuality,
      });
    }

    return query;
  }

  async selected(
    input: MonitoringInput,
    context: DatedContext,
    manager: EntityManager,
  ): Promise<{ ids: string[]; totals: StatusTotal[] }> {
    const query = this.filtered(input, context, manager);
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    const [ids, totals] = await Promise.all([
      query
        .clone()
        .select('employee.id', 'id')
        .orderBy('employee.fullName', 'ASC')
        .addOrderBy('employee.id', 'ASC')
        .offset((page - 1) * pageSize)
        .limit(pageSize)
        .getRawMany<{ id: string }>(),
      query
        .clone()
        .select(dayStatus, 'status')
        .addSelect('COUNT(*)', 'total')
        .addSelect(
          "SUM(CASE WHEN attendance.punctuality = 'LATE' THEN 1 ELSE 0 END)",
          'late',
        )
        .groupBy(dayStatus)
        .getRawMany<StatusTotal>(),
    ]);

    return { ids: ids.map((row) => row.id), totals };
  }

  employees(ids: string[], manager: EntityManager): Promise<EmployeeEntity[]> {
    if (!ids.length) {
      return Promise.resolve([]);
    }

    return manager.find(EmployeeEntity, {
      where: { id: In(ids) },
      relations: { division: true, position: true, photo: true },
      relationLoadStrategy: 'join',
      select: {
        id: true,
        fullName: true,
        photoFileId: true,
        division: { id: true, code: true, name: true },
        position: { id: true, code: true, name: true },
        photo: {
          id: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          ownerEmployeeId: true,
          purpose: true,
          state: true,
        },
      },
    });
  }
}

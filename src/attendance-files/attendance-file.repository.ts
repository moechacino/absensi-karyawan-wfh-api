import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import {
  FileObjectEntity,
  IdempotencyOperationEntity,
} from '../database/entities';
import type { Actor } from '../auth/access-token.service';
import type {
  CommandOutcomeInput,
  StagedCheckInImage,
} from '../attendance-rpc/rpc.files';

@Injectable()
export class AttendanceFileRepository {
  constructor(private readonly source: DataSource) {}

  findReadable(id: string, actor: Actor): Promise<FileObjectEntity | null> {
    return this.source
      .getRepository(FileObjectEntity)
      .createQueryBuilder('file')
      .addSelect('file.objectKey')
      .where(
        'file.id = :id AND file.state = :state AND file.purpose = :purpose',
        { id, state: 'ATTACHED', purpose: 'CHECK_IN_PHOTO' },
      )
      .andWhere(
        'EXISTS (SELECT 1 FROM attendances a WHERE a.photo_file_id = file.id AND a.employee_id = file.owner_employee_id)',
      )
      .andWhere(
        actor.role === 'HRD' ? '1 = 1' : 'file.owner_employee_id = :actor',
        { actor: actor.id },
      )
      .getOne();
  }

  async attach(
    manager: EntityManager,
    image: StagedCheckInImage,
  ): Promise<void> {
    const { stagedAt, ...file } = image;
    await manager.insert(FileObjectEntity, {
      ...file,
      purpose: 'CHECK_IN_PHOTO',
      state: 'ATTACHED',
      createdAt: new Date(stagedAt),
    });
  }

  // Ordinary committed read: never waits for the command's lock or claims absence is rollback.
  findCommitted(
    actorId: string,
    input: CommandOutcomeInput,
  ): Promise<IdempotencyOperationEntity | null> {
    return this.source.getRepository(IdempotencyOperationEntity).findOne({
      where: {
        actorId,
        routeScope: input.operation,
        idempotencyKey: input.key.toLowerCase(),
        fingerprint: input.fingerprint,
        state: 'COMPLETED',
      },
      select: { id: true, httpStatus: true, result: true, resourceId: true },
    });
  }
}

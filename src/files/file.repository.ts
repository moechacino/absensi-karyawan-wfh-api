import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { EmployeeEntity, FileObjectEntity } from '../database/entities';
import type { Actor } from '../auth/access-token.service';
import type { StagedImage } from './file.types';

@Injectable()
export class FileRepository {
  constructor(private readonly source: DataSource) {}

  async findReadable(
    id: string,
    actor: Actor,
  ): Promise<FileObjectEntity | null> {
    return this.source
      .getRepository(FileObjectEntity)
      .createQueryBuilder('file')
      .addSelect('file.objectKey')
      .where('file.id = :id AND file.state = :state', { id, state: 'ATTACHED' })
      .andWhere(
        "file.purpose = 'EMPLOYEE_PROFILE_PHOTO' AND EXISTS (SELECT 1 FROM employees e WHERE e.photo_file_id = file.id AND e.id = file.owner_employee_id)",
      )
      .andWhere(
        actor.role === 'HRD' ? '1 = 1' : 'file.owner_employee_id = :actor',
        { actor: actor.id },
      )
      .getOne();
  }

  findPurpose(id: string): Promise<FileObjectEntity | null> {
    return this.source.getRepository(FileObjectEntity).findOne({
      where: { id, state: 'ATTACHED' },
      select: { id: true, purpose: true },
    });
  }

  async attach(manager: EntityManager, staged: StagedImage): Promise<void> {
    await manager.insert(FileObjectEntity, { ...staged, state: 'ATTACHED' });
  }

  // The caller only removes bytes after this transaction commits. Parent commands must never rebind retired files.

  async retireIfUnreferenced(
    id: string,
  ): Promise<{ referenced: boolean; objectKey?: string }> {
    return this.source.transaction('READ COMMITTED', async (manager) => {
      const file = await manager.findOne(FileObjectEntity, {
        where: { id },
        select: { id: true, objectKey: true, purpose: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (!file) {
        return { referenced: false };
      }

      if (
        file.purpose !== 'EMPLOYEE_PROFILE_PHOTO' ||
        (await manager.existsBy(EmployeeEntity, { photoFileId: id }))
      ) {
        return { referenced: true };
      }

      await manager.update(FileObjectEntity, { id }, { state: 'RETIRED' });

      return { referenced: false, objectKey: file.objectKey };
    });
  }
}

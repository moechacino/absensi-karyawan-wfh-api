import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Index('uq_file_key', ['objectKey'], { unique: true })
@Index('ix_file_owner', ['ownerEmployeeId', 'purpose', 'createdAt'])
@ForeignKey('EmployeeEntity', ['ownerEmployeeId'], ['id'], {
  name: 'fk_file_owner',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Entity('file_objects')
export class FileObjectEntity {
  @PrimaryColumn({
    name: 'id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  id: string;

  @Column({
    name: 'created_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt: Date;

  @Column({
    name: 'owner_employee_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  ownerEmployeeId: string;

  @Column({
    name: 'object_key',
    type: 'varchar',
    length: 512,
    select: false,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  objectKey: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({
    name: 'mime_type',
    type: 'enum',
    enum: ['image/jpeg', 'image/png', 'image/webp'],
  })
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes: number;

  @Column({
    name: 'sha256',
    type: 'varchar',
    length: 64,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  sha256: string;

  @Column({
    name: 'purpose',
    type: 'enum',
    enum: ['CHECK_IN_PHOTO', 'EMPLOYEE_PROFILE_PHOTO'],
  })
  purpose: 'CHECK_IN_PHOTO' | 'EMPLOYEE_PROFILE_PHOTO';

  @Column({
    name: 'state',
    type: 'enum',
    enum: ['STAGED', 'ATTACHED', 'RETIRED'],
    default: 'STAGED',
  })
  state: 'STAGED' | 'ATTACHED' | 'RETIRED';
}

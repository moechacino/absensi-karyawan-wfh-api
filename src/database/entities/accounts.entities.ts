import {
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import type { DivisionEntity, PositionEntity } from './organization.entities';
import type { FileObjectEntity } from './files.entities';

@Index('uq_employee_email', ['email'], { unique: true })
@Index('ix_employee_name', ['fullName', 'id'])
@Index('ix_employee_role_status', ['role', 'status', 'id'])
@ForeignKey('DivisionEntity', ['divisionId'], ['id'], {
  name: 'fk_employee_division',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey(
  'PositionEntity',
  ['positionId', 'divisionId'],
  ['id', 'divisionId'],
  { name: 'fk_employee_position', onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
)
@ForeignKey('FileObjectEntity', ['photoFileId'], ['id'], {
  name: 'fk_employee_photo',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Entity('employees')
export class EmployeeEntity {
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

  @Column({ name: 'full_name', type: 'varchar', length: 160 })
  fullName: string;

  @Column({
    name: 'email',
    type: 'varchar',
    length: 254,
    collation: 'utf8mb4_bin',
    transformer: {
      to: (value: string) => value.trim().toLowerCase(),
      from: (value: string) => value,
    },
  })
  email: string;

  @Column({
    name: 'division_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  divisionId: string;

  @Column({
    name: 'position_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  positionId: string;

  @Column({
    name: 'role',
    type: 'enum',
    enum: ['EMPLOYEE', 'HRD'],
    default: 'EMPLOYEE',
  })
  role: 'EMPLOYEE' | 'HRD';

  @Column({
    name: 'status',
    type: 'enum',
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE',
  })
  status: 'ACTIVE' | 'INACTIVE';

  @Column({
    name: 'photo_file_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
    nullable: true,
  })
  photoFileId: string | null;

  @Column({ name: 'version', type: 'int', unsigned: true, default: 1 })
  version: number;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    onUpdate: 'CURRENT_TIMESTAMP(3)',
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt: Date;

  @Column({ name: 'has_password_changed', type: 'boolean', default: false })
  hasPasswordChanged: boolean;

  @Column({
    name: 'initial_password',
    type: 'varchar',
    length: 128,
    nullable: true,
    select: false,
  })
  initialPassword: string | null;

  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    nullable: true,
    select: false,
  })
  passwordHash: string | null;

  @ManyToOne('DivisionEntity', {
    nullable: false,
    createForeignKeyConstraints: false,
    persistence: false,
  })
  @JoinColumn({ name: 'division_id', referencedColumnName: 'id' })
  division: Relation<DivisionEntity>;

  @ManyToOne('PositionEntity', {
    nullable: false,
    createForeignKeyConstraints: false,
    persistence: false,
  })
  @JoinColumn({ name: 'position_id', referencedColumnName: 'id' })
  position: Relation<PositionEntity>;

  @ManyToOne('FileObjectEntity', {
    nullable: true,
    createForeignKeyConstraints: false,
    persistence: false,
  })
  @JoinColumn({ name: 'photo_file_id', referencedColumnName: 'id' })
  photo: Relation<FileObjectEntity> | null;
}

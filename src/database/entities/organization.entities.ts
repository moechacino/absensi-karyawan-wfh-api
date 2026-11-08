import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Index('uq_division_code', ['code'], { unique: true })
@Entity('divisions')
export class DivisionEntity {
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

  @Column({ name: 'code', type: 'varchar', length: 32 })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 160 })
  name: string;

  @Column({
    name: 'description',
    type: 'varchar',
    length: 2000,
    nullable: true,
  })
  description: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE',
  })
  status: 'ACTIVE' | 'INACTIVE';

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
}

@Index('uq_position_code', ['code'], { unique: true })
@Index('uq_position_division', ['id', 'divisionId'], { unique: true })
@ForeignKey('DivisionEntity', ['divisionId'], ['id'], {
  name: 'fk_position_division',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Entity('positions')
export class PositionEntity {
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
    name: 'division_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  divisionId: string;

  @Column({ name: 'code', type: 'varchar', length: 32 })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 160 })
  name: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE',
  })
  status: 'ACTIVE' | 'INACTIVE';

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
}

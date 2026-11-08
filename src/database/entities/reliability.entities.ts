import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Index('uq_idempotency_scope', ['actorId', 'routeScope', 'idempotencyKey'], {
  unique: true,
})
@Index('ix_idempotency_expiry', ['expiresAt'])
@ForeignKey('EmployeeEntity', ['actorId'], ['id'], {
  name: 'fk_idempotency_actor',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Entity('idempotency_operations')
export class IdempotencyOperationEntity {
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
    name: 'actor_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  actorId: string;

  @Column({
    name: 'route_scope',
    type: 'varchar',
    length: 200,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  routeScope: string;

  @Column({
    name: 'idempotency_key',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  idempotencyKey: string;

  @Column({
    name: 'fingerprint',
    type: 'varchar',
    length: 64,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  fingerprint: string;

  @Column({
    name: 'state',
    type: 'enum',
    enum: ['IN_PROGRESS', 'COMPLETED'],
    default: 'IN_PROGRESS',
  })
  state: 'IN_PROGRESS' | 'COMPLETED';

  @Column({
    name: 'lease_owner',
    type: 'varchar',
    length: 64,
    nullable: true,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  leaseOwner: string | null;

  @Column({
    name: 'lease_expires_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
  })
  leaseExpiresAt: Date | null;

  @Column({
    name: 'http_status',
    type: 'smallint',
    unsigned: true,
    nullable: true,
  })
  httpStatus: number | null;

  @Column({ name: 'result', type: 'json', nullable: true, select: false })
  result: Record<string, unknown> | null;

  @Column({
    name: 'resource_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
    nullable: true,
  })
  resourceId: string | null;

  @Column({
    name: 'completed_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
  })
  completedAt: Date | null;

  @Column({ name: 'expires_at', type: 'datetime', precision: 3 })
  expiresAt: Date;
}

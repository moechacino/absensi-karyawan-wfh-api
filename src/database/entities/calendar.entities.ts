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

import type { EmployeeEntity } from './accounts.entities';

@Entity('calendar_state')
export class CalendarStateEntity {
  @PrimaryColumn({ name: 'id', type: 'tinyint', unsigned: true })
  id: number;

  @Column({ name: 'version', type: 'int', unsigned: true, default: 0 })
  version: number;
}

@Index('ix_schedule_effective', ['effectiveAt', 'id'])
@ForeignKey('EmployeeEntity', ['createdBy'], ['id'], {
  name: 'fk_schedule_actor',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Entity('schedule_versions')
export class ScheduleVersionEntity {
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
    name: 'opens_minutes_before_start',
    type: 'smallint',
    unsigned: true,
    default: 15,
  })
  opensMinutesBeforeStart: number;

  @Column({ name: 'working_days', type: 'json' })
  workingDays: unknown[];

  @Column({ name: 'start_time', type: 'varchar', length: 5 })
  startTime: string;

  @Column({ name: 'end_time', type: 'varchar', length: 5 })
  endTime: string;

  @Column({
    name: 'end_day_offset',
    type: 'tinyint',
    unsigned: true,
    default: 0,
  })
  endDayOffset: number;

  @Column({ name: 'time_zone', type: 'varchar', length: 100 })
  timeZone: string;

  @Column({ name: 'effective_from', type: 'date' })
  effectiveFrom: string;

  @Column({ name: 'effective_at', type: 'datetime', precision: 3 })
  effectiveAt: Date;

  @Column({
    name: 'superseded_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
  })
  supersededAt: Date | null;

  @Column({
    name: 'created_by',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  createdBy: string;

  @ManyToOne('EmployeeEntity', {
    nullable: false,
    createForeignKeyConstraints: false,
    persistence: false,
  })
  @JoinColumn({ name: 'created_by', referencedColumnName: 'id' })
  actor: Relation<EmployeeEntity>;
}

@Index('ix_schedule_event_time', ['createdAt', 'id'])
@ForeignKey('ScheduleVersionEntity', ['scheduleVersionId'], ['id'], {
  name: 'fk_schedule_event_version',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('EmployeeEntity', ['actorId'], ['id'], {
  name: 'fk_schedule_event_actor',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Entity('schedule_events')
export class ScheduleEventEntity {
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
    name: 'schedule_version_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  scheduleVersionId: string;

  @Column({
    name: 'actor_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  actorId: string;

  @Column({ name: 'kind', type: 'enum', enum: ['SAVED', 'SUPERSEDED'] })
  kind: 'SAVED' | 'SUPERSEDED';

  @Column({ name: 'calendar_version', type: 'int', unsigned: true })
  calendarVersion: number;

  @Column({ name: 'details', type: 'json' })
  details: Record<string, unknown>;
}

@Entity('holiday_calendars')
export class HolidayCalendarEntity {
  @PrimaryColumn({ name: 'year', type: 'smallint', unsigned: true })
  year: number;

  @Column({ name: 'version', type: 'int', unsigned: true, default: 1 })
  version: number;
}

@ForeignKey('HolidayCalendarEntity', ['year'], ['year'], {
  name: 'fk_holiday_calendar',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Entity('holidays')
export class HolidayEntity {
  @PrimaryColumn({ name: 'year', type: 'smallint', unsigned: true })
  year: number;

  @PrimaryColumn({ name: 'date', type: 'date' })
  date: string;

  @Column({ name: 'name', type: 'varchar', length: 160 })
  name: string;

  @Column({
    name: 'category',
    type: 'enum',
    enum: ['COMPANY', 'PUBLIC', 'OTHER'],
  })
  category: 'COMPANY' | 'PUBLIC' | 'OTHER';
}

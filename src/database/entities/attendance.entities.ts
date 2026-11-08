import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Index('uq_attendance_day', ['employeeId', 'workDate'], { unique: true })
@Index('uq_attendance_open', ['openEmployeeId'], { unique: true })
@Index('ix_attendance_date', ['workDate', 'employeeId'])
@ForeignKey('EmployeeEntity', ['employeeId'], ['id'], {
  name: 'fk_attendance_employee',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('ScheduleVersionEntity', ['scheduleVersionId'], ['id'], {
  name: 'fk_attendance_schedule',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('FileObjectEntity', ['photoFileId'], ['id'], {
  name: 'fk_attendance_photo',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Entity('attendances')
export class AttendanceEntity {
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
    name: 'employee_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  employeeId: string;

  @Column({ name: 'work_date', type: 'date' })
  workDate: string;

  @Column({
    name: 'schedule_version_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  scheduleVersionId: string;

  @Column({ name: 'time_zone', type: 'varchar', length: 100 })
  timeZone: string;

  @Column({ name: 'planned_start_at', type: 'datetime', precision: 3 })
  plannedStartAt: Date;

  @Column({ name: 'planned_end_at', type: 'datetime', precision: 3 })
  plannedEndAt: Date;

  @Column({ name: 'check_in_at', type: 'datetime', precision: 3 })
  checkInAt: Date;

  @Column({
    name: 'check_out_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
  })
  checkOutAt: Date | null;

  @Column({ name: 'punctuality', type: 'enum', enum: ['ON_TIME', 'LATE'] })
  punctuality: 'ON_TIME' | 'LATE';

  @Column({ name: 'late_seconds', type: 'int', default: 0 })
  lateSeconds: number;

  @Column({ name: 'duration_seconds', type: 'int', nullable: true })
  durationSeconds: number | null;

  @Column({
    name: 'photo_file_id',
    type: 'char',
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
  })
  photoFileId: string;

  @Column({
    name: 'open_employee_id',
    type: 'char',
    asExpression:
      'CASE WHEN `check_out_at` IS NULL THEN `employee_id` ELSE NULL END',
    generatedType: 'STORED',
    insert: false,
    update: false,
    length: 36,
    charset: 'ascii',
    collation: 'ascii_bin',
    nullable: true,
    select: false,
  })
  openEmployeeId: string | null;

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

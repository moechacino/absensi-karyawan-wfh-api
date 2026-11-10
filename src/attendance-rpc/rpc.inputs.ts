import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  ValidateIf,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class EmptyInput {}

export class PageInput {
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  page?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class TimeZonesInput {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(160)
  q?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  atDate?: string;
}

export class ScheduleInput {
  @IsInt()
  @Min(0)
  @Max(1440)
  opensMinutesBeforeStart: number = 15;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  workingDays: number[];

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  endTime: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  timeZone: string;

  @IsIn([0, 1])
  endDayOffset: 0 | 1;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  effectiveFrom: string;
}

export class HolidayYearInput {
  @IsInt()
  @Min(1970)
  @Max(9999)
  year: number;
}

export class HolidayInput {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  date: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/\S/)
  name: string;

  @IsIn(['COMPANY', 'PUBLIC', 'OTHER'])
  category: 'COMPANY' | 'PUBLIC' | 'OTHER';
}

export class HolidayChangeInput extends HolidayYearInput {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion: number;

  @IsArray()
  @ArrayMaxSize(366)
  @ValidateNested({ each: true })
  @Type(() => HolidayInput)
  upsert: HolidayInput[];

  @IsArray()
  @ArrayMaxSize(366)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true })
  @IsDateString({ strict: true }, { each: true })
  remove: string[];
}

export class AttendanceDaysInput extends PageInput {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  from: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  to: string;
}

export class AttendanceRecordInput {
  @IsUUID()
  attendanceId: string;
}

export class CheckoutVersionInput {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion: number;
}

export class CheckOutInput extends CheckoutVersionInput {
  @IsUUID()
  attendanceId: string;
}

export class MonitoringInput extends PageInput {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(160)
  q?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  date: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  divisionId?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn([
    'NOT_CHECKED_IN',
    'WORKING',
    'COMPLETED',
    'MISSED_CHECK_OUT',
    'HOLIDAY',
    'REST_DAY',
    'UNCONFIGURED',
  ])
  status?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['ON_TIME', 'LATE'])
  punctuality?: string;
}

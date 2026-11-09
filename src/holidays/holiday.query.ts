import { Transform } from 'class-transformer';

import { HolidayYearInput } from '../attendance-rpc/rpc.inputs';
import { queryInteger } from '../http/parsing';

export class HolidayYearQuery extends HolidayYearInput {
  @Transform(({ value }) => queryInteger(value, 'year'))
  declare year: number;
}

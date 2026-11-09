import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthGuard, JsonBodyGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { OrganizationGuard } from '../organization/organization.guard';
import { MultipartOnlyGuard } from '../http/parsing';
import { FileService } from '../files/file.service';
import { FileUploadInterceptor } from '../files/file-upload.interceptor';
import type { FileUpload } from '../files/file.types';
import type { StagedImage } from '../files/file.types';
import { digestFile } from '../idempotency/fingerprint';
import { LocalCommandRunner } from '../idempotency/local-command-runner.service';
import { EmployeeService } from './employee.service';
import {
  EmployeeCreate,
  EmployeePatch,
  EmployeeQuery,
  RoleChange,
} from './employee.dto';

@Controller('hr/employees')
@UseGuards(AuthGuard, OrganizationGuard)
export class EmployeeController {
  constructor(
    private readonly service: EmployeeService,
    private readonly commands: LocalCommandRunner,
    private readonly files: FileService,
  ) {}

  @Get()
  list(@Query() query: EmployeeQuery) {
    return this.service.list(query);
  }

  @Get(':employeeId')
  get(@Param('employeeId', new ParseUUIDPipe()) id: string) {
    return this.service.get(id);
  }

  @Get(':employeeId/initial-credentials')
  credentials(@Param('employeeId', new ParseUUIDPipe()) id: string) {
    return this.service.initialCredentials(id);
  }

  @Post()
  @UseGuards(MultipartOnlyGuard)
  @UseInterceptors(FileUploadInterceptor, FileInterceptor('photo'))
  async create(
    @Body() input: EmployeeCreate,
    @UploadedFile()
    photo:
      { buffer: Buffer; mimetype: string; originalname: string } | undefined,
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const employeeId = randomUUID();
    const result = await this.files.withAtomicFiles(
      this.uploads(photo, employeeId),
      ([staged]) =>
        this.commands.run(
          {
            actorId: request.actor.id,
            operation: 'createEmployee',
            files: photo ? [digestFile('photo', photo.buffer)] : [],
            key,
            input: {
              fullName: input.fullName,
              email: input.email,
              divisionId: input.divisionId,
              positionId: input.positionId,
              role: input.role,
              status: input.status,
              confirmHrAccess: input.confirmHrAccess ?? false,
            },
          },
          async (manager) => ({
            employeeId: await this.service.create(
              input,
              manager,
              employeeId,
              staged,
            ),
          }),
          {
            present: (manager, receipt, replayed) =>
              this.service.created(manager, receipt.employeeId, replayed),
          },
        ),
    );

    response.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.body;
  }

  @Put(':employeeId/role')
  @UseGuards(JsonBodyGuard)
  role(
    @Param('employeeId', new ParseUUIDPipe()) id: string,
    @Body() input: RoleChange,
  ) {
    return this.service.role(id, input);
  }

  @Patch(':employeeId')
  @UseGuards(MultipartOnlyGuard)
  @UseInterceptors(FileUploadInterceptor, FileInterceptor('photo'))
  async update(
    @Param('employeeId', new ParseUUIDPipe()) id: string,
    @Body() input: EmployeePatch,
    @UploadedFile()
    photo:
      { buffer: Buffer; mimetype: string; originalname: string } | undefined,
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.service.validatePatch(input, photo !== undefined);
    const fields = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    let replacedPhotoId: string | null = null;

    const run = (staged?: StagedImage) =>
      this.commands.run(
        {
          actorId: request.actor.id,
          key,
          operation: 'updateEmployee',
          resourceId: id,
          input: { ...fields, removePhoto: input.removePhoto ?? false },
          files: photo ? [digestFile('photo', photo.buffer)] : [],
        },
        async (manager) => {
          const changed = await this.service.update(id, input, manager, staged);
          replacedPhotoId = changed.replacedPhotoId;
          return changed.employee;
        },
        { status: 200 },
      );

    const result = await this.files.withAtomicFiles(
      this.uploads(photo, id),
      ([staged]) => run(staged),
    );

    if (!result.replayed && replacedPhotoId) {
      await this.files.deleteReplaced(replacedPhotoId);
    }

    response.setHeader('Idempotency-Replayed', String(result.replayed));
    return result.body;
  }

  private uploads(
    photo:
      { buffer: Buffer; mimetype: string; originalname: string } | undefined,
    employeeId: string,
  ): FileUpload[] {
    if (!photo) {
      return [];
    }

    return [
      {
        input: {
          bytes: photo.buffer,
          mimeType: photo.mimetype,
          fileName: photo.originalname,
        },
        ownerEmployeeId: employeeId,
        purpose: 'EMPLOYEE_PROFILE_PHOTO',
      },
    ];
  }
}

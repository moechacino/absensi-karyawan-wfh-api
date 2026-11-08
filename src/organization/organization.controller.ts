import { LocalCommandRunner } from '../idempotency/local-command-runner.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { Response } from 'express';
import {
  Body,
  Controller,
  Get,
  Headers,
  Req,
  Res,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, JsonBodyGuard } from '../auth/auth.guard';
import { OrganizationGuard } from './organization.guard';
import { OrganizationService } from './organization.service';
import {
  DivisionCreate,
  DivisionPatch,
  DivisionQuery,
  PositionCreate,
  PositionPatch,
  PositionQuery,
} from './organization.dto';
import type { DivisionView, PositionView, Page } from './organization.types';

@Controller('hr')
@UseGuards(AuthGuard, OrganizationGuard)
export class OrganizationController {
  constructor(
    private readonly service: OrganizationService,
    private readonly commands: LocalCommandRunner,
  ) {}

  @Get('divisions')
  listDivisions(@Query() query: DivisionQuery): Promise<Page<DivisionView>> {
    return this.service.listDivisions(query);
  }

  @Get('positions')
  listPositions(@Query() query: PositionQuery): Promise<Page<PositionView>> {
    return this.service.listPositions(query);
  }

  @Post('divisions')
  @UseGuards(JsonBodyGuard)
  @HttpCode(201)
  async createDivision(
    @Body() input: DivisionCreate,
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DivisionView> {
    const result = await this.commands.run(
      {
        actorId: request.actor.id,
        operation: 'createDivision',
        key,
        input: {
          code: input.code,
          name: input.name,
          status: input.status,
          description: input.description ?? null,
        },
      },
      (manager) => this.service.createDivision(input, manager),
    );
    response.setHeader('Idempotency-Replayed', String(result.replayed));

    return result.body;
  }

  @Post('positions')
  @UseGuards(JsonBodyGuard)
  @HttpCode(201)
  async createPosition(
    @Body() input: PositionCreate,
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PositionView> {
    const result = await this.commands.run(
      {
        actorId: request.actor.id,
        operation: 'createPosition',
        key,
        input: {
          code: input.code,
          name: input.name,
          status: input.status,
          divisionId: input.divisionId,
        },
      },
      (manager) => this.service.createPosition(input, manager),
    );
    response.setHeader('Idempotency-Replayed', String(result.replayed));

    return result.body;
  }

  @Patch('divisions/:divisionId')
  @UseGuards(JsonBodyGuard)
  updateDivision(
    @Param('divisionId', new ParseUUIDPipe()) id: string,
    @Body() input: DivisionPatch,
  ): Promise<DivisionView> {
    return this.service.updateDivision(id, input);
  }

  @Patch('positions/:positionId')
  @UseGuards(JsonBodyGuard)
  updatePosition(
    @Param('positionId', new ParseUUIDPipe()) id: string,
    @Body() input: PositionPatch,
  ): Promise<PositionView> {
    return this.service.updatePosition(id, input);
  }
}

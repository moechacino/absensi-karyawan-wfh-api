import { pipeline } from 'node:stream/promises';
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ProblemException } from '../http/problem';
import { FileService } from './file.service';

@Controller('files')
@UseGuards(AuthGuard)
export class FileController {
  constructor(private readonly service: FileService) {}

  @Get(':fileId')
  async content(
    @Param(
      'fileId',
      new ParseUUIDPipe({
        exceptionFactory: () =>
          new ProblemException(400, 'INVALID_FILE_ID', 'Invalid file ID'),
      }),
    )
    id: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.service.content(id, request.actor);
    const encodedName = encodeURIComponent(
      Buffer.from(file.fileName, 'utf8').toString('utf8'),
    ).replace(
      /[!'()*]/g,
      (character) => '%' + character.charCodeAt(0).toString(16),
    );
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', file.sizeBytes);
    response.setHeader(
      'Content-Disposition',
      `inline; filename="image"; filename*=UTF-8''${encodedName}`,
    );

    if (request.method === 'HEAD') {
      file.stream.destroy();
      response.end();

      return;
    }

    try {
      await pipeline(file.stream, response);
    } catch {
      response.destroy();
    }
  }
}

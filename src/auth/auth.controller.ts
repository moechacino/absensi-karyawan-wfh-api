import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { AuthGuard, JsonBodyGuard } from './auth.guard';
import type { AuthenticatedRequest } from './auth.guard';
import { LoginInput, PasswordInput } from './auth.dto';

@Controller()
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Post('auth/login')
  @UseGuards(JsonBodyGuard)
  @HttpCode(200)
  login(@Body() input: LoginInput, @Req() request: Request) {
    return this.service.login(
      input,
      request.ip ?? request.socket.remoteAddress ?? 'unknown',
    );
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: AuthenticatedRequest) {
    return this.service.me(request.actor);
  }

  @Post('auth/logout')
  @UseGuards(AuthGuard)
  @HttpCode(204)
  logout(): void {
    // nothing to do, no revoking access token
  }

  @Post('auth/password')
  @UseGuards(AuthGuard, JsonBodyGuard)
  @HttpCode(204)
  changePassword(
    @Body() input: PasswordInput,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.changePassword(request.actor, input);
  }
}

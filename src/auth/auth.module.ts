import { Module } from '@nestjs/common';

import { AccessTokenModule } from './access-token.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { PasswordService } from './password.service';
import { AuthGuard, JsonBodyGuard } from './auth.guard';
import { LoginThrottle } from './login-throttle.service';

@Module({
  imports: [AccessTokenModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    PasswordService,
    AuthGuard,
    JsonBodyGuard,
    LoginThrottle,
  ],
  exports: [AuthGuard, AccessTokenModule],
})
export class AuthModule {}

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { PasswordService } from './password.service';
import { AccessTokenService } from './access-token.service';
import { AuthGuard, JsonBodyGuard } from './auth.guard';
import { LoginThrottle } from './login-throttle.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    PasswordService,
    AccessTokenService,
    AuthGuard,
    JsonBodyGuard,
    LoginThrottle,
  ],
  exports: [AuthGuard, AccessTokenService],
})
export class AuthModule {}

import { OrganizationModule } from './organization/organization.module';
import { FileModule } from './files/file.module';
import { AuthModule } from './auth/auth.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { HttpModule } from './http/http.module';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { RuntimeModule } from './runtime/runtime.module';

@Module({
  imports: [
    RuntimeModule,
    DatabaseModule,
    HttpModule,
    IdempotencyModule,
    AuthModule,
    FileModule,
    OrganizationModule,
  ],
})
export class AppModule {}

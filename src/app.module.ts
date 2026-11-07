import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { RuntimeModule } from './runtime/runtime.module';

@Module({
  imports: [RuntimeModule, DatabaseModule],
})
export class AppModule {}

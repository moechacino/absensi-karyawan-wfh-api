import { Module } from '@nestjs/common';
import { PrivateStorageModule } from '../files/private-storage.module';
import { AttendanceFileRepository } from './attendance-file.repository';
import { AttendanceFileService } from './attendance-file.service';
import { AttendanceFileRpcController } from './attendance-file.rpc-controller';

@Module({
  imports: [PrivateStorageModule],
  controllers: [AttendanceFileRpcController],
  providers: [AttendanceFileRepository, AttendanceFileService],
  exports: [AttendanceFileService],
})
export class AttendanceFileModule {}

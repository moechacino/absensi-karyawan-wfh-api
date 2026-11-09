import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FileUploadInterceptor } from './file-upload.interceptor';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { FileRepository } from './file.repository';
import { PrivateStorageModule } from './private-storage.module';
import { GatewayAttendanceModule } from '../gateway-attendance/gateway-attendance.module';
import { RemoteImageService } from './remote-image.service';
import { UploadReceiptInterceptor } from './upload-receipt.interceptor';

@Module({
  imports: [AuthModule, PrivateStorageModule, GatewayAttendanceModule],
  controllers: [FileController],
  providers: [
    FileService,
    FileRepository,
    RemoteImageService,
    UploadReceiptInterceptor,
    FileUploadInterceptor,
  ],
  exports: [
    FileService,
    FileUploadInterceptor,
    RemoteImageService,
    UploadReceiptInterceptor,
  ],
})
export class FileModule {}

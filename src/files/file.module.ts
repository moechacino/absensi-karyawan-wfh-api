import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { FileRepository } from './file.repository';
import { ImageService } from './image.service';
import { StorageService } from './storage.service';

@Module({
  imports: [AuthModule],
  controllers: [FileController],
  providers: [FileService, FileRepository, ImageService, StorageService],
  exports: [FileService],
})
export class FileModule {}

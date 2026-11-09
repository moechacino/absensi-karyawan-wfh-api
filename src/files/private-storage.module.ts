import { Module } from '@nestjs/common';
import { ImageService } from './image.service';
import { StorageService } from './storage.service';

@Module({
  providers: [ImageService, StorageService],
  exports: [ImageService, StorageService],
})
export class PrivateStorageModule {}

import { Module } from '@nestjs/common';
import { configRootModule, databaseRootModule } from './config/root-modules';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { MediaExtractionService } from './videos/media-extraction.service';
import { VideoProcessor } from './videos/video.processor';
import { VideosModule } from './videos/videos.module';

// Worker-only providers (the queue consumer) are registered here, never in
// VideosModule, so the API process does not consume jobs.
@Module({
  imports: [
    configRootModule,
    databaseRootModule,
    // Registers User, which Channel (and so Video) is related to.
    UsersModule,
    StorageModule,
    QueueModule,
    VideosModule,
  ],
  providers: [MediaExtractionService, VideoProcessor],
})
export class WorkerModule {}

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { configRootModule, databaseRootModule } from './config/root-modules';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    configRootModule,
    databaseRootModule,
    AuthModule,
    StorageModule,
    QueueModule,
    VideosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

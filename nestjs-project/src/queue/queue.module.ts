import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_JOB_OPTIONS, VIDEO_QUEUE_NAME } from './queue.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (queue: ConfigType<typeof queueConfig>) => ({
        connection: { host: queue.host, port: queue.port },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_QUEUE_NAME,
      defaultJobOptions: VIDEO_JOB_OPTIONS,
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}

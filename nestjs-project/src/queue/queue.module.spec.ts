import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, registerAs } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { VIDEO_QUEUE_NAME } from './queue.constants';
import { QueueModule } from './queue.module';

const fakeQueueConfig = registerAs('queue', () => ({
  host: 'redis',
  port: 6379,
  videoQueueName: VIDEO_QUEUE_NAME,
}));

describe('QueueModule', () => {
  it('should compile and expose the video queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [fakeQueueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(module.get(getQueueToken(VIDEO_QUEUE_NAME))).toBeInstanceOf(Queue);
    await module.close();
  });
});

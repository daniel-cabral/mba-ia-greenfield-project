import { Test } from '@nestjs/testing';
import { WorkerModule } from './worker.module';
import { VideosService } from './videos/videos.service';

describe('WorkerModule', () => {
  it('should compile and expose VideosService without an HTTP server', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    await module.close();
  }, 30000);
});

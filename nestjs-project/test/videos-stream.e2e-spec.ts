import request from 'supertest';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  createE2eApp,
  E2eContext,
  registerConfirmedUser,
  TestUser,
} from './helpers/e2e-app';
import { insertVideo } from './helpers/ready-video';

describe('GET /videos/:slug/stream (e2e)', () => {
  let context: E2eContext;
  let storage: StorageService;
  let owner: TestUser;
  let ready: Video;

  beforeAll(async () => {
    context = await createE2eApp();
    storage = context.app.get(StorageService);
  });

  afterAll(async () => {
    await context.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(context.dataSource);
    context.throttlerStorage.storage.clear();
    owner = await registerConfirmedUser(context, 'owner@example.com');
    context.throttlerStorage.storage.clear();
    ready = await insertVideo(context.dataSource, storage, owner.id, {
      withObject: true,
    });
  });

  const stream = (slug: string, token?: string) => {
    const req = request(context.app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .redirects(0);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('should redirect anonymous viewers to a presigned URL that serves Range', async () => {
    const res = await stream(ready.slug).expect(302);

    const location = res.headers.location;
    expect(location).toContain(`videos/${ready.id}/original`);
    expect(location).toContain('X-Amz-Signature');

    const ranged = await fetch(location, { headers: { Range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 0-99/1000');
  });

  it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
    'should hide a %s video from everyone, owner included',
    async (status) => {
      const video = await insertVideo(context.dataSource, storage, owner.id, {
        status,
      });

      for (const token of [undefined, owner.accessToken]) {
        const res = await stream(video.slug, token).expect(404);
        expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
      }
    },
  );

  it('should answer 404 for an unknown slug', async () => {
    const res = await stream('unknownslug').expect(404);

    expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });

  it('should not rate limit the stream route', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await stream(ready.slug);
      expect(res.status).not.toBe(429);
    }
  });
});

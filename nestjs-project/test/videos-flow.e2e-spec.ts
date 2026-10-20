import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { VIDEO_QUEUE_NAME } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createE2eApp,
  E2eContext,
  registerConfirmedUser,
  TestUser,
} from './helpers/e2e-app';
import { generateAudioOnly, generateLargeVideo } from './helpers/media';

const FIVE_MIB = 5 * 1024 * 1024;

interface UploadSession {
  id: string;
  slug: string;
  partSize: number;
  partCount: number;
}

interface VideoStatusBody {
  status: string;
  durationSeconds: number | null;
  failureReason: string | null;
}

describe('Video upload flow (e2e)', () => {
  let context: E2eContext;
  let owner: TestUser;
  let queue: Queue;

  beforeAll(async () => {
    // Read when the config provider is built, so the app slices in 5 MiB parts.
    process.env.UPLOAD_PART_SIZE_BYTES = String(FIVE_MIB);
    context = await createE2eApp({ withProcessor: true });
    queue = context.app.get(getQueueToken(VIDEO_QUEUE_NAME));
  }, 30000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await context.app.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(context.dataSource);
    owner = await registerConfirmedUser(context, 'owner@example.com');
  });

  const authed = (req: request.Test) =>
    req.set('Authorization', `Bearer ${owner.accessToken}`);

  /** Runs init, parts, direct-to-storage PUTs and complete. */
  const uploadAndComplete = async (
    file: Buffer,
    filename: string,
  ): Promise<UploadSession> => {
    context.throttlerStorage.storage.clear();
    const created = await authed(
      request(context.app.getHttpServer()).post('/videos'),
    )
      .send({ filename, size: file.length, contentType: 'video/mp4' })
      .expect(201);
    const session = created.body as UploadSession;
    expect(session.partSize).toBe(FIVE_MIB);
    expect(session.partCount).toBe(Math.ceil(file.length / FIVE_MIB));

    const partNumbers = Array.from(
      { length: session.partCount },
      (_, i) => i + 1,
    );
    const signed = await authed(
      request(context.app.getHttpServer()).post(`/videos/${session.id}/parts`),
    )
      .send({ partNumbers })
      .expect(200);
    const parts = (
      signed.body as { parts: { partNumber: number; url: string }[] }
    ).parts;
    for (const { partNumber, url } of parts) {
      const body = file.subarray(
        (partNumber - 1) * FIVE_MIB,
        partNumber * FIVE_MIB,
      );
      const put = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(put.status).toBe(200);
    }

    context.throttlerStorage.storage.clear();
    await authed(
      request(context.app.getHttpServer()).post(
        `/videos/${session.id}/complete`,
      ),
    )
      .send()
      .expect(200);
    return session;
  };

  const waitForFinalStatus = async (id: string): Promise<VideoStatusBody> => {
    for (let i = 0; i < 150; i++) {
      context.throttlerStorage.storage.clear();
      const res = await authed(
        request(context.app.getHttpServer()).get(`/videos/${id}`),
      ).expect(200);
      const body = res.body as VideoStatusBody;
      if (body.status === 'ready' || body.status === 'error') return body;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Video ${id} did not finish processing`);
  };

  it('should upload in parts, process to ready, then stream and download publicly', async () => {
    const file = generateLargeVideo();
    expect(Math.ceil(file.length / FIVE_MIB)).toBeGreaterThanOrEqual(2);

    const session = await uploadAndComplete(file, 'holiday.mp4');

    // Not public until processing finishes.
    await request(context.app.getHttpServer())
      .get(`/videos/${session.slug}/stream`)
      .redirects(0)
      .expect(404);

    const done = await waitForFinalStatus(session.id);
    expect(done.status).toBe('ready');
    expect(done.durationSeconds).toBeGreaterThan(0);

    const stream = await request(context.app.getHttpServer())
      .get(`/videos/${session.slug}/stream`)
      .redirects(0)
      .expect(302);
    const ranged = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(ranged.status).toBe(206);

    const download = await request(context.app.getHttpServer())
      .get(`/videos/${session.slug}/download`)
      .redirects(0)
      .expect(302);
    const attachment = await fetch(download.headers.location, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(attachment.headers.get('content-disposition')).toContain(
      'attachment; filename="holiday.mp4"',
    );
  }, 60000);

  it('should end in error with a reason when the file has no video stream', async () => {
    const session = await uploadAndComplete(generateAudioOnly(), 'song.mp4');

    const done = await waitForFinalStatus(session.id);

    expect(done.status).toBe('error');
    expect(done.failureReason).toContain('no video stream');
    await request(context.app.getHttpServer())
      .get(`/videos/${session.slug}/stream`)
      .redirects(0)
      .expect(404);
  }, 60000);
});

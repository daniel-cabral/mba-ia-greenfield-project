import { getQueueToken } from '@nestjs/bullmq';
import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VIDEO_QUEUE_NAME } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import {
  VideoAlreadyFinalizedException,
  VideoNotFoundException,
  VideoUploadExpiredException,
  VideoUploadIncompleteException,
} from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let queue: Queue;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let s3: S3Client;
  let bucket: string;
  let user: User;
  let channel: Channel;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    await module.init();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    queue = module.get(getQueueToken(VIDEO_QUEUE_NAME));
    dataSource = module.get(getDataSourceToken());
    const config = storageConfig();
    bucket = config.bucket;
    s3 = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }, 30000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hashed' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Owner', nickname: 'owner', user_id: user.id });
  });

  it('should persist a draft row and open a real multipart upload', async () => {
    const session = await service.createDraft(user.id, {
      filename: 'my clip.mp4',
      size: 150 * 1024 * 1024,
      contentType: 'video/mp4',
    });

    expect(session).toMatchObject({
      status: VideoStatus.DRAFT,
      partSize: storageConfig().uploadPartSizeBytes,
      partCount: Math.ceil(
        (150 * 1024 * 1024) / storageConfig().uploadPartSizeBytes,
      ),
    });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: session.id });
    expect(row).toMatchObject({
      channel_id: channel.id,
      slug: session.slug,
      status: VideoStatus.DRAFT,
      title: 'my clip.mp4',
      upload_id: session.uploadId,
      original_key: `videos/${session.id}/original`,
      size_bytes: 150 * 1024 * 1024,
      mime_type: 'video/mp4',
    });

    // ListParts only succeeds while the multipart upload is open.
    const parts = await s3.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: row.original_key,
        UploadId: session.uploadId,
      }),
    );
    expect(parts.Parts ?? []).toHaveLength(0);
  });

  it('should sign part URLs that accept a real PUT', async () => {
    const session = await service.createDraft(user.id, {
      filename: 'tiny.mp4',
      size: 11,
      contentType: 'video/mp4',
    });

    const [part] = await service.signParts(user.id, session.id, [1]);

    expect(new URL(part.url).host).toBe(
      new URL(storageConfig().publicEndpoint).host,
    );
    const response = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(11),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();
  });

  describe('completeUpload', () => {
    const putFirstPart = async (videoId: string): Promise<void> => {
      const [part] = await service.signParts(user.id, videoId, [1]);
      const response = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(11),
      });
      expect(response.status).toBe(200);
    };

    const createTiny = () =>
      service.createDraft(user.id, {
        filename: 'tiny.mp4',
        size: 11,
        contentType: 'video/mp4',
      });

    it('should complete in storage, mark processing and enqueue once even when repeated', async () => {
      const { id } = await createTiny();
      await putFirstPart(id);

      expect(await service.completeUpload(user.id, id)).toEqual({
        id,
        status: VideoStatus.PROCESSING,
      });
      expect(await service.completeUpload(user.id, id)).toEqual({
        id,
        status: VideoStatus.PROCESSING,
      });

      const row = await dataSource.getRepository(Video).findOneByOrFail({ id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.size_bytes).toBe(11);
      const jobs = await queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(id);
      expect(jobs[0].data).toEqual({ videoId: id });
    });

    it('should reject a draft without parts', async () => {
      const { id } = await createTiny();

      await expect(service.completeUpload(user.id, id)).rejects.toBeInstanceOf(
        VideoUploadIncompleteException,
      );
    });

    it('should recover when storage was completed but the row is still a draft', async () => {
      const { id, uploadId } = await createTiny();
      await putFirstPart(id);
      const row = await dataSource.getRepository(Video).findOneByOrFail({ id });
      const listed = await s3.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: row.original_key,
          UploadId: uploadId,
        }),
      );
      const etag = listed.Parts![0].ETag;
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: row.original_key,
          UploadId: uploadId,
          MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] },
        }),
      );

      const result = await service.completeUpload(user.id, id);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(await queue.getJobs(['waiting'])).toHaveLength(1);
    });

    it('should report an expired upload when it was aborted before completion', async () => {
      const { id, uploadId } = await createTiny();
      const row = await dataSource.getRepository(Video).findOneByOrFail({ id });
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: row.original_key,
          UploadId: uploadId,
        }),
      );

      await expect(service.completeUpload(user.id, id)).rejects.toBeInstanceOf(
        VideoUploadExpiredException,
      );
    });

    it('should refuse a finalized video', async () => {
      const { id } = await createTiny();
      await dataSource
        .getRepository(Video)
        .update({ id }, { status: VideoStatus.READY });

      await expect(service.completeUpload(user.id, id)).rejects.toBeInstanceOf(
        VideoAlreadyFinalizedException,
      );
    });
  });

  describe('getOwned', () => {
    it('should read the row for the owner and hide it from another user', async () => {
      const { id } = await service.createDraft(user.id, {
        filename: 'a.mp4',
        size: 10,
        contentType: 'video/mp4',
      });
      const stranger = await dataSource
        .getRepository(User)
        .save({ email: 'stranger@example.com', password: 'hashed' });
      await dataSource
        .getRepository(Channel)
        .save({ name: 'S', nickname: 'stranger', user_id: stranger.id });

      expect((await service.getOwned(user.id, id)).id).toBe(id);
      await expect(service.getOwned(stranger.id, id)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });

  describe('getPlaybackUrl', () => {
    const insertReady = async (title: string): Promise<Video> => {
      const id = randomUUID();
      const video = await dataSource.getRepository(Video).save({
        id,
        channel_id: channel.id,
        title,
        slug: id.replace(/-/g, '').slice(0, 11),
        status: VideoStatus.READY,
        upload_id: 'upload',
        original_key: `videos/${id}/original`,
        size_bytes: 1000,
        mime_type: 'video/mp4',
      });
      const bytes = Buffer.alloc(1000, 7);
      await storage.putObject(video.original_key, bytes, 'video/mp4');
      return video;
    };

    it('should stream with Range from the signed URL', async () => {
      const video = await insertReady('Clip');

      const url = await service.getPlaybackUrl(video.slug, 'stream');
      const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-99/1000');
    });

    it('should download as an attachment with a safe file name', async () => {
      const video = await insertReady('My "best"/clip');

      const url = await service.getPlaybackUrl(video.slug, 'download');
      const response = await fetch(url);

      expect(response.status).toBe(200);
      const disposition = response.headers.get('content-disposition')!;
      expect(disposition.startsWith('attachment')).toBe(true);
      expect(disposition).toContain('filename="My _best__clip.mp4"');
    });
  });
});

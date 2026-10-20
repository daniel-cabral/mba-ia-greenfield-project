import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  VideoAlreadyFinalizedException,
  VideoInvalidPartException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoUploadExpiredException,
  VideoUploadIncompleteException,
  VideoUploadTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { VIDEO_QUEUE_NAME } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { InvalidVideoTransitionError, VideosService } from './videos.service';

const MAX_BYTES = 1000;
const PART_SIZE = 100;

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    create: jest.fn((fields: Partial<Video>) => fields),
    save: jest.fn((video: Partial<Video>) => Promise.resolve(video)),
    findOneBy: jest.fn(),
    update: jest.fn(),
  };
  const queue = { add: jest.fn() };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    presignGet: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
    storageService.createMultipartUpload.mockResolvedValue('upload-1');
    videoRepository.save.mockImplementation((video: Partial<Video>) =>
      Promise.resolve(video),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: getQueueToken(VIDEO_QUEUE_NAME), useValue: queue },
        {
          provide: storageConfig.KEY,
          useValue: {
            uploadMaxBytes: MAX_BYTES,
            streamUrlExpiresSeconds: 300,
            downloadUrlExpiresSeconds: 900,
            uploadPartSizeBytes: PART_SIZE,
          },
        },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  const dto = { filename: 'clip.mp4', size: 250, contentType: 'video/mp4' };

  it('should reject a size above the cap before touching storage', async () => {
    await expect(
      service.createDraft('user-1', { ...dto, size: MAX_BYTES + 1 }),
    ).rejects.toBeInstanceOf(VideoUploadTooLargeException);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('should open the upload, persist a draft and compute the part count', async () => {
    const result = await service.createDraft('user-1', dto);

    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^videos\/[0-9a-f-]{36}\/original$/),
      'video/mp4',
    );
    expect(videoRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'channel-1',
        title: 'clip.mp4',
        status: VideoStatus.DRAFT,
        upload_id: 'upload-1',
        size_bytes: 250,
        mime_type: 'video/mp4',
      }),
    );
    expect(result.id).toHaveLength(36);
    expect(result.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(result).toMatchObject({
      status: VideoStatus.DRAFT,
      uploadId: 'upload-1',
      partSize: PART_SIZE,
      partCount: 3,
    });
  });

  it('should keep a provided title instead of the filename', async () => {
    await service.createDraft('user-1', { ...dto, title: 'My title' });

    expect(videoRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'My title' }),
    );
  });

  it('should retry with a new slug when the slug collides', async () => {
    const collision = Object.assign(
      new QueryFailedError('insert', [], new Error('duplicate')),
      { code: '23505', detail: 'Key (slug)=(x) already exists.' },
    );
    videoRepository.save.mockRejectedValueOnce(collision);

    const result = await service.createDraft('user-1', dto);

    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(result.slug).toHaveLength(11);
    const slugs = videoRepository.create.mock.calls.map(([f]) => f.slug);
    expect(slugs[0]).not.toBe(slugs[1]);
  });

  it('should rethrow other database errors without retrying', async () => {
    const failure = Object.assign(
      new QueryFailedError('insert', [], new Error('boom')),
      { code: '23503', detail: 'foreign key' },
    );
    videoRepository.save.mockRejectedValueOnce(failure);

    await expect(service.createDraft('user-1', dto)).rejects.toBe(failure);
    expect(videoRepository.save).toHaveBeenCalledTimes(1);
  });

  describe('signParts', () => {
    const draft = {
      id: '11111111-1111-4111-8111-111111111111',
      status: VideoStatus.DRAFT,
      size_bytes: 250,
      original_key: 'videos/x/original',
      upload_id: 'upload-1',
    };

    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue(draft);
      storageService.presignUploadPart.mockImplementation(
        (_key: string, _upload: string, part: number) =>
          Promise.resolve(`http://signed/${part}`),
      );
    });

    it('should sign each requested part of an owned draft', async () => {
      const parts = await service.signParts('user-1', draft.id, [1, 3]);

      expect(parts).toEqual([
        { partNumber: 1, url: 'http://signed/1' },
        { partNumber: 3, url: 'http://signed/3' },
      ]);
      expect(videoRepository.findOneBy).toHaveBeenCalledWith({
        id: draft.id,
        channel_id: 'channel-1',
      });
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/x/original',
        'upload-1',
        3,
      );
    });

    it('should answer not found for a malformed id, a missing video and a user without channel', async () => {
      await expect(
        service.signParts('user-1', 'not-a-uuid', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      videoRepository.findOneBy.mockResolvedValueOnce(null);
      await expect(
        service.signParts('user-1', draft.id, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      channelsService.findByUserId.mockResolvedValueOnce(null);
      await expect(
        service.signParts('user-1', draft.id, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should refuse a video that is not a draft', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        ...draft,
        status: VideoStatus.PROCESSING,
      });

      await expect(
        service.signParts('user-1', draft.id, [1]),
      ).rejects.toBeInstanceOf(VideoNotDraftException);
    });

    it.each([[[]], [[0]], [[4]], [[1, 4]]])(
      'should reject part numbers %j outside 1..3',
      async (partNumbers) => {
        await expect(
          service.signParts('user-1', draft.id, partNumbers),
        ).rejects.toBeInstanceOf(VideoInvalidPartException);
        expect(storageService.presignUploadPart).not.toHaveBeenCalled();
      },
    );
  });

  describe('completeUpload', () => {
    const videoId = '11111111-1111-4111-8111-111111111111';
    const video = {
      id: videoId,
      status: VideoStatus.DRAFT,
      size_bytes: 250,
      original_key: `videos/${videoId}/original`,
      upload_id: 'upload-1',
    };
    const parts = [
      { partNumber: 1, etag: 'a', size: 100 },
      { partNumber: 2, etag: 'b', size: 100 },
      { partNumber: 3, etag: 'c', size: 50 },
    ];
    const noSuchUpload = Object.assign(new Error('gone'), {
      name: 'NoSuchUpload',
    });

    beforeEach(() => {
      videoRepository.findOneBy.mockResolvedValue(video);
      storageService.listParts.mockResolvedValue(parts);
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.headObject.mockResolvedValue({ size: 250 });
    });

    const expectEnqueued = () =>
      expect(queue.add).toHaveBeenCalledWith(
        'video.process',
        { videoId },
        { jobId: videoId },
      );

    it('should complete the upload, mark processing and enqueue the job', async () => {
      const result = await service.completeUpload('user-1', videoId);

      expect(result).toEqual({ id: videoId, status: VideoStatus.PROCESSING });
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        video.original_key,
        'upload-1',
        parts,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: videoId },
        { status: VideoStatus.PROCESSING, size_bytes: 250 },
      );
      expectEnqueued();
    });

    it('should resume after a crash when the upload is gone but the object exists', async () => {
      storageService.listParts.mockRejectedValue(noSuchUpload);

      const result = await service.completeUpload('user-1', videoId);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expectEnqueued();
    });

    it('should report an expired upload when neither upload nor object exist', async () => {
      storageService.listParts.mockRejectedValue(noSuchUpload);
      storageService.headObject.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-1', videoId),
      ).rejects.toBeInstanceOf(VideoUploadExpiredException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each([[[]], [parts.slice(0, 2)]])(
      'should reject an upload with %j parts instead of the declared 3',
      async (stored) => {
        storageService.listParts.mockResolvedValue(stored);

        await expect(
          service.completeUpload('user-1', videoId),
        ).rejects.toBeInstanceOf(VideoUploadIncompleteException);
        expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it('should reject a stored object above the cap', async () => {
      storageService.headObject.mockResolvedValue({ size: MAX_BYTES + 1 });

      await expect(
        service.completeUpload('user-1', videoId),
      ).rejects.toBeInstanceOf(VideoUploadTooLargeException);
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should only re-enqueue a video that is already processing', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        ...video,
        status: VideoStatus.PROCESSING,
      });

      const result = await service.completeUpload('user-1', videoId);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(storageService.listParts).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
      expectEnqueued();
    });

    it.each([VideoStatus.READY, VideoStatus.ERROR])(
      'should refuse a video in %s',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue({ ...video, status });

        await expect(
          service.completeUpload('user-1', videoId),
        ).rejects.toBeInstanceOf(VideoAlreadyFinalizedException);
        expect(queue.add).not.toHaveBeenCalled();
      },
    );

    it('should rethrow unexpected storage errors', async () => {
      const failure = new Error('storage down');
      storageService.listParts.mockRejectedValue(failure);

      await expect(service.completeUpload('user-1', videoId)).rejects.toBe(
        failure,
      );
    });
  });

  describe('getOwned', () => {
    const videoId = '11111111-1111-4111-8111-111111111111';

    it('should return the video of its owner', async () => {
      const video = { id: videoId, channel_id: 'channel-1' };
      videoRepository.findOneBy.mockResolvedValue(video);

      expect(await service.getOwned('user-1', videoId)).toBe(video);
      expect(videoRepository.findOneBy).toHaveBeenCalledWith({
        id: videoId,
        channel_id: 'channel-1',
      });
    });

    it('should answer not found when the video belongs to someone else', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.getOwned('user-2', videoId)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });

  describe('worker transitions', () => {
    const videoId = '11111111-1111-4111-8111-111111111111';
    const result = {
      durationSeconds: 12.5,
      metadata: { format: { duration: '12.5' } },
      thumbnailKey: `videos/${videoId}/thumbnail.jpg`,
    };

    it('should move a processing video to ready with the extracted data', async () => {
      videoRepository.update.mockResolvedValue({ affected: 1 });

      await service.markReady(videoId, result);

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: videoId, status: VideoStatus.PROCESSING },
        {
          duration_seconds: 12.5,
          metadata: result.metadata,
          thumbnail_key: result.thumbnailKey,
          failure_reason: null,
          status: VideoStatus.READY,
        },
      );
    });

    it('should move a processing video to error with the reason', async () => {
      videoRepository.update.mockResolvedValue({ affected: 1 });

      await service.markError(videoId, 'No video stream');

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: videoId, status: VideoStatus.PROCESSING },
        { failure_reason: 'No video stream', status: VideoStatus.ERROR },
      );
    });

    it.each([
      [VideoStatus.READY, 'ready'],
      [VideoStatus.DRAFT, 'draft'],
      [null, 'missing'],
    ])(
      'should refuse to leave %s (nothing updated)',
      async (current, label) => {
        videoRepository.update.mockResolvedValue({ affected: 0 });
        videoRepository.findOneBy.mockResolvedValue(
          current ? { id: videoId, status: current } : null,
        );

        const attempt = service.markError(videoId, 'x');

        await expect(attempt).rejects.toBeInstanceOf(
          InvalidVideoTransitionError,
        );
        await expect(attempt).rejects.toThrow(`from ${label} to error`);
      },
    );

    it('should refuse markReady on a video that is already ready', async () => {
      videoRepository.update.mockResolvedValue({ affected: 0 });
      videoRepository.findOneBy.mockResolvedValue({
        id: videoId,
        status: VideoStatus.READY,
      });

      await expect(service.markReady(videoId, result)).rejects.toThrow(
        'cannot move from ready to ready',
      );
    });
  });

  describe('getPlaybackUrl', () => {
    const ready = {
      status: VideoStatus.READY,
      original_key: 'videos/x/original',
      title: 'Holiday "2024"',
      mime_type: 'video/mp4',
    };

    beforeEach(() => {
      storageService.presignGet.mockResolvedValue('http://signed/get');
    });

    it('should presign a plain read for streaming a ready video', async () => {
      videoRepository.findOneBy.mockResolvedValue(ready);

      const url = await service.getPlaybackUrl('abcdefghijk', 'stream');

      expect(url).toBe('http://signed/get');
      expect(videoRepository.findOneBy).toHaveBeenCalledWith({
        slug: 'abcdefghijk',
      });
      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos/x/original',
        300,
      );
    });

    it('should presign an attachment with a sanitized name for downloads', async () => {
      videoRepository.findOneBy.mockResolvedValue(ready);

      await service.getPlaybackUrl('abcdefghijk', 'download');

      const [key, expires, disposition] = storageService.presignGet.mock
        .calls[0] as [string, number, string];
      expect(key).toBe('videos/x/original');
      expect(expires).toBe(900);
      expect(disposition).toContain('attachment;');
      expect(disposition).toContain('filename="Holiday _2024_.mp4"');
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
      'should answer not found for a %s video in both modes',
      async (status) => {
        videoRepository.findOneBy.mockResolvedValue({ ...ready, status });

        for (const mode of ['stream', 'download'] as const) {
          await expect(
            service.getPlaybackUrl('abcdefghijk', mode),
          ).rejects.toBeInstanceOf(VideoNotFoundException);
        }
        expect(storageService.presignGet).not.toHaveBeenCalled();
      },
    );

    it('should answer not found for an unknown slug', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.getPlaybackUrl('unknownslug', 'stream'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});

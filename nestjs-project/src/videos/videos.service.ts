import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ChannelsService } from '../channels/channels.service';
import {
  VideoInvalidPartException,
  VideoAlreadyFinalizedException,
  VideoNotDraftException,
  VideoNotFoundException,
  VideoUploadExpiredException,
  VideoUploadIncompleteException,
  VideoUploadTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_QUEUE_NAME,
  type VideoProcessJobData,
} from '../queue/queue.constants';
import { isNoSuchUpload, StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import type { SignedPartDto } from './dto/signed-parts-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { attachmentDisposition } from './download-filename.util';
import { sanitizeFilename } from './filename.util';
import { generateSlug } from './slug.util';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_CONSTRAINT_HINT = 'slug';
const SLUG_MAX_ATTEMPTS = 5;

export class InvalidVideoTransitionError extends Error {
  constructor(videoId: string, from: VideoStatus | 'missing', to: VideoStatus) {
    super(`Video ${videoId} cannot move from ${from} to ${to}`);
    this.name = 'InvalidVideoTransitionError';
  }
}

export interface ProcessingResult {
  durationSeconds: number;
  metadata: Record<string, unknown>;
  thumbnailKey: string;
}

export interface UploadSession {
  id: string;
  slug: string;
  status: VideoStatus;
  uploadId: string;
  partSize: number;
  partCount: number;
}

function isSlugCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error as QueryFailedError & {
    code?: string;
    detail?: string;
  };
  return (
    code === PG_UNIQUE_VIOLATION && !!detail?.includes(SLUG_CONSTRAINT_HINT)
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    @InjectQueue(VIDEO_QUEUE_NAME)
    private readonly queue: Queue<VideoProcessJobData>,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<UploadSession> {
    if (dto.size > this.config.uploadMaxBytes) {
      throw new VideoUploadTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const originalKey = `videos/${id}/original`;
    const partSize = this.config.uploadPartSizeBytes;
    const uploadId = await this.storageService.createMultipartUpload(
      originalKey,
      dto.contentType,
    );

    const video = await this.saveWithUniqueSlug({
      id,
      channel_id: channel.id,
      title: dto.title ?? sanitizeFilename(dto.filename),
      status: VideoStatus.DRAFT,
      upload_id: uploadId,
      original_key: originalKey,
      size_bytes: dto.size,
      mime_type: dto.contentType,
    });

    return {
      id: video.id,
      slug: video.slug,
      status: video.status,
      uploadId,
      partSize,
      partCount: Math.ceil(dto.size / partSize),
    };
  }

  async signParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<SignedPartDto[]> {
    const video = await this.findOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotDraftException();
    }

    const partCount = Math.ceil(
      video.size_bytes / this.config.uploadPartSizeBytes,
    );
    if (
      partNumbers.length === 0 ||
      partNumbers.some((n) => n < 1 || n > partCount)
    ) {
      throw new VideoInvalidPartException();
    }

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          video.original_key,
          video.upload_id,
          partNumber,
        ),
      })),
    );
  }

  /**
   * Presigned URL for a public viewer. Only `ready` videos exist for the
   * public, whoever asks (the owner included).
   */
  async getPlaybackUrl(
    slug: string,
    mode: 'stream' | 'download',
  ): Promise<string> {
    const video = await this.videoRepository.findOneBy({ slug });
    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }

    if (mode === 'download') {
      return this.storageService.presignGet(
        video.original_key,
        this.config.downloadUrlExpiresSeconds,
        attachmentDisposition(video.title, video.mime_type),
      );
    }
    return this.storageService.presignGet(
      video.original_key,
      this.config.streamUrlExpiresSeconds,
    );
  }

  /** Unscoped lookup for the worker, which acts for no user. */
  async findById(videoId: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id: videoId });
  }

  /** processing -> ready, once the worker extracted metadata and thumbnail. */
  async markReady(videoId: string, result: ProcessingResult): Promise<void> {
    await this.transition(videoId, VideoStatus.READY, {
      duration_seconds: result.durationSeconds,
      metadata: result.metadata as QueryDeepPartialEntity<Video>['metadata'],
      thumbnail_key: result.thumbnailKey,
      failure_reason: null,
    });
  }

  /** processing -> error, with the reason the owner will see. */
  async markError(videoId: string, reason: string): Promise<void> {
    await this.transition(videoId, VideoStatus.ERROR, {
      failure_reason: reason,
    });
  }

  async getOwned(userId: string, videoId: string): Promise<Video> {
    return this.findOwnedVideo(userId, videoId);
  }

  /**
   * Closes the multipart upload and hands the video to the worker. Safe to
   * repeat and to resume after a crash between the storage completion and the
   * status write.
   */
  async completeUpload(
    userId: string,
    videoId: string,
  ): Promise<{ id: string; status: VideoStatus }> {
    const video = await this.findOwnedVideo(userId, videoId);

    if (
      video.status === VideoStatus.READY ||
      video.status === VideoStatus.ERROR
    ) {
      throw new VideoAlreadyFinalizedException();
    }

    if (video.status === VideoStatus.DRAFT) {
      const storedSize = await this.finishMultipartUpload(video);
      await this.videoRepository.update(
        { id: video.id },
        { status: VideoStatus.PROCESSING, size_bytes: storedSize },
      );
    }

    await this.enqueueProcessing(video.id);
    return { id: video.id, status: VideoStatus.PROCESSING };
  }

  /** Returns the size of the stored object once the upload is complete. */
  private async finishMultipartUpload(video: Video): Promise<number> {
    try {
      const parts = await this.storageService.listParts(
        video.original_key,
        video.upload_id,
      );
      const expectedParts = Math.ceil(
        video.size_bytes / this.config.uploadPartSizeBytes,
      );
      if (parts.length === 0 || parts.length !== expectedParts) {
        throw new VideoUploadIncompleteException();
      }
      await this.storageService.completeMultipartUpload(
        video.original_key,
        video.upload_id,
        parts,
      );
    } catch (error) {
      // The upload is gone: a previous call may have completed it in storage
      // and crashed before writing the status. The object tells the two apart.
      if (!isNoSuchUpload(error)) throw error;
    }

    const stored = await this.storageService.headObject(video.original_key);
    if (!stored) throw new VideoUploadExpiredException();
    if (stored.size > this.config.uploadMaxBytes) {
      throw new VideoUploadTooLargeException();
    }
    return stored.size;
  }

  /** Guarded in the WHERE clause so a concurrent change cannot be overwritten. */
  private async transition(
    videoId: string,
    to: VideoStatus,
    fields: QueryDeepPartialEntity<Video>,
  ): Promise<void> {
    const result = await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { ...fields, status: to },
    );
    if (result.affected) return;

    const current = await this.videoRepository.findOneBy({ id: videoId });
    throw new InvalidVideoTransitionError(
      videoId,
      current?.status ?? 'missing',
      to,
    );
  }

  private async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(VIDEO_PROCESS_JOB, { videoId }, { jobId: videoId });
  }

  /** Hides other users' videos behind the same 404 as a missing one. */
  private async findOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    if (!isUUID(videoId)) throw new VideoNotFoundException();
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new VideoNotFoundException();
    const video = await this.videoRepository.findOneBy({
      id: videoId,
      channel_id: channel.id,
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private async saveWithUniqueSlug(fields: Partial<Video>): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({ ...fields, slug: generateSlug() }),
        );
      } catch (error) {
        if (!isSlugCollision(error) || attempt >= SLUG_MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
  }
}

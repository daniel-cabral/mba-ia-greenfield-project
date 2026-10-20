import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import {
  VIDEO_QUEUE_NAME,
  type VideoProcessJobData,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from './entities/video.entity';
import {
  MediaExtractionService,
  NoVideoStreamError,
} from './media-extraction.service';
import { VideosService } from './videos.service';

const STALLED_MESSAGE = 'stalled more than allowable limit';
const MAX_FAILURE_REASON_LENGTH = 1000;

/** Consumes video.process jobs. Registered only in the worker module. */
@Processor(VIDEO_QUEUE_NAME)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly mediaExtraction: MediaExtractionService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const video = await this.videosService.findById(job.data.videoId);
    if (!video) {
      throw new UnrecoverableError(`Video ${job.data.videoId} not found`);
    }
    // At-least-once delivery: a repeated job must not redo finished work.
    if (video.status === VideoStatus.READY) return;
    if (video.status !== VideoStatus.PROCESSING) {
      throw new UnrecoverableError(
        `Video ${video.id} is ${video.status}, expected processing`,
      );
    }

    const sourceUrl = await this.storageService.presignInternalRead(
      video.original_key,
    );
    try {
      const probed = await this.mediaExtraction.probe(sourceUrl);
      const thumbnail = await this.mediaExtraction.extractThumbnail(
        sourceUrl,
        probed.durationSeconds,
      );
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await this.storageService.putObject(
        thumbnailKey,
        thumbnail,
        'image/jpeg',
      );
      await this.videosService.markReady(video.id, {
        durationSeconds: probed.durationSeconds,
        metadata: probed.metadata,
        thumbnailKey,
      });
    } catch (error) {
      if (error instanceof NoVideoStreamError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  /**
   * Writes the final `error` state. Also runs for jobs failed by stalling,
   * which never reach process().
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job || !this.isFinalFailure(job, error)) return;
    try {
      await this.videosService.markError(
        job.data.videoId,
        error.message.slice(0, MAX_FAILURE_REASON_LENGTH),
      );
    } catch (markError) {
      // Event handler: rethrowing would crash the worker process.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as error`,
        markError instanceof Error ? markError.stack : String(markError),
      );
    }
  }

  private isFinalFailure(job: Job<VideoProcessJobData>, error: Error): boolean {
    return (
      error instanceof UnrecoverableError ||
      error.message.includes(STALLED_MESSAGE) ||
      job.attemptsMade >= (job.opts.attempts ?? 1)
    );
  }
}

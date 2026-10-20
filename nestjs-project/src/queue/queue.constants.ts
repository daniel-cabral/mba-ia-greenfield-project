import 'dotenv/config';
import type { JobsOptions } from 'bullmq';

// Read at import time because @InjectQueue / registerQueue need a static name,
// and the Jest setup file renames the queue before any module is loaded.
export const VIDEO_QUEUE_NAME =
  process.env.VIDEO_QUEUE_NAME ?? 'video-processing';

export const VIDEO_PROCESS_JOB = 'video.process';

const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

export const VIDEO_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: { age: SEVEN_DAYS_IN_SECONDS },
};

export interface VideoProcessJobData {
  videoId: string;
}

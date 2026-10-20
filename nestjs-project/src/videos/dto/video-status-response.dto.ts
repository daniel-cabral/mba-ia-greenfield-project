import { ApiProperty } from '@nestjs/swagger';
import { Video, VideoStatus } from '../entities/video.entity';

export class VideoStatusResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dBjftJeZ4CV', minLength: 11, maxLength: 11 })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ type: Number, nullable: true, required: false })
  durationSeconds: number | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  failureReason: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  static from(video: Video): VideoStatusResponseDto {
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      failureReason: video.failure_reason,
      createdAt: video.created_at,
    };
  }
}

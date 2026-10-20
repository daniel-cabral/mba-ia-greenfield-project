import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class CreateVideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dBjftJeZ4CV', minLength: 11, maxLength: 11 })
  slug: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ description: 'S3 multipart upload id' })
  uploadId: string;

  @ApiProperty({ description: 'Bytes per part, except the last one' })
  partSize: number;

  @ApiProperty({ description: 'Number of parts the client must upload' })
  partCount: number;
}

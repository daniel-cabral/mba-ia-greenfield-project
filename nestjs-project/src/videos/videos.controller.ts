import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
  type HttpRedirectResponse,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignPartsDto } from './dto/sign-parts.dto';
import { SignedPartsResponseDto } from './dto/signed-parts-response.dto';
import { VideoCompletedResponseDto } from './dto/video-completed-response.dto';
import { VideoStatusResponseDto } from './dto/video-status-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a video draft and open the upload',
    description:
      "Creates a draft video in the caller's channel and opens an S3 multipart upload. The client uploads the parts straight to storage.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or declared size above the upload cap',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Post(':id/parts')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Signs presigned PUT URLs for the requested part numbers of a draft video. Owner only; called as often as the upload needs, so it is not rate limited.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: SignedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SignPartsDto,
  ): Promise<SignedPartsResponseDto> {
    return {
      parts: await this.videosService.signParts(user.sub, id, dto.partNumbers),
    };
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the upload and start processing',
    description:
      'Closes the multipart upload in storage, moves the video to processing and enqueues the processing job. Safe to call again while the video is processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, video is processing',
    type: VideoCompletedResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Missing parts or object above the upload cap',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video already finalized or the upload expired',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoCompletedResponseDto> {
    return this.videosService.completeUpload(user.sub, id);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the status of an own video',
    description:
      'Owner-only read of a video in any status, including the failure reason when processing failed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video status',
    type: VideoStatusResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoStatusResponseDto> {
    return VideoStatusResponseDto.from(
      await this.videosService.getOwned(user.sub, id),
    );
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a ready video',
    description:
      'Redirects to a short-lived presigned URL; storage serves the bytes with Range support. Only ready videos are available, for everyone.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned storage URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug or video not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('slug') slug: string): Promise<HttpRedirectResponse> {
    return {
      url: await this.videosService.getPlaybackUrl(slug, 'stream'),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a ready video',
    description:
      'Redirects to a presigned URL that forces an attachment download with a safe file name. Only ready videos are available, for everyone.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned storage URL (Location header)',
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug or video not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('slug') slug: string): Promise<HttpRedirectResponse> {
    return {
      url: await this.videosService.getPlaybackUrl(slug, 'download'),
      statusCode: HttpStatus.FOUND,
    };
  }
}

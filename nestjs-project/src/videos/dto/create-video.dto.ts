import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateVideoDto {
  /** Original file name, used as the default title. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** File size in bytes. The upper bound is enforced by the service. */
  @IsInt()
  @Min(1)
  size: number;

  /** MIME type of the file; must be a video type. */
  @IsString()
  @Matches(/^video\//)
  contentType: string;

  /** Video title. Defaults to the sanitized file name. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;
}

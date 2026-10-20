import { ArrayMaxSize, IsArray, IsInt } from 'class-validator';
import { MAX_PARTS_PER_SIGN_REQUEST } from '../videos.constants';

export class SignPartsDto {
  /** Part numbers to sign, each between 1 and the video's part count. */
  @IsArray()
  @ArrayMaxSize(MAX_PARTS_PER_SIGN_REQUEST)
  @IsInt({ each: true })
  partNumbers: number[];
}

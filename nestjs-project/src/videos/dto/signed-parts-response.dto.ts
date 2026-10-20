import { ApiProperty } from '@nestjs/swagger';

export class SignedPartDto {
  @ApiProperty({ minimum: 1 })
  partNumber: number;

  @ApiProperty({ description: 'Presigned PUT URL for this part' })
  url: string;
}

export class SignedPartsResponseDto {
  @ApiProperty({ type: [SignedPartDto] })
  parts: SignedPartDto[];
}

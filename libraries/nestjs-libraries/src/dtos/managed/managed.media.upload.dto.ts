import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { MANAGED_OPERATION_KEY } from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';
import { MANAGED_UPLOAD_MAX_BYTES } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

// The types a reserved upload may declare: the media library's own list
export const MANAGED_UPLOAD_MIME = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
] as const;

// What W&W declares before sending a byte. The server only records evidence
// for bytes it stored and read back with exactly this digest, size and type;
// the declaration is never evidence on its own
export class ReserveManagedMediaUploadDto {
  @IsString()
  @Matches(MANAGED_OPERATION_KEY)
  operationKey: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  sha256: string;

  @IsInt()
  @Min(1)
  @Max(MANAGED_UPLOAD_MAX_BYTES)
  byteLength: number;

  @IsString()
  @IsIn(MANAGED_UPLOAD_MIME)
  mimeType: string;
}

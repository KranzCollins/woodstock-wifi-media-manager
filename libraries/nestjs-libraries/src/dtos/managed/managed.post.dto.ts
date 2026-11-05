import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// W&W managed API (docs/managed-extension/README.md). None of these carry an
// organization: it always comes from the authenticated managed credential.

export const MANAGED_OPERATION_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;

// the longest alt text a provider takes (instagram's checkValidity)
export const MANAGED_ALT_MAX_LENGTH = 1000;
// a sanity bound only: the video's duration is not known to the server
export const MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS = 24 * 60 * 60 * 1000;

// a cover picture: other media of the organization, proven like any media
export class ManagedThumbnailRefDto {
  @IsString()
  @Matches(ID)
  mediaId: string;

  @IsString()
  @Matches(SHA256)
  sha256: string;
}

export class ManagedMediaRefDto {
  @IsString()
  @Matches(ID)
  mediaId: string;

  // the digest W&W approved; compared with the server's own evidence, never
  // trusted on its own
  @IsString()
  @Matches(SHA256)
  sha256: string;

  // The options below are what W&W reviewed for this media. An absent option
  // is left out of the payload hash, so a request without any hashes as before
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MANAGED_ALT_MAX_LENGTH)
  // no control character (C0, DEL, C1), so no line break either
  @Matches(/^[^\x00-\x1f\x7f-\x9f]*$/)
  alt?: string;

  // thumbnail and thumbnailTimestampMs are mutually exclusive
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ManagedThumbnailRefDto)
  thumbnail?: ManagedThumbnailRefDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS)
  thumbnailTimestampMs?: number;
}

export class ManagedPostMemberDto {
  @IsDefined()
  @IsString()
  @MaxLength(100000)
  content: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10080)
  delay?: number;

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ManagedMediaRefDto)
  media: ManagedMediaRefDto[];
}

class ManagedDraftBodyDto {
  @IsString()
  @Matches(MANAGED_OPERATION_KEY)
  operationKey: string;

  @IsInt()
  @Min(1)
  expectedBindingGeneration: number;

  // an explicit offset, so the meaning (and the payload hash) never depends
  // on the server's timezone
  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/)
  @MaxLength(40)
  intendedPublishDate: string;

  @IsOptional()
  @IsObject()
  settings?: Record<string, any>;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ManagedPostMemberDto)
  members: ManagedPostMemberDto[];
}

export class CreateManagedDraftDto extends ManagedDraftBodyDto {
  @IsString()
  @Matches(ID)
  integrationId: string;
}

export class EditManagedDraftDto extends ManagedDraftBodyDto {
  @IsInt()
  @Min(1)
  expectedRevision: number;
}

export class QualifyManagedChannelDto {
  @IsInt()
  @Min(1)
  expectedGeneration: number;

  @IsString()
  @Matches(/^sha256:[a-f0-9]{64}$/)
  identityFingerprint: string;
}

import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import {
  INSTAGRAM_AUDIO_KINDS,
  InstagramAudioKind,
  MANAGED_HELPER_NAMES,
  ManagedHelperName,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.helper.contracts';

// One W&W platform helper call (docs/managed-extension/platform-helpers.md).
// No organization, provider, URL, method name or credential: the
// organization comes from the managed credential, the provider from the
// bound channel and the request from the helper's fixed definition. Which of
// query / kind / genre a helper takes is checked by the service.

const ID = /^[A-Za-z0-9_-]{1,64}$/;
// printable text without controls or line breaks, at most 100 characters
// (upstream locationSearch cuts its query at 100)
const QUERY = /^[^\u0000-\u001f\u007f-\u009f]{1,100}$/u;
// TikTok's genre filter values are upper-case words (POP, ROCK, ELECTRONIC)
const GENRE = /^[A-Z][A-Z_]{0,31}$/;

export class ManagedHelperRequestDto {
  @IsString()
  @IsIn(MANAGED_HELPER_NAMES)
  helper: ManagedHelperName;

  @IsString()
  @Matches(ID)
  integrationId: string;

  @IsInt()
  @Min(1)
  expectedBindingGeneration: number;

  @IsOptional()
  @IsString()
  @Matches(QUERY)
  query?: string;

  @IsOptional()
  @IsString()
  @IsIn(INSTAGRAM_AUDIO_KINDS)
  kind?: InstagramAudioKind;

  @IsOptional()
  @IsString()
  @Matches(GENRE)
  genre?: string;
}

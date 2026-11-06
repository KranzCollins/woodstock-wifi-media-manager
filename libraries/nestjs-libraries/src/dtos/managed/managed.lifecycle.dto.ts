import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  MANAGED_CANCEL_SCOPES,
  MANAGED_DELETABLE_LIFECYCLES,
  MANAGED_DISPATCH_MEMBER_STATUSES,
  MANAGED_LIFECYCLE_HASH,
  MANAGED_LIFECYCLE_INSTANT,
  MANAGED_LIFECYCLE_LIMITS,
  MANAGED_LIFECYCLE_NOTE,
  MANAGED_LIFECYCLE_SHA256,
  MANAGED_LIFECYCLE_UUID,
  MANAGED_LIFECYCLE_VERSION,
  MANAGED_RELEASE_ID,
  MANAGED_RELEASE_URL,
  MANAGED_RESOLUTIONS,
  MANAGED_RESOLVE_OUTCOMES,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import { MANAGED_CAPTION_CODECS } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publication-text';
import { MANAGED_OPERATION_KEY } from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';

// The owned post lifecycle (ww.managed-lifecycle.v1,
// managed.lifecycle.contracts.ts). No organization, credential, provider,
// token, content or media: the organization comes from the managed
// credential and everything sent follows from the bound revision. These
// declare each request field with its format, so the whitelist keeps exactly
// them; a field that only another scope or state takes is declared too, and
// refused by parseManagedLifecycleRequest, which the service runs on the same
// body and which alone checks how the fields fit together. Every field is
// required; one that can be empty is null. No field has an initializer, and
// the targets this compiles to (ES2015-ES2020, so no useDefineForClassFields)
// emit none, so plainToInstance yields exactly the keys sent and the strict
// parser takes the instance as it takes the body.

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OCCURRENCE = MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences - 1;

class ManagedLifecycleKeyDto {
  @Equals(MANAGED_LIFECYCLE_VERSION)
  version: typeof MANAGED_LIFECYCLE_VERSION;

  @IsString()
  @Matches(MANAGED_OPERATION_KEY)
  operationKey: string;
}

class ManagedLifecyclePostBodyDto extends ManagedLifecycleKeyDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedRevision: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedScheduleGeneration: number;
}

class ManagedLifecycleReleaseBodyDto extends ManagedLifecyclePostBodyDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedBindingGeneration: number;

  // the ww-release-hash-v1 W&W derived from its own approved payload
  @IsString()
  @Matches(MANAGED_LIFECYCLE_HASH)
  releaseHash: string;

  // W&W's digest of the content it approved, stored as sent
  @IsString()
  @Matches(MANAGED_LIFECYCLE_SHA256)
  contentSha256: string;

  @IsString()
  @IsIn(MANAGED_CAPTION_CODECS)
  codec: string;

  @IsInt()
  @Min(0)
  @Max(MANAGED_LIFECYCLE_LIMITS.maxLatenessMs)
  maxLatenessMs: number;
}

export class ManagedLifecycleRepeatDto {
  @IsInt()
  @Min(MANAGED_LIFECYCLE_LIMITS.repeatMinIntervalDays)
  @Max(MANAGED_LIFECYCLE_LIMITS.repeatMaxIntervalDays)
  intervalDays: number;

  @IsInt()
  @Min(MANAGED_LIFECYCLE_LIMITS.repeatMinOccurrences)
  @Max(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences)
  maxOccurrences: number;

  // every due time, publishAt first: the confirmed future scope
  @IsArray()
  @ArrayMinSize(MANAGED_LIFECYCLE_LIMITS.repeatMinOccurrences)
  @ArrayMaxSize(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences)
  @IsString({ each: true })
  @Matches(MANAGED_LIFECYCLE_INSTANT, { each: true })
  dueAts: string[];
}

export class ManagedLifecyclePublishNowDto extends ManagedLifecycleReleaseBodyDto {}

export class ManagedLifecycleScheduleDto extends ManagedLifecycleReleaseBodyDto {
  @IsString()
  @Matches(MANAGED_LIFECYCLE_INSTANT)
  publishAt: string;

  // null: once
  @ValidateIf((body) => body.repeat !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => ManagedLifecycleRepeatDto)
  repeat: ManagedLifecycleRepeatDto | null;
}

// PENDING: the materialized occurrence, with its dispatch and version.
// NOT_MATERIALIZED: a later one, by its number and anchored due time
export class ManagedLifecycleAffectedOccurrenceDto {
  @IsString()
  @IsIn(['PENDING', 'NOT_MATERIALIZED'])
  state: 'PENDING' | 'NOT_MATERIALIZED';

  @IsInt()
  @Min(0)
  @Max(MAX_OCCURRENCE)
  occurrence: number;

  @IsString()
  @Matches(MANAGED_LIFECYCLE_INSTANT)
  dueAt: string;

  // PENDING only
  @ValidateIf((entry) => entry.state === 'PENDING' || entry.dispatchId !== undefined)
  @IsString()
  @Matches(MANAGED_LIFECYCLE_UUID)
  dispatchId?: string;

  // PENDING only
  @ValidateIf(
    (entry) => entry.state === 'PENDING' || entry.expectedDispatchVersion !== undefined
  )
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedDispatchVersion?: number;
}

// the earlier occurrence a REMAINING cancel leaves alone
export class ManagedLifecycleInFlightDto {
  @IsInt()
  @Min(0)
  @Max(MAX_OCCURRENCE)
  occurrence: number;

  @IsString()
  @Matches(MANAGED_LIFECYCLE_UUID)
  dispatchId: string;

  @IsString()
  @IsIn(['ADMITTED', 'UNKNOWN', 'PARTIAL'])
  expectedStatus: 'ADMITTED' | 'UNKNOWN' | 'PARTIAL';

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedDispatchVersion: number;
}

// The exact scope a cancel was previewed against, and its hash
export class ManagedLifecycleCancelsDto {
  @IsString()
  @Matches(MANAGED_LIFECYCLE_UUID)
  scheduleId: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedScheduleVersion: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences)
  @ValidateNested({ each: true })
  @Type(() => ManagedLifecycleAffectedOccurrenceDto)
  affected: ManagedLifecycleAffectedOccurrenceDto[];

  @IsString()
  @Matches(MANAGED_LIFECYCLE_HASH)
  affectedHash: string;
}

export class ManagedLifecycleCancelDto extends ManagedLifecyclePostBodyDto {
  @IsString()
  @IsIn(MANAGED_CANCEL_SCOPES)
  scope: (typeof MANAGED_CANCEL_SCOPES)[number];

  @IsString()
  @Matches(MANAGED_LIFECYCLE_UUID)
  scheduleId: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedScheduleVersion: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MANAGED_LIFECYCLE_LIMITS.repeatMaxOccurrences)
  @ValidateNested({ each: true })
  @Type(() => ManagedLifecycleAffectedOccurrenceDto)
  affected: ManagedLifecycleAffectedOccurrenceDto[];

  @IsString()
  @Matches(MANAGED_LIFECYCLE_HASH)
  affectedHash: string;

  // OCCURRENCE only
  @ValidateIf((body) => body.scope === 'OCCURRENCE' || body.occurrence !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_OCCURRENCE)
  occurrence?: number;

  // REMAINING only
  @ValidateIf((body) => body.scope === 'REMAINING' || body.fromOccurrence !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_OCCURRENCE)
  fromOccurrence?: number;

  // REMAINING only; null: nothing earlier is admitted or unresolved
  @ValidateIf(
    (body) =>
      (body.scope === 'REMAINING' || body.inFlight !== undefined) && body.inFlight !== null
  )
  @IsObject()
  @ValidateNested()
  @Type(() => ManagedLifecycleInFlightDto)
  inFlight?: ManagedLifecycleInFlightDto | null;
}

// retained soft deletion of the Postiz record only; the social-network post
// is never deleted
export class ManagedLifecycleDeleteDto extends ManagedLifecyclePostBodyDto {
  @IsString()
  @IsIn(MANAGED_DELETABLE_LIFECYCLES)
  expectedLifecycle: (typeof MANAGED_DELETABLE_LIFECYCLES)[number];

  @Equals('RETAINED_SOFT_DELETE')
  effect: 'RETAINED_SOFT_DELETE';

  // the occurrences a SCHEDULED post's delete cancels; null otherwise
  @ValidateIf((body) => body.cancels !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => ManagedLifecycleCancelsDto)
  cancels: ManagedLifecycleCancelsDto | null;
}

export class ManagedLifecycleEvidenceDto {
  @Equals('HUMAN_OBSERVATION')
  source: 'HUMAN_OBSERVATION';

  @IsString()
  @Matches(MANAGED_LIFECYCLE_INSTANT)
  observedAt: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MANAGED_LIFECYCLE_LIMITS.noteMax)
  @Matches(MANAGED_LIFECYCLE_NOTE)
  note: string;
}

// every member as it was shown; exactly the UNKNOWN one has an outcome
export class ManagedLifecycleResolveMemberDto {
  @IsInt()
  @Min(0)
  @Max(MANAGED_LIFECYCLE_LIMITS.members - 1)
  position: number;

  @IsString()
  @Matches(ID)
  postId: string;

  @IsString()
  @IsIn(MANAGED_DISPATCH_MEMBER_STATUSES)
  expectedStatus: (typeof MANAGED_DISPATCH_MEMBER_STATUSES)[number];

  @ValidateIf((member) => member.outcome !== null)
  @IsString()
  @IsIn(MANAGED_RESOLVE_OUTCOMES)
  outcome: (typeof MANAGED_RESOLVE_OUTCOMES)[number] | null;

  @ValidateIf((member) => member.releaseURL !== null)
  @IsString()
  @MaxLength(MANAGED_LIFECYCLE_LIMITS.releaseUrlMax)
  @Matches(MANAGED_RELEASE_URL)
  releaseURL: string | null;

  @ValidateIf((member) => member.releaseId !== null)
  @IsString()
  @Matches(MANAGED_RELEASE_ID)
  releaseId: string | null;
}

// a record of what a human observed; it never makes anything be sent again
export class ManagedLifecycleResolveDto extends ManagedLifecycleKeyDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedDispatchVersion: number;

  @IsString()
  @IsIn(['UNKNOWN', 'PARTIAL'])
  expectedStatus: 'UNKNOWN' | 'PARTIAL';

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedScheduleGeneration: number;

  @IsString()
  @IsIn(MANAGED_RESOLUTIONS)
  resolution: (typeof MANAGED_RESOLUTIONS)[number];

  @IsObject()
  @ValidateNested()
  @Type(() => ManagedLifecycleEvidenceDto)
  evidence: ManagedLifecycleEvidenceDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MANAGED_LIFECYCLE_LIMITS.members)
  @ValidateNested({ each: true })
  @Type(() => ManagedLifecycleResolveMemberDto)
  members: ManagedLifecycleResolveMemberDto[];
}

// GET /lifecycle/release-preview/:managedPostId?revision=&codec=
export class ManagedLifecycleReleasePreviewQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision: number;

  @IsString()
  @IsIn(MANAGED_CAPTION_CODECS)
  codec: string;
}

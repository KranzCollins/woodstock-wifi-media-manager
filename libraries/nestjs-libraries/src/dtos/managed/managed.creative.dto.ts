import {
  Equals,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CREATIVE_STAGE_NAMES,
  CREATIVE_UUID,
  CreativeStageName,
  MANAGED_CREATIVE_VERSION,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.contracts';

// The owned creative runtime (docs/managed-extension/creative-runtime.md).
// No organization, provider, model, url, key or scratch path: the
// organization comes from the managed credential, and everything a provider
// receives follows from the closed job input. `input` and `handle` are
// parsed strictly by the service (unknown keys refused).

const ASSEMBLY_ID = /^[a-f0-9]{32}$/;
const CALL_KEY = /^[0-9a-f-]{36}:[a-z.]{1,32}:\d{1,2}:[12]$/;

export class ManagedCreativeJobDto {
  @Equals(MANAGED_CREATIVE_VERSION)
  version: typeof MANAGED_CREATIVE_VERSION;

  @IsString()
  @Matches(CREATIVE_UUID)
  tenantId: string;

  @IsString()
  @Matches(CREATIVE_UUID)
  workspaceId: string;

  @IsObject()
  input: Record<string, unknown>;
}

// One CreativeCall of W&W's runtime port: one ledger row
export class ManagedCreativeCallDto extends ManagedCreativeJobDto {
  @IsString()
  @Matches(CREATIVE_UUID)
  jobId: string;

  @IsString()
  @IsIn(CREATIVE_STAGE_NAMES)
  stage: CreativeStageName;

  @IsInt()
  @Min(0)
  @Max(10)
  item: number;

  @IsInt()
  @IsIn([1, 2])
  attempt: 1 | 2;

  @IsString()
  @Matches(CALL_KEY)
  callKey: string;

  // slides.assemble only: the id W&W committed before the call
  @IsOptional()
  @IsString()
  @Matches(ASSEMBLY_ID)
  assemblyId?: string;
}

export class ManagedCreativePollCallDto {
  @IsString()
  @IsIn(['clip.analyse', 'clip.fetch', 'clip.render'])
  stage: CreativeStageName;

  @IsInt()
  @Min(0)
  @Max(10)
  item: number;

  @IsInt()
  @IsIn([1, 2])
  attempt: 1 | 2;
}

export class ManagedCreativePollDto {
  @Equals(MANAGED_CREATIVE_VERSION)
  version: typeof MANAGED_CREATIVE_VERSION;

  @IsObject()
  handle: Record<string, unknown>;

  // RunPod polls only: the call the handle belongs to
  @IsOptional()
  @ValidateNested()
  @Type(() => ManagedCreativePollCallDto)
  call?: ManagedCreativePollCallDto;
}

export class ManagedCreativeArtifactDto {
  @Equals(MANAGED_CREATIVE_VERSION)
  version: typeof MANAGED_CREATIVE_VERSION;

  @IsString()
  @Matches(CREATIVE_UUID)
  jobId: string;

  @IsString()
  @IsIn(CREATIVE_STAGE_NAMES)
  stage: CreativeStageName;

  @IsInt()
  @Min(0)
  @Max(10)
  item: number;

  @IsOptional()
  @IsObject()
  handle?: Record<string, unknown> | null;
}

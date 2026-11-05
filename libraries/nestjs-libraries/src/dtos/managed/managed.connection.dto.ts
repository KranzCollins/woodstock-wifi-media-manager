import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { MANAGED_OPERATION_KEY } from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';

// W&W managed account connection (docs/managed-extension/account-connection.md).
// None of these carry an organization: it always comes from the managed
// credential.

export const MANAGED_CONNECTION_MODES = ['CONNECT', 'RECONNECT'] as const;
export type ManagedConnectionMode = (typeof MANAGED_CONNECTION_MODES)[number];

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_IDENTIFIER = /^[a-z0-9-]{1,64}$/;
// a provider's own account id (Integration.internalId)
const INTERNAL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
// a handle as the provider reports it: printable, no whitespace or controls
const PROFILE = /^[^\s\u0000-\u001f\u007f]{1,128}$/;
// 32 random bytes, base64url without padding (the server generates it)
export const MANAGED_CONNECTION_STATE = /^[A-Za-z0-9_-]{43}$/;
// an opaque provider code: printable ASCII, no whitespace
const AUTHORIZATION_CODE = /^[\x21-\x7e]{1,2048}$/;
// the OAuth error code a provider sends back instead of a code
const PROVIDER_ERROR = /^[a-z_]{1,64}$/;

// The account the owner is expected to authorize. A provider answer that
// differs in any given field is never bound
export class ManagedExpectedAccountDto {
  @IsOptional()
  @IsString()
  @Matches(INTERNAL_ID)
  internalId?: string;

  @IsOptional()
  @IsString()
  @Matches(PROFILE)
  profile?: string;
}

export class CreateManagedConnectionIntentDto {
  @IsString()
  @Matches(MANAGED_OPERATION_KEY)
  operationKey: string;

  @IsString()
  @Matches(PROVIDER_IDENTIFIER)
  providerIdentifier: string;

  @IsString()
  @IsIn(MANAGED_CONNECTION_MODES)
  mode: ManagedConnectionMode;

  // RECONNECT only: the exact channel and the binding generation W&W saw
  @IsOptional()
  @IsString()
  @Matches(ID)
  integrationId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedBindingGeneration?: number;

  @IsDefined()
  @ValidateNested()
  @Type(() => ManagedExpectedAccountDto)
  expectedAccount: ManagedExpectedAccountDto;
}

// What W&W's server relay received on its registered callback page: the
// state, and either the code or the provider's error
export class ManagedConnectionCallbackDto {
  @IsString()
  @Matches(MANAGED_CONNECTION_STATE)
  state: string;

  @IsOptional()
  @IsString()
  @Matches(AUTHORIZATION_CODE)
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(PROVIDER_ERROR)
  error?: string;
}

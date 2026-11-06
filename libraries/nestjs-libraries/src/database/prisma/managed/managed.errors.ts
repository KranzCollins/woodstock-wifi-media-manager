import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { isManagedOrganization } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

// Every managed refusal carries a stable `code` so W&W can branch on it
// without parsing messages: { code, msg }

export type ManagedConflictCode =
  | 'OPERATION_KEY_PAYLOAD_MISMATCH'
  | 'OPERATION_KEY_KIND_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'BINDING_GENERATION_MISMATCH'
  | 'CHANNEL_NOT_QUALIFIED'
  | 'CHANNEL_IDENTITY_CHANGED'
  | 'IDENTITY_FINGERPRINT_MISMATCH'
  | 'POST_NOT_DRAFT'
  | 'POST_DRIFTED'
  | 'OPERATION_KEY_CREDENTIAL_MISMATCH'
  | 'OBSERVATION_IN_PROGRESS'
  | 'UPLOAD_IN_PROGRESS'
  | 'UPLOAD_NEEDS_RECOVERY'
  | 'UPLOAD_FAILED'
  | 'UPLOAD_SUPERSEDED'
  | 'STORAGE_HAS_NO_PRIVATE_READ';

export type ManagedUnprocessableCode =
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_NOT_READY'
  | 'MEDIA_PROOF_MISSING'
  | 'MEDIA_PROOF_STALE'
  | 'MEDIA_DIGEST_MISMATCH'
  | 'MEDIA_SIZE_MISMATCH'
  | 'MEDIA_TYPE_MISMATCH'
  | 'MEDIA_OPTIONS_INVALID'
  | 'INTEGRATION_NOT_FOUND'
  | 'CONTENT_NOT_CANONICAL'
  | 'SETTINGS_INVALID'
  | 'OBSERVATION_BOUND_EXCEEDED';

export class ManagedConflictException extends ConflictException {
  constructor(public readonly code: ManagedConflictCode, msg: string) {
    super({ code, msg });
  }
}

export class ManagedUnprocessableException extends UnprocessableEntityException {
  constructor(public readonly code: ManagedUnprocessableCode, msg: string) {
    super({ code, msg });
  }
}

export class ManagedNotFoundException extends NotFoundException {
  constructor(msg: string) {
    super({ code: 'NOT_FOUND', msg });
  }
}

export class ManagedBadRequestException extends BadRequestException {
  constructor(msg: string) {
    super({ code: 'INVALID_INPUT', msg });
  }
}

// Raised by the write fence below every repository: an API / UI / agent /
// worker write that targets a managed organization outside the managed path.
export class ManagedWriteRefusedError extends ForbiddenException {
  constructor(
    public readonly model: string,
    public readonly action: string,
    public readonly organizationId: string | null,
    public readonly code:
      | 'MANAGED_WRITE_REFUSED'
      | 'MANAGED_FENCE_UNRESOLVED_ORGANIZATION' = 'MANAGED_WRITE_REFUSED'
  ) {
    super({
      code,
      msg:
        code === 'MANAGED_WRITE_REFUSED'
          ? 'This organization is managed by W&W: posts, channels and media can only be changed through W&W'
          : 'The organization of this write could not be determined while managed mode is enabled',
    });
  }
}

// Raised before a provider, AI, processor or OAuth call is made for a managed
// organization. The write fence alone is too late for these: the external
// effect would already have happened when the follow-up write is refused
export class ManagedEffectRefusedError extends ForbiddenException {
  constructor(
    public readonly effect: string,
    public readonly organizationId: string
  ) {
    super({
      code: 'MANAGED_EFFECT_REFUSED',
      msg: `This organization is managed by W&W: ${effect} is refused`,
    });
  }
}

export function refuseManagedEffect(
  organizationId: string | null | undefined,
  effect: string
) {
  if (isManagedOrganization(organizationId)) {
    throw new ManagedEffectRefusedError(effect, organizationId!);
  }
}

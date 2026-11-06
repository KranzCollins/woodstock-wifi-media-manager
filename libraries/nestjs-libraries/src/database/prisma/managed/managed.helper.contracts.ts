import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ManagedCredential,
  isManagedOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

// The closed set of W&W platform helpers (docs/managed-extension/
// platform-helpers.md): point-in-time provider lookups the Postiz UI and
// agent offer through the generic /integrations/function endpoint. Nothing
// here is a passthrough: each helper is one fixed GET with typed input and a
// typed, plain-text result. Pure: no Prisma, no Nest DI, no network.

export const MANAGED_HELPER_SCOPE = 'helpers:read' as const;

export const MANAGED_HELPER_NAMES = [
  'instagram.audio-search.v1',
  'linkedin.mention-search.v1',
  'tiktok-business.music-search.v1',
  'tiktok-business.location-search.v1',
] as const;
export type ManagedHelperName = (typeof MANAGED_HELPER_NAMES)[number];

export const INSTAGRAM_AUDIO_KINDS = ['music', 'original_sound'] as const;
export type InstagramAudioKind = (typeof INSTAGRAM_AUDIO_KINDS)[number];

// The input fields each helper takes; any other field is refused
export type ManagedHelperInput = {
  query?: string;
  kind?: InstagramAudioKind;
  genre?: string;
};

export interface ManagedHelperDefinition {
  // the provider identifiers whose pinned upstream class has this method
  // (own or inherited), see platform-helpers.md for the source lines
  providerIdentifiers: readonly string[];
  required: readonly (keyof ManagedHelperInput)[];
  optional: readonly (keyof ManagedHelperInput)[];
}

export const MANAGED_HELPER_DEFINITIONS: Record<
  ManagedHelperName,
  ManagedHelperDefinition
> = {
  // InstagramProvider.audioSearch. instagram-standalone does not extend
  // InstagramProvider and has no audioSearch, so it is not listed
  'instagram.audio-search.v1': {
    providerIdentifiers: ['instagram'],
    required: ['kind'],
    optional: ['query'],
  },
  // LinkedinProvider.mention; LinkedinPageProvider extends it without an
  // override, so linkedin-page runs the same request with its own token
  'linkedin.mention-search.v1': {
    providerIdentifiers: ['linkedin', 'linkedin-page'],
    required: ['query'],
    optional: [],
  },
  'tiktok-business.music-search.v1': {
    providerIdentifiers: ['tiktok-business'],
    required: [],
    optional: ['genre'],
  },
  'tiktok-business.location-search.v1': {
    providerIdentifiers: ['tiktok-business'],
    required: ['query'],
    optional: [],
  },
};

// Bounds of one helper call
export const MANAGED_HELPER_CALL_DEADLINE_MS = 10 * 1000;
export const MANAGED_HELPER_MAX_RESPONSE_BYTES = 512 * 1024;
export const MANAGED_HELPER_MAX_ITEMS = 50;
export const MANAGED_HELPER_MAX_TEXT = 200;
// The latest moment helper access can be configured to last: the end of the
// operator-stated customer access (2026-11-10T23:00Z). A later or missing
// POSTIZ_MANAGED_HELPER_EXPIRES_AT enables nothing
export const MANAGED_HELPER_MAX_EXPIRY = new Date('2026-11-10T23:00:00.000Z');

// ---- results ----------------------------------------------------------------

export type ManagedHelperItem =
  | {
      kind: 'AUDIO';
      id: string;
      title: string;
      artist: string;
      durationMs: number | null;
    }
  | {
      kind: 'MENTION';
      id: string;
      label: string;
      // LinkedinProvider.mentionFormat as plain text, never HTML; null when
      // the label could not be written into it unchanged
      mention: string | null;
    }
  | {
      kind: 'LOCATION';
      id: string;
      name: string;
      address: string;
    };

export type ManagedHelperCoverageReason =
  // the provider sent more than MANAGED_HELPER_MAX_ITEMS
  | 'ITEM_LIMIT'
  // entries without a usable id were left out
  | 'ITEMS_DROPPED'
  // the provider's own list is one page, trending or a vanity-name match;
  // the helper never claims it is the full catalogue
  | 'PROVIDER_PAGE';

export interface ManagedHelperResult {
  schemaVersion: 1;
  helper: ManagedHelperName;
  integrationId: string;
  provider: string;
  bindingGeneration: number;
  // when the provider's answer was read; a point in time, nothing more
  observedAt: string;
  coverage: {
    partial: true;
    reasons: ManagedHelperCoverageReason[];
    returned: number;
    limit: number;
  };
  items: ManagedHelperItem[];
}

// ---- refusals ---------------------------------------------------------------

export type ManagedHelperCode =
  | 'HELPER_CREDENTIAL_NOT_DEDICATED'
  | 'HELPER_ORGANIZATION_NOT_ENABLED'
  | 'HELPER_NOT_ENABLED'
  | 'HELPER_ACCESS_EXPIRED'
  | 'HELPER_INPUT_INVALID'
  | 'HELPER_NOT_SUPPORTED_FOR_PROVIDER'
  | 'RECONNECT_REQUIRED'
  | 'BINDING_CHANGED_DURING_CALL'
  | 'PROVIDER_CALL_FAILED';

// Why a provider call gave no result. Never the provider's text, status line
// or URL: a Meta URL carries the access token in its query
export type ManagedHelperCallFailure =
  | 'TIMEOUT'
  | 'NETWORK'
  | 'REDIRECT_REFUSED'
  | 'TOO_LARGE'
  | 'MALFORMED'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR';

const STATUS: Record<ManagedHelperCode, HttpStatus> = {
  HELPER_CREDENTIAL_NOT_DEDICATED: HttpStatus.FORBIDDEN,
  HELPER_ORGANIZATION_NOT_ENABLED: HttpStatus.FORBIDDEN,
  HELPER_NOT_ENABLED: HttpStatus.FORBIDDEN,
  HELPER_ACCESS_EXPIRED: HttpStatus.FORBIDDEN,
  HELPER_INPUT_INVALID: HttpStatus.BAD_REQUEST,
  HELPER_NOT_SUPPORTED_FOR_PROVIDER: HttpStatus.CONFLICT,
  RECONNECT_REQUIRED: HttpStatus.CONFLICT,
  BINDING_CHANGED_DURING_CALL: HttpStatus.CONFLICT,
  PROVIDER_CALL_FAILED: HttpStatus.BAD_GATEWAY,
};

export class ManagedHelperException extends HttpException {
  constructor(
    public readonly code: ManagedHelperCode,
    msg: string,
    public readonly reason?: ManagedHelperCallFailure
  ) {
    super(reason ? { code, msg, reason } : { code, msg }, STATUS[code]);
  }
}

// ---- operator qualification -------------------------------------------------

function list(value: string | undefined) {
  return new Set(
    String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry)
  );
}

// Every condition must hold, read from the environment on every call. The
// defaults (all unset) enable nothing. Returns the refusal, or null
export function managedHelperRefusal(
  credential: ManagedCredential,
  helper: ManagedHelperName,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): ManagedHelperException | null {
  // a helper credential is its own principal: one that can also write drafts,
  // upload or connect would let a lookup budget be spent by a writer
  if (
    credential.scopes.length !== 1 ||
    credential.scopes[0] !== MANAGED_HELPER_SCOPE
  ) {
    return new ManagedHelperException(
      'HELPER_CREDENTIAL_NOT_DEDICATED',
      `Helpers are only served to a credential that holds ${MANAGED_HELPER_SCOPE} and no other scope`
    );
  }

  if (
    !isManagedOrganization(credential.organizationId) ||
    !list(env.POSTIZ_MANAGED_HELPER_ORGANIZATIONS).has(
      credential.organizationId
    )
  ) {
    return new ManagedHelperException(
      'HELPER_ORGANIZATION_NOT_ENABLED',
      'Helpers are not enabled for this organization'
    );
  }

  if (!list(env.POSTIZ_MANAGED_HELPERS).has(helper)) {
    return new ManagedHelperException(
      'HELPER_NOT_ENABLED',
      'This helper is not enabled on this server'
    );
  }

  const raw = env.POSTIZ_MANAGED_HELPER_EXPIRES_AT;
  const expiresAt = raw ? new Date(raw) : null;
  if (
    !expiresAt ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.getTime() > MANAGED_HELPER_MAX_EXPIRY.getTime() ||
    now.getTime() >= expiresAt.getTime()
  ) {
    return new ManagedHelperException(
      'HELPER_ACCESS_EXPIRED',
      'Helper access is not configured with a valid expiry, or it expired'
    );
  }

  return null;
}

// Checks the fields a helper takes. The DTO already refused unknown keys and
// malformed values; this refuses a field the chosen helper does not take
export function managedHelperInputRefusal(
  helper: ManagedHelperName,
  input: ManagedHelperInput
): ManagedHelperException | null {
  const definition = MANAGED_HELPER_DEFINITIONS[helper];
  const allowed = [...definition.required, ...definition.optional];
  const given = (Object.keys(input) as (keyof ManagedHelperInput)[]).filter(
    (key) => input[key] !== undefined
  );

  const extra = given.filter((key) => !allowed.includes(key));
  const missing = definition.required.filter((key) => !given.includes(key));
  if (extra.length || missing.length) {
    return new ManagedHelperException(
      'HELPER_INPUT_INVALID',
      `${helper} takes ${
        allowed.length ? allowed.join(', ') : 'no input'
      }; required: ${definition.required.join(', ') || 'none'}`
    );
  }

  return null;
}

// ---- untrusted provider text ------------------------------------------------

// C0/C1 controls, bidi overrides/isolates, zero-width and BOM: a value is
// shown to people and models as plain text, never as markup or layout
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export const MANAGED_HELPER_ITEM_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

// a provider string as bounded plain text; anything that is not a string is ''
export function plainText(value: unknown, max = MANAGED_HELPER_MAX_TEXT) {
  if (typeof value !== 'string') {
    return '';
  }

  const clean = value.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('');
}

// a provider id (string or integer) when it is a plain token, else null
export function providerId(value: unknown) {
  const id =
    typeof value === 'string' || (Number.isSafeInteger(value) && Number(value) >= 0)
      ? String(value)
      : '';
  return MANAGED_HELPER_ITEM_ID.test(id) ? id : null;
}

// a duration in whole milliseconds, at most a day; else null
export function durationMs(value: unknown, multiplier = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const ms = Math.round(value * multiplier);
  return ms <= 24 * 60 * 60 * 1000 ? ms : null;
}

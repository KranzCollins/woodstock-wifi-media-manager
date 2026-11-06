import { Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

// Operator-only configuration of the W&W managed-organization mode
// (docs/managed-extension/README.md). Nothing here can be influenced by a
// request: the allowlist and the credentials come from the environment, and a
// caller is bound to the organization of the credential that matched.

export const MANAGED_SCOPES = [
  'channels:read',
  'channels:qualify',
  'channels:connect',
  'channels:connect-callback',
  'posts:read',
  'posts:write',
  // Separate lifecycle authority; existing draft credentials gain neither.
  'posts:schedule',
  'posts:publish',
  'media:write',
  // reserved uploads only; meant for the W&W ingest worker's own credential
  'media:upload',
  // provider lookups (docs/managed-extension/platform-helpers.md); only
  // honoured on a credential that holds no other scope
  'helpers:read',
  // the owned creative runtime (docs/managed-extension/creative-runtime.md);
  // only honoured on a credential that holds no other scope
  'creative:run',
] as const;

export type ManagedScope = (typeof MANAGED_SCOPES)[number];

export interface ManagedCredential {
  id: string;
  organizationId: string;
  tokenSha256: string;
  scopes: ManagedScope[];
}

// The parsed credential list. `problems` names every entry that was left out
// or only partly used, by position only: never an id, a digest or a token, so
// a raw token pasted into the wrong field can't reach a log line
export interface ManagedCredentialParse {
  credentials: ManagedCredential[];
  problems: string[];
}

interface ManagedModeConfig extends ManagedCredentialParse {
  enabled: boolean;
  organizations: Set<string>;
}

const ORGANIZATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CREDENTIAL_FIELDS = ['id', 'organizationId', 'tokenSha256', 'scopes'];
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;

const logger = new Logger('ManagedMode');

let cached: { key: string; config: ManagedModeConfig } | undefined;

// why an entry can't authenticate anyone at all
function unusableCredential(entry: any, organizations: Set<string>) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return 'is not an object';
  }
  if (typeof entry.id !== 'string' || !CREDENTIAL_ID.test(entry.id)) {
    return 'has an invalid id';
  }
  if (
    typeof entry.organizationId !== 'string' ||
    !organizations.has(entry.organizationId)
  ) {
    return 'names an organization that is not on POSTIZ_MANAGED_ORGANIZATIONS';
  }
  if (
    typeof entry.tokenSha256 !== 'string' ||
    !SHA256_HEX.test(entry.tokenSha256)
  ) {
    return 'has no tokenSha256 of 64 lowercase hex characters';
  }
  if (
    !Array.isArray(entry.scopes) ||
    !entry.scopes.some((scope: unknown) =>
      (MANAGED_SCOPES as readonly unknown[]).includes(scope)
    )
  ) {
    return 'has no known scope';
  }
  return undefined;
}

function parseCredentials(
  raw: string | undefined,
  organizations: Set<string>
): ManagedCredentialParse {
  if (!raw) {
    return { credentials: [], problems: [] };
  }

  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    // fail closed: a broken credential list authenticates nobody
    return {
      credentials: [],
      problems: ['POSTIZ_MANAGED_CREDENTIALS is not valid JSON'],
    };
  }

  if (!Array.isArray(list)) {
    return {
      credentials: [],
      problems: ['POSTIZ_MANAGED_CREDENTIALS must be a JSON array'],
    };
  }

  const problems: string[] = [];
  const valid: { position: number; credential: ManagedCredential }[] = [];
  list.forEach((entry: any, index) => {
    const position = index + 1;
    const unusable = unusableCredential(entry, organizations);
    if (unusable) {
      problems.push(`entry ${position} ${unusable}`);
      return;
    }

    // still used by a lenient process, but never silently
    if (Object.keys(entry).some((key) => !CREDENTIAL_FIELDS.includes(key))) {
      problems.push(
        `entry ${position} has a field other than ${CREDENTIAL_FIELDS.join(', ')}`
      );
    }
    const scopes = entry.scopes.filter((scope: unknown) =>
      (MANAGED_SCOPES as readonly unknown[]).includes(scope)
    );
    if (scopes.length !== entry.scopes.length) {
      problems.push(`entry ${position} has an unknown scope`);
    }

    valid.push({
      position,
      credential: {
        id: entry.id,
        organizationId: entry.organizationId,
        tokenSha256: entry.tokenSha256,
        scopes,
      },
    });
  });

  // a digest or id shared by two entries is ambiguous, so none of them is used
  const credentials: ManagedCredential[] = [];
  for (const { position, credential } of valid) {
    const shared = valid.filter(
      (other) =>
        other.credential.tokenSha256 === credential.tokenSha256 ||
        other.credential.id === credential.id
    );
    if (shared.length === 1) {
      credentials.push(credential);
    } else {
      problems.push(
        `entry ${position} shares its id or tokenSha256 with entry ${shared
          .filter((other) => other.position !== position)
          .map((other) => other.position)
          .join(', ')}`
      );
    }
  }

  return { credentials, problems };
}

function parse(): ManagedModeConfig {
  const enabled = process.env.POSTIZ_MANAGED_MODE === 'enabled';
  if (!enabled) {
    return {
      enabled: false,
      organizations: new Set(),
      credentials: [],
      problems: [],
    };
  }

  const organizations = new Set(
    String(process.env.POSTIZ_MANAGED_ORGANIZATIONS || '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => ORGANIZATION_ID.test(id))
  );

  const parsed = parseCredentials(
    process.env.POSTIZ_MANAGED_CREDENTIALS,
    organizations
  );
  for (const problem of parsed.problems) {
    logger.warn(`Managed credential not fully used: ${problem}`);
  }

  return { enabled, organizations, ...parsed };
}

// Read on every call (the fence runs on every write) but only re-parsed when
// the environment changed
function config(): ManagedModeConfig {
  const key = [
    process.env.POSTIZ_MANAGED_MODE,
    process.env.POSTIZ_MANAGED_ORGANIZATIONS,
    process.env.POSTIZ_MANAGED_CREDENTIALS,
  ].join('\u0000');

  if (cached?.key !== key) {
    cached = { key, config: parse() };
  }

  return cached.config;
}

/** A copy used by repository filters; callers cannot change the configured enrollment. */
export function managedOrganizationIds(): readonly string[] {
  return Object.freeze([...config().organizations]);
}

export function isManagedModeEnabled() {
  return config().enabled;
}

export function isManagedOrganization(organizationId?: string | null) {
  const current = config();
  return (
    current.enabled &&
    typeof organizationId === 'string' &&
    current.organizations.has(organizationId)
  );
}

export function sha256Hex(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

// Compares against every credential (no early exit) so the response time
// does not tell which entry was close
export function findManagedCredential(
  token: string | undefined
): ManagedCredential | undefined {
  if (
    typeof token !== 'string' ||
    token.length < MIN_TOKEN_LENGTH ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return undefined;
  }

  const presented = Buffer.from(sha256Hex(token), 'hex');
  let found: ManagedCredential | undefined;
  for (const credential of config().credentials) {
    const expected = Buffer.from(credential.tokenSha256, 'hex');
    if (timingSafeEqual(presented, expected) && !found) {
      found = credential;
    }
  }

  return found;
}

// The strict check of a process that serves the managed API on its own (the
// isolated runtime): every configured entry must be used as written and at
// least one must authenticate, or the process doesn't start. The message names
// positions and reasons only
export function assertManagedCredentials() {
  const { enabled, credentials, problems } = config();
  if (!enabled) {
    throw new Error('POSTIZ_MANAGED_MODE is not "enabled"');
  }

  if (problems.length) {
    throw new Error(
      `POSTIZ_MANAGED_CREDENTIALS has ${problems.length} problems: ${problems.join('; ')}`
    );
  }

  if (!credentials.length) {
    throw new Error('POSTIZ_MANAGED_CREDENTIALS has no usable credential');
  }
}

// Called once per process at boot (PrismaService, so the backend, the
// orchestrator and the commands all run it). A mode that is switched on but
// cannot enroll anything, or an allowlist entry that would be silently
// dropped, stops the process instead of running with a fence that guards
// less than the operator configured. The fingerprint lets an operator compare
// the enrollment of every runtime; a log line is not proof that every runtime
// was started with it, assertManagedEnrollment below is the check against the
// database.
export function assertManagedModeConfig() {
  const mode = process.env.POSTIZ_MANAGED_MODE;
  if (mode && mode !== 'enabled' && mode !== 'disabled') {
    throw new Error(
      'POSTIZ_MANAGED_MODE must be "enabled", "disabled" or unset'
    );
  }

  if (mode !== 'enabled') {
    if (process.env.POSTIZ_MANAGED_ORGANIZATIONS) {
      logger.warn(
        'POSTIZ_MANAGED_ORGANIZATIONS is set but POSTIZ_MANAGED_MODE is not "enabled": no organization is managed in this process'
      );
    }
    return;
  }

  const entries = String(process.env.POSTIZ_MANAGED_ORGANIZATIONS || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id);

  if (!entries.length) {
    throw new Error(
      'POSTIZ_MANAGED_MODE is enabled but POSTIZ_MANAGED_ORGANIZATIONS is empty'
    );
  }

  const invalid = entries.filter((id) => !ORGANIZATION_ID.test(id));
  if (invalid.length) {
    throw new Error(
      `POSTIZ_MANAGED_ORGANIZATIONS has ${invalid.length} invalid entries`
    );
  }

  const organizations = [...config().organizations].sort();
  logger.log(
    `Managed mode enabled for ${
      organizations.length
    } organizations, enrollment sha256:${sha256Hex(organizations.join(','))}`
  );
}

// only the read the enrollment check needs, so tests can pass a plain fake
type EnrollmentClient = {
  managedOrganization: { findMany(args: any): PromiseLike<any> };
};

export class ManagedEnrollmentError extends Error {}

// The durable side of enrollment. An organization gets its ManagedOrganization
// row the first time the managed API writes for it, and nothing in the
// application removes it. Every process checks the rows once it is connected
// (PrismaService), so a runtime started without the mode or with an allowlist
// that leaves out an enrolled organization stops instead of letting the fence
// and the worker treat that organization as an ordinary one. The error only
// carries counts, never organization ids. `quiet` leaves out the success log
// line, for a check that runs on every readiness probe.
export async function assertManagedEnrollment(
  client: EnrollmentClient,
  options: { quiet?: boolean } = {}
) {
  // A missing table is unknown enrollment, not proof of an empty enrollment.
  // Schema setup runs before application startup; no process may bypass this
  // gate because its database is old, unreachable or restored incompletely.
  const enrolled = await client.managedOrganization.findMany({
    select: { organizationId: true },
  });

  const missing = enrolled.filter(
    (row) => !isManagedOrganization(row.organizationId)
  ).length;

  if (missing) {
    throw new ManagedEnrollmentError(
      `${missing} of ${enrolled.length} durably enrolled managed organizations are not enrolled in this process (POSTIZ_MANAGED_MODE / POSTIZ_MANAGED_ORGANIZATIONS)`
    );
  }

  if (enrolled.length && !options.quiet) {
    logger.log(
      `All ${enrolled.length} durably enrolled managed organizations are enrolled in this process`
    );
  }
}

// Shared by every managed route and credential of an organization. The
// environment can lower it, never raise it above the 200 / hour the W&W
// admission budget is sized for
export const MANAGED_RATE_LIMIT_MAX = 200;

export function managedRateLimit() {
  const limit = Number(process.env.POSTIZ_MANAGED_RATE_LIMIT);
  return Number.isInteger(limit) && limit > 0
    ? Math.min(limit, MANAGED_RATE_LIMIT_MAX)
    : MANAGED_RATE_LIMIT_MAX;
}

// Requests per hour per client address (Express req.ip, see the runtime's
// trust proxy setting). Over it no request of that address is answered with
// the outcome of its token, so guessing is bounded per address
export const MANAGED_AUTH_ATTEMPTS_PER_HOUR = 300;
// Failed authentications per hour across every address. Over it a failing
// request is refused before an address counter is created, so rotating
// addresses can't grow Redis without bound. A valid credential is not
// counted here, so this never takes the organizations' 200 / hour budget
export const MANAGED_AUTH_FAILURES_PER_HOUR = 3000;

// The largest reserved upload, the whole W&W file bound
export const MANAGED_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
// How long one attempt holds a reservation before it may be recovered
export const MANAGED_UPLOAD_LEASE_MS = 15 * 60 * 1000;
// Attempts per reservation before it fails for good
export const MANAGED_UPLOAD_MAX_ATTEMPTS = 3;

export function managedMaxDigestBytes() {
  const max = Number(process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES);
  return Number.isInteger(max) && max > 0 ? max : 64 * 1024 * 1024;
}

import { HttpException, HttpStatus } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { addAbortSignal, Readable } from 'stream';
import { inspect } from 'util';
import { managedMaxDigestBytes } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  lifecyclePolicyRefusal,
  MANAGED_LIFECYCLE_MAX_EXPIRY,
  ManagedLifecyclePolicy,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import { STORED_OBJECT_KEY } from '@gitroom/nestjs-libraries/upload/upload.interface';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type');

// Short-lived, digest-pinned fetches of one private media object for one
// admitted lifecycle call (lifecycle-root-decisions-20261105.md, Media;
// lifecycle-architecture-corrections-20261105.md, 8). The dispatcher mints a
// capability for each media its admitted call delivers by URL; the provider
// fetches it; the dispatcher revokes it once the provider took the media or
// the call settled. Nothing here is routed, gated open or composed yet: the
// durable store, the pinned storage read, the call authority, the shared
// budget, the clock and the keys are all injected, and every one of them is
// required. Without explicitly configured keys every mint and fetch refuses.
//
// The token is `wwmc1.<id>.<mac>`: 32 random bytes and their HMAC-SHA256
// under one configured key. It names no organization, call, media, key or
// object; the durable record holds those and is only found by the sha256 of
// the id, so the token itself is never stored. A token is checked against
// every configured key before the store is asked anything. It is never part
// of the approved content, the release hash, the request hash, a DTO, an
// event or a log line: mint hands it out wrapped, and it does not serialize.
//
// Every fetch, in order: the token; the record (not revoked, before its
// exclusive expiry, fetches left); the call it was minted for, still active
// with the same dispatch version and the same pinned media; the range; room
// in the process's read capacity; an atomic claim of one fetch from the
// durable quota; one unit of the organization's shared budget; the evidence
// still pinned to the same object; a bounded read of the whole object by its pinned key, namespace and
// version, whose length, digest and sniffed type must equal the pin; then
// the record and the call again. Only then are bytes answered, the whole
// object or one range of it. A refusal carries a closed code and a fixed
// message, never a token, key, path, version, byte or underlying error.
//
// The claimed fetch and the reserved budget unit are kept when anything after
// them refuses, as the shared budget keeps reserved units. A revocation that
// lands after the final check still lets that one answer through: the
// capability is revoked for every later fetch, nothing more is promised.
//
// One capability per call and media, ever: the record's unique keys hold
// revoked rows too. A capability is never reminted, renewed past its
// lifetime or reused for a DISPATCHING call, and a refusal refunds no fetch
// and no budget. A dispatcher that proved its call NOT_SENT starts a new
// call, with a new call id and attempt, and mints for that one; a crash after
// a mint and before the provider was asked leaves the call UNKNOWN until a
// human resolves it. A mint that fails once its record may exist (the insert
// failed or outlived the deadline, or any check after it refused or threw)
// revokes that record, best effort and within what the request has left, and
// refuses either way: a revocation that fails too never turns the refusal
// into a grant, and the token was never handed out. Revoking does not free
// the call's and media's unique key.
//
// Every mint, fetch and revocation runs under ONE deadline,
// requestDeadlineMs: every port it asks (the store, the authority, the
// budget, the evidence, the storage namespace, versions, open and stream),
// the sniffer, the wait for read capacity and the final checks. Once it
// passed nothing new is started and the request refuses with the closed code
// of what it waited on. A port's promise can't be cancelled: what answers
// late is never used, a late open stream is destroyed, a late inserted
// capability is revoked, and a late failure is swallowed. A database
// statement still running may commit after the refusal (a fetch claimed, a
// record written); nothing here pretends otherwise. Expiry is always decided
// by the injected clock, read again after every answer it depends on.
//
// Whole-object reads are bounded per process: at most maxConcurrentReads at
// once, holding at most maxReadBytes between them, and at most
// maxQueuedReads waiting, in order, for room until their deadline; anything
// beyond refuses CAPACITY_UNAVAILABLE. A read reserves the object's pinned
// length, plus the length of the range copied out of it, before anything is
// opened or allocated, and holds it until the request ended and its buffer
// can no longer be written; each open stream's own small internal buffer
// comes on top. A fetch waits for capacity before it claims: a
// CAPACITY_UNAVAILABLE refusal spends no fetch and no budget. This bounds
// what this leaf holds, not what its callers hold: once a body is returned
// the caller owns it, and the route answering it must bound its outgoing
// responses itself. Ranges are still cut from the whole verified object;
// nothing here streams or chunks a video.

export const MANAGED_MEDIA_CAPABILITY_VERSION = 'ww-media-capability-v1' as const;

export const MANAGED_MEDIA_CAPABILITY_LIMITS = Object.freeze({
  // a capability lives no longer than this, and never past its call, the
  // policy or MANAGED_LIFECYCLE_MAX_EXPIRY
  maxTtlMs: 15 * 60 * 1000,
  // fetches (whole or ranged) one capability may answer
  maxFetches: 8,
  // the private read bound of managed.media.service.ts: the environment can
  // lower it, never raise it
  ceilingBytes: 64 * 1024 * 1024,
  // one whole mint, fetch or revocation, from its first port to its answer
  requestDeadlineMs: 60 * 1000,
  // per process: whole-object reads at once, the bytes they hold between
  // them (two objects at the ceiling, or one with a range of nearly all of
  // it), and reads waiting for room
  maxConcurrentReads: 2,
  maxReadBytes: 128 * 1024 * 1024,
  maxQueuedReads: 8,
  minKeyBytes: 32,
  maxKeys: 4,
  // shared budget units one fetch reserves before storage is read
  budgetUnitsPerFetch: 1,
});

// The bounds a service runs under. Production uses the limits above; a
// service may be built with lower ones (tests), never higher
const BOUND_NAMES = [
  'requestDeadlineMs',
  'maxConcurrentReads',
  'maxReadBytes',
  'maxQueuedReads',
] as const;
export type ManagedMediaCapabilityBounds = {
  readonly [name in (typeof BOUND_NAMES)[number]]: number;
};

// a dispatchVersion the record's Prisma Int column can hold
const PRISMA_INT_MAX = 2147483647;

// the types a reserved upload may declare (managed.media.service.ts)
export const MANAGED_MEDIA_CAPABILITY_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
] as const;

export function managedMediaCapabilityMaxBytes() {
  return Math.min(
    managedMaxDigestBytes(),
    MANAGED_MEDIA_CAPABILITY_LIMITS.ceilingBytes
  );
}

const TOKEN = /^wwmc1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
const TOKEN_MAX_LENGTH = 128;
const RANGE_MAX_LENGTH = 64;
const RANGE = /^bytes=(\d{0,15})-(\d{0,15})$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// enough of the head for file-type to tell every allowed type apart
const SNIFF_BYTES = 4100;

// ---- refusals -----------------------------------------------------------------

export const MANAGED_MEDIA_CAPABILITY_REFUSALS = [
  'NOT_CONFIGURED',
  'INVALID_REQUEST',
  'POLICY_CLOSED',
  'CAPABILITY_INVALID',
  'CAPABILITY_REVOKED',
  'CAPABILITY_EXPIRED',
  'CAPABILITY_EXHAUSTED',
  'QUOTA_CONFLICT',
  'ALREADY_MINTED',
  'CALL_INACTIVE',
  'SCOPE_MISMATCH',
  'MEDIA_NOT_CURRENT',
  'MEDIA_CHANGED',
  'RANGE_INVALID',
  'RANGE_NOT_SATISFIABLE',
  'BUDGET_EXHAUSTED',
  'STORE_UNAVAILABLE',
  'STORAGE_UNAVAILABLE',
  'CAPACITY_UNAVAILABLE',
] as const;
export type ManagedMediaCapabilityRefusal =
  (typeof MANAGED_MEDIA_CAPABILITY_REFUSALS)[number];

const REFUSAL_STATUS: Record<ManagedMediaCapabilityRefusal, HttpStatus> = {
  NOT_CONFIGURED: HttpStatus.NOT_FOUND,
  INVALID_REQUEST: HttpStatus.BAD_REQUEST,
  POLICY_CLOSED: HttpStatus.CONFLICT,
  CAPABILITY_INVALID: HttpStatus.NOT_FOUND,
  CAPABILITY_REVOKED: HttpStatus.GONE,
  CAPABILITY_EXPIRED: HttpStatus.GONE,
  CAPABILITY_EXHAUSTED: HttpStatus.GONE,
  QUOTA_CONFLICT: HttpStatus.CONFLICT,
  ALREADY_MINTED: HttpStatus.CONFLICT,
  CALL_INACTIVE: HttpStatus.CONFLICT,
  SCOPE_MISMATCH: HttpStatus.CONFLICT,
  MEDIA_NOT_CURRENT: HttpStatus.UNPROCESSABLE_ENTITY,
  MEDIA_CHANGED: HttpStatus.CONFLICT,
  RANGE_INVALID: HttpStatus.BAD_REQUEST,
  RANGE_NOT_SATISFIABLE: HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
  BUDGET_EXHAUSTED: HttpStatus.TOO_MANY_REQUESTS,
  STORE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  STORAGE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  CAPACITY_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

const REFUSAL_MESSAGE: Record<ManagedMediaCapabilityRefusal, string> = {
  NOT_CONFIGURED: 'Media capabilities are not configured',
  INVALID_REQUEST: 'The media capability request is not valid',
  POLICY_CLOSED: 'The lifecycle policy is not open',
  CAPABILITY_INVALID: 'Unknown media capability',
  CAPABILITY_REVOKED: 'The media capability was revoked',
  CAPABILITY_EXPIRED: 'The media capability expired',
  CAPABILITY_EXHAUSTED: 'The media capability has no fetches left',
  QUOTA_CONFLICT: 'The fetch could not be claimed',
  ALREADY_MINTED: 'A media capability was already minted for this call and media',
  CALL_INACTIVE: 'The call of this media capability is not active',
  SCOPE_MISMATCH: 'The call no longer delivers this media',
  MEDIA_NOT_CURRENT: 'The media is not the pinned, verified object',
  MEDIA_CHANGED: 'The pinned media changed',
  RANGE_INVALID: 'Only one byte range is served',
  RANGE_NOT_SATISFIABLE: 'The byte range is outside the media',
  BUDGET_EXHAUSTED: 'The organization budget is exhausted',
  STORE_UNAVAILABLE: 'Media capabilities are unavailable',
  STORAGE_UNAVAILABLE: 'The media could not be read',
  CAPACITY_UNAVAILABLE: 'Media reads are at capacity',
};

// { code, msg } like every managed refusal; no cause is ever attached
export class ManagedMediaCapabilityException extends HttpException {
  constructor(public readonly code: ManagedMediaCapabilityRefusal) {
    super({ code, msg: REFUSAL_MESSAGE[code] }, REFUSAL_STATUS[code]);
  }
}

const refuse = (code: ManagedMediaCapabilityRefusal) =>
  new ManagedMediaCapabilityException(code);

// ---- ports --------------------------------------------------------------------

// One media exactly as an admitted release binds it
export interface ManagedMediaPin {
  mediaId: string;
  evidenceId: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
}

// The media's current evidence and the object it is pinned to
export interface ManagedMediaPinnedEvidence extends ManagedMediaPin {
  storageKey: string;
  storageNamespace: string;
  storageVersion: string;
}

export type ManagedMediaRevokeReason =
  | 'CALL_SETTLED'
  | 'OPERATOR'
  | 'CALL_INACTIVE'
  | 'SCOPE_MISMATCH'
  | 'MEDIA_CHANGED';

export interface ManagedMediaCapabilityRecord extends ManagedMediaPinnedEvidence {
  // sha256 hex of the token's random id; the token is never stored
  capabilityIdSha256: string;
  keyId: string;
  organizationId: string;
  dispatchId: string;
  callId: string;
  dispatchVersion: number;
  issuedAt: Date;
  // exclusive
  expiresAt: Date;
  maxFetches: number;
  fetchCount: number;
  // retained: a revoked capability is never deleted
  revokedAt: Date | null;
  revokeReason: ManagedMediaRevokeReason | null;
}

export type ManagedMediaCapabilityDraft = Omit<
  ManagedMediaCapabilityRecord,
  'fetchCount' | 'revokedAt' | 'revokeReason'
>;

// The durable record. Every method is one statement against the database
export interface ManagedMediaCapabilityStore {
  // Inserts with fetchCount 0 and never replaces: null when the id is taken
  // or a capability (revoked or not) exists for the same organization, call
  // and evidence
  create(
    draft: ManagedMediaCapabilityDraft
  ): Promise<ManagedMediaCapabilityRecord | null>;
  get(capabilityIdSha256: string): Promise<ManagedMediaCapabilityRecord | null>;
  // Compare-and-set of fetchCount from `expected` to expected + 1, only
  // while revokedAt is null and expiresAt > now; false when nothing changed
  claimFetch(
    capabilityIdSha256: string,
    expected: number,
    now: Date
  ): Promise<boolean>;
  // Sets revokedAt / revokeReason where revokedAt is null; the row stays.
  // Returns how many were revoked
  revoke(
    capabilityIdSha256: string,
    at: Date,
    reason: ManagedMediaRevokeReason
  ): Promise<number>;
  revokeCall(
    organizationId: string,
    callId: string,
    at: Date,
    reason: ManagedMediaRevokeReason
  ): Promise<number>;
}

// The private storage, read by key in one namespace only (the key methods of
// IUploadProvider), and the evidence a media's stored path is pinned to now
export interface ManagedMediaPinnedStorage {
  // null unless the media is ready, its current evidence is pinned to a key,
  // namespace and version, and its stored path still addresses that key
  pinnedEvidence(
    organizationId: string,
    mediaId: string
  ): Promise<ManagedMediaPinnedEvidence | null>;
  namespace(): Promise<string | null>;
  // null when the key does not exist
  versionAt(key: string): Promise<string | null>;
  openAt(key: string): Promise<{ stream: Readable; version: string } | null>;
}

// The call as the database holds it now
export interface ManagedMediaActiveCall {
  organizationId: string;
  dispatchId: string;
  callId: string;
  dispatchVersion: number;
  // DISPATCHING under its current holder, or waiting on the provider's
  // ingestion of what it sent
  active: boolean;
  // exclusive: the admission lease or the pending deadline, and the policy
  activeUntil: Date;
  // the media of the release it admitted
  media: readonly ManagedMediaPin[];
}

export interface ManagedMediaCallAuthority {
  activeCall(
    organizationId: string,
    callId: string
  ): Promise<ManagedMediaActiveCall | null>;
}

// The organization's shared 200 / hour bucket; false (or a failure) when the
// units can't be reserved, including when the bucket is unavailable
export interface ManagedMediaBudget {
  reserve(organizationId: string, units: number): Promise<boolean>;
}

export interface ManagedMediaClock {
  now(): Date;
}

// Explicit: there is no default key. Mints with activeKeyId; every listed
// key still verifies, so a key can be rotated out by removing it
export interface ManagedMediaCapabilityKeys {
  activeKeyId: string;
  keys: readonly { id: string; secret: Buffer }[];
}

export interface ManagedMediaCapabilityPorts {
  store: ManagedMediaCapabilityStore;
  storage: ManagedMediaPinnedStorage;
  authority: ManagedMediaCallAuthority;
  budget: ManagedMediaBudget;
  clock: ManagedMediaClock;
  keys: ManagedMediaCapabilityKeys | null;
}

// ---- requests and answers ---------------------------------------------------

export interface ManagedMediaCapabilityMintRequest {
  organizationId: string;
  dispatchId: string;
  callId: string;
  dispatchVersion: number;
  media: ManagedMediaPin;
  policy: ManagedLifecyclePolicy | null;
  ttlMs: number;
  maxFetches: number;
}

export interface ManagedMediaCapabilityFetchRequest {
  token: unknown;
  // the Range header as received; absent for the whole object
  range?: unknown;
  // Optional route extension constraint, checked before quota/budget claims.
  expectedMimeType?: unknown;
}

export interface ManagedMediaCapabilityResponse {
  status: 200 | 206;
  headers: Readonly<Record<string, string>>;
  // The caller's own: the verified object itself for a whole answer, a copy
  // of the range alone otherwise. The service keeps no reference to it, and
  // the read capacity stops counting it once it is returned
  body: Buffer;
}

const GRANT_TOKENS = new WeakMap<ManagedMediaCapabilityGrant, string>();

// What mint hands the dispatcher. The token is only reachable through
// token(): it is not a property of the grant, and is left out of JSON and of
// inspection, so a grant that ends up in a log, an evidence record or a DTO
// carries no token
export class ManagedMediaCapabilityGrant {
  constructor(
    token: string,
    readonly expiresAt: Date,
    readonly maxFetches: number
  ) {
    GRANT_TOKENS.set(this, token);
  }

  token() {
    return GRANT_TOKENS.get(this)!;
  }

  toJSON() {
    return {
      expiresAt: this.expiresAt.toISOString(),
      maxFetches: this.maxFetches,
    };
  }

  [inspect.custom]() {
    return `ManagedMediaCapabilityGrant ${JSON.stringify(this.toJSON())}`;
  }
}

// ---- service ------------------------------------------------------------------

interface Keyring {
  activeKeyId: string;
  ids: string[];
  mac(keyId: string, id: Buffer): Buffer;
}

// The secrets stay in this closure: nothing on the service shows them
function keyring(keys: ManagedMediaCapabilityKeys | null): Keyring | null {
  if (
    !keys ||
    !Array.isArray(keys.keys) ||
    !keys.keys.length ||
    keys.keys.length > MANAGED_MEDIA_CAPABILITY_LIMITS.maxKeys
  ) {
    return null;
  }

  const secrets = new Map<string, Buffer>();
  for (const key of keys.keys) {
    if (
      !key ||
      typeof key.id !== 'string' ||
      !KEY_ID.test(key.id) ||
      secrets.has(key.id) ||
      !Buffer.isBuffer(key.secret) ||
      key.secret.length < MANAGED_MEDIA_CAPABILITY_LIMITS.minKeyBytes
    ) {
      return null;
    }
    secrets.set(key.id, Buffer.from(key.secret));
  }

  if (!secrets.has(keys.activeKeyId)) {
    return null;
  }

  return {
    activeKeyId: keys.activeKeyId,
    ids: [...secrets.keys()],
    mac: (keyId, id) =>
      createHmac('sha256', secrets.get(keyId)!)
        .update(`${MANAGED_MEDIA_CAPABILITY_VERSION}\n${keyId}\n`)
        .update(id)
        .digest(),
  };
}

const sha256Of = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');

const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

const safeInt = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max;

function validPin(pin: ManagedMediaPin | null | undefined) {
  return (
    !!pin &&
    typeof pin.mediaId === 'string' &&
    ID.test(pin.mediaId) &&
    typeof pin.evidenceId === 'string' &&
    ID.test(pin.evidenceId) &&
    typeof pin.sha256 === 'string' &&
    SHA256_HEX.test(pin.sha256) &&
    safeInt(pin.byteLength, 1, managedMediaCapabilityMaxBytes()) &&
    (MANAGED_MEDIA_CAPABILITY_TYPES as readonly unknown[]).includes(
      pin.mimeType
    )
  );
}

const samePin = (a: ManagedMediaPin, b: ManagedMediaPin) =>
  a.mediaId === b.mediaId &&
  a.evidenceId === b.evidenceId &&
  a.sha256 === b.sha256 &&
  a.byteLength === b.byteLength &&
  a.mimeType === b.mimeType;

const samePinnedObject = (
  a: ManagedMediaPinnedEvidence,
  b: ManagedMediaPinnedEvidence
) =>
  samePin(a, b) &&
  a.storageKey === b.storageKey &&
  a.storageNamespace === b.storageNamespace &&
  a.storageVersion === b.storageVersion;

// a key the storage's key reads accept: never a path, a URL or a `..`
function validPinnedEvidence(
  pinned: ManagedMediaPinnedEvidence | null | undefined
): pinned is ManagedMediaPinnedEvidence {
  return (
    validPin(pinned) &&
    typeof pinned!.storageKey === 'string' &&
    STORED_OBJECT_KEY.test(pinned!.storageKey) &&
    typeof pinned!.storageNamespace === 'string' &&
    !!pinned!.storageNamespace &&
    typeof pinned!.storageVersion === 'string' &&
    !!pinned!.storageVersion
  );
}

// The call is active now and is the very admission the scope names, with the
// pinned media in its release
function callRefusal(
  call: ManagedMediaActiveCall | null,
  scope: {
    organizationId: string;
    dispatchId: string;
    callId: string;
    dispatchVersion: number;
  },
  pin: ManagedMediaPin,
  now: Date
): 'CALL_INACTIVE' | 'SCOPE_MISMATCH' | null {
  if (
    !call ||
    call.active !== true ||
    !validDate(call.activeUntil) ||
    now.getTime() >= call.activeUntil.getTime()
  ) {
    return 'CALL_INACTIVE';
  }
  if (
    call.organizationId !== scope.organizationId ||
    call.dispatchId !== scope.dispatchId ||
    call.callId !== scope.callId ||
    call.dispatchVersion !== scope.dispatchVersion ||
    !Array.isArray(call.media) ||
    !call.media.some((media) => !!media && samePin(media, pin))
  ) {
    return 'SCOPE_MISMATCH';
  }
  return null;
}

// One range of `bytes=`, never several (no multipart answer). null: the whole
// object
function byteRange(
  header: unknown,
  length: number
): { start: number; end: number } | null {
  if (header === undefined || header === null) {
    return null;
  }

  const match =
    typeof header === 'string' && header.length <= RANGE_MAX_LENGTH
      ? RANGE.exec(header)
      : null;
  if (!match || (!match[1] && !match[2])) {
    throw refuse('RANGE_INVALID');
  }

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) {
      throw refuse('RANGE_NOT_SATISFIABLE');
    }
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : length - 1;
  if (start >= length) {
    throw refuse('RANGE_NOT_SATISFIABLE');
  }
  if (end < start) {
    throw refuse('RANGE_INVALID');
  }
  return { start, end: Math.min(end, length - 1) };
}

// The production bounds, or lower ones; anything else is not a configuration
function readBounds(
  lowered: Partial<ManagedMediaCapabilityBounds> | null | undefined
): ManagedMediaCapabilityBounds | null {
  const bounds: Record<string, number> = {};
  for (const name of BOUND_NAMES) {
    const value = lowered?.[name] ?? MANAGED_MEDIA_CAPABILITY_LIMITS[name];
    if (!safeInt(value, 1, MANAGED_MEDIA_CAPABILITY_LIMITS[name])) {
      return null;
    }
    bounds[name] = value;
  }
  return bounds as ManagedMediaCapabilityBounds;
}

// an opened object that will not be read
function discard(opened: { stream: Readable } | null | undefined) {
  try {
    opened?.stream?.destroy();
  } catch (err) {}
}

// One request's deadline. It never cancels a port: it stops waiting for it
class RequestDeadline {
  private readonly _controller = new AbortController();
  private readonly _timer: ReturnType<typeof setTimeout>;

  constructor(ms: number) {
    this._timer = setTimeout(() => this._controller.abort(), ms);
    // a pending deadline never keeps the process alive
    (this._timer as { unref?: () => void }).unref?.();
  }

  get signal() {
    return this._controller.signal;
  }

  get expired() {
    return this._controller.signal.aborted;
  }

  // The port's answer, or `code` when it fails or the deadline passes first.
  // Nothing is started once the deadline passed. An answer that comes after
  // it goes to `late` and nowhere else; a failure that comes after it is
  // dropped
  run<T>(
    call: () => Promise<T>,
    code: ManagedMediaCapabilityRefusal,
    late?: (value: T) => void
  ): Promise<T> {
    if (this.expired) {
      return Promise.reject(refuse(code));
    }

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(call());
    } catch (err) {
      return Promise.reject(refuse(code));
    }

    const signal = this.signal;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (!settled) {
          settled = true;
          reject(refuse(code));
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (!settled) {
            settled = true;
            resolve(value);
            return;
          }
          try {
            late?.(value);
          } catch (err) {}
        },
        () => {
          signal.removeEventListener('abort', abort);
          abort();
        }
      );
    });
  }

  dispose() {
    clearTimeout(this._timer);
  }
}

// Room for one read's bytes, freed once every holder let go: the request,
// and the read writing its buffer, which may outlive the request's deadline
class ReadLease {
  private _holders = 1;

  constructor(private readonly _free: () => void) {}

  retain() {
    this._holders++;
  }

  release() {
    if (this._holders > 0 && --this._holders === 0) {
      this._free();
    }
  }
}

// The whole-object reads of this process. Each request is measured against
// its own service's bounds, which are never above the production limits, so
// the process never holds more than those
class ManagedMediaReadCapacity {
  private _reads = 0;
  private _bytes = 0;
  private readonly _waiting: {
    bytes: number;
    bounds: ManagedMediaCapabilityBounds;
    grant: (lease: ReadLease) => void;
  }[] = [];

  // null: no room ever, the queue is full, or the deadline passed first
  acquire(
    bytes: number,
    bounds: ManagedMediaCapabilityBounds,
    deadline: RequestDeadline
  ): Promise<ReadLease | null> {
    if (deadline.expired || bytes > bounds.maxReadBytes) {
      return Promise.resolve(null);
    }
    if (!this._waiting.length && this.fits(bytes, bounds)) {
      return Promise.resolve(this.lease(bytes));
    }
    if (this._waiting.length >= bounds.maxQueuedReads) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const giveUp = () => {
        const at = this._waiting.indexOf(waiter);
        if (at >= 0) {
          this._waiting.splice(at, 1);
          resolve(null);
          this.drain();
        }
      };
      const waiter = {
        bytes,
        bounds,
        grant: (lease: ReadLease) => {
          deadline.signal.removeEventListener('abort', giveUp);
          resolve(lease);
        },
      };
      deadline.signal.addEventListener('abort', giveUp, { once: true });
      this._waiting.push(waiter);
    });
  }

  private fits(bytes: number, bounds: ManagedMediaCapabilityBounds) {
    return (
      this._reads < bounds.maxConcurrentReads &&
      this._bytes + bytes <= bounds.maxReadBytes
    );
  }

  private lease(bytes: number) {
    this._reads++;
    this._bytes += bytes;
    return new ReadLease(() => {
      this._reads--;
      this._bytes -= bytes;
      this.drain();
    });
  }

  // in order: a waiter that does not fit yet holds back the ones behind it
  private drain() {
    while (
      this._waiting.length &&
      this.fits(this._waiting[0].bytes, this._waiting[0].bounds)
    ) {
      const waiter = this._waiting.shift()!;
      waiter.grant(this.lease(waiter.bytes));
    }
  }
}

const READ_CAPACITY = new ManagedMediaReadCapacity();

type PinnedRead = Buffer | 'UNAVAILABLE' | 'CHANGED';

type VerifiedToken = { capabilityIdSha256: string; keyId: string };

export class ManagedMediaCapabilityService {
  private readonly _store: ManagedMediaCapabilityStore;
  private readonly _storage: ManagedMediaPinnedStorage;
  private readonly _authority: ManagedMediaCallAuthority;
  private readonly _budget: ManagedMediaBudget;
  private readonly _clock: ManagedMediaClock;
  private readonly _keyring: Keyring | null;
  private readonly _bounds: ManagedMediaCapabilityBounds | null;

  // `lowered` is for tests: each bound may only be lowered, and anything
  // else refuses every mint and fetch
  constructor(
    ports: ManagedMediaCapabilityPorts,
    lowered?: Partial<ManagedMediaCapabilityBounds>
  ) {
    this._store = ports.store;
    this._storage = ports.storage;
    this._authority = ports.authority;
    this._budget = ports.budget;
    this._clock = ports.clock;
    this._keyring = keyring(ports.keys);
    this._bounds = readBounds(lowered);
  }

  // A capability for one media of one admitted call. The whole object is
  // read and verified against the pin before anything is recorded
  async mint(
    request: ManagedMediaCapabilityMintRequest
  ): Promise<ManagedMediaCapabilityGrant> {
    const { ring, bounds } = this.configured();
    if (
      !request ||
      typeof request.organizationId !== 'string' ||
      !ID.test(request.organizationId) ||
      typeof request.dispatchId !== 'string' ||
      !ID.test(request.dispatchId) ||
      typeof request.callId !== 'string' ||
      !ID.test(request.callId) ||
      !safeInt(request.dispatchVersion, 1, PRISMA_INT_MAX) ||
      !validPin(request.media) ||
      !safeInt(request.ttlMs, 1, MANAGED_MEDIA_CAPABILITY_LIMITS.maxTtlMs) ||
      !safeInt(
        request.maxFetches,
        1,
        MANAGED_MEDIA_CAPABILITY_LIMITS.maxFetches
      )
    ) {
      throw refuse('INVALID_REQUEST');
    }

    if (lifecyclePolicyRefusal(request.policy, this.now())) {
      throw refuse('POLICY_CLOSED');
    }

    const deadline = new RequestDeadline(bounds.requestDeadlineMs);
    try {
      return await this.mintWithin(deadline, ring, bounds, request);
    } finally {
      deadline.dispose();
    }
  }

  private async mintWithin(
    deadline: RequestDeadline,
    ring: Keyring,
    bounds: ManagedMediaCapabilityBounds,
    request: ManagedMediaCapabilityMintRequest
  ): Promise<ManagedMediaCapabilityGrant> {
    const call = await this.activeCall(
      deadline,
      request.organizationId,
      request.callId
    );
    const callRefused = callRefusal(call, request, request.media, this.now());
    if (callRefused) {
      throw refuse(callRefused);
    }

    const pinned = await deadline.run(
      () =>
        this._storage.pinnedEvidence(
          request.organizationId,
          request.media.mediaId
        ),
      'STORAGE_UNAVAILABLE'
    );
    if (!validPinnedEvidence(pinned) || !samePin(pinned, request.media)) {
      throw refuse('MEDIA_NOT_CURRENT');
    }

    const lease = await READ_CAPACITY.acquire(
      pinned.byteLength,
      bounds,
      deadline
    );
    if (!lease) {
      throw refuse('CAPACITY_UNAVAILABLE');
    }
    // only the outcome is kept: the bytes are dropped with the lease
    let read: 'VERIFIED' | 'UNAVAILABLE' | 'CHANGED';
    try {
      const bytes = await this.readPinned(deadline, pinned, lease, null);
      read = typeof bytes === 'string' ? bytes : 'VERIFIED';
    } finally {
      lease.release();
    }
    if (read === 'UNAVAILABLE') {
      throw refuse('STORAGE_UNAVAILABLE');
    }
    if (read === 'CHANGED') {
      throw refuse('MEDIA_NOT_CURRENT');
    }

    // the read took time: the lifetime starts after it
    const issuedAt = this.now();
    if (lifecyclePolicyRefusal(request.policy, issuedAt)) {
      throw refuse('POLICY_CLOSED');
    }
    const expiresAt = new Date(
      Math.min(
        issuedAt.getTime() + request.ttlMs,
        call!.activeUntil.getTime(),
        request.policy!.expiresAt.getTime(),
        MANAGED_LIFECYCLE_MAX_EXPIRY.getTime()
      )
    );
    if (expiresAt.getTime() <= issuedAt.getTime()) {
      throw refuse('CALL_INACTIVE');
    }

    const id = randomBytes(32);
    const capabilityIdSha256 = sha256Of(id);
    // revokes the record this mint may have written but will not grant
    const withdraw = (
      reason: ManagedMediaRevokeReason,
      within: RequestDeadline | null
    ) => this.revokeQuietly(within, capabilityIdSha256, reason, issuedAt);

    // assigned inside the deadline's call
    let inserting = undefined as Promise<unknown> | undefined;
    let created: ManagedMediaCapabilityRecord | null;
    try {
      created = await deadline.run(
        () =>
          (inserting = this._store.create({
            capabilityIdSha256,
            keyId: ring.activeKeyId,
            organizationId: request.organizationId,
            dispatchId: request.dispatchId,
            callId: request.callId,
            dispatchVersion: request.dispatchVersion,
            mediaId: pinned.mediaId,
            evidenceId: pinned.evidenceId,
            sha256: pinned.sha256,
            byteLength: pinned.byteLength,
            mimeType: pinned.mimeType,
            storageKey: pinned.storageKey,
            storageNamespace: pinned.storageNamespace,
            storageVersion: pinned.storageVersion,
            issuedAt,
            expiresAt,
            maxFetches: request.maxFetches,
          })),
        'STORE_UNAVAILABLE'
      );
    } catch (err) {
      // the insert failed or outlived the deadline, and may have committed
      // or still commit: revoked now, and again once it settled
      await withdraw('CALL_INACTIVE', deadline);
      if (deadline.expired) {
        const late = () => withdraw('CALL_INACTIVE', null);
        void inserting?.then(late, late);
      }
      throw err;
    }
    if (!created) {
      throw refuse('ALREADY_MINTED');
    }

    // The call may have settled while the capability was written; a token
    // is only handed out for a call that is still active after the record.
    // Whatever refuses or fails here (an unconfirmed call counts as an
    // inactive one) revokes the record before the refusal goes out
    try {
      const after = await this.activeCall(
        deadline,
        request.organizationId,
        request.callId
      );
      const confirmedAt = this.now();
      const afterRefused = lifecyclePolicyRefusal(request.policy, confirmedAt)
        ? 'POLICY_CLOSED'
        : expiresAt.getTime() <= confirmedAt.getTime()
        ? 'CALL_INACTIVE'
        : callRefusal(after, request, request.media, confirmedAt);
      if (afterRefused) {
        throw refuse(afterRefused);
      }
    } catch (err) {
      const refusal =
        err instanceof ManagedMediaCapabilityException
          ? err
          : refuse('STORE_UNAVAILABLE');
      await withdraw(
        refusal.code === 'SCOPE_MISMATCH' ? 'SCOPE_MISMATCH' : 'CALL_INACTIVE',
        deadline
      );
      throw refusal;
    }

    return new ManagedMediaCapabilityGrant(
      `wwmc1.${id.toString('base64url')}.${ring
        .mac(ring.activeKeyId, id)
        .toString('base64url')}`,
      expiresAt,
      request.maxFetches
    );
  }

  // The provider's fetch: verified bytes of the pinned object, or a refusal
  async fetch(
    request: ManagedMediaCapabilityFetchRequest
  ): Promise<ManagedMediaCapabilityResponse> {
    const { ring, bounds } = this.configured();
    const verified = this.verify(ring, request?.token);
    if (!verified) {
      throw refuse('CAPABILITY_INVALID');
    }

    const deadline = new RequestDeadline(bounds.requestDeadlineMs);
    try {
      return await this.fetchWithin(deadline, bounds, verified, request.range, request.expectedMimeType);
    } finally {
      deadline.dispose();
    }
  }

  private async fetchWithin(
    deadline: RequestDeadline,
    bounds: ManagedMediaCapabilityBounds,
    verified: VerifiedToken,
    rangeHeader: unknown,
    expectedMimeType: unknown
  ): Promise<ManagedMediaCapabilityResponse> {
    const record = await this.record(deadline, verified);
    this.assertUsable(record, this.now());
    if (expectedMimeType !== undefined && expectedMimeType !== record.mimeType) {
      throw refuse('CAPABILITY_INVALID');
    }

    const call = await this.activeCall(
      deadline,
      record.organizationId,
      record.callId
    );
    const checkedAt = this.now();
    const callRefused = callRefusal(call, record, record, checkedAt);
    if (callRefused) {
      await this.revokeQuietly(
        deadline,
        record.capabilityIdSha256,
        callRefused,
        checkedAt
      );
      throw refuse(callRefused);
    }

    const range = byteRange(rangeHeader, record.byteLength);

    // room for the whole object and the range cut out of it, before
    // anything is claimed
    const lease = await READ_CAPACITY.acquire(
      record.byteLength + (range ? range.end - range.start + 1 : 0),
      bounds,
      deadline
    );
    if (!lease) {
      throw refuse('CAPACITY_UNAVAILABLE');
    }
    try {
      return await this.answer(deadline, verified, record, range, lease);
    } finally {
      lease.release();
    }
  }

  private async answer(
    deadline: RequestDeadline,
    verified: VerifiedToken,
    record: ManagedMediaCapabilityRecord,
    range: { start: number; end: number } | null,
    lease: ReadLease
  ): Promise<ManagedMediaCapabilityResponse> {
    await this.claimFetch(deadline, verified, record);

    const reserved = await deadline
      .run(
        () =>
          this._budget.reserve(
            record.organizationId,
            MANAGED_MEDIA_CAPABILITY_LIMITS.budgetUnitsPerFetch
          ),
        'BUDGET_EXHAUSTED'
      )
      .then((value) => value === true);
    if (!reserved) {
      throw refuse('BUDGET_EXHAUSTED');
    }

    const pinned = await deadline.run(
      () =>
        this._storage.pinnedEvidence(record.organizationId, record.mediaId),
      'STORAGE_UNAVAILABLE'
    );
    if (!validPinnedEvidence(pinned) || !samePinnedObject(pinned, record)) {
      await this.revokeQuietly(
        deadline,
        record.capabilityIdSha256,
        'MEDIA_CHANGED',
        this.now()
      );
      throw refuse('MEDIA_CHANGED');
    }

    const body = await this.readPinned(deadline, record, lease, range);
    if (body === 'UNAVAILABLE') {
      throw refuse('STORAGE_UNAVAILABLE');
    }
    if (body === 'CHANGED') {
      await this.revokeQuietly(
        deadline,
        record.capabilityIdSha256,
        'MEDIA_CHANGED',
        this.now()
      );
      throw refuse('MEDIA_CHANGED');
    }

    // revoked, expired or settled while the object was read: nothing is
    // answered
    const current = await this.record(deadline, verified);
    this.assertLive(current, this.now());
    const after = await this.activeCall(
      deadline,
      record.organizationId,
      record.callId
    );
    const confirmedAt = this.now();
    this.assertLive(record, confirmedAt);
    const afterRefused = callRefusal(after, record, record, confirmedAt);
    if (afterRefused) {
      await this.revokeQuietly(
        deadline,
        record.capabilityIdSha256,
        afterRefused,
        confirmedAt
      );
      throw refuse(afterRefused);
    }

    return {
      status: range ? 206 : 200,
      headers: Object.freeze({
        'content-type': record.mimeType,
        'content-length': String(body.length),
        'accept-ranges': 'bytes',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        ...(range
          ? {
              'content-range': `bytes ${range.start}-${range.end}/${record.byteLength}`,
            }
          : {}),
      }),
      body,
    };
  }

  // Once the provider took the media, or the call settled. Works without
  // keys: revoking never depends on being able to mint
  async revokeCall(
    organizationId: string,
    callId: string,
    reason: 'CALL_SETTLED' | 'OPERATOR'
  ): Promise<number> {
    if (
      typeof organizationId !== 'string' ||
      !ID.test(organizationId) ||
      typeof callId !== 'string' ||
      !ID.test(callId) ||
      (reason !== 'CALL_SETTLED' && reason !== 'OPERATOR')
    ) {
      throw refuse('INVALID_REQUEST');
    }

    const at = this.now();
    const deadline = new RequestDeadline(
      this._bounds?.requestDeadlineMs ??
        MANAGED_MEDIA_CAPABILITY_LIMITS.requestDeadlineMs
    );
    try {
      return await deadline.run(
        () => this._store.revokeCall(organizationId, callId, at, reason),
        'STORE_UNAVAILABLE'
      );
    } finally {
      deadline.dispose();
    }
  }

  private configured() {
    if (!this._keyring || !this._bounds) {
      throw refuse('NOT_CONFIGURED');
    }
    return { ring: this._keyring, bounds: this._bounds };
  }

  private now() {
    let now: Date;
    try {
      now = this._clock.now();
    } catch (err) {
      throw refuse('NOT_CONFIGURED');
    }
    if (!validDate(now)) {
      throw refuse('NOT_CONFIGURED');
    }
    return now;
  }

  private activeCall(
    deadline: RequestDeadline,
    organizationId: string,
    callId: string
  ) {
    return deadline.run(
      () => this._authority.activeCall(organizationId, callId),
      'STORE_UNAVAILABLE'
    );
  }

  // the id's digest and the key that signed it, checked against every key
  // without stopping at the first match; null for anything else
  private verify(ring: Keyring, token: unknown) {
    if (typeof token !== 'string' || token.length > TOKEN_MAX_LENGTH) {
      return null;
    }

    const match = TOKEN.exec(token);
    if (!match) {
      return null;
    }

    const id = Buffer.from(match[1], 'base64url');
    const mac = Buffer.from(match[2], 'base64url');
    // one spelling per token
    if (
      id.length !== 32 ||
      mac.length !== 32 ||
      id.toString('base64url') !== match[1] ||
      mac.toString('base64url') !== match[2]
    ) {
      return null;
    }

    let keyId: string | null = null;
    for (const candidate of ring.ids) {
      if (timingSafeEqual(ring.mac(candidate, id), mac) && !keyId) {
        keyId = candidate;
      }
    }

    return keyId ? { capabilityIdSha256: sha256Of(id), keyId } : null;
  }

  // The record of a verified token, signed by the key it was minted under
  // and within every bound a mint could have written; anything else is not
  // a capability
  private async record(
    deadline: RequestDeadline,
    verified: VerifiedToken
  ): Promise<ManagedMediaCapabilityRecord> {
    const record = await deadline.run(
      () => this._store.get(verified.capabilityIdSha256),
      'STORE_UNAVAILABLE'
    );
    if (
      !record ||
      record.capabilityIdSha256 !== verified.capabilityIdSha256 ||
      record.keyId !== verified.keyId ||
      typeof record.organizationId !== 'string' ||
      !ID.test(record.organizationId) ||
      typeof record.dispatchId !== 'string' ||
      !ID.test(record.dispatchId) ||
      typeof record.callId !== 'string' ||
      !ID.test(record.callId) ||
      !safeInt(record.dispatchVersion, 1, PRISMA_INT_MAX) ||
      !validPinnedEvidence(record) ||
      !validDate(record.issuedAt) ||
      !validDate(record.expiresAt) ||
      record.expiresAt.getTime() <= record.issuedAt.getTime() ||
      record.expiresAt.getTime() - record.issuedAt.getTime() >
        MANAGED_MEDIA_CAPABILITY_LIMITS.maxTtlMs ||
      record.expiresAt.getTime() > MANAGED_LIFECYCLE_MAX_EXPIRY.getTime() ||
      !safeInt(record.maxFetches, 1, MANAGED_MEDIA_CAPABILITY_LIMITS.maxFetches) ||
      !safeInt(record.fetchCount, 0, Number.MAX_SAFE_INTEGER) ||
      (record.revokedAt !== null && !validDate(record.revokedAt))
    ) {
      throw refuse('CAPABILITY_INVALID');
    }
    return record;
  }

  private assertLive(record: ManagedMediaCapabilityRecord, now: Date) {
    if (record.revokedAt) {
      throw refuse('CAPABILITY_REVOKED');
    }
    if (now.getTime() >= record.expiresAt.getTime()) {
      throw refuse('CAPABILITY_EXPIRED');
    }
  }

  private assertUsable(record: ManagedMediaCapabilityRecord, now: Date) {
    this.assertLive(record, now);
    if (record.fetchCount >= record.maxFetches) {
      throw refuse('CAPABILITY_EXHAUSTED');
    }
  }

  // One fetch from the durable quota, by compare-and-set. A lost race is
  // retried on the newer record; every retry follows another fetch's claim,
  // so it ends once the quota is used up
  private async claimFetch(
    deadline: RequestDeadline,
    verified: VerifiedToken,
    record: ManagedMediaCapabilityRecord
  ) {
    let current = record;
    for (
      let attempt = 0;
      attempt <= MANAGED_MEDIA_CAPABILITY_LIMITS.maxFetches;
      attempt++
    ) {
      // the claim compares the expiry against the clock as it is now
      const now = this.now();
      this.assertUsable(current, now);
      const claimed = current;
      if (
        await deadline.run(
          () =>
            this._store.claimFetch(
              claimed.capabilityIdSha256,
              claimed.fetchCount,
              now
            ),
          'STORE_UNAVAILABLE'
        )
      ) {
        return;
      }

      const next = await this.record(deadline, verified);
      if (!next.revokedAt && next.fetchCount <= current.fetchCount) {
        // refused without a visible reason: not retried
        throw refuse('QUOTA_CONFLICT');
      }
      current = next;
    }
    throw refuse('QUOTA_CONFLICT');
  }

  // Best effort: the refusal stands whatever happens to it. Awaited only
  // for what `deadline` has left; past it (or without one) it is sent and
  // not awaited, and its failure is dropped. `fallback` stamps it when the
  // clock does not answer
  private async revokeQuietly(
    deadline: RequestDeadline | null,
    capabilityIdSha256: string,
    reason: ManagedMediaRevokeReason,
    fallback: Date
  ) {
    let at = fallback;
    try {
      at = this.now();
    } catch (err) {}

    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(
        this._store.revoke(capabilityIdSha256, at, reason)
      );
    } catch (err) {
      return;
    }
    pending.catch(() => undefined);

    if (deadline && !deadline.expired) {
      try {
        await deadline.run(() => pending, 'STORE_UNAVAILABLE');
      } catch (err) {}
    }
  }

  private async storageNamespace(deadline: RequestDeadline) {
    try {
      return (
        (await deadline.run(
          () => this._storage.namespace(),
          'STORAGE_UNAVAILABLE'
        )) || null
      );
    } catch (err) {
      return null;
    }
  }

  // false when storage did not answer in time
  private async storageVersion(
    deadline: RequestDeadline,
    key: string
  ): Promise<string | null | false> {
    try {
      return await deadline.run(
        () => this._storage.versionAt(key),
        'STORAGE_UNAVAILABLE'
      );
    } catch (err) {
      return false;
    }
  }

  // The whole pinned object, by its key in its namespace at its version,
  // bounded by its recorded length, with the version and namespace unchanged
  // across the read and the length, digest and sniffed type equal to the pin.
  // Answers the verified object itself, or a copy of `range` alone; `lease`
  // must already hold room for both. UNAVAILABLE: storage could not answer
  // in time. CHANGED: it answered with something other than the pinned
  // object
  private async readPinned(
    deadline: RequestDeadline,
    pin: ManagedMediaPinnedEvidence,
    lease: ReadLease,
    range: { start: number; end: number } | null
  ): Promise<PinnedRead> {
    if (
      !validPinnedEvidence(pin) ||
      pin.byteLength > managedMediaCapabilityMaxBytes()
    ) {
      return 'CHANGED';
    }

    const namespace = await this.storageNamespace(deadline);
    if (!namespace) {
      return 'UNAVAILABLE';
    }
    if (namespace !== pin.storageNamespace) {
      return 'CHANGED';
    }

    const before = await this.storageVersion(deadline, pin.storageKey);
    if (before === false) {
      return 'UNAVAILABLE';
    }
    if (before !== pin.storageVersion) {
      return 'CHANGED';
    }

    let opened: { stream: Readable; version: string } | null;
    try {
      opened = await deadline.run(
        () => this._storage.openAt(pin.storageKey),
        'STORAGE_UNAVAILABLE',
        // opened after the deadline: never read
        discard
      );
    } catch (err) {
      return 'UNAVAILABLE';
    }
    if (!opened) {
      return 'CHANGED';
    }
    if (!(opened.stream instanceof Readable)) {
      discard(opened);
      return 'UNAVAILABLE';
    }
    if (opened.version !== pin.storageVersion) {
      discard(opened);
      return 'CHANGED';
    }

    const stream = opened.stream;
    let read: PinnedRead;
    try {
      read = await deadline.run(
        () => this.consume(deadline, stream, pin.byteLength, lease),
        'STORAGE_UNAVAILABLE'
      );
    } catch (err) {
      stream.destroy();
      return 'UNAVAILABLE';
    }
    if (typeof read === 'string') {
      return read;
    }
    const bytes = read;

    const after = await this.storageVersion(deadline, pin.storageKey);
    if (after === false) {
      return 'UNAVAILABLE';
    }
    if (after !== pin.storageVersion) {
      return 'CHANGED';
    }

    const namespaceAfter = await this.storageNamespace(deadline);
    if (!namespaceAfter) {
      return 'UNAVAILABLE';
    }
    if (namespaceAfter !== pin.storageNamespace) {
      return 'CHANGED';
    }

    if (sha256Of(bytes) !== pin.sha256) {
      return 'CHANGED';
    }

    let mimeType: string | null = null;
    try {
      mimeType =
        (
          await deadline.run<{ mime: string } | undefined>(
            () => fileTypeFromBuffer(bytes.subarray(0, SNIFF_BYTES)),
            'STORAGE_UNAVAILABLE'
          )
        )?.mime || null;
    } catch (err) {
      if (deadline.expired) {
        return 'UNAVAILABLE';
      }
    }
    if (mimeType !== pin.mimeType) {
      return 'CHANGED';
    }

    // the caller owns what is answered; the whole object is not copied again
    return range
      ? Buffer.from(bytes.subarray(range.start, range.end + 1))
      : bytes;
  }

  // Exactly `length` bytes of the stream, in one buffer allocated only now
  // that the read was admitted and its length validated. The deadline
  // destroys the stream; the lease is held for as long as the buffer may be
  // written, even past the request's end, so the capacity never undercounts
  private async consume(
    deadline: RequestDeadline,
    stream: Readable,
    length: number,
    lease: ReadLease
  ): Promise<PinnedRead> {
    lease.retain();
    try {
      addAbortSignal(deadline.signal, stream);
      const bytes = Buffer.alloc(length);
      let at = 0;
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) {
          stream.destroy();
          return 'UNAVAILABLE';
        }
        if (at + chunk.length > length) {
          stream.destroy();
          return 'CHANGED';
        }
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return at === length ? bytes : 'CHANGED';
    } catch (err) {
      stream.destroy();
      return 'UNAVAILABLE';
    } finally {
      lease.release();
    }
  }
}

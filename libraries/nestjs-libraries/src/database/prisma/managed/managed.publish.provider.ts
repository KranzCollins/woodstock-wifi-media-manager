import { createHash } from 'crypto';
import type { Integration } from '@prisma/client';
import { countLength } from '@gitroom/helpers/utils/count.length';
import {
  BadBody,
  Disconnect,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { InstagramProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.provider';
import { InstagramStandaloneProvider } from '@gitroom/nestjs-libraries/integrations/social/instagram.standalone.provider';
import { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/facebook.provider';
import type { InstagramDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/instagram.dto';
import type {
  MediaContent,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  MANAGED_ALT_MAX_LENGTH,
  MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';
import {
  ManagedUnprocessableCode,
  ManagedUnprocessableException,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';
import {
  MANAGED_LIFECYCLE_LIMITS,
  MANAGED_RELEASE_URL,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import type {
  MANAGED_DISPATCH_NOT_SENT_CODES,
  MANAGED_DISPATCH_REJECTED_CODES,
  MANAGED_DISPATCH_UNKNOWN_CODES,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import type { ManagedMediaPin } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';
import {
  ManagedPublishFetch,
  ManagedPublishSentLedger,
  ManagedPublishTransportCode,
  ManagedPublishTransportError,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.transport';

// Closed provider adapters the owned lifecycle dispatcher drives, one admitted
// step at a time (lifecycle-root-decisions-20261105.md 9;
// lifecycle-architecture-corrections-20261105.md 3, 8, 9). An adapter runs the
// pinned upstream provider class itself, so every request is the one
// production Postiz builds. For instagram-standalone each step gets a fresh
// InstagramProvider whose own instance fetch forwards to the step's
// ManagedPublishTransport#adapterFetch(), handed to a real
// InstagramStandaloneProvider. No global, prototype, IntegrationManager,
// Temporal workflow, token refresh, reconnect, upstream retry or legacy
// blocking post() is reachable from here, and nothing here is composed, routed
// or gated open.
//
// The dispatcher owns everything durable: the transport, its ports and ledger,
// the admission row before IO, the shared-budget units it reserves (stepUnits)
// and the step deadline (steps), capability mints, the persisted continuation,
// polls and recovery. An adapter never retries, and never decides from its own
// error that nothing was sent: the transport's ledger does. After any
// attempted mutation an outcome is UNKNOWN unless the provider's answer proves
// the post was refused. Outcomes and errors carry closed codes only: no token,
// capability URL, provider text or continuation.

export type ManagedPublishStep = 'POST' | 'POLL' | 'FINALIZE' | 'COMMENT';

export interface ManagedPublishStepFact {
  // the transport's deadlineAt is the admission time plus this; never above
  // the transport's 120 s or MANAGED_LIFECYCLE_TIMING.maxStepDeadlineMs
  deadlineMs: number;
  // false: read-only at the provider (a poll)
  mutation: boolean;
}

type RejectedCode = (typeof MANAGED_DISPATCH_REJECTED_CODES)[number];
type UnknownCode = Extract<
  (typeof MANAGED_DISPATCH_UNKNOWN_CODES)[number],
  'OUTCOME_UNKNOWN' | 'STEP_BUDGET_EXCEEDED' | 'LEASE_LOST'
>;
type NotSentCode = Extract<
  (typeof MANAGED_DISPATCH_NOT_SENT_CODES)[number],
  | 'REQUEST_NOT_SENT'
  | 'MEDIA_NOT_CURRENT'
  | 'MEDIA_CHANGED'
  | 'MEDIA_DELIVERY_NOT_QUALIFIED'
>;

// success: published, by the provider's own answer to this step's mutation.
// pending / ready: persist continuation.sealed(), poll it, FINALIZE once
// ready. not_sent: the ledger shows no mutation left. poll_failed: a poll
// could not read the status; nothing changed, poll again until the deadline
export type ManagedPublishOutcome =
  | { status: 'success'; releaseId: string; releaseURL: string | null }
  | { status: 'pending'; continuation: ManagedPublishContinuation }
  | { status: 'ready'; continuation: ManagedPublishContinuation }
  | { status: 'rejected'; code: RejectedCode }
  | { status: 'unknown'; code: UnknownCode }
  | { status: 'not_sent'; code: NotSentCode }
  | { status: 'poll_failed' };

const TOKENS = new WeakMap<ManagedPublishCredential, string>();

// The channel's access token for one call. It is not a property: JSON and
// inspection show nothing, and no outcome, error or hash carries it
export class ManagedPublishCredential {
  constructor(accessToken: string) {
    TOKENS.set(this, accessToken);
  }
}

const SEALED = new WeakMap<ManagedPublishContinuation, string>();

// What a pending call persists (ManagedDispatchCall.pendingEnvelope) so it can
// be polled and finalized after a restart: bound to the release's
// requestHash, bounded, without a token or URL. Only sealed() reads it
export class ManagedPublishContinuation {
  constructor(sealed: string) {
    SEALED.set(this, sealed);
  }

  sealed(): string {
    return SEALED.get(this)!;
  }
}

const RELEASES = new WeakMap<ManagedPublishPrepared, InstagramRelease>();

// A release an adapter checked and will send exactly as it is. Only facts are
// on it; what it sends stays with the adapter that prepared it, so a prepared
// release can't be made or changed anywhere else
export class ManagedPublishPrepared {
  constructor(
    readonly identifier: string,
    // sha256 of the exact adapter input: identity, settings, texts and media
    // pins. No token, capability or URL
    readonly requestHash: string,
    readonly members: number,
    readonly media: number,
    // the most units each step can use; stepUnits() is exact per call
    readonly units: Readonly<Record<ManagedPublishStep, number>>,
    // FINALIZE calls the root needs: 2 for a carousel (its container, then
    // its publish, with a poll between them)
    readonly finalizeSteps: 1 | 2
  ) {
    Object.freeze(this);
  }
}

// One media as the release binds it: its pin and the options W&W approved
export interface ManagedPublishMediaInput {
  pin: ManagedMediaPin;
  alt: string | null;
  // the cover picture, delivered like any media
  thumbnail: ManagedMediaPin | null;
  thumbnailTimestampMs: number | null;
}

export interface ManagedPublishReleaseInput {
  // Integration.internalId and .profile; nothing else of the row
  internalId: string;
  profile: string;
  // W&W's approved settings, without the server's __type
  settings: Record<string, unknown>;
  // position 0 is the post, the rest are comments. text is the strict
  // decoding of the approved content (decodeManagedPublicationText) and is
  // sent as it is, byte for byte
  members: { postId: string; text: string; media: ManagedPublishMediaInput[] }[];
}

// Supplied by the dispatcher for one admitted POST call: a short-lived
// capability URL (managed.lifecycle.media-capability.ts) for exactly this
// pinned media, on the configured origin, a path without query ending in the
// type's extension. Asked once per media of the call, in order. A thrown
// MEDIA_CHANGED / MEDIA_NOT_CURRENT code is kept; any other failure is
// MEDIA_DELIVERY_NOT_QUALIFIED
export interface ManagedPublishMediaUrls {
  url(media: ManagedMediaPin): Promise<string>;
}

// Root-owned and immutable from here: the adapter gets no transport object,
// no ports and no way to write the ledger
export interface ManagedPublishCall {
  credential: ManagedPublishCredential;
  // the frozen ManagedPublishTransport#adapterFetch() of a transport fresh for
  // this one admitted step, built with stepUnits() reserved units: the only
  // network path of the step
  fetch: ManagedPublishFetch;
  // that same transport's ledger(): a frozen copy per read, only read to
  // classify an outcome
  ledger: () => Readonly<ManagedPublishSentLedger>;
}

export interface ManagedPublishAdapter {
  readonly identifier: string;
  readonly editor: 'normal';
  // a root without media is refused at prepare
  readonly requiresMedia: boolean;
  readonly maxStepUnits: number;
  readonly maxStepDeadlineMs: number;
  readonly canComment: boolean;
  readonly mediaDelivery: 'CAPABILITY_URL';
  // the provider fetches media while its containers are processed: keep the
  // call's capabilities until a poll answers ready or the call settles
  readonly mediaFetchedUntil: 'READY';
  readonly steps: Readonly<Record<ManagedPublishStep, ManagedPublishStepFact>>;
  prepare(input: ManagedPublishReleaseInput): ManagedPublishPrepared;
  stepUnits(
    prepared: ManagedPublishPrepared,
    step: ManagedPublishStep,
    continuation?: string
  ): number;
  // pending | rejected | unknown | not_sent
  postPending(
    prepared: ManagedPublishPrepared,
    call: ManagedPublishCall & { media: ManagedPublishMediaUrls }
  ): Promise<ManagedPublishOutcome>;
  // pending | ready | rejected | unknown | poll_failed
  poll(
    prepared: ManagedPublishPrepared,
    continuation: string,
    call: ManagedPublishCall
  ): Promise<ManagedPublishOutcome>;
  // success | pending | rejected | unknown | not_sent
  finalize(
    prepared: ManagedPublishPrepared,
    continuation: string,
    call: ManagedPublishCall
  ): Promise<ManagedPublishOutcome>;
  // success | rejected | unknown | not_sent
  comment(
    prepared: ManagedPublishPrepared,
    member: number,
    parentReleaseId: string,
    call: ManagedPublishCall
  ): Promise<ManagedPublishOutcome>;
}

// ---- refusals -----------------------------------------------------------------

export type ManagedPublishPrepareRefusal =
  | 'RELEASE_INVALID'
  | 'IDENTITY_INVALID'
  | 'SETTING_NOT_SUPPORTED'
  | 'AUDIO_NOT_SUPPORTED'
  | 'COLLABORATORS_INVALID'
  | 'TRIAL_REEL_NOT_SUPPORTED'
  | 'COMMENTS_NOT_SUPPORTED'
  | 'STEP_UNITS_EXCEEDED'
  | 'MEDIA_REQUIRED'
  | 'MEDIA_INVALID'
  | 'MEDIA_TYPE_NOT_SUPPORTED'
  | 'ALT_NOT_SUPPORTED'
  | 'COVER_NOT_SUPPORTED'
  | 'THUMBNAIL_TIMESTAMP_NOT_SUPPORTED'
  | 'TEXT_INVALID'
  | 'TEXT_TOO_LONG'
  | 'TEXT_NOT_SUPPORTED'
  | 'TEXT_REQUIRED';

const PREPARE_REFUSALS: Record<
  ManagedPublishPrepareRefusal,
  [ManagedUnprocessableCode, string]
> = {
  RELEASE_INVALID: ['SETTINGS_INVALID', 'the release is not an identity, settings and 1-20 distinct members'],
  IDENTITY_INVALID: ['SETTINGS_INVALID', 'the channel is not an Instagram account id and username'],
  SETTING_NOT_SUPPORTED: ['SETTINGS_INVALID', 'a setting is unknown, invalid or not sent for this post type'],
  AUDIO_NOT_SUPPORTED: ['SETTINGS_INVALID', 'audio is only sent through Facebook login, never for instagram-standalone'],
  COLLABORATORS_INVALID: ['SETTINGS_INVALID', 'collaborators are at most 3 Instagram usernames'],
  TRIAL_REEL_NOT_SUPPORTED: ['SETTINGS_INVALID', 'a trial reel is one video post, and only it takes a graduation strategy'],
  COMMENTS_NOT_SUPPORTED: ['SETTINGS_INVALID', 'a story takes no comments'],
  STEP_UNITS_EXCEEDED: ['SETTINGS_INVALID', 'a step of this release needs more requests than one step may reserve'],
  MEDIA_REQUIRED: ['MEDIA_OPTIONS_INVALID', 'an Instagram post needs at least one media'],
  MEDIA_INVALID: ['MEDIA_OPTIONS_INVALID', 'a media is not a pin with valid options, or a pin differs between uses'],
  MEDIA_TYPE_NOT_SUPPORTED: ['MEDIA_OPTIONS_INVALID', 'only JPEG and PNG pictures and MP4 videos are delivered'],
  ALT_NOT_SUPPORTED: ['MEDIA_OPTIONS_INVALID', 'alt text is only sent for a picture of a post'],
  COVER_NOT_SUPPORTED: ['MEDIA_OPTIONS_INVALID', 'a cover is only sent for a single video post, and is a JPEG or PNG'],
  THUMBNAIL_TIMESTAMP_NOT_SUPPORTED: ['MEDIA_OPTIONS_INVALID', 'a thumbnail offset is only sent for a video of a post without a cover'],
  TEXT_INVALID: ['CONTENT_NOT_CANONICAL', 'the text is not a well-formed string'],
  TEXT_TOO_LONG: ['CONTENT_NOT_CANONICAL', 'the text is longer than instagram-standalone takes'],
  TEXT_NOT_SUPPORTED: ['CONTENT_NOT_CANONICAL', 'a story shows no caption'],
  TEXT_REQUIRED: ['CONTENT_NOT_CANONICAL', 'a comment needs text and takes no media'],
};

// the existing 422 codes, with the reason; the message never holds input
export class ManagedPublishPrepareError extends ManagedUnprocessableException {
  constructor(public readonly reason: ManagedPublishPrepareRefusal) {
    super(
      PREPARE_REFUSALS[reason][0],
      `${reason}: ${PREPARE_REFUSALS[reason][1]}`
    );
  }
}

export type ManagedPublishCallRefusal =
  | 'PREPARED_UNKNOWN'
  | 'CREDENTIAL_INVALID'
  | 'TRANSPORT_INVALID'
  | 'TRANSPORT_USED'
  | 'CONTINUATION_INVALID'
  | 'MEMBER_INVALID';

// Thrown before upstream runs: the transport's ledger is untouched. A
// CONTINUATION_INVALID is a damaged or foreign durable record, never a reason
// to send anything again
export class ManagedPublishCallError extends Error {
  constructor(public readonly code: ManagedPublishCallRefusal) {
    super(`Managed publish call refused: ${code}`);
    this.name = 'ManagedPublishCallError';
  }
}

const refused = (reason: ManagedPublishPrepareRefusal) =>
  new ManagedPublishPrepareError(reason);

// ---- instagram-standalone -------------------------------------------------------

const IDENTIFIER = 'instagram-standalone';
const GRAPH_HOST = 'graph.instagram.com';
const REQUEST_HASH_VERSION = 'ww-instagram-standalone-request-v1';
const CONTINUATION_VERSION = 'ww-instagram-standalone-pending-v1';
const MAX_CONTINUATION_BYTES = 16 * 1024;
const MAX_CAPABILITY_URL = 2048;
const MAX_COLLABORATORS = 3;

// Graph node ids (accounts, containers, media, comments) are decimal
const NODE_ID = /^\d{1,32}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// letters, digits, periods and underscores; the profile as Instagram reports it
const PROFILE = /^[a-z0-9._]{1,30}$/;
const COLLABORATOR = /^[A-Za-z0-9._]{1,30}$/;
// the same rule as ManagedMediaRefDto.alt
const ALT = /^[^\x00-\x1f\x7f-\x9f]*$/;
// it is put in query strings as it is, and split on '___' by upstream
const TOKEN = /^[A-Za-z0-9._-]{16,2048}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// The types delivered, and the extension a capability URL must end with:
// upstream tells a video from a picture only by hasExtension(path, 'mp4')
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'video/mp4': '.mp4',
});
const COVER_TYPES = ['image/jpeg', 'image/png'];
const SETTINGS = ['post_type', 'is_trial_reel', 'graduation_strategy', 'collaborators'];
const GRADUATION_STRATEGIES = ['MANUAL', 'SS_PERFORMANCE'];

const STEPS: Readonly<Record<ManagedPublishStep, ManagedPublishStepFact>> =
  Object.freeze({
    POST: Object.freeze({ deadlineMs: 120_000, mutation: true }),
    POLL: Object.freeze({ deadlineMs: 30_000, mutation: false }),
    FINALIZE: Object.freeze({ deadlineMs: 120_000, mutation: true }),
    COMMENT: Object.freeze({ deadlineMs: 60_000, mutation: true }),
  });

// Facts of the pinned upstream class, read once. This instance never makes a
// request: its delegate still has SocialAbstract's own fetch
const UPSTREAM = (() => {
  const provider = new InstagramStandaloneProvider();
  return {
    identifier: provider.identifier,
    editor: provider.editor,
    maxLength: provider.maxLength(),
  };
})();

interface ReleaseMedia {
  pin: ManagedMediaPin;
  alt: string | null;
  thumbnail: ManagedMediaPin | null;
  thumbnailTimestampMs: number | null;
  video: boolean;
}

interface ReleaseMember {
  postId: string;
  text: string;
  media: ReleaseMedia[];
}

interface InstagramRelease {
  internalId: string;
  profile: string;
  // the approved settings, as upstream receives them
  settings: InstagramDto;
  postType: 'single' | 'carousel' | 'stories';
  count: number;
  // what upstream keeps in pendingData: the handles without a leading @, and
  // only for a post
  collaborators: string[] | null;
  members: ReleaseMember[];
  requestHash: string;
}

// upstream's pendingData (instagram.provider.ts postPending / finalizePost)
interface InstagramPending {
  type: string;
  postType: InstagramRelease['postType'];
  containers: string[];
  message: string;
  collaborators?: string[];
  carouselId?: string;
}

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const plain = (value: unknown): value is Record<string, any> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const exact = (value: unknown, keys: readonly string[]): value is Record<string, any> =>
  plain(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => hasOwn(value, key));

const safeInt = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max;

// InstagramProvider#stripHandle, which upstream applies to every collaborator
const stripHandle = (label: string) => label.replace(/^@+/, '');

// ---- prepare --------------------------------------------------------------------

function approvedSettings(value: unknown): InstagramDto {
  if (!plain(value)) {
    throw refused('RELEASE_INVALID');
  }
  // audio_configuration is only sent through graph.facebook.com
  if (hasOwn(value, 'audio')) {
    throw refused('AUDIO_NOT_SUPPORTED');
  }

  const { post_type, is_trial_reel, graduation_strategy, collaborators } = value;
  if (
    Object.keys(value).some((key) => !SETTINGS.includes(key)) ||
    (post_type !== 'post' && post_type !== 'story') ||
    (is_trial_reel !== undefined && typeof is_trial_reel !== 'boolean')
  ) {
    throw refused('SETTING_NOT_SUPPORTED');
  }
  // upstream reads the strategy for a trial reel only
  if (
    graduation_strategy !== undefined &&
    (is_trial_reel !== true || !GRADUATION_STRATEGIES.includes(graduation_strategy))
  ) {
    throw refused('TRIAL_REEL_NOT_SUPPORTED');
  }
  if (
    collaborators !== undefined &&
    !(
      Array.isArray(collaborators) &&
      collaborators.length <= MAX_COLLABORATORS &&
      collaborators.every(
        (collaborator) =>
          exact(collaborator, ['label']) &&
          typeof collaborator.label === 'string' &&
          COLLABORATOR.test(stripHandle(collaborator.label))
      )
    )
  ) {
    throw refused('COLLABORATORS_INVALID');
  }

  return {
    post_type,
    ...(is_trial_reel !== undefined ? { is_trial_reel } : {}),
    ...(graduation_strategy !== undefined ? { graduation_strategy } : {}),
    ...(collaborators !== undefined
      ? { collaborators: collaborators.map(({ label }: { label: string }) => ({ label })) }
      : {}),
  } as InstagramDto;
}

// One pinned object per media of the release: a capability is minted once
// per call for a media and for an evidence
function mediaPin(value: unknown, pins: Map<string, ManagedMediaPin>): ManagedMediaPin {
  if (!exact(value, ['mediaId', 'evidenceId', 'sha256', 'byteLength', 'mimeType'])) {
    throw refused('MEDIA_INVALID');
  }
  const { mediaId, evidenceId, sha256, byteLength, mimeType } = value;
  if (
    typeof mediaId !== 'string' ||
    !ID.test(mediaId) ||
    typeof evidenceId !== 'string' ||
    !ID.test(evidenceId) ||
    typeof sha256 !== 'string' ||
    !SHA256_HEX.test(sha256) ||
    !safeInt(byteLength, 1, Number.MAX_SAFE_INTEGER) ||
    typeof mimeType !== 'string'
  ) {
    throw refused('MEDIA_INVALID');
  }
  if (!hasOwn(MEDIA_EXTENSIONS, mimeType)) {
    throw refused('MEDIA_TYPE_NOT_SUPPORTED');
  }

  const pin: ManagedMediaPin = { mediaId, evidenceId, sha256, byteLength, mimeType };
  const known = pins.get(mediaId);
  if (
    (known && JSON.stringify(known) !== JSON.stringify(pin)) ||
    [...pins.values()].some(
      (other) => other.evidenceId === evidenceId && other.mediaId !== mediaId
    )
  ) {
    throw refused('MEDIA_INVALID');
  }
  pins.set(mediaId, pin);
  return pin;
}

function releaseMedia(value: unknown, pins: Map<string, ManagedMediaPin>): ReleaseMedia {
  if (!exact(value, ['pin', 'alt', 'thumbnail', 'thumbnailTimestampMs'])) {
    throw refused('MEDIA_INVALID');
  }
  const { alt, thumbnail, thumbnailTimestampMs } = value;
  if (
    (alt !== null &&
      !(
        typeof alt === 'string' &&
        alt.length >= 1 &&
        alt.length <= MANAGED_ALT_MAX_LENGTH &&
        ALT.test(alt)
      )) ||
    (thumbnailTimestampMs !== null &&
      !safeInt(thumbnailTimestampMs, 0, MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS))
  ) {
    throw refused('MEDIA_INVALID');
  }

  const pin = mediaPin(value.pin, pins);
  const cover = thumbnail === null ? null : mediaPin(thumbnail, pins);
  if (cover && !COVER_TYPES.includes(cover.mimeType)) {
    throw refused('COVER_NOT_SUPPORTED');
  }
  return {
    pin,
    alt,
    thumbnail: cover,
    thumbnailTimestampMs,
    video: pin.mimeType === 'video/mp4',
  };
}

function releaseMember(value: unknown, pins: Map<string, ManagedMediaPin>): ReleaseMember {
  if (!exact(value, ['postId', 'text', 'media'])) {
    throw refused('RELEASE_INVALID');
  }
  const { postId, text, media } = value;
  if (typeof postId !== 'string' || !ID.test(postId) || !Array.isArray(media)) {
    throw refused('RELEASE_INVALID');
  }
  // encodeURIComponent, which upstream applies, throws on a lone surrogate
  if (typeof text !== 'string' || LONE_SURROGATE.test(text)) {
    throw refused('TEXT_INVALID');
  }
  // the measure and bound upstream validation applies to this provider
  if (countLength(IDENTIFIER, text) > UPSTREAM.maxLength) {
    throw refused('TEXT_TOO_LONG');
  }
  if (media.length > MANAGED_LIFECYCLE_LIMITS.mediaPerMember) {
    throw refused('MEDIA_INVALID');
  }
  return { postId, text, media: media.map((item) => releaseMedia(item, pins)) };
}

// What upstream postPending would drop or never send, refused instead
function rootRefusal(
  root: ReleaseMember,
  settings: InstagramDto,
  story: boolean
): ManagedPublishPrepareRefusal | null {
  if (!root.media.length) {
    return 'MEDIA_REQUIRED';
  }
  const single = root.media.length === 1;
  if (story && root.text !== '') {
    return 'TEXT_NOT_SUPPORTED';
  }
  if (story && settings.collaborators?.length) {
    return 'SETTING_NOT_SUPPORTED';
  }
  if (settings.is_trial_reel === true && (story || !single || !root.media[0].video)) {
    return 'TRIAL_REEL_NOT_SUPPORTED';
  }
  for (const item of root.media) {
    if (item.alt !== null && (story || item.video)) {
      return 'ALT_NOT_SUPPORTED';
    }
    // cover_url is sent for a single reel only; a carousel video gets thumb_offset
    if (item.thumbnail && (story || !item.video || !single)) {
      return 'COVER_NOT_SUPPORTED';
    }
    if (item.thumbnailTimestampMs !== null && (story || !item.video || item.thumbnail)) {
      return 'THUMBNAIL_TIMESTAMP_NOT_SUPPORTED';
    }
  }
  return null;
}

function requestHash(
  internalId: string,
  profile: string,
  settings: InstagramDto,
  members: ReleaseMember[]
) {
  const input = {
    v: REQUEST_HASH_VERSION,
    identifier: IDENTIFIER,
    graphVersion: META_GRAPH_API_VERSION,
    internalId,
    profile,
    settings,
    members: members.map((member) => ({
      postId: member.postId,
      text: member.text,
      media: member.media.map((item) => ({
        ...item.pin,
        alt: item.alt,
        thumbnail: item.thumbnail,
        thumbnailTimestampMs: item.thumbnailTimestampMs,
      })),
    })),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

// ---- continuation ---------------------------------------------------------------

// upstream's pendingData exactly as it must be for this release; null for
// anything else (another host, count, post type, caption or handles)
function pendingOf(
  release: InstagramRelease,
  value: unknown,
  carousel: boolean
): InstagramPending | null {
  const keys = [
    'type',
    'postType',
    'containers',
    'message',
    ...(release.collaborators ? ['collaborators'] : []),
    ...(carousel ? ['carouselId'] : []),
  ];
  if (!exact(value, keys)) {
    return null;
  }

  const { type, postType, containers, message, collaborators, carouselId } = value;
  if (
    type !== GRAPH_HOST ||
    postType !== release.postType ||
    message !== release.members[0].text ||
    !Array.isArray(containers) ||
    containers.length !== release.count ||
    new Set(containers).size !== release.count ||
    !containers.every((id) => typeof id === 'string' && NODE_ID.test(id)) ||
    (release.collaborators &&
      !(
        Array.isArray(collaborators) &&
        collaborators.length === release.collaborators.length &&
        collaborators.every((handle, index) => handle === release.collaborators![index])
      )) ||
    (carousel &&
      (release.postType !== 'carousel' ||
        typeof carouselId !== 'string' ||
        !NODE_ID.test(carouselId) ||
        containers.includes(carouselId)))
  ) {
    return null;
  }

  return {
    type,
    postType,
    containers: [...containers],
    message,
    ...(release.collaborators ? { collaborators: [...release.collaborators] } : {}),
    ...(carousel ? { carouselId } : {}),
  };
}

function seal(release: InstagramRelease, pending: InstagramPending) {
  return new ManagedPublishContinuation(
    JSON.stringify({
      v: CONTINUATION_VERSION,
      requestHash: release.requestHash,
      pendingData: pending,
    })
  );
}

// Checked before any request: a continuation of another release, host or
// shape, or one not spelled exactly as sealed, is refused
function unseal(release: InstagramRelease, sealed: unknown): InstagramPending {
  let pending: InstagramPending | null = null;
  if (
    typeof sealed === 'string' &&
    sealed.length <= MAX_CONTINUATION_BYTES &&
    Buffer.byteLength(sealed) <= MAX_CONTINUATION_BYTES
  ) {
    try {
      const parsed = JSON.parse(sealed);
      if (
        exact(parsed, ['v', 'requestHash', 'pendingData']) &&
        parsed.v === CONTINUATION_VERSION &&
        parsed.requestHash === release.requestHash &&
        plain(parsed.pendingData)
      ) {
        pending = pendingOf(
          release,
          parsed.pendingData,
          hasOwn(parsed.pendingData, 'carouselId')
        );
      }
    } catch (err) {
      pending = null;
    }
  }
  if (!pending || seal(release, pending).sealed() !== sealed) {
    throw new ManagedPublishCallError('CONTINUATION_INVALID');
  }
  return pending;
}

const sameSealed = (release: InstagramRelease, a: InstagramPending, b: InstagramPending) =>
  seal(release, a).sealed() === seal(release, b).sealed();

// ---- media delivery ---------------------------------------------------------------

// https, scheme, host and port only, and no '.mp4' (upstream would take every
// picture for a video)
function capabilityOrigin(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    return null;
  }
  return url.protocol === 'https:' &&
    url.origin === value &&
    !value.toLowerCase().includes('.mp4')
    ? value
    : null;
}

// Upstream puts image_url / video_url into the query unencoded, so the URL is
// a canonical path of safe segments without query or fragment. '.mp4' occurs
// exactly at the end of a video and nowhere in a picture's URL
function capabilityUrl(value: unknown, origin: string, mimeType: string): string | null {
  if (typeof value !== 'string' || value.length > MAX_CAPABILITY_URL || /[?#]/.test(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (err) {
    return null;
  }
  const lower = value.toLowerCase();
  const mp4 = lower.indexOf('.mp4');
  return url.href === value &&
    url.origin === origin &&
    /^(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/.test(url.pathname) &&
    lower.endsWith(MEDIA_EXTENSIONS[mimeType]) &&
    (mimeType === 'video/mp4' ? mp4 === value.length - 4 : mp4 === -1)
    ? value
    : null;
}

function mediaContent(item: ReleaseMedia, urls: Map<string, string>): MediaContent {
  return {
    type: item.video ? 'video' : 'image',
    path: urls.get(item.pin.mediaId)!,
    ...(item.alt !== null ? { alt: item.alt } : {}),
    ...(item.thumbnail ? { thumbnail: urls.get(item.thumbnail.mediaId) } : {}),
    ...(item.thumbnailTimestampMs !== null
      ? { thumbnailTimestamp: item.thumbnailTimestampMs }
      : {}),
  };
}

// ---- requests of one step ---------------------------------------------------------

type RequestKind = 'CONTAINER' | 'STATUS' | 'PUBLISH' | 'PERMALINK' | 'COMMENT';

// The only upstream requests each step lets through to the transport. A poll
// reads; the recent-media probe after a blocked publish is never reached
const STEP_REQUESTS: Record<ManagedPublishStep, readonly RequestKind[]> = {
  POST: ['CONTAINER'],
  POLL: ['STATUS'],
  FINALIZE: ['STATUS', 'CONTAINER', 'PUBLISH', 'PERMALINK'],
  COMMENT: ['COMMENT', 'PERMALINK'],
};
const MUTATIONS: readonly RequestKind[] = ['CONTAINER', 'PUBLISH', 'COMMENT'];
// a container is invisible until it is published
const VISIBLE: readonly RequestKind[] = ['PUBLISH', 'COMMENT'];

// Graph codes that say "not now" rather than "refused"
const TRANSIENT_GRAPH_CODES = [1, 2, 4, 17, 32, 341, 613];

const UNKNOWN_CODES: Partial<Record<ManagedPublishTransportCode, UnknownCode>> = {
  RESERVATION_EXHAUSTED: 'STEP_BUDGET_EXCEEDED',
  ADMISSION_LOST: 'LEASE_LOST',
};

function requestKind(
  input: string,
  method: string,
  account: string,
  parent: string | null
): RequestKind | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch (err) {
    return null;
  }
  const path = /^\/([^/]+)\/(\d{1,32})(?:\/(media|media_publish|comments))?$/.exec(
    url.pathname
  );
  if (url.protocol !== 'https:' || url.host !== GRAPH_HOST || path?.[1] !== META_GRAPH_API_VERSION) {
    return null;
  }

  const [, , node, edge] = path;
  if (method === 'POST') {
    return edge === 'media' && node === account
      ? 'CONTAINER'
      : edge === 'media_publish' && node === account
      ? 'PUBLISH'
      : edge === 'comments' && node === parent
      ? 'COMMENT'
      : null;
  }
  const fields = url.searchParams.get('fields');
  return method !== 'GET' || edge
    ? null
    : fields === 'status_code,status'
    ? 'STATUS'
    : fields === 'permalink'
    ? 'PERMALINK'
    : null;
}

// A refusal the answer proves: a 4xx Graph error that is not transient and
// that upstream's own handleErrors names. media_publish answered "blocked"
// may still have published (instagram.provider.ts finalizePost), so it is not
function provenRefusal(
  kind: RequestKind,
  status: number,
  body: string,
  handleErrors: (body: string, status: number) => { type: string; value: string } | undefined
): RejectedCode | null {
  if (status < 400 || status > 499 || status === 408 || status === 429) {
    return null;
  }
  let error: any;
  try {
    error = JSON.parse(body)?.error;
  } catch (err) {
    return null;
  }
  if (
    !error ||
    typeof error !== 'object' ||
    error.is_transient === true ||
    !Number.isSafeInteger(error.code) ||
    TRANSIENT_GRAPH_CODES.includes(error.code)
  ) {
    return null;
  }
  const handled = handleErrors(body, status);
  if (
    !handled ||
    handled.type === 'retry' ||
    (kind === 'PUBLISH' && handled.value.includes('blocked'))
  ) {
    return null;
  }
  return handled.type === 'bad-body' ? 'PROVIDER_REJECTED' : 'CHANNEL_REFRESH_NEEDED';
}

function answeredId(body: string): string | null {
  try {
    const id = JSON.parse(body)?.id;
    return typeof id === 'string' && NODE_ID.test(id) ? id : null;
  } catch (err) {
    return null;
  }
}

interface SentRequest {
  kind: RequestKind;
  // ok: a 200/201 reached upstream; answered: any other status; failed: the
  // transport threw
  outcome: 'ok' | 'answered' | 'failed';
  id: string | null;
  refusal: RejectedCode | null;
}

// Carries nothing of the request or answer
class ManagedPublishStepStopped extends Error {
  constructor() {
    super('The managed publish step stopped');
    this.name = 'ManagedPublishStepStopped';
  }
}

// InstagramProvider#fetch of one step's delegate: one request at a time, only
// the kinds the step allows, and none after the first that failed or did not
// get a 200/201 (so Promise.all in upstream stops there). What each request
// got is kept for classification; the answer body goes back to upstream only
class StepRequests {
  readonly sent: SentRequest[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly adapterFetch: ManagedPublishFetch,
    private readonly kinds: readonly RequestKind[],
    private readonly account: string,
    private readonly parent: string | null,
    private readonly handleErrors: (
      body: string,
      status: number
    ) => { type: string; value: string } | undefined
  ) {}

  send = (url: string, options?: RequestInit): Promise<Response> => {
    const request = this.tail.then(() => this.perform(url, options));
    this.tail = request.catch(() => undefined);
    return request;
  };

  // every request upstream started has settled
  settled() {
    return this.tail;
  }

  private async perform(url: string, options?: RequestInit): Promise<Response> {
    const method = options?.method ?? 'GET';
    const kind = requestKind(url, method, this.account, this.parent);
    if (
      this.stopped ||
      !kind ||
      !this.kinds.includes(kind) ||
      Object.keys(options ?? {}).some((key) => key !== 'method')
    ) {
      this.stopped = true;
      throw new ManagedPublishStepStopped();
    }

    const request: SentRequest = { kind, outcome: 'failed', id: null, refusal: null };
    this.sent.push(request);
    let status: number;
    let body: string;
    // called without a receiver: the transport never sees this object. A
    // request it refuses stops the step; nothing goes around it
    const adapterFetch = this.adapterFetch;
    try {
      const response = await adapterFetch(url, { method });
      status = response.status;
      body = await response.text();
    } catch (err) {
      this.stopped = true;
      throw err instanceof ManagedPublishTransportError
        ? err
        : new ManagedPublishStepStopped();
    }

    if (status === 200 || status === 201) {
      request.outcome = 'ok';
      request.id = answeredId(body);
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }

    this.stopped = true;
    request.outcome = 'answered';
    request.refusal = provenRefusal(kind, status, body, this.handleErrors);
    throw new ManagedPublishStepStopped();
  }
}

const answered = (sent: readonly SentRequest[], kind: RequestKind) =>
  sent.filter((request) => request.kind === kind && request.outcome === 'ok').map((request) => request.id);

// upstream threw after reading an ERROR / EXPIRED container status
function containerRefusal(error: unknown, last: SentRequest | undefined): RejectedCode | null {
  if (last?.kind !== 'STATUS' || last.outcome !== 'ok') {
    return null;
  }
  return error instanceof Disconnect
    ? 'CHANNEL_REFRESH_NEEDED'
    : error instanceof BadBody
    ? 'PROVIDER_REJECTED'
    : null;
}

const LEDGER_KEYS = [
  'attemptedRequests',
  'attemptedMutations',
  'completedRequests',
  'mutationMayHaveLeft',
  'failure',
];

// One read of the dispatcher's ledger, as a copy; null when it can't be read
// or is not a ledger, which classifies as anything may have left
function readLedger(call: ManagedPublishCall): Readonly<ManagedPublishSentLedger> | null {
  let value: unknown;
  try {
    value = call.ledger();
  } catch (err) {
    return null;
  }
  if (!exact(value, LEDGER_KEYS)) {
    return null;
  }
  const { attemptedRequests, attemptedMutations, completedRequests, mutationMayHaveLeft, failure } =
    value;
  return safeInt(attemptedRequests, 0, Number.MAX_SAFE_INTEGER) &&
    safeInt(attemptedMutations, 0, attemptedRequests) &&
    safeInt(completedRequests, 0, attemptedRequests) &&
    typeof mutationMayHaveLeft === 'boolean' &&
    (failure === null || typeof failure === 'string')
    ? Object.freeze({
        attemptedRequests,
        attemptedMutations,
        completedRequests,
        mutationMayHaveLeft,
        failure,
      })
    : null;
}

// Whatever upstream threw, or an answer that did not check out, judged by the
// transport's ledger and the requests the step sent
function classify(
  step: ManagedPublishStep,
  error: unknown,
  sent: readonly SentRequest[],
  ledger: Readonly<ManagedPublishSentLedger> | null
): ManagedPublishOutcome {
  const last = sent[sent.length - 1];
  // a poll only reads (STEP_REQUESTS); any other unreadable ledger is UNKNOWN
  if (!ledger) {
    return step === 'POLL'
      ? { status: 'poll_failed' }
      : { status: 'unknown', code: 'OUTCOME_UNKNOWN' };
  }
  if (!ledger.mutationMayHaveLeft) {
    const refusal = last?.refusal ?? containerRefusal(error, last);
    if (refusal) {
      return { status: 'rejected', code: refusal };
    }
    return step === 'POLL'
      ? { status: 'poll_failed' }
      : { status: 'not_sent', code: 'REQUEST_NOT_SENT' };
  }

  const published = sent.filter(
    (request) => VISIBLE.includes(request.kind) && request.outcome === 'ok'
  );
  // the refused request was the last, and nothing before it is visible. The
  // transport marks every answered non-2xx mutation PROVIDER_REJECTED; any
  // other failure (budget, lease, deadline, network) leaves it uncertain
  if (
    !published.length &&
    last &&
    MUTATIONS.includes(last.kind) &&
    last.refusal &&
    (!ledger.failure || ledger.failure === 'PROVIDER_REJECTED')
  ) {
    return { status: 'rejected', code: last.refusal };
  }
  // the comment exists (its id was answered); only the parent's permalink
  // read after it failed
  if (step === 'COMMENT' && published.length === 1 && published[0].id && last.kind === 'PERMALINK') {
    return { status: 'success', releaseId: published[0].id, releaseURL: null };
  }
  return {
    status: 'unknown',
    code: (ledger.failure && UNKNOWN_CODES[ledger.failure]) || 'OUTCOME_UNKNOWN',
  };
}

// a permalink Instagram answered; upstream's fallback to the profile page (or
// anything else) is not the post's address and is answered as null
function releaseUrl(value: unknown, profile: string): string | null {
  if (
    typeof value !== 'string' ||
    value.length > MANAGED_LIFECYCLE_LIMITS.releaseUrlMax ||
    !MANAGED_RELEASE_URL.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.host === 'www.instagram.com' &&
      url.href === value &&
      value !== `https://www.instagram.com/${profile}`
      ? value
      : null;
  } catch (err) {
    return null;
  }
}

// postPending: one pending answer for the root, whose containers are the ids
// Instagram answered, in media order
function pendingAnswer(
  release: InstagramRelease,
  value: PostResponse[],
  sent: readonly SentRequest[]
): ManagedPublishOutcome | null {
  const [answer] = Array.isArray(value) && value.length === 1 ? value : [];
  if (answer?.id !== release.members[0].postId || answer.status !== 'pending') {
    return null;
  }
  const pending = pendingOf(release, answer.pendingData, false);
  return pending && answered(sent, 'CONTAINER').join() === pending.containers.join()
    ? { status: 'pending', continuation: seal(release, pending) }
    : null;
}

// checkPostStatus hands back the same pendingData. A container already
// published that this dispatch never published is left to a human
function pollAnswer(
  release: InstagramRelease,
  pending: InstagramPending,
  value: PendingCheckResponse
): ManagedPublishOutcome | null {
  if (value?.status === 'completed') {
    return { status: 'unknown', code: 'OUTCOME_UNKNOWN' };
  }
  if (value?.status !== 'pending' && value?.status !== 'ready') {
    return null;
  }
  const again = pendingOf(release, value.pendingData, !!pending.carouselId);
  return again && sameSealed(release, again, pending)
    ? { status: value.status, continuation: seal(release, again) }
    : null;
}

// finalizePost: a carousel's container created (pending again), or published
// by exactly this step's own media_publish answers (one per story)
function finalizeAnswer(
  release: InstagramRelease,
  pending: InstagramPending,
  value: PendingCheckResponse,
  sent: readonly SentRequest[]
): ManagedPublishOutcome | null {
  if (value?.status === 'pending') {
    const created = answered(sent, 'CONTAINER');
    const next =
      release.postType === 'carousel' && !pending.carouselId
        ? pendingOf(release, value.pendingData, true)
        : null;
    return next &&
      created.length === 1 &&
      next.carouselId === created[0] &&
      sameSealed(release, next, { ...pending, carouselId: next.carouselId })
      ? { status: 'pending', continuation: seal(release, next) }
      : null;
  }
  if (value?.status !== 'completed') {
    return null;
  }

  const published = answered(sent, 'PUBLISH');
  const releaseId = published[published.length - 1];
  return published.length === (release.postType === 'stories' ? release.count : 1) &&
    published.every(Boolean) &&
    value.postId === releaseId
    ? { status: 'success', releaseId, releaseURL: releaseUrl(value.releaseURL, release.profile) }
    : { status: 'unknown', code: 'OUTCOME_UNKNOWN' };
}

function commentAnswer(
  release: InstagramRelease,
  member: ReleaseMember,
  value: PostResponse[],
  sent: readonly SentRequest[]
): ManagedPublishOutcome | null {
  const [answer] = Array.isArray(value) && value.length === 1 ? value : [];
  const [commentId] = answered(sent, 'COMMENT');
  return answer?.id === member.postId &&
    answer.status === 'success' &&
    commentId &&
    answer.postId === commentId
    ? { status: 'success', releaseId: commentId, releaseURL: releaseUrl(answer.releaseURL, release.profile) }
    : null;
}

// ---- the adapter ------------------------------------------------------------------

export class InstagramStandalonePublishAdapter implements ManagedPublishAdapter {
  readonly identifier = IDENTIFIER;
  readonly editor = 'normal' as const;
  readonly requiresMedia = true;
  // Stories are the largest step: one status and one publish per item,
  // then one permalink. Every other supported step uses no more requests.
  readonly maxStepUnits = 2 * MANAGED_LIFECYCLE_LIMITS.mediaPerMember + 1;
  readonly maxStepDeadlineMs = Math.max(...Object.values(STEPS).map(step => step.deadlineMs));
  readonly canComment = true;
  readonly mediaDelivery = 'CAPABILITY_URL' as const;
  readonly mediaFetchedUntil = 'READY' as const;
  readonly steps = STEPS;
  private readonly mediaOrigin: string | null;

  // mediaOrigin: where capability URLs are served. Without a valid one every
  // POST is MEDIA_DELIVERY_NOT_QUALIFIED and nothing is minted
  constructor(options: { mediaOrigin: string | null }) {
    if (UPSTREAM.identifier !== this.identifier || UPSTREAM.editor !== this.editor) {
      throw new Error('The pinned instagram-standalone provider changed');
    }
    this.mediaOrigin = capabilityOrigin(options?.mediaOrigin);
  }

  prepare(input: ManagedPublishReleaseInput): ManagedPublishPrepared {
    if (
      !exact(input, ['internalId', 'profile', 'settings', 'members']) ||
      !Array.isArray(input.members) ||
      !input.members.length ||
      input.members.length > MANAGED_LIFECYCLE_LIMITS.members
    ) {
      throw refused('RELEASE_INVALID');
    }
    const { internalId, profile } = input;
    if (
      typeof internalId !== 'string' ||
      !NODE_ID.test(internalId) ||
      typeof profile !== 'string' ||
      !PROFILE.test(profile)
    ) {
      throw refused('IDENTITY_INVALID');
    }

    const settings = approvedSettings(input.settings);
    const story = settings.post_type === 'story';
    const pins = new Map<string, ManagedMediaPin>();
    const members = input.members.map((member: unknown) => releaseMember(member, pins));
    if (new Set(members.map((member) => member.postId)).size !== members.length) {
      throw refused('RELEASE_INVALID');
    }

    const [root, ...comments] = members;
    const refusal = rootRefusal(root, settings, story);
    if (refusal) {
      throw refused(refusal);
    }
    if (story && comments.length) {
      throw refused('COMMENTS_NOT_SUPPORTED');
    }
    if (comments.some((comment) => !comment.text || comment.media.length)) {
      throw refused('TEXT_REQUIRED');
    }

    // upstream's own request counts: a container per media, a status read
    // per container, per story a status read and a media_publish, then the
    // permalink, and two requests per comment
    const count = root.media.length;
    const postType = story && count > 1 ? 'stories' : count === 1 ? 'single' : 'carousel';
    const units = {
      POST: count,
      POLL: count,
      FINALIZE: postType === 'stories' ? 2 * count + 1 : 2,
      COMMENT: 2,
    };
    if (Object.values(units).some((value) => value > MANAGED_LIFECYCLE_LIMITS.maxStepUnits)) {
      throw refused('STEP_UNITS_EXCEEDED');
    }

    const release: InstagramRelease = {
      internalId,
      profile,
      settings,
      postType,
      count,
      collaborators:
        !story && settings.collaborators?.length
          ? settings.collaborators.map(({ label }) => stripHandle(label))
          : null,
      members,
      requestHash: requestHash(internalId, profile, settings, members),
    };
    const prepared = new ManagedPublishPrepared(
      IDENTIFIER,
      release.requestHash,
      members.length,
      count,
      Object.freeze(units),
      postType === 'carousel' ? 2 : 1
    );
    RELEASES.set(prepared, release);
    return prepared;
  }

  // The exact units to reserve before admitting this step
  stepUnits(
    prepared: ManagedPublishPrepared,
    step: ManagedPublishStep,
    continuation?: string
  ): number {
    const release = this.release(prepared);
    if (step === 'POST' || step === 'COMMENT') {
      return step === 'POST' ? release.count : 2;
    }
    const pending = unseal(release, continuation);
    if (step === 'POLL') {
      return pending.carouselId ? 1 : release.count;
    }
    return release.postType === 'carousel' && !pending.carouselId
      ? 1
      : release.postType === 'stories'
      ? 2 * release.count + 1
      : 2;
  }

  async postPending(
    prepared: ManagedPublishPrepared,
    call: ManagedPublishCall & { media: ManagedPublishMediaUrls }
  ): Promise<ManagedPublishOutcome> {
    const { release, token } = this.begin(prepared, call);
    const urls = await this.capabilityUrls(release, call.media);
    if (typeof urls === 'string') {
      return readLedger(call)?.attemptedRequests === 0
        ? { status: 'not_sent', code: urls }
        : { status: 'unknown', code: 'OUTCOME_UNKNOWN' };
    }

    const root = release.members[0];
    const posts: PostDetails<InstagramDto>[] = [
      {
        id: root.postId,
        message: root.text,
        settings: this.settings(release),
        media: root.media.map((item) => mediaContent(item, urls)),
      },
    ];
    return this.run(
      'POST',
      release,
      call,
      null,
      (provider, integration) =>
        provider.postPending(release.internalId, token, posts, integration),
      (value, sent) => pendingAnswer(release, value, sent)
    );
  }

  async poll(
    prepared: ManagedPublishPrepared,
    continuation: string,
    call: ManagedPublishCall
  ): Promise<ManagedPublishOutcome> {
    const { release, token } = this.begin(prepared, call);
    const pending = unseal(release, continuation);
    return this.run(
      'POLL',
      release,
      call,
      null,
      (provider, integration) => provider.checkPostStatus(token, pending, integration),
      (value) => pollAnswer(release, pending, value)
    );
  }

  async finalize(
    prepared: ManagedPublishPrepared,
    continuation: string,
    call: ManagedPublishCall
  ): Promise<ManagedPublishOutcome> {
    const { release, token } = this.begin(prepared, call);
    const pending = unseal(release, continuation);
    return this.run(
      'FINALIZE',
      release,
      call,
      null,
      (provider, integration) => provider.finalizePost(token, pending, integration),
      (value, sent) => finalizeAnswer(release, pending, value, sent)
    );
  }

  async comment(
    prepared: ManagedPublishPrepared,
    member: number,
    parentReleaseId: string,
    call: ManagedPublishCall
  ): Promise<ManagedPublishOutcome> {
    const { release, token } = this.begin(prepared, call);
    const comment = safeInt(member, 1, release.members.length - 1)
      ? release.members[member]
      : null;
    if (!comment || typeof parentReleaseId !== 'string' || !NODE_ID.test(parentReleaseId)) {
      throw new ManagedPublishCallError('MEMBER_INVALID');
    }

    const posts: PostDetails<InstagramDto>[] = [
      { id: comment.postId, message: comment.text, settings: this.settings(release), media: [] },
    ];
    return this.run(
      'COMMENT',
      release,
      call,
      parentReleaseId,
      (provider, integration) =>
        provider.comment(release.internalId, parentReleaseId, undefined, token, posts, integration),
      (value, sent) => commentAnswer(release, comment, value, sent)
    );
  }

  private release(prepared: ManagedPublishPrepared): InstagramRelease {
    const release = prepared instanceof ManagedPublishPrepared ? RELEASES.get(prepared) : undefined;
    if (!release) {
      throw new ManagedPublishCallError('PREPARED_UNKNOWN');
    }
    return release;
  }

  private begin(prepared: ManagedPublishPrepared, call: ManagedPublishCall) {
    const release = this.release(prepared);
    const token =
      call?.credential instanceof ManagedPublishCredential
        ? TOKENS.get(call.credential)
        : undefined;
    if (typeof token !== 'string' || !TOKEN.test(token) || token.includes('___')) {
      throw new ManagedPublishCallError('CREDENTIAL_INVALID');
    }
    // adapterFetch() is frozen; a plain fetch, global or not, is not it
    if (
      typeof call.fetch !== 'function' ||
      !Object.isFrozen(call.fetch) ||
      call.fetch === globalThis.fetch ||
      typeof call.ledger !== 'function'
    ) {
      throw new ManagedPublishCallError('TRANSPORT_INVALID');
    }
    const ledger = readLedger(call);
    if (!ledger) {
      throw new ManagedPublishCallError('TRANSPORT_INVALID');
    }
    if (ledger.attemptedRequests || ledger.mutationMayHaveLeft || ledger.failure) {
      throw new ManagedPublishCallError('TRANSPORT_USED');
    }
    return { release, token };
  }

  // a copy per call: upstream receives the approved settings, never shared
  private settings(release: InstagramRelease): InstagramDto {
    return JSON.parse(JSON.stringify(release.settings));
  }

  // One capability URL per media of the root (its cover included), minted in
  // media order and reused wherever the media is sent again
  private async capabilityUrls(
    release: InstagramRelease,
    media: ManagedPublishMediaUrls
  ): Promise<Map<string, string> | NotSentCode> {
    if (!this.mediaOrigin || typeof media?.url !== 'function') {
      return 'MEDIA_DELIVERY_NOT_QUALIFIED';
    }

    const urls = new Map<string, string>();
    for (const item of release.members[0].media) {
      for (const pin of item.thumbnail ? [item.pin, item.thumbnail] : [item.pin]) {
        if (urls.has(pin.mediaId)) {
          continue;
        }
        let url: unknown;
        try {
          url = await media.url({ ...pin });
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code;
          return code === 'MEDIA_CHANGED' || code === 'MEDIA_NOT_CURRENT'
            ? code
            : 'MEDIA_DELIVERY_NOT_QUALIFIED';
        }
        const checked = capabilityUrl(url, this.mediaOrigin, pin.mimeType);
        if (!checked || [...urls.values()].includes(checked)) {
          return 'MEDIA_DELIVERY_NOT_QUALIFIED';
        }
        urls.set(pin.mediaId, checked);
      }
    }
    return urls;
  }

  // One step through the real upstream classes, with a delegate whose only
  // network path is this step's transport
  private async run<T>(
    step: ManagedPublishStep,
    release: InstagramRelease,
    call: ManagedPublishCall,
    parent: string | null,
    invoke: (provider: InstagramStandaloneProvider, integration: Integration) => Promise<T>,
    answer: (value: T, sent: readonly SentRequest[]) => ManagedPublishOutcome | null
  ): Promise<ManagedPublishOutcome> {
    const delegate = new InstagramProvider();
    const requests = new StepRequests(
      call.fetch,
      STEP_REQUESTS[step],
      release.internalId,
      parent,
      (body, status) => delegate.handleErrors(body, status)
    );
    // this one instance's fetch, nothing else: no global, no prototype and
    // none of SocialAbstract#fetch's retries
    delegate.fetch = requests.send;
    // After a "blocked" media_publish upstream takes the account's newest
    // media for the post; that is never proof of this publication, so this
    // instance finds none and the step stays UNKNOWN
    Object.defineProperty(delegate, 'igPublishedMediaId', {
      value: async () => '',
    });
    const provider = new InstagramStandaloneProvider(delegate);
    // what upstream reads of the channel, never the Integration row
    const integration = {
      internalId: release.internalId,
      profile: release.profile,
    } as Integration;

    let outcome: ManagedPublishOutcome | null = null;
    let error: unknown;
    try {
      const value = await invoke(provider, integration);
      await requests.settled();
      outcome = answer(value, requests.sent);
    } catch (err) {
      error = err;
    }
    await requests.settled();
    return outcome ?? classify(step, error, requests.sent, readLedger(call));
  }
}

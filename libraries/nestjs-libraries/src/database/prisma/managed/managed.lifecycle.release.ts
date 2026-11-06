import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { allProviders } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings';
import {
  MANAGED_ALT_MAX_LENGTH,
  MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';
import {
  BindingRow,
  IntegrationIdentity,
  ManagedPostRow,
  ManagedReader,
  MediaWithEvidence,
  PostRow,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import {
  canonicalJson,
  fingerprint,
  identityFingerprint,
  ManagedEvidenceView,
  ManagedMediaRefView,
  ManagedPostSnapshot,
  orderRows,
  rowFingerprint,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import {
  decodeManagedPublicationText,
  ManagedCaptionCodec,
  ManagedPublicationTextError,
  ManagedPublicationTextInput,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publication-text';
import {
  lifecycleProviderEligible,
  lifecycleTextException,
  MANAGED_LIFECYCLE_LIMITS,
  MANAGED_LIFECYCLE_UUID,
  MANAGED_LIFECYCLE_VERSION,
  MANAGED_RELEASE_HASH_VERSION,
  ManagedLifecycleCode,
  ManagedLifecycleException,
  managedLifecycleIssues,
  ManagedLifecycleProviderFacts,
  ManagedReleasePreview,
  parseManagedLifecycleResponse,
  releaseHashInput,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import {
  MANAGED_MEDIA_CAPABILITY_TYPES,
  managedMediaCapabilityMaxBytes,
  ManagedMediaPin,
  ManagedMediaPinnedEvidence,
  ManagedMediaPinnedStorage,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';
import type { ManagedPublishMediaInput } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.provider';

// The one release builder of the owned lifecycle: release preview, request
// acceptance and dispatcher admission all derive what would be sent here, so
// none of them can disagree with another (lifecycle-root-decisions-20261105.md
// 7, 8 and 14; lifecycle-architecture-corrections-20261105.md 5, 6 and 8).
//
// Read-only and point-in-time: everything is read through the caller's
// organization-scoped ManagedReader (a consistent read, or the transaction of
// an admission), and the answer holds for that read only. No row, revision,
// binding, evidence or event is written; no binding is reconciled; no provider
// or storage is called. The media's pinned-storage observation is taken by
// observeManagedReleaseMedia before the read, outside any transaction (as
// ManagedMediaService.currentEvidence before a draft), and only evidence that
// observation and this read agree on is released.
//
// The release comes from the retained Post rows checked against the current
// immutable revision snapshot. The rows are trusted only while their
// fingerprint is the one ManagedPost.rowFingerprint holds: a lifecycle-
// authorized QUEUE / PUBLISHED transition keeps that fingerprint current, so
// it is not foreign drift; anything else is. A revision snapshot is never
// changed here.
//
// The public preview is a comparison only. W&W derives its own release hash
// from its approved payload and retained upload bindings and compares; it
// never takes a value from the preview. The preview carries no settings, token,
// path, URL, storage key, namespace, version or capability; the internal
// release keeps the approved settings and media pins for the adapter.
//
// Covers carry the same exact byte length and MIME pin as primary media;
// both are included in the release hash. settingsHash is fingerprint() of the approved settings exactly as the
// revision bound them (without __type), which W&W must reproduce; and a DRAFT
// may hold an empty alt the release contract can't carry, which is refused
// here (POST_NOT_SCHEDULABLE), never turned into "no alt".

// members × media per member × (media + its cover)
const MAX_RELEASE_MEDIA_IDS =
  MANAGED_LIFECYCLE_LIMITS.members * MANAGED_LIFECYCLE_LIMITS.mediaPerMember * 2;

// the bounds and the cover rule of managed.service.ts
const MAX_SETTINGS_BYTES = 32 * 1024;
const THUMBNAIL_MIME_TYPES = ['image/jpeg', 'image/png'];
const ALT = /^[^\x00-\x1f\x7f-\x9f]*$/;

// The states a live member row may be in: the draft, and the ones a lifecycle-
// authorized transition leaves behind. ERROR and anything else are not
// released
const RELEASABLE_ROW_STATES = ['DRAFT', 'QUEUE', 'PUBLISHED'];

// the Post.image keys managed.service.ts writes, and nothing else
const IMAGE_KEYS = ['id', 'name', 'path', 'alt', 'thumbnail', 'thumbnailTimestamp'];

// Pinned evidence by media id: only media whose current evidence is pinned to
// a key, namespace and version that storage still holds at that version
export type ManagedReleaseObservedMedia = ReadonlyMap<
  string,
  Readonly<ManagedMediaPinnedEvidence>
>;

export interface ManagedReleaseRequest {
  managedPostId: string;
  expectedRevision: number;
  codec: ManagedCaptionCodec;
  // what the adapter declares for the channel's provider; null when none is
  // configured. Never assumed from the provider's name
  provider: ManagedLifecycleProviderFacts | null;
  // the media capability delivery is configured for this runtime
  mediaDeliveryReady: boolean;
  // observeManagedReleaseMedia, taken before this read
  observedMedia: ManagedReleaseObservedMedia;
}

export interface ManagedPreparedReleaseMember {
  postId: string;
  position: number;
  delay: number;
  // decodeManagedPublicationText of the stored content, sent as it is
  text: string;
  // each media and its cover as pins; no path, URL or storage key
  media: readonly Readonly<ManagedPublishMediaInput>[];
}

// Internal only, never answered: what the dispatcher hands an adapter
// (ManagedPublishReleaseInput is { internalId, profile, settings, members:
// { postId, text, media } }) and what it rechecks at admission
export interface ManagedPreparedRelease {
  managedPostId: string;
  revision: number;
  bindingGeneration: number;
  integrationId: string;
  providerIdentifier: string;
  identityFingerprint: string;
  codec: ManagedCaptionCodec;
  settingsHash: string;
  releaseHash: string;
  // ManagedPost.rowFingerprint the rows were found consistent with
  rowFingerprint: string;
  // Integration.internalId / .profile as recorded at this read
  internalId: string;
  profile: string | null;
  // W&W's approved settings as the revision bound them, without __type
  settings: Readonly<Record<string, unknown>>;
  members: readonly Readonly<ManagedPreparedReleaseMember>[];
}

export interface ManagedReleaseBuild {
  preview: ManagedReleasePreview;
  release: ManagedPreparedRelease;
}

const refuse = (code: ManagedLifecycleCode, msg: string) =>
  new ManagedLifecycleException(code, msg);

// a storage read that fails is the same as one that found nothing; its error
// is never kept
const quietly = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

const isPlainObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as object).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

function parseSnapshot(raw: string): ManagedPostSnapshot | null {
  try {
    const snapshot = JSON.parse(raw);
    return isPlainObject(snapshot) && Array.isArray(snapshot.members)
      ? (snapshot as ManagedPostSnapshot)
      : null;
  } catch {
    return null;
  }
}

// every media and cover id the members of a revision reference
const snapshotMediaIds = (snapshot: ManagedPostSnapshot) => [
  ...new Set(
    snapshot.members.flatMap((member) =>
      (member.media || []).flatMap((ref) =>
        ref.thumbnail ? [ref.mediaId, ref.thumbnail.mediaId] : [ref.mediaId]
      )
    )
  ),
];

// The media ids a release of this revision reads, for the storage
// observation taken before the release is built. Empty for a revision that
// does not exist; the build refuses it
export async function managedReleaseMediaIds(
  reader: ManagedReader,
  managedPostId: string,
  revision: number
): Promise<string[]> {
  const row = await reader.getRevision(managedPostId, revision);
  const snapshot = row ? parseSnapshot(row.snapshot) : null;
  return snapshot ? snapshotMediaIds(snapshot) : [];
}

// A read-only look at where each media's current evidence is pinned, through
// the actual pinned-storage interface: the evidence is kept only while its key
// resolves in the pinned namespace, before and after every read, at the
// pinned version. The bytes are not read again here; the capability fetch
// verifies them whole before any byte leaves (managed.lifecycle.media-
// capability.ts). Nothing is written, and no storage error escapes
export async function observeManagedReleaseMedia(
  storage: Pick<ManagedMediaPinnedStorage, 'pinnedEvidence' | 'namespace' | 'versionAt'>,
  organizationId: string,
  mediaIds: readonly string[]
): Promise<ManagedReleaseObservedMedia> {
  const ids = [...new Set(mediaIds)];
  if (ids.length > MAX_RELEASE_MEDIA_IDS) {
    throw refuse(
      'LIFECYCLE_INPUT_INVALID',
      `A release references at most ${MAX_RELEASE_MEDIA_IDS} media`
    );
  }

  const observed = new Map<string, Readonly<ManagedMediaPinnedEvidence>>();
  if (!ids.length) {
    return observed;
  }

  const namespace = await quietly(() => storage.namespace());
  if (!namespace) {
    return observed;
  }

  for (const mediaId of ids) {
    const pin = await quietly(() => storage.pinnedEvidence(organizationId, mediaId));
    if (!pin || pin.mediaId !== mediaId || pin.storageNamespace !== namespace) {
      continue;
    }

    const version = await quietly(() => storage.versionAt(pin.storageKey));
    if (version && version === pin.storageVersion) {
      observed.set(
        mediaId,
        Object.freeze({
          mediaId: pin.mediaId,
          evidenceId: pin.evidenceId,
          sha256: pin.sha256,
          byteLength: pin.byteLength,
          mimeType: pin.mimeType,
          storageKey: pin.storageKey,
          storageNamespace: pin.storageNamespace,
          storageVersion: pin.storageVersion,
        })
      );
    }
  }

  // keys that resolve in another namespace by now prove nothing about any
  return (await quietly(() => storage.namespace())) === namespace
    ? observed
    : new Map();
}

// the revision record is the one the managed post is at
function snapshotMatches(snapshot: ManagedPostSnapshot, managed: ManagedPostRow) {
  return (
    snapshot.managedPostId === managed.id &&
    snapshot.revision === managed.revision &&
    snapshot.group === managed.group &&
    snapshot.integrationId === managed.integrationId &&
    snapshot.bindingGeneration === managed.bindingGeneration &&
    isPlainObject(snapshot.settings) &&
    snapshot.members.length >= 1 &&
    snapshot.members.length <= MANAGED_LIFECYCLE_LIMITS.members &&
    snapshot.members.every(
      (member, position) =>
        member.position === position &&
        Array.isArray(member.media) &&
        member.media.length <= MANAGED_LIFECYCLE_LIMITS.mediaPerMember &&
        member.media.every((ref, index) => ref.position === index)
    )
  );
}

// The live member rows, in member order, once they are the rows the revision
// bound in the state the last authorized write left them in
function liveMembers(
  managed: ManagedPostRow,
  snapshot: ManagedPostSnapshot,
  rows: PostRow[]
): PostRow[] {
  const ordered = orderRows(rows);
  const root = ordered[0];
  if (!root || root.parentPostId) {
    throw refuse('POST_DRIFTED', 'The root row of the post is missing');
  }

  if (root.deletedAt) {
    throw refuse('POST_DELETED', 'The post was deleted');
  }

  if (rowFingerprint(rows) !== managed.rowFingerprint) {
    throw refuse(
      'POST_DRIFTED',
      'The rows of the post were changed outside the managed API'
    );
  }

  const retired = new Set(
    (snapshot.retiredMembers || []).map((member) => member.postId)
  );
  const live = ordered.filter((row) => !row.deletedAt);
  if (
    ordered.some((row) => row.deletedAt && !retired.has(row.id)) ||
    live.length !== snapshot.members.length
  ) {
    throw refuse('POST_DRIFTED', 'The member rows are not the revision members');
  }

  live.forEach((row, position) => {
    const member = snapshot.members[position];
    const parentPostId = position ? live[position - 1].id : null;
    if (
      row.id !== member.postId ||
      row.parentPostId !== parentPostId ||
      member.parentPostId !== parentPostId ||
      row.integrationId !== managed.integrationId ||
      row.content !== member.content ||
      row.delay !== member.delay
    ) {
      throw refuse(
        'POST_DRIFTED',
        `members[${position}] is not the member the revision bound`
      );
    }

    if (!RELEASABLE_ROW_STATES.includes(row.state)) {
      throw refuse(
        'LIFECYCLE_STATE_CONFLICT',
        `members[${position}] is in a state no release is made from`
      );
    }
  });

  return live;
}

// The channel as recorded at this read, never reconciled: the order of
// ManagedService.channelGate, plus a refresh that is needed
function channelRefusal(
  managed: ManagedPostRow,
  integration: IntegrationIdentity | null,
  binding: BindingRow | null
) {
  if (!integration) {
    return refuse('CHANNEL_UNAVAILABLE', 'The channel no longer exists');
  }

  if (!binding || binding.integrationId !== integration.id) {
    return refuse('CHANNEL_NOT_QUALIFIED', 'This channel has not been qualified');
  }

  if (
    binding.status === 'PAUSED_IDENTITY_CHANGED' ||
    binding.identityFingerprint !== identityFingerprint(integration) ||
    binding.providerIdentifier !== integration.providerIdentifier
  ) {
    return refuse(
      'CHANNEL_IDENTITY_CHANGED',
      'The recorded identity of this channel changed; it must be qualified again'
    );
  }

  if (
    integration.deletedAt ||
    integration.disabled ||
    integration.inBetweenSteps ||
    integration.refreshNeeded
  ) {
    return refuse(
      'CHANNEL_UNAVAILABLE',
      'The channel is deleted, disabled, unfinished or needs a refresh'
    );
  }

  if (binding.status !== 'QUALIFIED') {
    return refuse('CHANNEL_NOT_QUALIFIED', 'This channel has not been qualified');
  }

  if (binding.generation !== managed.bindingGeneration) {
    return refuse(
      'BINDING_GENERATION_MISMATCH',
      `The binding is at generation ${binding.generation}`
    );
  }

  return null;
}

// Every live row holds exactly the approved settings and the server's __type
function checkRowSettings(
  live: PostRow[],
  providerIdentifier: string,
  settings: Record<string, any>
) {
  const approved = canonicalJson(settings);
  live.forEach((row, position) => {
    let stored: unknown = null;
    try {
      stored = JSON.parse(row.settings ?? '');
    } catch {
      stored = null;
    }

    if (!isPlainObject(stored) || stored.__type !== providerIdentifier) {
      throw refuse(
        'POST_DRIFTED',
        `members[${position}] does not hold the channel's settings`
      );
    }

    const rest = { ...stored };
    delete rest.__type;
    if (canonicalJson(rest) !== approved) {
      throw refuse(
        'POST_DRIFTED',
        `members[${position}] does not hold the settings the revision bound`
      );
    }
  });
}

// The approved settings against the provider settings DTO the editor uses, as
// ManagedService.settingsRefusal: unknown fields refused, {} without a DTO
async function settingsRefusal(
  providerIdentifier: string,
  settings: Record<string, any>
) {
  if (
    '__type' in settings ||
    Buffer.byteLength(JSON.stringify(settings)) > MAX_SETTINGS_BYTES
  ) {
    return refuse('POST_NOT_SCHEDULABLE', 'The approved settings are not valid');
  }

  const dto = allProviders().find(
    (provider) => provider.name === providerIdentifier
  )?.value;
  if (!dto) {
    return Object.keys(settings).length
      ? refuse('POST_NOT_SCHEDULABLE', `${providerIdentifier} channels take no settings`)
      : null;
  }

  const errors = await validate(plainToInstance(dto, settings), {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  return errors.length
    ? refuse(
        'POST_NOT_SCHEDULABLE',
        `The approved settings are invalid for ${providerIdentifier}: ${errors
          .map((error) => error.property)
          .join(', ')
          .slice(0, 300)}`
      )
    : null;
}

// One media or cover exactly as the revision recorded it, the database holds
// it now and the storage observation found it pinned
function pinOf(
  recorded: ManagedEvidenceView,
  found: Map<string, MediaWithEvidence>,
  observed: ManagedReleaseObservedMedia
): ManagedMediaPin {
  const entry = found.get(recorded.mediaId);
  const evidence = entry?.evidence;
  const pinned = observed.get(recorded.mediaId);
  if (
    !entry ||
    entry.media.status !== 'ready' ||
    !evidence ||
    evidence.mediaId !== recorded.mediaId ||
    evidence.id !== recorded.evidenceId ||
    evidence.sha256 !== recorded.sha256 ||
    evidence.byteLength !== recorded.byteLength ||
    evidence.mimeType !== recorded.mimeType ||
    !pinned ||
    pinned.evidenceId !== evidence.id ||
    pinned.sha256 !== evidence.sha256 ||
    pinned.byteLength !== evidence.byteLength ||
    pinned.mimeType !== evidence.mimeType ||
    pinned.storageKey !== evidence.storageKey ||
    pinned.storageNamespace !== evidence.storageNamespace ||
    pinned.storageVersion !== evidence.storageVersion
  ) {
    throw refuse(
      'MEDIA_NOT_CURRENT',
      `Media ${recorded.mediaId} is not the pinned object the revision bound`
    );
  }

  if (
    !(MANAGED_MEDIA_CAPABILITY_TYPES as readonly string[]).includes(evidence.mimeType) ||
    evidence.byteLength < 1 ||
    evidence.byteLength > managedMediaCapabilityMaxBytes()
  ) {
    throw refuse(
      'MEDIA_DELIVERY_NOT_QUALIFIED',
      `Media ${recorded.mediaId} has a type or size the media delivery does not take`
    );
  }

  return {
    mediaId: evidence.mediaId,
    evidenceId: evidence.id,
    sha256: evidence.sha256,
    byteLength: evidence.byteLength,
    mimeType: evidence.mimeType,
  };
}

// the options W&W approved, under the rules the draft took them with and the
// ones the contract answers
function optionsRefusal(
  ref: ManagedMediaRefView,
  media: ManagedMediaPin,
  cover: ManagedMediaPin | null
): boolean {
  const timestamp = ref.thumbnailTimestampMs;
  return !!(
    (ref.alt !== undefined &&
      (typeof ref.alt !== 'string' ||
        !ref.alt.length ||
        ref.alt.length > MANAGED_ALT_MAX_LENGTH ||
        !ALT.test(ref.alt))) ||
    (timestamp !== undefined &&
      (!Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        timestamp > MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS)) ||
    (cover && timestamp !== undefined) ||
    ((cover || timestamp !== undefined) && !media.mimeType.startsWith('video/')) ||
    (cover && !THUMBNAIL_MIME_TYPES.includes(cover.mimeType))
  );
}

// The Post.image the row holds is the one managed.service.ts writes for these
// references: the media's own stored paths and the approved options, nothing a
// caller supplied. A path is only compared, never used
function imageMatches(
  row: PostRow,
  refs: ManagedMediaRefView[],
  found: Map<string, MediaWithEvidence>
) {
  let image: unknown = null;
  try {
    image = JSON.parse(row.image ?? '');
  } catch {
    return false;
  }

  return (
    Array.isArray(image) &&
    image.length === refs.length &&
    refs.every((ref, index) => {
      const item = image[index];
      return (
        isPlainObject(item) &&
        Object.keys(item).every((key) => IMAGE_KEYS.includes(key)) &&
        item.id === ref.mediaId &&
        typeof item.name === 'string' &&
        item.path === found.get(ref.mediaId)?.media.path &&
        item.alt === ref.alt &&
        item.thumbnail ===
          (ref.thumbnail ? found.get(ref.thumbnail.mediaId)?.media.path : undefined) &&
        item.thumbnailTimestamp === ref.thumbnailTimestampMs
      );
    })
  );
}

// The release of the current revision, or a ManagedLifecycleException. The
// same call serves the preview, request acceptance and dispatcher admission;
// each compares what it bound (revision, binding generation, release hash)
// with the answer
export async function buildManagedRelease(
  reader: ManagedReader,
  request: ManagedReleaseRequest
): Promise<ManagedReleaseBuild> {
  if (
    typeof request.managedPostId !== 'string' ||
    !MANAGED_LIFECYCLE_UUID.test(request.managedPostId) ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 1 ||
    !(request.observedMedia instanceof Map)
  ) {
    throw refuse('LIFECYCLE_INPUT_INVALID', 'The release request is not valid');
  }

  const managed = await reader.getManagedPost(request.managedPostId);
  if (!managed) {
    throw refuse('NOT_FOUND', 'Managed post not found');
  }

  if (managed.revision !== request.expectedRevision) {
    throw refuse(
      'REVISION_CONFLICT',
      `The post is at revision ${managed.revision}; only the current revision is released`
    );
  }

  const revision = await reader.getRevision(managed.id, managed.revision);
  const snapshot = revision ? parseSnapshot(revision.snapshot) : null;
  if (!snapshot || !snapshotMatches(snapshot, managed)) {
    throw refuse(
      'POST_DRIFTED',
      'The current revision record does not match the managed post'
    );
  }

  const live = liveMembers(
    managed,
    snapshot,
    await reader.getPostRows([managed.group])
  );

  const integration = await reader.getIntegration(managed.integrationId);
  const binding = await reader.getBinding(managed.integrationId);
  const channel = channelRefusal(managed, integration, binding);
  if (channel) {
    throw channel;
  }

  checkRowSettings(live, integration.providerIdentifier, snapshot.settings);

  const provider = request.provider;
  if (!provider || provider.identifier !== integration.providerIdentifier) {
    throw refuse(
      'PROVIDER_NOT_QUALIFIED',
      `No lifecycle adapter is declared for ${integration.providerIdentifier}`
    );
  }

  // the real strict decoder, with the adapter's own editor, before anything
  // can be accepted or admitted
  const texts = live.map((row) => {
    try {
      return decodeManagedPublicationText({
        codec: request.codec,
        content: row.content,
        editor: provider.editor as ManagedPublicationTextInput['editor'],
      });
    } catch (err) {
      if (err instanceof ManagedPublicationTextError) {
        throw lifecycleTextException(err);
      }
      throw err;
    }
  });

  if (!lifecycleProviderEligible(provider, request.mediaDeliveryReady)) {
    throw refuse(
      'PROVIDER_NOT_QUALIFIED',
      `The adapter of ${integration.providerIdentifier} is not qualified for this runtime`
    );
  }

  const invalidSettings = await settingsRefusal(
    integration.providerIdentifier,
    snapshot.settings
  );
  if (invalidSettings) {
    throw invalidSettings;
  }

  const refs = snapshot.members.map((member) => member.media);
  if (provider.requiresMedia && !refs[0].length) {
    throw refuse(
      'POST_NOT_SCHEDULABLE',
      `${integration.providerIdentifier} does not publish a post without media`
    );
  }

  if (refs.some((media) => media.length) && !request.mediaDeliveryReady) {
    throw refuse(
      'MEDIA_DELIVERY_NOT_QUALIFIED',
      'Media delivery is not configured for this runtime'
    );
  }

  const found = new Map(
    (await reader.getMediaWithEvidence(snapshotMediaIds(snapshot))).map(
      (entry) => [entry.media.id, entry]
    )
  );

  const media = refs.map((member, position) =>
    member.map((ref) => {
      const pin = pinOf(ref, found, request.observedMedia);
      const cover = ref.thumbnail
        ? pinOf(ref.thumbnail, found, request.observedMedia)
        : null;
      if (optionsRefusal(ref, pin, cover)) {
        throw refuse(
          'POST_NOT_SCHEDULABLE',
          `members[${position}].media[${ref.position}] has options a release cannot carry`
        );
      }

      return { ref, pin, cover };
    })
  );

  live.forEach((row, position) => {
    if (!imageMatches(row, refs[position], found)) {
      throw refuse(
        'POST_DRIFTED',
        `members[${position}] does not hold the media the revision bound`
      );
    }
  });

  const unhashed = {
    version: MANAGED_LIFECYCLE_VERSION,
    hashVersion: MANAGED_RELEASE_HASH_VERSION,
    managedPostId: managed.id,
    revision: managed.revision,
    bindingGeneration: binding.generation,
    integrationId: integration.id,
    providerIdentifier: integration.providerIdentifier,
    identityFingerprint: binding.identityFingerprint,
    codec: request.codec,
    settingsHash: fingerprint(snapshot.settings),
    members: live.map((row, position) => ({
      position,
      delay: row.delay,
      content: row.content,
      text: texts[position],
      media: media[position].map(({ ref, pin, cover }) => ({
        position: ref.position,
        mediaId: pin.mediaId,
        evidenceId: pin.evidenceId,
        sha256: pin.sha256,
        byteLength: pin.byteLength,
        mimeType: pin.mimeType,
        alt: ref.alt ?? null,
        thumbnail: cover
          ? {
              mediaId: cover.mediaId,
              evidenceId: cover.evidenceId,
              sha256: cover.sha256,
              byteLength: cover.byteLength,
              mimeType: cover.mimeType,
            }
          : null,
        thumbnailTimestampMs: ref.thumbnailTimestampMs ?? null,
      })),
    })),
  };

  // releaseHashInput never reads releaseHash
  const releaseHash = fingerprint(
    releaseHashInput(unhashed as ManagedReleasePreview)
  );
  const preview = parseManagedLifecycleResponse('RELEASE_PREVIEW', {
    ...unhashed,
    releaseHash,
  });
  if (!preview) {
    throw refuse(
      'LIFECYCLE_NOT_AVAILABLE',
      `The release does not fit the lifecycle contract: ${managedLifecycleIssues(
        'RELEASE_PREVIEW',
        { ...unhashed, releaseHash }
      )
        .join('; ')
        .slice(0, 300)}`
    );
  }

  const release: ManagedPreparedRelease = {
    managedPostId: preview.managedPostId,
    revision: preview.revision,
    bindingGeneration: preview.bindingGeneration,
    integrationId: preview.integrationId,
    providerIdentifier: preview.providerIdentifier,
    identityFingerprint: preview.identityFingerprint,
    codec: preview.codec,
    settingsHash: preview.settingsHash,
    releaseHash: preview.releaseHash,
    rowFingerprint: managed.rowFingerprint,
    internalId: integration.internalId,
    profile: integration.profile,
    settings: snapshot.settings,
    members: live.map((row, position) => ({
      postId: row.id,
      position,
      delay: row.delay,
      text: texts[position],
      media: media[position].map(({ ref, pin, cover }) => ({
        pin,
        alt: ref.alt ?? null,
        thumbnail: cover,
        thumbnailTimestampMs: ref.thumbnailTimestampMs ?? null,
      })),
    })),
  };

  return { preview: frozen(preview), release: frozen(release) };
}

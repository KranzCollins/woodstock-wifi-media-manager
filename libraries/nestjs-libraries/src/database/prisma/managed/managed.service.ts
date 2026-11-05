import { HttpException, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import striptags from 'striptags';
import { sanitizePostContent } from '@gitroom/helpers/utils/sanitize.post.content';
import { allProviders } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings';
import {
  ManagedMediaObservation,
  ManagedMediaObservationReason,
  ManagedMediaService,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import {
  BindingRow,
  IntegrationIdentity,
  ManagedPostRow,
  ManagedReader,
  ManagedRepository,
  ManagedTx,
  MediaWithEvidence,
  PostRow,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import {
  ManagedBadRequestException,
  ManagedConflictException,
  ManagedNotFoundException,
  ManagedUnprocessableException,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';
import { sha256Hex } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  CreateManagedDraftDto,
  EditManagedDraftDto,
  MANAGED_ALT_MAX_LENGTH,
  MANAGED_OPERATION_KEY,
  MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS,
  QualifyManagedChannelDto,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';

const MAX_SETTINGS_BYTES = 32 * 1024;
const MIN_PUBLISH_DATE = Date.UTC(2000, 0, 1);
const MAX_PUBLISH_DATE = Date.UTC(2100, 0, 1);

// a cover is a JPEG or PNG picture of a video (the upstream editor's and
// providers' rule)
const THUMBNAIL_MIME_TYPES = ['image/jpeg', 'image/png'];

// The escapes the editor sanitizer's serializer makes in text (DOMPurify ->
// jsdom -> parse5 -> entities escapeText): & < > and U+00A0 only. Quotes stay
// literal, and so does a newline
const PLAIN_TEXT_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '\u{a0}': '&nbsp;',
};

// members × media per member × (media + its cover): every identity one
// current-media observation may read
const MAX_OBSERVED_IDENTITIES = 20 * 10 * 2;

// The recorded size of the distinct objects one observation may read in
// total, refused before any storage call, and how long its reads may take.
// One observation per organization runs at a time, in this process only:
// each backend host behind a load balancer allows its own
const MAX_OBSERVED_BYTES = 256 * 1024 * 1024;
const OBSERVATION_DEADLINE_MS = 45 * 1000;

// GET /managed/v1/capabilities: what this server accepts, under one fixed
// version W&W pins. The content codecs are checked, vector by vector, against
// the real sanitizer in canonical.caption.vectors.json. The server never
// encodes or rewrites content: it only accepts a sanitizer fixed point.
// v2: no codec is recommended for publication any more (v1 recommended the
// paragraph form); draft storage and review are declared on their own
export const MANAGED_CAPABILITIES = {
  version: 'ww-managed-capabilities-v2',
  posts: {
    states: ['DRAFT'],
    edit: {
      expectedRevision: true,
      members: {
        min: 1,
        max: 20,
        addChildren: true,
        removeChildren: true,
        // the root and every kept child keep their row id and position;
        // added members are appended, removed ones are taken from the end
        identity: 'POSITIONAL',
        retirement: 'SOFT_DELETED_UNLINKED_RETAINED',
      },
    },
    media: {
      maxPerMember: 10,
      options: {
        alt: { maxLength: MANAGED_ALT_MAX_LENGTH, controlCharacters: false },
        thumbnail: {
          appliesTo: 'video/*',
          mimeTypes: THUMBNAIL_MIME_TYPES,
          proof: 'SAME_AS_MEDIA',
        },
        thumbnailTimestampMs: {
          min: 0,
          max: MANAGED_THUMBNAIL_TIMESTAMP_MAX_MS,
          appliesTo: 'video/*',
          frameBounds: 'UNQUALIFIED_DURATION_UNKNOWN',
        },
        mutuallyExclusive: [['thumbnail', 'thumbnailTimestampMs']],
        // a request without options keeps its earlier payload hash
        absentOptionsInPayloadHash: false,
      },
    },
    operationStatus: {
      path: '/managed/v1/operations/:operationKey',
      scope: 'posts:read',
      statuses: ['ABSENT', 'COMMITTED'],
      acks: ['CURRENT', 'HISTORICAL'],
    },
    // GET /posts/:id answers what the database recorded at the revision and
    // never calls storage; this is the fresh, read-only look at the objects
    mediaObservation: {
      path: '/managed/v1/posts/:managedPostId/media-observation?revision=',
      scope: 'posts:read',
      revision: 'CURRENT_ONLY',
      read: 'PRIVATE_STORAGE_BY_PINNED_KEY_AND_NAMESPACE',
      maxIdentities: MAX_OBSERVED_IDENTITIES,
      maxRecordedBytes: MAX_OBSERVED_BYTES,
      deadlineMs: OBSERVATION_DEADLINE_MS,
      inFlight: 'ONE_PER_ORGANIZATION_PER_PROCESS',
      writes: 'NONE',
      statuses: [
        'VERIFIED',
        'UNVERIFIED',
        'NO_MEDIA_REFERENCED',
        'INDETERMINATE',
      ],
    },
  },
  content: {
    gate: 'SANITIZE_POST_CONTENT_FIXED_POINT',
    vectors: 'ww-canonical-caption-vectors-v1',
    // Managed posts stay DRAFT. Neither codec survives the converter Postiz
    // runs before a provider (stripHtmlValidation) exactly, so neither is
    // qualified to publish the reviewed text; see each codec's
    // publicationDefects. Only the 'normal' mode was checked against vectors
    publication: {
      qualified: false,
      converter: 'stripHtmlValidation',
      checkedModes: ['normal'],
    },
    codecs: [
      {
        id: 'ww-plain-escape-v1',
        form: 'TAGLESS',
        escapes: PLAIN_TEXT_ESCAPES,
        quotes: 'LITERAL',
        newlines: 'LITERAL_LF',
        refusedInput: ['U+000D', 'U+0000', 'LONE_SURROGATE'],
        sanitizerFixedPoint: true,
        // DOMPurify returns a value without "<" unparsed, so the gate cannot
        // tell escaped text from unescaped text in this form
        gateRefusesUnescapedText: false,
        // postContentPlainText gives back exactly the encoded plain text
        reviewText: 'EXACT',
        // stored as sent, but the gate cannot catch a missing escape
        draftStorage: 'ACCEPTED_UNCHECKED_ESCAPES',
        // stripHtmlValidation('normal') returns HTML without <p> as it is:
        // a provider would receive the entities, not the characters
        providerText: 'ENTITIES_NOT_DECODED',
        publication: 'NOT_QUALIFIED',
        publicationDefects: ['ENTITIES_REACH_PROVIDER_ENCODED'],
      },
      {
        id: 'ww-plain-paragraph-escape-v1',
        form: 'ONE_PARAGRAPH',
        wrapper: ['<p>', '</p>'],
        escapes: PLAIN_TEXT_ESCAPES,
        quotes: 'LITERAL',
        newlines: 'LITERAL_LF',
        refusedInput: ['U+000D', 'U+0000', 'LONE_SURROGATE'],
        sanitizerFixedPoint: true,
        // parsed, so an unescaped & (not a reference), > or U+00A0 changes
        // and is refused; a literal "&amp;" can never be told from "&"
        gateRefusesUnescapedText: true,
        reviewText: 'EXACT',
        // the form to store drafts in: the gate refuses an unescaped & > or
        // U+00A0
        draftStorage: 'RECOMMENDED',
        // decoded; U+00A0 reaches a provider as a plain space (upstream)
        providerText: 'DECODED_NBSP_AS_SPACE',
        publication: 'NOT_QUALIFIED',
        // upstream decodes &amp; before &lt; / &gt;, so text that reads
        // "&lt;b&gt;" reaches a provider as "<b>"
        publicationDefects: [
          'NBSP_REACHES_PROVIDER_AS_SPACE',
          'LITERAL_ENTITY_TEXT_DECODED_TWICE',
        ],
      },
    ],
  },
} as const;

export interface ManagedEvidenceView {
  mediaId: string;
  evidenceId: string;
  sha256: string;
  byteLength: number;
  mimeType: string | null;
  method: string;
}

export interface ManagedMediaRefView extends ManagedEvidenceView {
  position: number;
  // the options W&W sent; each key is only present when it was sent
  alt?: string;
  thumbnail?: ManagedEvidenceView;
  thumbnailTimestampMs?: number;
  // the offset is kept as sent: the server does not know the video's length
  thumbnailTimestampBounds?: 'UNQUALIFIED_DURATION_UNKNOWN';
}

export interface ManagedMemberView {
  postId: string;
  position: number;
  role: 'ROOT' | 'CHILD';
  parentPostId: string | null;
  content: string;
  delay: number;
  media: ManagedMediaRefView[];
}

// a child row an edit removed; the row is kept (soft-deleted), never reused
export interface ManagedRetiredMemberView {
  postId: string;
  position: number;
  retiredAtRevision: number;
}

// What a revision bound: stored whole in ManagedPostRevision and in the
// POST_CREATED / POST_REVISED feed events
export interface ManagedPostSnapshot {
  managedPostId: string;
  group: string;
  integrationId: string;
  revision: number;
  bindingGeneration: number;
  state: 'DRAFT';
  intendedPublishDate: string;
  settings: Record<string, any>;
  members: ManagedMemberView[];
  // every child retired up to this revision; absent while there is none
  retiredMembers?: ManagedRetiredMemberView[];
  operationKey: string;
  payloadHash: string;
  sequence: number;
  revisedAt: string;
}

export interface ManagedWriteResult {
  managedPostId: string;
  revision: number;
  sequence: number;
  operationKey: string;
  payloadHash: string;
  replayed: boolean;
  post: ManagedPostSnapshot;
}

export interface ManagedChannelView {
  integrationId: string;
  providerIdentifier: string;
  displayName: string;
  socialIdentity: { internalId: string; profile: string | null };
  identityFingerprint: string;
  connection: {
    disabled: boolean;
    refreshNeeded: boolean;
    inBetweenSteps: boolean;
    deleted: boolean;
  };
  binding: {
    generation: number;
    status: string;
    identityFingerprint: string;
    boundIdentity: {
      providerIdentifier: string;
      internalId: string;
      profile: string | null;
    };
    qualifiedAt: Date | null;
    pausedAt: Date | null;
  };
  identityEvidence: 'RECORDED_IN_POSTIZ_NOT_UPSTREAM_VERIFIED';
}

// One media or cover a member of the observed revision references, with the
// evidence that revision recorded for it and what a fresh read found
export interface ManagedMediaIdentityObservation {
  memberPosition: number;
  mediaPosition: number;
  role: 'MEDIA' | 'THUMBNAIL';
  mediaId: string;
  evidenceId: string;
  sha256: string;
  byteLength: number;
  mimeType: string | null;
  status: 'VERIFIED' | 'UNVERIFIED';
  // only present when UNVERIFIED
  reason?: ManagedMediaObservationReason;
  observedAt: string;
}

// OBSERVATION_DEADLINE_EXCEEDED / OBSERVATION_CANCELLED: the reads were
// stopped (deadline, or the client went away) before they all finished
export type ManagedMediaObservationChange =
  | 'POST_CHANGED_DURING_OBSERVATION'
  | 'BINDING_CHANGED_DURING_OBSERVATION'
  | 'MEDIA_RECORD_CHANGED_DURING_OBSERVATION'
  | 'OBSERVATION_DEADLINE_EXCEEDED'
  | 'OBSERVATION_CANCELLED';

interface ManagedMediaObservationBase {
  managedPostId: string;
  revision: number;
  observation: 'PRIVATE_STORAGE_READ_BY_PINNED_KEY';
  startedAt: string;
  finishedAt: string;
  // the generation the revision bound, and the binding as read at the start
  binding: {
    atRevisionGeneration: number;
    generation: number | null;
    status: string | null;
  };
}

// GET /managed/v1/posts/:managedPostId/media-observation. VERIFIED: every
// identity is the pinned object at the recorded version with the recorded
// bytes, and the rows are the ones the revision bound. INDETERMINATE: the
// post, its binding or a media record changed while storage was read, so
// nothing is claimed about any identity
export type ManagedMediaObservationResult =
  | (ManagedMediaObservationBase & {
      status: 'VERIFIED' | 'UNVERIFIED' | 'NO_MEDIA_REFERENCED';
      reasons: ('MEDIA_UNVERIFIED' | 'ROWS_DRIFTED')[];
      rows: 'CONSISTENT' | 'DRIFTED';
      media: ManagedMediaIdentityObservation[];
    })
  | (ManagedMediaObservationBase & {
      status: 'INDETERMINATE';
      reasons: ManagedMediaObservationChange[];
    });

interface NormalizedMediaRef {
  mediaId: string;
  sha256: string;
  // undefined (left out of the payload hash) when not sent
  alt?: string;
  thumbnail?: { mediaId: string; sha256: string };
  thumbnailTimestampMs?: number;
}

interface NormalizedDraft {
  intendedPublishDate: string;
  settings: Record<string, any>;
  members: {
    content: string;
    delay: number;
    media: NormalizedMediaRef[];
  }[];
}

type Outcome<T> = { ok: T } | { refused: HttpException };

// Keys sorted at every level, so the same payload always hashes the same
export function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function fingerprint(value: any) {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

// What Postiz recorded about the account behind an integration id. A change
// of any of these under the same id pauses the binding
export function identityFingerprint(integration: IntegrationIdentity) {
  return fingerprint({
    organizationId: integration.organizationId,
    integrationId: integration.id,
    providerIdentifier: integration.providerIdentifier,
    internalId: integration.internalId,
    rootInternalId: integration.rootInternalId,
    profile: integration.profile,
    deleted: !!integration.deletedAt,
  });
}

// root first, then each comment after its parent (the chain
// createOrUpdatePost builds); rows outside the chain (retired members, or
// drift) trail by id, so the order never depends on equal creation times
export function orderRows(rows: PostRow[]) {
  const ordered: PostRow[] = [];
  let current =
    rows.find((row) => !row.parentPostId && !row.deletedAt) ||
    rows.find((row) => !row.parentPostId);

  while (current && !ordered.includes(current)) {
    ordered.push(current);
    const parent: PostRow = current;
    current = rows.find((row) => row.parentPostId === parent.id);
  }

  return [
    ...ordered,
    ...rows
      .filter((row) => !ordered.includes(row))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  ];
}

export function rowFingerprint(rows: PostRow[]) {
  return fingerprint(
    orderRows(rows).map((row) => ({
      id: row.id,
      parentPostId: row.parentPostId,
      integrationId: row.integrationId,
      content: row.content,
      delay: row.delay,
      image: row.image,
      settings: row.settings,
      publishDate: new Date(row.publishDate).toISOString(),
      state: row.state,
      deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
    }))
  );
}

@Injectable()
export class ManagedService {
  // organizations with a media observation in flight in this process
  private observing = new Set<string>();

  constructor(
    private _managedRepository: ManagedRepository,
    private _managedMediaService: ManagedMediaService
  ) {}

  private unwrap<T>(outcome: Outcome<T>): T {
    if ('refused' in outcome) {
      throw outcome.refused;
    }

    return outcome.ok;
  }

  // The stored content is exactly what W&W reviewed: content the editor's
  // sanitizer would change (unsafe or non-canonical HTML) is refused as it
  // is, never rewritten behind W&W's back
  private normalizeDraft(
    body: CreateManagedDraftDto | EditManagedDraftDto
  ): NormalizedDraft {
    const date = new Date(body.intendedPublishDate);
    if (
      isNaN(date.getTime()) ||
      date.getTime() < MIN_PUBLISH_DATE ||
      date.getTime() >= MAX_PUBLISH_DATE
    ) {
      throw new ManagedBadRequestException('intendedPublishDate is invalid');
    }

    const settings = body.settings || {};
    if (Buffer.byteLength(JSON.stringify(settings)) > MAX_SETTINGS_BYTES) {
      throw new ManagedBadRequestException('settings are larger than 32 kB');
    }

    if ('__type' in settings) {
      throw new ManagedUnprocessableException(
        'SETTINGS_INVALID',
        'settings.__type is set by the server from the channel'
      );
    }

    for (const [position, member] of body.members.entries()) {
      if (sanitizePostContent(member.content) !== member.content) {
        throw new ManagedUnprocessableException(
          'CONTENT_NOT_CANONICAL',
          `members[${position}].content is not in the canonical form the Postiz editor stores (unsafe or normalized HTML); it was not changed or stored`
        );
      }

      if (!striptags(member.content).trim() && !member.media?.length) {
        throw new ManagedBadRequestException(
          `members[${position}] needs text or media`
        );
      }
    }

    return {
      intendedPublishDate: date.toISOString(),
      settings,
      members: body.members.map((member, position) => ({
        content: member.content,
        delay: member.delay ?? 0,
        media: (member.media || []).map((ref, index) => {
          const thumbnailTimestampMs = ref.thumbnailTimestampMs ?? undefined;
          if (ref.thumbnail && thumbnailTimestampMs !== undefined) {
            throw new ManagedBadRequestException(
              `members[${position}].media[${index}]: thumbnail and thumbnailTimestampMs are mutually exclusive`
            );
          }

          return {
            mediaId: ref.mediaId,
            sha256: ref.sha256.toLowerCase(),
            alt: ref.alt ?? undefined,
            thumbnail: ref.thumbnail
              ? {
                  mediaId: ref.thumbnail.mediaId,
                  sha256: ref.thumbnail.sha256.toLowerCase(),
                }
              : undefined,
            thumbnailTimestampMs,
          };
        }),
      })),
    };
  }

  // Validated against the same provider settings DTO the Postiz editor uses
  // (no provider is called), and stricter: unknown fields are refused, and a
  // provider without a settings DTO only takes {}
  private async settingsRefusal(
    providerIdentifier: string,
    settings: Record<string, any>
  ): Promise<HttpException | null> {
    const dto = allProviders().find(
      (provider) => provider.name === providerIdentifier
    )?.value;

    if (!dto) {
      return Object.keys(settings).length
        ? new ManagedUnprocessableException(
            'SETTINGS_INVALID',
            `${providerIdentifier} channels take no settings`
          )
        : null;
    }

    const errors = await validate(plainToInstance(dto, settings), {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });

    return errors.length
      ? new ManagedUnprocessableException(
          'SETTINGS_INVALID',
          `settings are invalid for ${providerIdentifier}: ${errors
            .map((error) => error.property)
            .join(', ')
            .slice(0, 500)}`
        )
      : null;
  }

  // A recorded identity that no longer matches pauses the binding with a new
  // generation; only an explicit qualify lifts it
  private async reconcileBinding(
    tx: ManagedTx,
    integration: IntegrationIdentity
  ): Promise<BindingRow> {
    const current = identityFingerprint(integration);
    const binding = await tx.getBinding(integration.id);

    if (!binding) {
      const sequence = tx.nextSequence();
      const created = await tx.createBinding({
        integrationId: integration.id,
        generation: 1,
        status: 'PENDING_QUALIFICATION',
        providerIdentifier: integration.providerIdentifier,
        internalId: integration.internalId,
        profile: integration.profile,
        identityFingerprint: current,
        qualifiedAt: null,
        pausedAt: null,
      });

      await tx.appendEvent({
        sequence,
        kind: 'CHANNEL_BINDING_CREATED',
        entityType: 'CHANNEL',
        entityId: integration.id,
        revision: null,
        bindingGeneration: created.generation,
        operationKey: null,
        data: JSON.stringify({ identityFingerprint: current }),
      });

      return created;
    }

    if (
      binding.identityFingerprint === current ||
      binding.status === 'PAUSED_IDENTITY_CHANGED'
    ) {
      return binding;
    }

    const sequence = tx.nextSequence();
    const paused = await tx.updateBinding(binding.id, {
      status: 'PAUSED_IDENTITY_CHANGED',
      generation: binding.generation + 1,
      pausedAt: new Date(),
    });

    await tx.appendEvent({
      sequence,
      kind: 'CHANNEL_PAUSED_IDENTITY_CHANGED',
      entityType: 'CHANNEL',
      entityId: integration.id,
      revision: null,
      bindingGeneration: paused.generation,
      operationKey: null,
      data: JSON.stringify({
        boundIdentityFingerprint: binding.identityFingerprint,
        recordedIdentityFingerprint: current,
      }),
    });

    return paused;
  }

  private channelView(
    integration: IntegrationIdentity,
    binding: BindingRow
  ): ManagedChannelView {
    return {
      integrationId: integration.id,
      providerIdentifier: integration.providerIdentifier,
      displayName: integration.customName || integration.name,
      socialIdentity: {
        internalId: integration.internalId,
        profile: integration.profile,
      },
      identityFingerprint: identityFingerprint(integration),
      connection: {
        disabled: integration.disabled,
        refreshNeeded: integration.refreshNeeded,
        inBetweenSteps: integration.inBetweenSteps,
        deleted: !!integration.deletedAt,
      },
      binding: {
        generation: binding.generation,
        status: binding.status,
        identityFingerprint: binding.identityFingerprint,
        boundIdentity: {
          providerIdentifier: binding.providerIdentifier,
          internalId: binding.internalId,
          profile: binding.profile,
        },
        qualifiedAt: binding.qualifiedAt,
        pausedAt: binding.pausedAt,
      },
      identityEvidence: 'RECORDED_IN_POSTIZ_NOT_UPSTREAM_VERIFIED',
    };
  }

  async listChannels(organizationId: string) {
    return this._managedRepository.mutate(organizationId, async (tx) => {
      const bindings = await tx.getBindings();
      const integrations = await tx.getIntegrations(
        bindings.map((binding) => binding.integrationId)
      );

      const channels: ManagedChannelView[] = [];
      for (const integration of integrations) {
        channels.push(
          this.channelView(
            integration,
            await this.reconcileBinding(tx, integration)
          )
        );
      }

      return channels;
    });
  }

  async qualifyChannel(
    organizationId: string,
    credentialId: string,
    integrationId: string,
    body: QualifyManagedChannelDto
  ) {
    const outcome = await this._managedRepository.mutate(
      organizationId,
      async (tx): Promise<Outcome<ManagedChannelView>> => {
        const integration = await tx.getIntegration(integrationId);
        if (!integration) {
          return {
            refused: new ManagedUnprocessableException(
              'INTEGRATION_NOT_FOUND',
              'Channel not found in this organization'
            ),
          };
        }

        const binding = await this.reconcileBinding(tx, integration);
        if (binding.generation !== body.expectedGeneration) {
          return {
            refused: new ManagedConflictException(
              'BINDING_GENERATION_MISMATCH',
              `The binding is at generation ${binding.generation}`
            ),
          };
        }

        const current = identityFingerprint(integration);
        if (current !== body.identityFingerprint) {
          return {
            refused: new ManagedConflictException(
              'IDENTITY_FINGERPRINT_MISMATCH',
              'The recorded identity is not the one that was confirmed'
            ),
          };
        }

        const unusable = this.unusableChannel(integration);
        if (unusable) {
          return { refused: unusable };
        }

        const sequence = tx.nextSequence();
        const qualified = await tx.updateBinding(binding.id, {
          status: 'QUALIFIED',
          generation: binding.generation + 1,
          providerIdentifier: integration.providerIdentifier,
          internalId: integration.internalId,
          profile: integration.profile,
          identityFingerprint: current,
          qualifiedAt: new Date(),
          pausedAt: null,
        });

        await tx.appendEvent({
          sequence,
          kind: 'CHANNEL_QUALIFIED',
          entityType: 'CHANNEL',
          entityId: integration.id,
          revision: null,
          bindingGeneration: qualified.generation,
          operationKey: null,
          data: JSON.stringify({ identityFingerprint: current }),
        });

        return { ok: this.channelView(integration, qualified) };
      }
    );

    return this.unwrap(outcome);
  }

  // A channel in between steps still holds a placeholder internal id that
  // Postiz would rewrite later, and a disabled or deleted one is not in use:
  // none of them is an identity to bind or draft to
  private unusableChannel(integration: IntegrationIdentity) {
    if (
      integration.deletedAt ||
      integration.disabled ||
      integration.inBetweenSteps
    ) {
      return new ManagedConflictException(
        'CHANNEL_NOT_QUALIFIED',
        'A deleted, disabled or unfinished (in between steps) channel cannot be qualified or drafted to'
      );
    }

    return null;
  }

  private async channelGate(
    tx: ManagedTx,
    integration: IntegrationIdentity,
    expectedGeneration: number
  ): Promise<Outcome<BindingRow>> {
    const binding = await this.reconcileBinding(tx, integration);

    if (binding.status === 'PAUSED_IDENTITY_CHANGED') {
      return {
        refused: new ManagedConflictException(
          'CHANNEL_IDENTITY_CHANGED',
          'The recorded identity of this channel changed; it must be qualified again'
        ),
      };
    }

    const unusable = this.unusableChannel(integration);
    if (unusable) {
      return { refused: unusable };
    }

    if (binding.status !== 'QUALIFIED') {
      return {
        refused: new ManagedConflictException(
          'CHANNEL_NOT_QUALIFIED',
          'This channel has not been qualified'
        ),
      };
    }

    if (binding.generation !== expectedGeneration) {
      return {
        refused: new ManagedConflictException(
          'BINDING_GENERATION_MISMATCH',
          `The binding is at generation ${binding.generation}`
        ),
      };
    }

    return { ok: binding };
  }

  // a cover picture is media of its own and is proven the same way
  private mediaIds(draft: NormalizedDraft) {
    return [
      ...new Set(
        draft.members.flatMap((member) =>
          member.media.flatMap((m) =>
            m.thumbnail ? [m.mediaId, m.thumbnail.mediaId] : [m.mediaId]
          )
        )
      ),
    ];
  }

  private proofRefusal(
    found: Map<string, MediaWithEvidence>,
    current: Set<string>,
    ref: { mediaId: string; sha256: string }
  ) {
    const entry = found.get(ref.mediaId);
    if (!entry) {
      return new ManagedUnprocessableException(
        'MEDIA_NOT_FOUND',
        `Media ${ref.mediaId} does not exist in this organization`
      );
    }

    // processing / failed media can still be rewritten or is unusable
    if (entry.media.status !== 'ready') {
      return new ManagedUnprocessableException(
        'MEDIA_NOT_READY',
        `Media ${ref.mediaId} is not ready`
      );
    }

    if (!entry.evidence) {
      return new ManagedUnprocessableException(
        'MEDIA_PROOF_MISSING',
        `Media ${ref.mediaId} has no retained byte proof; supply a new authorized reserved upload`
      );
    }

    if (entry.evidence.sha256 !== ref.sha256) {
      return new ManagedUnprocessableException(
        'MEDIA_DIGEST_MISMATCH',
        `Media ${ref.mediaId} does not have the approved digest`
      );
    }

    // a remembered digest of the path is not proof of the bytes there now
    if (!current.has(entry.evidence.id)) {
      return new ManagedUnprocessableException(
        'MEDIA_PROOF_STALE',
        `The stored object of media ${ref.mediaId} cannot be matched to its retained private storage identity; recover the original storage binding before continuing`
      );
    }

    return null;
  }

  // a cover (picture or frame offset) only means something for a video, and
  // the type is the one proven with the bytes, never the file name
  private optionsRefusal(
    found: Map<string, MediaWithEvidence>,
    ref: NormalizedMediaRef
  ) {
    if (
      (ref.thumbnail || ref.thumbnailTimestampMs !== undefined) &&
      !found.get(ref.mediaId)!.evidence!.mimeType?.startsWith('video/')
    ) {
      return new ManagedUnprocessableException(
        'MEDIA_OPTIONS_INVALID',
        `Media ${ref.mediaId} is not a proven video; a thumbnail or thumbnailTimestampMs only applies to a video`
      );
    }

    if (
      ref.thumbnail &&
      !THUMBNAIL_MIME_TYPES.includes(
        found.get(ref.thumbnail.mediaId)!.evidence!.mimeType || ''
      )
    ) {
      return new ManagedUnprocessableException(
        'MEDIA_OPTIONS_INVALID',
        `The thumbnail ${ref.thumbnail.mediaId} is not a proven JPEG or PNG picture`
      );
    }

    return null;
  }

  // `current` holds the evidence ids whose storage version was checked
  // against the stored object just before this transaction
  private async resolveMedia(
    tx: ManagedReader,
    draft: NormalizedDraft,
    current: Set<string>
  ): Promise<Outcome<Map<string, MediaWithEvidence>>> {
    const ids = this.mediaIds(draft);
    const found = new Map(
      (await tx.getMediaWithEvidence(ids)).map((entry) => [
        entry.media.id,
        entry,
      ])
    );

    for (const member of draft.members) {
      for (const ref of member.media) {
        const refused =
          this.proofRefusal(found, current, ref) ||
          (ref.thumbnail
            ? this.proofRefusal(found, current, ref.thumbnail)
            : null) ||
          this.optionsRefusal(found, ref);
        if (refused) {
          return { refused };
        }
      }
    }

    return { ok: found };
  }

  // the Post.image shape the editor and the providers read ({ id, path, alt,
  // thumbnail, thumbnailTimestamp }, see manage.modal.tsx and MediaContent).
  // The library row's own thumbnail and alt are never used: only an option
  // W&W sent is written, and a key is only there when it was sent
  private imageJson(
    media: NormalizedMediaRef[],
    found: Map<string, MediaWithEvidence>
  ) {
    return JSON.stringify(
      media.map((ref) => {
        const row = found.get(ref.mediaId)!.media;
        return {
          id: row.id,
          name: row.name,
          path: row.path,
          ...(ref.alt !== undefined ? { alt: ref.alt } : {}),
          ...(ref.thumbnail
            ? { thumbnail: found.get(ref.thumbnail.mediaId)!.media.path }
            : {}),
          ...(ref.thumbnailTimestampMs !== undefined
            ? { thumbnailTimestamp: ref.thumbnailTimestampMs }
            : {}),
        };
      })
    );
  }

  private evidenceView(
    mediaId: string,
    media: Map<string, MediaWithEvidence>
  ): ManagedEvidenceView {
    const evidence = media.get(mediaId)!.evidence!;
    return {
      mediaId,
      evidenceId: evidence.id,
      sha256: evidence.sha256,
      byteLength: evidence.byteLength,
      mimeType: evidence.mimeType,
      method: evidence.method,
    };
  }

  private mediaRefView(
    ref: NormalizedMediaRef,
    position: number,
    media: Map<string, MediaWithEvidence>
  ): ManagedMediaRefView {
    return {
      position,
      ...this.evidenceView(ref.mediaId, media),
      ...(ref.alt !== undefined ? { alt: ref.alt } : {}),
      ...(ref.thumbnail
        ? { thumbnail: this.evidenceView(ref.thumbnail.mediaId, media) }
        : {}),
      ...(ref.thumbnailTimestampMs !== undefined
        ? {
            thumbnailTimestampMs: ref.thumbnailTimestampMs,
            thumbnailTimestampBounds: 'UNQUALIFIED_DURATION_UNKNOWN' as const,
          }
        : {}),
    };
  }

  private buildSnapshot(input: {
    managedPostId: string;
    group: string;
    integrationId: string;
    revision: number;
    bindingGeneration: number;
    draft: NormalizedDraft;
    // the current members as stored, in member order
    members: PostRow[];
    retiredMembers: ManagedRetiredMemberView[];
    media: Map<string, MediaWithEvidence>;
    operationKey: string;
    payloadHash: string;
    sequence: number;
  }): ManagedPostSnapshot {
    return {
      managedPostId: input.managedPostId,
      group: input.group,
      integrationId: input.integrationId,
      revision: input.revision,
      bindingGeneration: input.bindingGeneration,
      state: 'DRAFT',
      intendedPublishDate: input.draft.intendedPublishDate,
      settings: input.draft.settings,
      members: input.members.map((row, position) => ({
        postId: row.id,
        position,
        role: position === 0 ? ('ROOT' as const) : ('CHILD' as const),
        parentPostId: row.parentPostId,
        content: row.content,
        delay: row.delay,
        media: input.draft.members[position].media.map((ref, index) =>
          this.mediaRefView(ref, index, input.media)
        ),
      })),
      ...(input.retiredMembers.length
        ? { retiredMembers: input.retiredMembers }
        : {}),
      operationKey: input.operationKey,
      payloadHash: input.payloadHash,
      sequence: input.sequence,
      revisedAt: new Date().toISOString(),
    };
  }

  private writeResult(
    snapshot: ManagedPostSnapshot,
    replayed: boolean
  ): ManagedWriteResult {
    return {
      managedPostId: snapshot.managedPostId,
      revision: snapshot.revision,
      sequence: snapshot.sequence,
      operationKey: snapshot.operationKey,
      payloadHash: snapshot.payloadHash,
      replayed,
      post: snapshot,
    };
  }

  private async replay(
    tx: ManagedTx,
    operationKey: string,
    payloadHash: string
  ): Promise<Outcome<ManagedWriteResult> | null> {
    const operation = await tx.getOperation(operationKey);
    if (!operation) {
      return null;
    }

    if (operation.payloadHash !== payloadHash) {
      return {
        refused: new ManagedConflictException(
          'OPERATION_KEY_PAYLOAD_MISMATCH',
          'This operation key was already used with a different payload'
        ),
      };
    }

    const revision = await tx.getRevision(
      operation.managedPostId,
      operation.revision
    );

    return { ok: this.writeResult(JSON.parse(revision!.snapshot), true) };
  }

  private async commitRevision(
    tx: ManagedTx,
    credentialId: string,
    kind: 'CREATE_DRAFT' | 'EDIT_DRAFT',
    snapshot: ManagedPostSnapshot
  ) {
    const data = JSON.stringify(snapshot);

    await tx.createRevision({
      managedPostId: snapshot.managedPostId,
      revision: snapshot.revision,
      operationKey: snapshot.operationKey,
      payloadHash: snapshot.payloadHash,
      sequence: snapshot.sequence,
      snapshot: data,
    });

    await tx.createOperation({
      operationKey: snapshot.operationKey,
      kind,
      payloadHash: snapshot.payloadHash,
      managedPostId: snapshot.managedPostId,
      revision: snapshot.revision,
      sequence: snapshot.sequence,
      credentialId,
    });

    await tx.appendEvent({
      sequence: snapshot.sequence,
      kind: kind === 'CREATE_DRAFT' ? 'POST_CREATED' : 'POST_REVISED',
      entityType: 'MANAGED_POST',
      entityId: snapshot.managedPostId,
      revision: snapshot.revision,
      bindingGeneration: snapshot.bindingGeneration,
      operationKey: snapshot.operationKey,
      data,
    });
  }

  async createDraft(
    organizationId: string,
    credentialId: string,
    body: CreateManagedDraftDto
  ) {
    const draft = this.normalizeDraft(body);
    const payloadHash = fingerprint({
      kind: 'CREATE_DRAFT',
      integrationId: body.integrationId,
      expectedBindingGeneration: body.expectedBindingGeneration,
      ...draft,
    });
    const current = await this._managedMediaService.currentEvidence(
      organizationId,
      this.mediaIds(draft)
    );

    const outcome = await this._managedRepository.mutate(
      organizationId,
      async (tx): Promise<Outcome<ManagedWriteResult>> => {
        const replayed = await this.replay(tx, body.operationKey, payloadHash);
        if (replayed) {
          return replayed;
        }

        const integration = await tx.getIntegration(body.integrationId);
        if (!integration) {
          return {
            refused: new ManagedUnprocessableException(
              'INTEGRATION_NOT_FOUND',
              'Channel not found in this organization'
            ),
          };
        }

        const gate = await this.channelGate(
          tx,
          integration,
          body.expectedBindingGeneration
        );
        if ('refused' in gate) {
          return gate;
        }

        const invalidSettings = await this.settingsRefusal(
          integration.providerIdentifier,
          draft.settings
        );
        if (invalidSettings) {
          return { refused: invalidSettings };
        }

        const media = await this.resolveMedia(tx, draft, current);
        if ('refused' in media) {
          return media;
        }

        const sequence = tx.nextSequence();
        const managedPostId = uuidv4();
        const group = uuidv4();
        const settings = JSON.stringify({
          ...draft.settings,
          __type: integration.providerIdentifier,
        });

        const rows: PostRow[] = [];
        for (const member of draft.members) {
          rows.push(
            await tx.createPostRow({
              group,
              integrationId: integration.id,
              parentPostId: rows[rows.length - 1]?.id ?? null,
              content: member.content,
              delay: member.delay,
              image: this.imageJson(member.media, media.ok),
              settings,
              publishDate: new Date(draft.intendedPublishDate),
            })
          );
        }

        const snapshot = this.buildSnapshot({
          managedPostId,
          group,
          integrationId: integration.id,
          revision: 1,
          bindingGeneration: gate.ok.generation,
          draft,
          members: rows,
          retiredMembers: [],
          media: media.ok,
          operationKey: body.operationKey,
          payloadHash,
          sequence,
        });

        await tx.createManagedPost({
          id: managedPostId,
          integrationId: integration.id,
          group,
          revision: 1,
          bindingGeneration: gate.ok.generation,
          rowFingerprint: rowFingerprint(rows),
          lastSequence: sequence,
          createdOperationKey: body.operationKey,
          lastOperationKey: body.operationKey,
        });

        await this.commitRevision(tx, credentialId, 'CREATE_DRAFT', snapshot);

        return { ok: this.writeResult(snapshot, false) };
      }
    );

    return this.unwrap(outcome);
  }

  // One atomic replacement of caption / media / settings / intended date on
  // the same rows, only from the revision the caller saw
  async editDraft(
    organizationId: string,
    credentialId: string,
    managedPostId: string,
    body: EditManagedDraftDto
  ) {
    const draft = this.normalizeDraft(body);
    const payloadHash = fingerprint({
      kind: 'EDIT_DRAFT',
      managedPostId,
      expectedRevision: body.expectedRevision,
      expectedBindingGeneration: body.expectedBindingGeneration,
      ...draft,
    });
    const current = await this._managedMediaService.currentEvidence(
      organizationId,
      this.mediaIds(draft)
    );

    const outcome = await this._managedRepository.mutate(
      organizationId,
      async (tx): Promise<Outcome<ManagedWriteResult>> => {
        const replayed = await this.replay(tx, body.operationKey, payloadHash);
        if (replayed) {
          return replayed;
        }

        const managed = await tx.getManagedPost(managedPostId);
        if (!managed) {
          return {
            refused: new ManagedNotFoundException('Managed post not found'),
          };
        }

        if (managed.revision !== body.expectedRevision) {
          return {
            refused: new ManagedConflictException(
              'REVISION_CONFLICT',
              `The post is at revision ${managed.revision}`
            ),
          };
        }

        const integration = await tx.getIntegration(managed.integrationId);
        if (!integration) {
          return {
            refused: new ManagedUnprocessableException(
              'INTEGRATION_NOT_FOUND',
              'Channel not found in this organization'
            ),
          };
        }

        const gate = await this.channelGate(
          tx,
          integration,
          body.expectedBindingGeneration
        );
        if ('refused' in gate) {
          return gate;
        }

        // the members are the rows the current revision bound, in its order;
        // members retired by an earlier edit stay in the group, soft-deleted
        const previous: ManagedPostSnapshot = JSON.parse(
          (await tx.getRevision(managed.id, managed.revision))!.snapshot
        );
        const rows = await tx.getPostRows([managed.group]);
        const members = previous.members.map((member) =>
          rows.find((row) => row.id === member.postId)
        );
        if (
          !members.length ||
          members.some((row) => !row || row.state !== 'DRAFT' || row.deletedAt)
        ) {
          return {
            refused: new ManagedConflictException(
              'POST_NOT_DRAFT',
              'Only a draft that was not deleted can be edited'
            ),
          };
        }

        if (rowFingerprint(rows) !== managed.rowFingerprint) {
          return {
            refused: new ManagedConflictException(
              'POST_DRIFTED',
              'The post rows were changed outside the managed path'
            ),
          };
        }

        const invalidSettings = await this.settingsRefusal(
          integration.providerIdentifier,
          draft.settings
        );
        if (invalidSettings) {
          return { refused: invalidSettings };
        }

        const media = await this.resolveMedia(tx, draft, current);
        if ('refused' in media) {
          return media;
        }

        const sequence = tx.nextSequence();
        const settings = JSON.stringify({
          ...draft.settings,
          __type: integration.providerIdentifier,
        });

        // positional: the root and every kept child keep their row id and
        // position; members past the old end are new rows chained after the
        // last one, and members past the new end are retired, never deleted
        const kept: string[] = [];
        for (const [position, member] of draft.members.entries()) {
          const fields = {
            content: member.content,
            delay: member.delay,
            image: this.imageJson(member.media, media.ok),
            settings,
            publishDate: new Date(draft.intendedPublishDate),
          };

          const existing = members[position];
          if (existing) {
            await tx.updatePostRow(existing.id, fields);
            kept.push(existing.id);
          } else {
            const created = await tx.createPostRow({
              ...fields,
              group: managed.group,
              integrationId: managed.integrationId,
              parentPostId: kept[kept.length - 1],
            });
            kept.push(created.id);
          }
        }

        const retired = members.slice(draft.members.length);
        for (const row of retired) {
          await tx.retirePostRow(row!.id);
        }

        const updated = await tx.getPostRows([managed.group]);
        const snapshot = this.buildSnapshot({
          managedPostId: managed.id,
          group: managed.group,
          integrationId: managed.integrationId,
          revision: managed.revision + 1,
          bindingGeneration: gate.ok.generation,
          draft,
          members: kept.map((id) => updated.find((row) => row.id === id)!),
          retiredMembers: [
            ...(previous.retiredMembers || []),
            ...retired.map((row, index) => ({
              postId: row!.id,
              position: draft.members.length + index,
              retiredAtRevision: managed.revision + 1,
            })),
          ],
          media: media.ok,
          operationKey: body.operationKey,
          payloadHash,
          sequence,
        });

        await tx.updateManagedPost(managed.id, {
          revision: snapshot.revision,
          bindingGeneration: snapshot.bindingGeneration,
          rowFingerprint: rowFingerprint(updated),
          lastSequence: sequence,
          lastOperationKey: body.operationKey,
        });

        await this.commitRevision(tx, credentialId, 'EDIT_DRAFT', snapshot);

        return { ok: this.writeResult(snapshot, false) };
      }
    );

    return this.unwrap(outcome);
  }

  // What the database remembers, not a fresh look at the stored bytes: a read
  // never calls storage. The draft gate is where the current object version
  // is checked
  private mediaStatus(
    ref: ManagedEvidenceView,
    entry: MediaWithEvidence | undefined
  ) {
    if (!entry) {
      return 'UNVERIFIED_MEDIA_REMOVED' as const;
    }

    if (!entry.evidence || entry.evidence.sha256 !== ref.sha256) {
      return 'UNVERIFIED_CHANGED_SINCE_REVISION' as const;
    }

    return 'EVIDENCE_RECORDED_AT_REVISION' as const;
  }

  private itemView(
    managed: ManagedPostRow,
    snapshot: ManagedPostSnapshot,
    rows: PostRow[],
    media: Map<string, MediaWithEvidence>
  ) {
    const ordered = orderRows(rows);
    const root = ordered[0];

    return {
      managedPostId: managed.id,
      group: managed.group,
      integrationId: managed.integrationId,
      revision: managed.revision,
      bindingGeneration: managed.bindingGeneration,
      lastSequence: managed.lastSequence,
      createdOperationKey: managed.createdOperationKey,
      lastOperationKey: managed.lastOperationKey,
      state: !root ? 'MISSING' : root.deletedAt ? 'DELETED' : root.state,
      dates: {
        intendedPublishDate: snapshot.intendedPublishDate,
        rowPublishDate: root ? new Date(root.publishDate).toISOString() : null,
        createdAt: managed.createdAt,
        updatedAt: managed.updatedAt,
        revisedAt: snapshot.revisedAt,
      },
      settings: snapshot.settings,
      members: snapshot.members.map((member) => ({
        ...member,
        media: member.media.map((ref) => ({
          ...ref,
          ...(ref.thumbnail
            ? {
                thumbnail: {
                  ...ref.thumbnail,
                  status: this.mediaStatus(
                    ref.thumbnail,
                    media.get(ref.thumbnail.mediaId)
                  ),
                },
              }
            : {}),
          status: this.mediaStatus(ref, media.get(ref.mediaId)),
        })),
      })),
      retiredMembers: snapshot.retiredMembers || [],
      integrity: {
        status:
          rowFingerprint(ordered) === managed.rowFingerprint
            ? ('CONSISTENT' as const)
            : ('DRIFTED' as const),
        rowFingerprint: managed.rowFingerprint,
      },
    };
  }

  private async itemViews(reader: ManagedReader, managed: ManagedPostRow[]) {
    const revisions = await reader.getLatestRevisions(
      managed.map((post) => ({ id: post.id, revision: post.revision }))
    );
    const rows = await reader.getPostRows(managed.map((post) => post.group));
    const snapshots = new Map<string, ManagedPostSnapshot>(
      revisions.map((revision) => [
        revision.managedPostId,
        JSON.parse(revision.snapshot),
      ])
    );
    const media = new Map(
      (
        await reader.getMediaWithEvidence([
          ...new Set(
            [...snapshots.values()].flatMap((snapshot) =>
              this.snapshotMediaIds(snapshot)
            )
          ),
        ])
      ).map((entry) => [entry.media.id, entry])
    );

    return managed.map((post) =>
      this.itemView(
        post,
        snapshots.get(post.id)!,
        rows.filter((row) => row.group === post.group),
        media
      )
    );
  }

  // every media and cover id the members of a revision reference
  private snapshotMediaIds(snapshot: ManagedPostSnapshot) {
    return snapshot.members.flatMap((member) =>
      member.media.flatMap((ref) =>
        ref.thumbnail ? [ref.mediaId, ref.thumbnail.mediaId] : [ref.mediaId]
      )
    );
  }

  // What a media observation compares before and after it reads storage, in
  // one consistent read. Nothing here writes: the binding is read as it is,
  // never reconciled
  private async observedState(reader: ManagedReader, managedPostId: string) {
    const managed = await reader.getManagedPost(managedPostId);
    if (!managed) {
      return null;
    }

    const revision = await reader.getRevision(managed.id, managed.revision);
    const snapshot: ManagedPostSnapshot = JSON.parse(revision!.snapshot);
    const integration = await reader.getIntegration(managed.integrationId);
    const binding = await reader.getBinding(managed.integrationId);
    const rows = await reader.getPostRows([managed.group]);
    const media = await reader.getMediaWithEvidence([
      ...new Set(this.snapshotMediaIds(snapshot)),
    ]);

    return {
      managed,
      snapshot,
      binding,
      media: new Map(media.map((entry) => [entry.media.id, entry])),
      rows:
        rowFingerprint(rows) === managed.rowFingerprint
          ? ('CONSISTENT' as const)
          : ('DRIFTED' as const),
      post: fingerprint({
        revision: managed.revision,
        lastSequence: managed.lastSequence,
        rowFingerprint: managed.rowFingerprint,
        rows: rowFingerprint(rows),
      }),
      channel: fingerprint({
        identity: integration ? identityFingerprint(integration) : null,
        binding: binding
          ? {
              generation: binding.generation,
              status: binding.status,
              identityFingerprint: binding.identityFingerprint,
            }
          : null,
      }),
      records: fingerprint(
        media
          .map((entry) => ({
            id: entry.media.id,
            path: entry.media.path,
            status: entry.media.status,
            evidenceId: entry.evidence?.id ?? null,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      ),
    };
  }

  // A fresh, read-only look at the private objects the current revision's
  // media and covers were proven against (GET /posts/:id only reports what
  // the database recorded). Only the revision the caller names, and only
  // while it is current. Storage is read outside any transaction; the post,
  // its binding and the media records are read again afterwards, and any
  // change makes the whole answer INDETERMINATE. Nothing is written:
  // no evidence, operation, event, binding or row. `cancel` aborts the reads
  // when the client went away
  async observeCurrentMedia(
    organizationId: string,
    managedPostId: string,
    expectedRevision: number,
    cancel?: AbortSignal
  ): Promise<ManagedMediaObservationResult> {
    // checked and taken before the first await, so two requests of one
    // organization never both pass
    if (this.observing.has(organizationId)) {
      throw new ManagedConflictException(
        'OBSERVATION_IN_PROGRESS',
        'Another media observation of this organization is in progress; retry once it finished'
      );
    }

    this.observing.add(organizationId);
    try {
      return await this.observeRevision(
        organizationId,
        managedPostId,
        expectedRevision,
        cancel
      );
    } finally {
      this.observing.delete(organizationId);
    }
  }

  private async observeRevision(
    organizationId: string,
    managedPostId: string,
    expectedRevision: number,
    cancel?: AbortSignal
  ): Promise<ManagedMediaObservationResult> {
    const startedAt = new Date().toISOString();
    const start = await this._managedRepository.read(organizationId, (reader) =>
      this.observedState(reader, managedPostId)
    );
    if (!start) {
      throw new ManagedNotFoundException('Managed post not found');
    }

    if (start.managed.revision !== expectedRevision) {
      throw new ManagedConflictException(
        'REVISION_CONFLICT',
        `The post is at revision ${start.managed.revision}; only the current revision can be observed`
      );
    }

    const identities = start.snapshot.members.flatMap((member) =>
      member.media.flatMap((ref, mediaPosition) => [
        {
          memberPosition: member.position,
          mediaPosition,
          role: 'MEDIA' as const,
          ref: ref as ManagedEvidenceView,
        },
        ...(ref.thumbnail
          ? [
              {
                memberPosition: member.position,
                mediaPosition,
                role: 'THUMBNAIL' as const,
                ref: ref.thumbnail,
              },
            ]
          : []),
      ])
    );
    if (identities.length > MAX_OBSERVED_IDENTITIES) {
      throw new ManagedUnprocessableException(
        'OBSERVATION_BOUND_EXCEEDED',
        `A revision with more than ${MAX_OBSERVED_IDENTITIES} media references cannot be observed`
      );
    }

    // each distinct object is read at most up to its recorded size
    const recordedBytes = new Map(
      identities.map(({ ref }) => [
        `${ref.mediaId}:${ref.evidenceId}`,
        ref.byteLength,
      ])
    );
    if (
      [...recordedBytes.values()].reduce((sum, bytes) => sum + bytes, 0) >
      MAX_OBSERVED_BYTES
    ) {
      throw new ManagedUnprocessableException(
        'OBSERVATION_BOUND_EXCEEDED',
        `A revision whose distinct media hold more than ${MAX_OBSERVED_BYTES} recorded bytes cannot be observed`
      );
    }

    const deadline = AbortSignal.timeout(OBSERVATION_DEADLINE_MS);
    const signal = cancel ? AbortSignal.any([deadline, cancel]) : deadline;

    // each object once, one after the other, until the reads are stopped
    const observed = new Map<
      string,
      { observation: ManagedMediaObservation; observedAt: string }
    >();
    for (const { ref } of identities) {
      const key = `${ref.mediaId}:${ref.evidenceId}`;
      if (signal.aborted) {
        break;
      }
      if (!observed.has(key)) {
        observed.set(key, {
          observation: await this._managedMediaService.observeEvidence(
            start.media.get(ref.mediaId),
            ref,
            signal
          ),
          observedAt: new Date().toISOString(),
        });
      }
    }

    // a read the stop cut short is not an answer about its object
    const stopped = !signal.aborted
      ? null
      : deadline.aborted
      ? ('OBSERVATION_DEADLINE_EXCEEDED' as const)
      : ('OBSERVATION_CANCELLED' as const);

    const end = stopped
      ? null
      : await this._managedRepository.read(organizationId, (reader) =>
          this.observedState(reader, managedPostId)
        );

    const base = {
      managedPostId: start.managed.id,
      revision: start.managed.revision,
      observation: 'PRIVATE_STORAGE_READ_BY_PINNED_KEY' as const,
      startedAt,
      finishedAt: new Date().toISOString(),
      binding: {
        atRevisionGeneration: start.snapshot.bindingGeneration,
        generation: start.binding?.generation ?? null,
        status: start.binding?.status ?? null,
      },
    };

    const changes: ManagedMediaObservationChange[] = stopped
      ? [stopped]
      : [
          ...(end?.post !== start.post
            ? ['POST_CHANGED_DURING_OBSERVATION' as const]
            : []),
          ...(end?.channel !== start.channel
            ? ['BINDING_CHANGED_DURING_OBSERVATION' as const]
            : []),
          ...(end?.records !== start.records
            ? ['MEDIA_RECORD_CHANGED_DURING_OBSERVATION' as const]
            : []),
        ];
    if (changes.length) {
      return { ...base, status: 'INDETERMINATE' as const, reasons: changes };
    }

    const media = identities.map(
      ({ memberPosition, mediaPosition, role, ref }) => {
        const { observation, observedAt } = observed.get(
          `${ref.mediaId}:${ref.evidenceId}`
        )!;
        return {
          memberPosition,
          mediaPosition,
          role,
          mediaId: ref.mediaId,
          evidenceId: ref.evidenceId,
          sha256: ref.sha256,
          byteLength: ref.byteLength,
          mimeType: ref.mimeType,
          status: observation.status,
          ...(observation.status === 'UNVERIFIED'
            ? { reason: observation.reason }
            : {}),
          observedAt,
        };
      }
    );

    const reasons = [
      ...(media.some((item) => item.status === 'UNVERIFIED')
        ? ['MEDIA_UNVERIFIED' as const]
        : []),
      ...(start.rows === 'DRIFTED' ? ['ROWS_DRIFTED' as const] : []),
    ];

    return {
      ...base,
      status: reasons.length
        ? ('UNVERIFIED' as const)
        : media.length
        ? ('VERIFIED' as const)
        : ('NO_MEDIA_REFERENCED' as const),
      reasons,
      rows: start.rows,
      media,
    };
  }

  async getPost(organizationId: string, managedPostId: string) {
    return this._managedRepository.read(organizationId, async (reader) => {
      const managed = await reader.getManagedPost(managedPostId);
      if (!managed) {
        throw new ManagedNotFoundException('Managed post not found');
      }

      const [view] = await this.itemViews(reader, [managed]);
      return view;
    });
  }

  async listRevisions(organizationId: string, managedPostId: string) {
    return this._managedRepository.read(organizationId, async (reader) => {
      const managed = await reader.getManagedPost(managedPostId);
      if (!managed) {
        throw new ManagedNotFoundException('Managed post not found');
      }

      return (await reader.getRevisions(managedPostId)).map((revision) => {
        const post: ManagedPostSnapshot = JSON.parse(revision.snapshot);
        return {
          revision: revision.revision,
          sequence: revision.sequence,
          operationKey: revision.operationKey,
          payloadHash: revision.payloadHash,
          createdAt: revision.createdAt,
          current: revision.revision === managed.revision,
          memberCount: post.members.length,
          retiredMemberCount: post.retiredMembers?.length ?? 0,
          post,
        };
      });
    });
  }

  // Read-only answer for a lost create / edit acknowledgement: whether the
  // key committed, and if so the revision it committed, exactly as stored.
  // ABSENT is only true as of asOfSequence: a request still in flight with
  // the key can commit later, and resending the same key and payload is how
  // that is settled. A committed revision that is no longer the post's
  // current one is answered as HISTORICAL, never as current
  async operationStatus(organizationId: string, operationKey: string) {
    if (!MANAGED_OPERATION_KEY.test(operationKey)) {
      throw new ManagedBadRequestException('Invalid operation key');
    }

    return this._managedRepository.read(organizationId, async (reader) => {
      const asOfSequence = await reader.headSequence();
      const operation = await reader.getOperation(operationKey);
      if (!operation) {
        return { operationKey, status: 'ABSENT' as const, asOfSequence };
      }

      const revision = await reader.getRevision(
        operation.managedPostId,
        operation.revision
      );
      const managed = await reader.getManagedPost(operation.managedPostId);

      return {
        operationKey,
        status: 'COMMITTED' as const,
        asOfSequence,
        kind: operation.kind,
        payloadHash: operation.payloadHash,
        managedPostId: operation.managedPostId,
        revision: operation.revision,
        sequence: operation.sequence,
        committedAt: revision!.createdAt,
        currentRevision: managed!.revision,
        ack:
          operation.revision === managed!.revision
            ? ('CURRENT' as const)
            : ('HISTORICAL' as const),
        post: JSON.parse(revision!.snapshot) as ManagedPostSnapshot,
      };
    });
  }

  capabilities() {
    return MANAGED_CAPABILITIES;
  }

  private encodeCursor(snapshotSequence: number, afterId: string) {
    return Buffer.from(
      JSON.stringify({ v: 1, s: snapshotSequence, a: afterId })
    ).toString('base64url');
  }

  private decodeCursor(cursor?: string) {
    if (!cursor) {
      return undefined;
    }

    let decoded: any;
    try {
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch (err) {
      throw new ManagedBadRequestException('Invalid cursor');
    }

    if (
      decoded?.v !== 1 ||
      !Number.isInteger(decoded?.s) ||
      decoded.s < 0 ||
      typeof decoded?.a !== 'string' ||
      !/^[A-Za-z0-9-]{1,64}$/.test(decoded.a) ||
      Object.keys(decoded).length !== 3
    ) {
      throw new ManagedBadRequestException('Invalid cursor');
    }

    return { snapshotSequence: decoded.s as number, afterId: decoded.a };
  }

  // Inventory pages + changes(after = snapshotSequence) cover every managed
  // post: ids are immutable and never deleted, so a page can't skip a post
  // that existed at the snapshot, and anything committed later has a higher
  // sequence and shows up in the feed. Only the first page is read at
  // snapshotSequence: every page is its own consistent read at
  // observedSequence, so a later page can already hold newer revisions
  // (dedupe by highest revision) and its coverage counts are current at
  // observedSequence, not at the snapshot
  async inventory(organizationId: string, cursor?: string, limit = 50) {
    const decoded = this.decodeCursor(cursor);
    await this._managedRepository.ensureOrganization(organizationId);

    return this._managedRepository.read(organizationId, async (reader) => {
      const head = await reader.headSequence();
      if (decoded && decoded.snapshotSequence > head) {
        throw new ManagedBadRequestException('Invalid cursor');
      }

      // the cursor carries the first page's sequence, the feed resume point
      const snapshotSequence = decoded ? decoded.snapshotSequence : head;
      const page = await reader.listManagedPosts(
        decoded?.afterId ?? null,
        limit + 1
      );
      const managed = page.slice(0, limit);
      const hasMore = page.length > limit;
      const items = await this.itemViews(reader, managed);
      const managedPosts = await reader.countManagedPosts();
      const rootPosts = await reader.countRootPosts();

      return {
        snapshotSequence,
        observedSequence: head,
        items,
        nextCursor: hasMore
          ? this.encodeCursor(snapshotSequence, managed[managed.length - 1].id)
          : null,
        // the last page; complete together with changes(after=snapshotSequence)
        complete: !hasMore,
        coverage: {
          asOf: 'OBSERVED_SEQUENCE' as const,
          observedSequence: head,
          managedPosts,
          unmanagedRootPostsInOrganization: Math.max(
            0,
            rootPosts - managedPosts
          ),
        },
      };
    });
  }

  async changes(organizationId: string, after = 0, limit = 100) {
    await this._managedRepository.ensureOrganization(organizationId);

    return this._managedRepository.read(organizationId, async (reader) => {
      const headSequence = await reader.headSequence();
      if (after > headSequence) {
        throw new ManagedBadRequestException(
          `after is beyond the head sequence ${headSequence}`
        );
      }

      const events = await reader.listEvents(after, limit);
      const nextAfter = events.length
        ? events[events.length - 1].sequence
        : after;

      return {
        events: events.map((event) => ({
          sequence: event.sequence,
          kind: event.kind,
          entityType: event.entityType,
          entityId: event.entityId,
          revision: event.revision,
          bindingGeneration: event.bindingGeneration,
          operationKey: event.operationKey,
          occurredAt: event.createdAt,
          data: JSON.parse(event.data),
        })),
        headSequence,
        nextAfter,
        hasMore: nextAfter < headSequence,
      };
    });
  }

  // The worker refused to publish a post of a managed organization; kept in
  // the feed instead of writing an ERROR state on the row
  async recordDispatchRefusal(
    organizationId: string,
    postId: string,
    source: string
  ) {
    await this._managedRepository.mutate(organizationId, async (tx) => {
      await tx.appendEvent({
        sequence: tx.nextSequence(),
        kind: 'DISPATCH_REFUSED',
        entityType: 'POST_ROW',
        entityId: postId,
        revision: null,
        bindingGeneration: null,
        operationKey: null,
        data: JSON.stringify({ source }),
      });
    });
  }
}

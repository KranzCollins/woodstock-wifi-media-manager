import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runAsManagedWriter } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.write.fence';
import { ManagedConflictException } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';

// Row shapes the managed service works with. Integration is only ever read
// through INTEGRATION_IDENTITY_SELECT: no token, refreshToken,
// customInstanceDetails or additionalSettings leaves this file.

export interface IntegrationIdentity {
  id: string;
  organizationId: string;
  providerIdentifier: string;
  internalId: string;
  rootInternalId: string | null;
  profile: string | null;
  name: string;
  customName: string | null;
  disabled: boolean;
  refreshNeeded: boolean;
  inBetweenSteps: boolean;
  deletedAt: Date | null;
}

export type BindingStatus =
  | 'PENDING_QUALIFICATION'
  | 'QUALIFIED'
  | 'PAUSED_IDENTITY_CHANGED';

export interface BindingRow {
  id: string;
  organizationId: string;
  integrationId: string;
  generation: number;
  status: BindingStatus;
  providerIdentifier: string;
  internalId: string;
  profile: string | null;
  identityFingerprint: string;
  qualifiedAt: Date | null;
  pausedAt: Date | null;
}

export interface ManagedPostRow {
  id: string;
  organizationId: string;
  integrationId: string;
  group: string;
  revision: number;
  bindingGeneration: number;
  rowFingerprint: string;
  lastSequence: number;
  createdOperationKey: string;
  lastOperationKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostRow {
  id: string;
  group: string;
  organizationId: string;
  integrationId: string;
  parentPostId: string | null;
  content: string;
  delay: number;
  image: string | null;
  settings: string | null;
  publishDate: Date;
  state: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewPostRow {
  group: string;
  integrationId: string;
  parentPostId: string | null;
  content: string;
  delay: number;
  image: string;
  settings: string;
  publishDate: Date;
}

// the library's own thumbnail and alt are left out on purpose: nothing proves
// that thumbnail's bytes, and an alt text W&W did not review must not reach a
// draft. A draft only carries the options W&W sent with the media reference
export interface MediaRow {
  id: string;
  organizationId: string;
  name: string;
  path: string;
  status: string;
}

export interface EvidenceRow {
  id: string;
  mediaId: string;
  storedPath: string;
  storageVersion: string | null;
  // server-private pin of the object (see IUploadProvider.objectKeyOf and
  // objectNamespace); never returned. null on evidence recorded before it
  storageKey: string | null;
  storageNamespace: string | null;
  sha256: string;
  byteLength: number;
  mimeType: string | null;
  method: string;
  sequence: number;
}

export interface MediaWithEvidence {
  media: MediaRow;
  // the newest evidence captured for the media's current stored path
  evidence: EvidenceRow | null;
}

export interface OperationRow {
  operationKey: string;
  kind: string;
  payloadHash: string;
  managedPostId: string;
  revision: number;
  sequence: number;
}

export interface RevisionRow {
  managedPostId: string;
  revision: number;
  operationKey: string;
  payloadHash: string;
  sequence: number;
  snapshot: string;
  createdAt: Date;
}

export interface EventRow {
  sequence: number;
  kind: string;
  entityType: string;
  entityId: string;
  revision: number | null;
  bindingGeneration: number | null;
  operationKey: string | null;
  data: string;
  createdAt: Date;
}

export type MediaUploadStatus = 'RESERVED' | 'RECEIVING' | 'COMPLETED' | 'FAILED';

export interface MediaUploadRow {
  id: string;
  operationKey: string;
  credentialId: string;
  requestHash: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
  status: MediaUploadStatus;
  attempt: number;
  leaseExpiresAt: Date | null;
  mediaId: string | null;
  evidenceId: string | null;
  completedSequence: number | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MediaUploadOutcome =
  | 'RECEIVING'
  | 'STORED'
  | 'ABSENT'
  | 'BYTES_REJECTED'
  | 'SUPERSEDED';

export interface MediaUploadAttemptRow {
  id: string;
  uploadId: string;
  attempt: number;
  storageKey: string;
  storedPath: string;
  // server-private (see IUploadProvider.objectNamespace); null on attempts
  // claimed before it was recorded
  storageNamespace: string | null;
  outcome: MediaUploadOutcome;
  detail: string | null;
}

export interface ManagedReader {
  headSequence(): Promise<number>;
  getIntegrations(includeIds: string[]): Promise<IntegrationIdentity[]>;
  getIntegration(integrationId: string): Promise<IntegrationIdentity | null>;
  getBinding(integrationId: string): Promise<BindingRow | null>;
  getBindings(): Promise<BindingRow[]>;
  getOperation(operationKey: string): Promise<OperationRow | null>;
  getManagedPost(managedPostId: string): Promise<ManagedPostRow | null>;
  listManagedPosts(
    afterId: string | null,
    limit: number
  ): Promise<ManagedPostRow[]>;
  countManagedPosts(): Promise<number>;
  countRootPosts(): Promise<number>;
  getPostRows(groups: string[]): Promise<PostRow[]>;
  getRevision(
    managedPostId: string,
    revision: number
  ): Promise<RevisionRow | null>;
  getRevisions(managedPostId: string): Promise<RevisionRow[]>;
  getLatestRevisions(
    posts: { id: string; revision: number }[]
  ): Promise<RevisionRow[]>;
  getMediaWithEvidence(mediaIds: string[]): Promise<MediaWithEvidence[]>;
  listEvents(after: number, limit: number): Promise<EventRow[]>;
  getMediaUpload(operationKey: string): Promise<MediaUploadRow | null>;
  // a reservation of the same request whose attempt is still RECEIVING
  getReceivingMediaUpload(requestHash: string): Promise<MediaUploadRow | null>;
  getMediaUploadAttempt(
    uploadId: string,
    attempt: number
  ): Promise<MediaUploadAttemptRow | null>;
}

export interface ManagedTx extends ManagedReader {
  // dense per-organization sequence, committed with the transaction
  nextSequence(): number;
  createBinding(
    data: Omit<BindingRow, 'id' | 'organizationId'>
  ): Promise<BindingRow>;
  updateBinding(
    id: string,
    data: Partial<Omit<BindingRow, 'id' | 'organizationId' | 'integrationId'>>
  ): Promise<BindingRow>;
  createPostRow(data: NewPostRow): Promise<PostRow>;
  updatePostRow(
    id: string,
    data: Pick<
      NewPostRow,
      'content' | 'delay' | 'image' | 'settings' | 'publishDate'
    >
  ): Promise<void>;
  // a member an edit removed: soft-deleted and unlinked, never removed
  retirePostRow(id: string): Promise<void>;
  createManagedPost(
    data: Omit<ManagedPostRow, 'organizationId' | 'createdAt' | 'updatedAt'>
  ): Promise<ManagedPostRow>;
  updateManagedPost(
    id: string,
    data: Pick<
      ManagedPostRow,
      | 'revision'
      | 'bindingGeneration'
      | 'rowFingerprint'
      | 'lastSequence'
      | 'lastOperationKey'
    >
  ): Promise<ManagedPostRow>;
  createRevision(data: Omit<RevisionRow, 'createdAt'>): Promise<void>;
  createOperation(data: OperationRow & { credentialId: string }): Promise<void>;
  appendEvent(data: Omit<EventRow, 'createdAt'>): Promise<void>;
  createMedia(data: {
    name: string;
    path: string;
    originalName: string | null;
  }): Promise<MediaRow>;
  createEvidence(
    data: Omit<EvidenceRow, 'id'> & { credentialId: string }
  ): Promise<EvidenceRow>;
  createMediaUpload(
    data: Pick<
      MediaUploadRow,
      | 'operationKey'
      | 'credentialId'
      | 'requestHash'
      | 'sha256'
      | 'byteLength'
      | 'mimeType'
    >
  ): Promise<MediaUploadRow>;
  updateMediaUpload(
    id: string,
    data: Partial<
      Pick<
        MediaUploadRow,
        | 'status'
        | 'attempt'
        | 'leaseExpiresAt'
        | 'mediaId'
        | 'evidenceId'
        | 'completedSequence'
        | 'failureReason'
      >
    >
  ): Promise<MediaUploadRow>;
  createMediaUploadAttempt(
    data: Omit<MediaUploadAttemptRow, 'id' | 'outcome' | 'detail'>
  ): Promise<MediaUploadAttemptRow>;
  // RECEIVING -> its terminal outcome, once
  updateMediaUploadAttempt(
    id: string,
    data: {
      outcome: Exclude<MediaUploadOutcome, 'RECEIVING' | 'SUPERSEDED'>;
      detail: string | null;
    }
  ): Promise<void>;
  // ABSENT / BYTES_REJECTED -> SUPERSEDED when an object of the attempt
  // turned up after it was closed; `from` is the row as read, and the new
  // detail must carry it, so no earlier outcome is lost
  supersedeMediaUploadAttempt(
    id: string,
    from: Pick<MediaUploadAttemptRow, 'outcome' | 'detail'>,
    detail: string
  ): Promise<void>;
}

const INTEGRATION_IDENTITY_SELECT = {
  id: true,
  organizationId: true,
  providerIdentifier: true,
  internalId: true,
  rootInternalId: true,
  profile: true,
  name: true,
  customName: true,
  disabled: true,
  refreshNeeded: true,
  inBetweenSteps: true,
  deletedAt: true,
} as const;

const BINDING_SELECT = {
  id: true,
  organizationId: true,
  integrationId: true,
  generation: true,
  status: true,
  providerIdentifier: true,
  internalId: true,
  profile: true,
  identityFingerprint: true,
  qualifiedAt: true,
  pausedAt: true,
} as const;

const POST_ROW_SELECT = {
  id: true,
  group: true,
  organizationId: true,
  integrationId: true,
  parentPostId: true,
  content: true,
  delay: true,
  image: true,
  settings: true,
  publishDate: true,
  state: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MEDIA_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  path: true,
  status: true,
} as const;

const EVIDENCE_SELECT = {
  id: true,
  mediaId: true,
  storedPath: true,
  storageVersion: true,
  storageKey: true,
  storageNamespace: true,
  sha256: true,
  byteLength: true,
  mimeType: true,
  method: true,
  sequence: true,
} as const;

const REVISION_SELECT = {
  managedPostId: true,
  revision: true,
  operationKey: true,
  payloadHash: true,
  sequence: true,
  snapshot: true,
  createdAt: true,
} as const;

const OPERATION_SELECT = {
  operationKey: true,
  kind: true,
  payloadHash: true,
  managedPostId: true,
  revision: true,
  sequence: true,
} as const;

const MEDIA_UPLOAD_SELECT = {
  id: true,
  operationKey: true,
  credentialId: true,
  requestHash: true,
  sha256: true,
  byteLength: true,
  mimeType: true,
  status: true,
  attempt: true,
  leaseExpiresAt: true,
  mediaId: true,
  evidenceId: true,
  completedSequence: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MEDIA_UPLOAD_ATTEMPT_SELECT = {
  id: true,
  uploadId: true,
  attempt: true,
  storageKey: true,
  storedPath: true,
  storageNamespace: true,
  outcome: true,
  detail: true,
} as const;

// Every query is scoped to the organization the store was opened for; there
// is no method that takes another organization id
export class PrismaManagedStore implements ManagedTx {
  constructor(
    private _client: Prisma.TransactionClient,
    private _organizationId: string,
    private _sequence: { value: number } | null
  ) {}

  get sequence() {
    return this._sequence?.value ?? null;
  }

  nextSequence() {
    if (!this._sequence) {
      throw new Error('A managed reader cannot allocate sequences');
    }

    this._sequence.value += 1;
    return this._sequence.value;
  }

  async headSequence() {
    if (this._sequence) {
      return this._sequence.value;
    }

    const organization =
      await this._client.managedOrganization.findUnique({
        where: { organizationId: this._organizationId },
        select: { sequence: true },
      });

    return organization?.sequence ?? 0;
  }

  getIntegrations(includeIds: string[]) {
    return this._client.integration.findMany({
      where: {
        organizationId: this._organizationId,
        OR: [
          { deletedAt: null },
          ...(includeIds.length ? [{ id: { in: includeIds } }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: INTEGRATION_IDENTITY_SELECT,
    });
  }

  getIntegration(integrationId: string) {
    return this._client.integration.findFirst({
      where: { id: integrationId, organizationId: this._organizationId },
      select: INTEGRATION_IDENTITY_SELECT,
    });
  }

  async getBinding(integrationId: string) {
    return (await this._client.managedChannelBinding.findFirst({
      where: { integrationId, organizationId: this._organizationId },
      select: BINDING_SELECT,
    })) as BindingRow | null;
  }

  async getBindings() {
    return (await this._client.managedChannelBinding.findMany({
      where: { organizationId: this._organizationId },
      select: BINDING_SELECT,
    })) as BindingRow[];
  }

  getOperation(operationKey: string) {
    return this._client.managedOperation.findUnique({
      where: {
        organizationId_operationKey: {
          organizationId: this._organizationId,
          operationKey,
        },
      },
      select: OPERATION_SELECT,
    });
  }

  getManagedPost(managedPostId: string) {
    return this._client.managedPost.findFirst({
      where: { id: managedPostId, organizationId: this._organizationId },
    });
  }

  listManagedPosts(afterId: string | null, limit: number) {
    return this._client.managedPost.findMany({
      where: {
        organizationId: this._organizationId,
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
  }

  countManagedPosts() {
    return this._client.managedPost.count({
      where: { organizationId: this._organizationId },
    });
  }

  countRootPosts() {
    return this._client.post.count({
      where: {
        organizationId: this._organizationId,
        deletedAt: null,
        parentPostId: null,
      },
    });
  }

  // all rows of the groups, deleted ones included, so drift is visible
  getPostRows(groups: string[]) {
    if (!groups.length) {
      return Promise.resolve([] as PostRow[]);
    }

    return this._client.post.findMany({
      where: { organizationId: this._organizationId, group: { in: groups } },
      orderBy: { createdAt: 'asc' },
      select: POST_ROW_SELECT,
    }) as Promise<PostRow[]>;
  }

  getRevision(managedPostId: string, revision: number) {
    return this._client.managedPostRevision.findFirst({
      where: {
        managedPostId,
        revision,
        organizationId: this._organizationId,
      },
      select: REVISION_SELECT,
    });
  }

  getRevisions(managedPostId: string) {
    return this._client.managedPostRevision.findMany({
      where: { managedPostId, organizationId: this._organizationId },
      orderBy: { revision: 'asc' },
      select: REVISION_SELECT,
    });
  }

  getLatestRevisions(posts: { id: string; revision: number }[]) {
    if (!posts.length) {
      return Promise.resolve([] as RevisionRow[]);
    }

    return this._client.managedPostRevision.findMany({
      where: {
        organizationId: this._organizationId,
        OR: posts.map((post) => ({
          managedPostId: post.id,
          revision: post.revision,
        })),
      },
      select: REVISION_SELECT,
    });
  }

  async getMediaWithEvidence(mediaIds: string[]) {
    if (!mediaIds.length) {
      return [];
    }

    const [media, evidence] = await Promise.all([
      this._client.media.findMany({
        where: {
          id: { in: mediaIds },
          organizationId: this._organizationId,
          deletedAt: null,
        },
        select: MEDIA_SELECT,
      }),
      this._client.managedMediaEvidence.findMany({
        where: {
          organizationId: this._organizationId,
          mediaId: { in: mediaIds },
        },
        orderBy: { sequence: 'desc' },
        select: EVIDENCE_SELECT,
      }),
    ]);

    return media.map((row) => ({
      media: row,
      evidence:
        evidence.find(
          (item) => item.mediaId === row.id && item.storedPath === row.path
        ) || null,
    }));
  }

  listEvents(after: number, limit: number) {
    return this._client.managedChangeEvent.findMany({
      where: {
        organizationId: this._organizationId,
        sequence: { gt: after },
      },
      orderBy: { sequence: 'asc' },
      take: limit,
      select: {
        sequence: true,
        kind: true,
        entityType: true,
        entityId: true,
        revision: true,
        bindingGeneration: true,
        operationKey: true,
        data: true,
        createdAt: true,
      },
    });
  }

  async createBinding(data: Omit<BindingRow, 'id' | 'organizationId'>) {
    return (await this._client.managedChannelBinding.create({
      data: { ...data, organizationId: this._organizationId },
      select: BINDING_SELECT,
    })) as BindingRow;
  }

  async updateBinding(
    id: string,
    data: Partial<Omit<BindingRow, 'id' | 'organizationId' | 'integrationId'>>
  ) {
    return (await this._client.managedChannelBinding.update({
      where: { id, organizationId: this._organizationId },
      data,
      select: BINDING_SELECT,
    })) as BindingRow;
  }

  async createPostRow(data: NewPostRow) {
    return (await this._client.post.create({
      data: {
        state: 'DRAFT',
        publishDate: data.publishDate,
        content: data.content,
        delay: data.delay,
        group: data.group,
        image: data.image,
        settings: data.settings,
        creationMethod: 'API',
        approvedSubmitForOrder: 'NO',
        organization: { connect: { id: this._organizationId } },
        integration: { connect: { id: data.integrationId } },
        ...(data.parentPostId
          ? { parentPost: { connect: { id: data.parentPostId } } }
          : {}),
      },
      select: POST_ROW_SELECT,
    })) as PostRow;
  }

  // the state / deletedAt conditions make a row that left DRAFT fail the
  // whole transaction instead of being rewritten; thrown (not returned) so
  // the rows already updated in this transaction are rolled back
  private async updateDraftRow(
    id: string,
    data: Prisma.PostUncheckedUpdateInput
  ) {
    try {
      await this._client.post.update({
        where: {
          id,
          organizationId: this._organizationId,
          state: 'DRAFT',
          deletedAt: null,
        },
        data,
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new ManagedConflictException(
          'POST_NOT_DRAFT',
          'Only a draft that was not deleted can be edited'
        );
      }
      throw err;
    }
  }

  updatePostRow(
    id: string,
    data: Pick<
      NewPostRow,
      'content' | 'delay' | 'image' | 'settings' | 'publishDate'
    >
  ) {
    return this.updateDraftRow(id, data);
  }

  // the way createOrUpdatePost retires a removed comment: unlinked from the
  // chain and soft-deleted, so no reader or worker sees it as a member. The
  // row and every revision that held it stay
  retirePostRow(id: string) {
    return this.updateDraftRow(id, {
      parentPostId: null,
      deletedAt: new Date(),
    });
  }

  createManagedPost(
    data: Omit<ManagedPostRow, 'organizationId' | 'createdAt' | 'updatedAt'>
  ) {
    return this._client.managedPost.create({
      data: { ...data, organizationId: this._organizationId },
    });
  }

  updateManagedPost(
    id: string,
    data: Pick<
      ManagedPostRow,
      | 'revision'
      | 'bindingGeneration'
      | 'rowFingerprint'
      | 'lastSequence'
      | 'lastOperationKey'
    >
  ) {
    return this._client.managedPost.update({
      where: { id, organizationId: this._organizationId },
      data,
    });
  }

  async createRevision(data: Omit<RevisionRow, 'createdAt'>) {
    await this._client.managedPostRevision.create({
      data: { ...data, organizationId: this._organizationId },
      select: { id: true },
    });
  }

  async createOperation(data: OperationRow & { credentialId: string }) {
    await this._client.managedOperation.create({
      data: { ...data, organizationId: this._organizationId },
      select: { id: true },
    });
  }

  async appendEvent(data: Omit<EventRow, 'createdAt'>) {
    await this._client.managedChangeEvent.create({
      data: { ...data, organizationId: this._organizationId },
      select: { id: true },
    });
  }

  createMedia(data: {
    name: string;
    path: string;
    originalName: string | null;
  }) {
    return this._client.media.create({
      data: {
        organization: { connect: { id: this._organizationId } },
        name: data.name,
        path: data.path,
        originalName: data.originalName,
      },
      select: MEDIA_SELECT,
    });
  }

  createEvidence(data: Omit<EvidenceRow, 'id'> & { credentialId: string }) {
    return this._client.managedMediaEvidence.create({
      data: { ...data, organizationId: this._organizationId },
      select: EVIDENCE_SELECT,
    });
  }

  async getMediaUpload(operationKey: string) {
    return (await this._client.managedMediaUpload.findUnique({
      where: {
        organizationId_operationKey: {
          organizationId: this._organizationId,
          operationKey,
        },
      },
      select: MEDIA_UPLOAD_SELECT,
    })) as MediaUploadRow | null;
  }

  async getReceivingMediaUpload(requestHash: string) {
    return (await this._client.managedMediaUpload.findFirst({
      where: {
        organizationId: this._organizationId,
        requestHash,
        status: 'RECEIVING',
      },
      select: MEDIA_UPLOAD_SELECT,
    })) as MediaUploadRow | null;
  }

  async getMediaUploadAttempt(uploadId: string, attempt: number) {
    return (await this._client.managedMediaUploadAttempt.findFirst({
      where: { uploadId, attempt, organizationId: this._organizationId },
      select: MEDIA_UPLOAD_ATTEMPT_SELECT,
    })) as MediaUploadAttemptRow | null;
  }

  async createMediaUpload(
    data: Pick<
      MediaUploadRow,
      | 'operationKey'
      | 'credentialId'
      | 'requestHash'
      | 'sha256'
      | 'byteLength'
      | 'mimeType'
    >
  ) {
    return (await this._client.managedMediaUpload.create({
      data: { ...data, organizationId: this._organizationId },
      select: MEDIA_UPLOAD_SELECT,
    })) as MediaUploadRow;
  }

  async updateMediaUpload(
    id: string,
    data: Partial<
      Pick<
        MediaUploadRow,
        | 'status'
        | 'attempt'
        | 'leaseExpiresAt'
        | 'mediaId'
        | 'evidenceId'
        | 'completedSequence'
        | 'failureReason'
      >
    >
  ) {
    return (await this._client.managedMediaUpload.update({
      where: { id, organizationId: this._organizationId },
      data,
      select: MEDIA_UPLOAD_SELECT,
    })) as MediaUploadRow;
  }

  async createMediaUploadAttempt(
    data: Omit<MediaUploadAttemptRow, 'id' | 'outcome' | 'detail'>
  ) {
    return (await this._client.managedMediaUploadAttempt.create({
      data: { ...data, organizationId: this._organizationId },
      select: MEDIA_UPLOAD_ATTEMPT_SELECT,
    })) as MediaUploadAttemptRow;
  }

  // The outcome condition makes a transition the attempt already left fail
  // the whole transaction instead of rewriting a settled attempt. Only the
  // outcome and detail of `from` are read: a whole row passed as `from`
  // cannot replace the organization scope
  private async moveMediaUploadAttempt(
    id: string,
    from: Pick<MediaUploadAttemptRow, 'outcome'> &
      Partial<Pick<MediaUploadAttemptRow, 'detail'>>,
    data: Pick<MediaUploadAttemptRow, 'outcome' | 'detail'>
  ) {
    try {
      await this._client.managedMediaUploadAttempt.update({
        where: {
          id,
          outcome: from.outcome,
          ...(from.detail !== undefined ? { detail: from.detail } : {}),
          organizationId: this._organizationId,
        },
        data,
        select: { id: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new ManagedConflictException(
          'UPLOAD_SUPERSEDED',
          'This attempt was already settled'
        );
      }
      throw err;
    }
  }

  updateMediaUploadAttempt(
    id: string,
    data: {
      outcome: Exclude<MediaUploadOutcome, 'RECEIVING' | 'SUPERSEDED'>;
      detail: string | null;
    }
  ) {
    return this.moveMediaUploadAttempt(id, { outcome: 'RECEIVING' }, data);
  }

  supersedeMediaUploadAttempt(
    id: string,
    from: Pick<MediaUploadAttemptRow, 'outcome' | 'detail'>,
    detail: string
  ) {
    if (from.outcome !== 'ABSENT' && from.outcome !== 'BYTES_REJECTED') {
      throw new ManagedConflictException(
        'UPLOAD_SUPERSEDED',
        'Only an attempt closed without bytes can be superseded'
      );
    }

    return this.moveMediaUploadAttempt(id, from, {
      outcome: 'SUPERSEDED',
      detail,
    });
  }
}

@Injectable()
export class ManagedRepository {
  constructor(
    private _managedOrganization: PrismaRepository<'managedOrganization'>,
    private _transaction: PrismaTransaction
  ) {}

  // Two first calls can race on the insert; the loser finds the row
  async ensureOrganization(organizationId: string) {
    try {
      await this._managedOrganization.model.managedOrganization.upsert({
        where: { organizationId },
        create: { organizationId },
        update: {},
        select: { id: true },
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2002'
      ) {
        throw err;
      }
    }
  }

  // One managed mutation = one transaction that first takes the
  // organization row (same no-op update lock as ClippingRepository
  // createClips): concurrent mutations of an organization run one after the
  // other, so sequences commit in order and operation keys are checked
  // against everything committed before.
  async mutate<T>(
    organizationId: string,
    func: (tx: ManagedTx) => Promise<T>
  ): Promise<T> {
    await this.ensureOrganization(organizationId);

    return runAsManagedWriter(organizationId, () =>
      this._transaction.model.$transaction(
        async (tx) => {
          const locked = await tx.managedOrganization.update({
            where: { organizationId },
            data: { updatedAt: new Date() },
            select: { sequence: true },
          });

          const store = new PrismaManagedStore(tx, organizationId, {
            value: locked.sequence,
          });
          const result = await func(store);

          if (store.sequence !== locked.sequence) {
            await tx.managedOrganization.update({
              where: { organizationId },
              data: { sequence: store.sequence! },
              select: { id: true },
            });
          }

          return result;
        },
        { maxWait: 10000, timeout: 20000 }
      )
    );
  }

  // A consistent read: the head sequence and the rows come from one snapshot
  read<T>(
    organizationId: string,
    func: (reader: ManagedReader) => Promise<T>
  ): Promise<T> {
    return this._transaction.model.$transaction(
      (tx) => func(new PrismaManagedStore(tx, organizationId, null)),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
}

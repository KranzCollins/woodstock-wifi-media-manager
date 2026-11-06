import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { addAbortSignal, pipeline, Readable } from 'stream';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { CapturedUploadFile } from '@gitroom/nestjs-libraries/upload/multer.stream.engine';
import {
  digestStream,
  getMaxSize,
  maxSizeStream,
} from '@gitroom/nestjs-libraries/upload/custom.upload.validation';
import {
  EvidenceRow,
  ManagedReader,
  ManagedRepository,
  ManagedTx,
  MediaRow,
  MediaUploadAttemptRow,
  MediaUploadRow,
  MediaWithEvidence,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import {
  ManagedBadRequestException,
  ManagedConflictException,
  ManagedNotFoundException,
  ManagedUnprocessableCode,
  ManagedUnprocessableException,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.errors';
import {
  MANAGED_UPLOAD_LEASE_MS,
  MANAGED_UPLOAD_MAX_ATTEMPTS,
  MANAGED_UPLOAD_MAX_BYTES,
  managedMaxDigestBytes,
  sha256Hex,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { ReserveManagedMediaUploadDto } from '@gitroom/nestjs-libraries/dtos/managed/managed.media.upload.dto';
import { MANAGED_OPERATION_KEY } from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer, fileTypeStream } = require('file-type');

// enough of the head for file-type to tell every allowed type apart
const SNIFF_BYTES = 4100;

// A writer is cut off this long before its lease ends, and recovery only
// reads an attempt this long after the lease ended. That makes a late commit
// unlikely by the time absence is read, it does not prove one: a request
// storage already received may still commit, and a paused or dead writer
// process is not stopped by its own deadline. What holds regardless: each
// attempt has its own key that is never replaced, a closed attempt is never
// reopened or adopted as media, and a late object seen by its still-running
// writer is recorded as SUPERSEDED. One that lands after that (e.g. from a
// dead process) stays in storage unreferenced and unrecorded; nothing
// deletes or cleans it up
const WRITE_DEADLINE_MARGIN_MS = 60 * 1000;
export const MANAGED_UPLOAD_RECOVERY_GRACE_MS = 2 * 60 * 1000;

// the environment can lower the bound of a private read, never raise it
const MANAGED_DIGEST_CEILING_BYTES = 64 * 1024 * 1024;

// An object an attempt left in storage is never deleted (no storage deletion
// is authorized for managed uploads) and never referenced by a media row
const OBJECT_RETAINED = 'OBJECT_RETAINED_UNREFERENCED';

// the extension file-type gives each type a reservation may declare
const UPLOAD_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'video/mp4': 'mp4',
};

export interface ManagedMediaUploadState {
  operationKey: string;
  status: MediaUploadRow['status'];
  sha256: string;
  byteLength: number;
  mimeType: string;
  attempt: number;
  leaseExpiresAt: string | null;
  // RECEIVING and the lease ran out: POST .../recover settles the attempt
  recoverable: boolean;
  // why the last recovery could not settle the attempt; the state is held
  recovery: 'READ_FAILED' | 'CHANGED_DURING_READ' | null;
  failureReason: string | null;
  media: {
    mediaId: string;
    evidenceId: string;
    sha256: string;
    byteLength: number;
    mimeType: string;
    method: 'UPLOAD_READBACK';
    sequence: number;
  } | null;
}

type ReadBack =
  | { sha256: string; byteLength: number; mimeType: string | null; version: string }
  | 'ABSENT'
  | 'READ_FAILED'
  | 'CHANGED_DURING_READ'
  | 'TOO_LARGE_FOR_BOUNDED_READ';

type SettleDecision =
  | { outcome: 'STORED'; version: string }
  | {
      outcome: 'ABSENT' | 'BYTES_REJECTED';
      detail: string;
    };

// STORAGE_IDENTITY_UNPROVEN: the media's evidence was recorded before
// evidence was pinned to a key and namespace, so no read can say it is the
// same object; it is held, never re-pinned. STORAGE_IDENTITY_CHANGED: the
// stored path no longer addresses the pinned key, or keys now resolve in
// another namespace than the pinned one
export type ManagedMediaUnverifiedReason =
  | 'NOT_IN_PRIVATE_STORAGE'
  | 'TOO_LARGE_FOR_BOUNDED_READ'
  | 'READ_FAILED'
  | 'CHANGED_DURING_READ'
  | 'STORAGE_HAS_NO_PRIVATE_READ'
  | 'STORAGE_IDENTITY_UNPROVEN'
  | 'STORAGE_IDENTITY_CHANGED';

export type ManagedMediaEvidenceMethod =
  | 'UPLOAD_CAPTURE'
  | 'UPLOAD_READBACK'
  | 'PRIVATE_STORAGE_READ';

// VERIFIED with the evidence that stands for the object: the existing one
// (any method) when the object is unchanged, or a new PRIVATE_STORAGE_READ
export type ManagedMediaVerification =
  | {
      status: 'VERIFIED';
      mediaId: string;
      sha256: string;
      byteLength: number;
      mimeType: string | null;
      method: ManagedMediaEvidenceMethod;
    }
  | {
      status: 'UNVERIFIED';
      mediaId: string;
      reason: ManagedMediaUnverifiedReason;
    };

// Why a fresh look at the object a revision bound could not confirm it.
// MEDIA_REMOVED / MEDIA_NOT_READY / EVIDENCE_*: the database no longer holds
// the evidence the revision recorded for the media's stored path.
// BYTES_MISMATCH: the pinned key holds other bytes (or more of them).
// STORAGE_VERSION_CHANGED: the same digest, but not the pinned version of the
// object, so not the object the evidence was taken from
export type ManagedMediaObservationReason =
  | 'MEDIA_REMOVED'
  | 'MEDIA_NOT_READY'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_CHANGED_SINCE_REVISION'
  | 'STORAGE_HAS_NO_PRIVATE_READ'
  | 'STORAGE_IDENTITY_UNPROVEN'
  | 'STORAGE_IDENTITY_CHANGED'
  | 'NOT_IN_PRIVATE_STORAGE'
  | 'READ_FAILED'
  | 'CHANGED_DURING_READ'
  | 'TOO_LARGE_FOR_BOUNDED_READ'
  | 'BYTES_MISMATCH'
  | 'STORAGE_VERSION_CHANGED';

export type ManagedMediaObservation =
  | { status: 'VERIFIED' }
  | { status: 'UNVERIFIED'; reason: ManagedMediaObservationReason };

// Media byte evidence for managed organizations: either the digest of the
// exact bytes streamed into storage at upload, or a bounded read of a file
// the storage itself holds. Each digest is pinned to the object it was taken
// from: its key, the namespace the key resolved in and the storage's version
// of it. The public URL only says which key to look at; the object is never
// identified by it, and is only read again by the pinned key in the pinned
// namespace. A draft only accepts evidence whose object is still the pinned
// one at the recorded version. A URL is never fetched and a caller's digest
// is never stored as evidence.
@Injectable()
export class ManagedMediaService {
  private storage = UploadFactory.createStorage();
  // how long one attempt may take to hand its bytes to storage
  private writeDeadlineMs = MANAGED_UPLOAD_LEASE_MS - WRITE_DEADLINE_MARGIN_MS;

  constructor(private _managedRepository: ManagedRepository) {}

  // `head` keeps the first bytes so the type can be sniffed from what was read.
  // An aborted `signal` destroys the stream mid-read: READ_FAILED
  private async digestBounded(
    stream: Readable,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<
    | { sha256: string; byteLength: number; head: Buffer }
    | 'TOO_LARGE_FOR_BOUNDED_READ'
    | 'READ_FAILED'
  > {
    if (signal) {
      addAbortSignal(signal, stream);
    }

    const hash = createHash('sha256');
    let byteLength = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const chunk of stream) {
        byteLength += chunk.length;
        if (byteLength > maxBytes) {
          stream.destroy();
          return 'TOO_LARGE_FOR_BOUNDED_READ';
        }
        hash.update(chunk);
        if (head.length < SNIFF_BYTES) {
          head = Buffer.concat([head, Buffer.from(chunk)]).subarray(
            0,
            SNIFF_BYTES
          );
        }
      }
    } catch (err) {
      stream.destroy();
      return 'READ_FAILED';
    }

    return { sha256: hash.digest('hex'), byteLength, head };
  }

  // what stored media is read through: by key, inside one namespace
  private canReadByKey() {
    return (
      !!this.storage.objectKeyOf &&
      !!this.storage.objectNamespace &&
      !!this.storage.objectVersionAt &&
      !!this.storage.openObjectAt
    );
  }

  private async currentVersion(key: string) {
    try {
      return await this.storage.objectVersionAt!(key);
    } catch (err) {
      return null;
    }
  }

  // The version of the pinned key, read only while keys resolve in the
  // pinned namespace before and after the read; null when they did not or
  // storage could not answer
  private async pinnedVersion(key: string, namespace: string) {
    if ((await this.storageNamespace()) !== namespace) {
      return null;
    }

    const version = await this.currentVersion(key);
    return version && (await this.storageNamespace()) === namespace
      ? version
      : null;
  }

  // Evidence whose object is still the pinned one: the stored path still
  // addresses the pinned key and the key, in the pinned namespace, is still
  // at the recorded version. Evidence recorded without a pin is never current
  private async isCurrent(media: MediaRow, evidence: EvidenceRow) {
    if (
      !evidence.storageKey ||
      !evidence.storageNamespace ||
      !evidence.storageVersion ||
      !this.canReadByKey() ||
      this.storage.objectKeyOf!(media.path) !== evidence.storageKey
    ) {
      return false;
    }

    return (
      (await this.pinnedVersion(
        evidence.storageKey,
        evidence.storageNamespace
      )) === evidence.storageVersion
    );
  }

  // Not routed: POST /managed/v1/media answers 410 before any byte is read.
  // Kept only for the direct database checks; reserved uploads below are the
  // managed upload path
  async recordCapturedUpload(
    organizationId: string,
    credentialId: string,
    file: CapturedUploadFile | undefined
  ): Promise<ManagedMediaVerification> {
    if (!file) {
      throw new ManagedBadRequestException('No file provided');
    }

    // The key is random and not known to anyone before the media row exists,
    // so the version read right after the upload, by that key inside one
    // namespace, is the uploaded object's. Unlike a reserved upload's
    // read-back, this rests on the key not existing in another namespace:
    // the captured digest is of the bytes streamed, not of a read
    const storageKey =
      file.capturedDigest && this.canReadByKey()
        ? this.storage.objectKeyOf!(file.path)
        : null;
    const storageNamespace = storageKey ? await this.storageNamespace() : null;
    const storageVersion = storageNamespace
      ? await this.currentVersion(storageKey!)
      : null;

    if (
      !file.capturedDigest ||
      !storageKey ||
      (storageNamespace && !storageVersion)
    ) {
      // never store media without its digest and version: drop the file
      await this.storage.removeFile(file.path).catch(() => {});
      throw new ManagedBadRequestException(
        file.capturedDigest
          ? 'The stored upload has no storage version'
          : 'The upload was not captured'
      );
    }

    // without its namespace the file's URL may resolve elsewhere by now, so
    // it is neither recorded nor removed by that URL
    if (
      !storageNamespace ||
      (await this.storageNamespace()) !== storageNamespace
    ) {
      throw new ManagedBadRequestException(
        'Storage could not be identified; the upload was not recorded'
      );
    }

    const { sha256, byteLength } = file.capturedDigest;

    try {
      return await this._managedRepository.mutate(
        organizationId,
        async (tx) => {
          const sequence = tx.nextSequence();
          const media = await tx.createMedia({
            name: file.filename,
            path: file.path,
            originalName: file.originalname || null,
          });

          await tx.createEvidence({
            mediaId: media.id,
            storedPath: media.path,
            storageVersion,
            storageKey,
            storageNamespace,
            sha256,
            byteLength,
            mimeType: file.mimetype || null,
            method: 'UPLOAD_CAPTURE',
            sequence,
            credentialId,
          });

          await tx.appendEvent({
            sequence,
            kind: 'MEDIA_EVIDENCE_RECORDED',
            entityType: 'MEDIA',
            entityId: media.id,
            revision: null,
            bindingGeneration: null,
            operationKey: null,
            data: JSON.stringify({
              sha256,
              byteLength,
              mimeType: file.mimetype || null,
              method: 'UPLOAD_CAPTURE',
            }),
          });

          return {
            status: 'VERIFIED' as const,
            mediaId: media.id,
            sha256,
            byteLength,
            mimeType: file.mimetype || null,
            method: 'UPLOAD_CAPTURE' as const,
          };
        }
      );
    } catch (err) {
      await this.storage.removeFile(file.path).catch(() => {});
      throw err;
    }
  }

  async verifyStoredMedia(
    organizationId: string,
    credentialId: string,
    mediaId: string
  ): Promise<ManagedMediaVerification> {
    const [entry] = await this._managedRepository.read(
      organizationId,
      (reader) => reader.getMediaWithEvidence([mediaId])
    );

    if (!entry) {
      throw new ManagedNotFoundException('Media not found');
    }

    const unverified = (reason: ManagedMediaUnverifiedReason) => ({
      status: 'UNVERIFIED' as const,
      mediaId,
      reason,
    });

    if (!this.canReadByKey()) {
      return unverified('STORAGE_HAS_NO_PRIVATE_READ');
    }

    // Media that already has evidence for its stored path is only read again
    // as the object that evidence was pinned to. Evidence without a pin is
    // held: a fresh read in whatever namespace is current now would bless an
    // object nothing ties to the one first proven. A pin without a version
    // is held too: no read could show it is still that object, and a new
    // row would replace it and drop the type it proved
    const pinned = entry.evidence;
    if (
      pinned &&
      (!pinned.storageKey || !pinned.storageNamespace || !pinned.storageVersion)
    ) {
      return unverified('STORAGE_IDENTITY_UNPROVEN');
    }

    const key = this.storage.objectKeyOf!(entry.media.path);
    if (!key || (pinned && pinned.storageKey !== key)) {
      return unverified(
        pinned ? 'STORAGE_IDENTITY_CHANGED' : 'NOT_IN_PRIVATE_STORAGE'
      );
    }

    const namespace = await this.storageNamespace();
    if (!namespace) {
      return unverified('READ_FAILED');
    }
    if (pinned && pinned.storageNamespace !== namespace) {
      return unverified('STORAGE_IDENTITY_CHANGED');
    }

    let opened: { stream: Readable; version: string } | null;
    try {
      opened = await this.storage.openObjectAt!(key);
    } catch (err) {
      return unverified('READ_FAILED');
    }

    if (!opened) {
      return unverified('NOT_IN_PRIVATE_STORAGE');
    }

    const digest = await this.digestBounded(
      opened.stream,
      Math.min(managedMaxDigestBytes(), MANAGED_DIGEST_CEILING_BYTES)
    );
    if (typeof digest === 'string') {
      return unverified(digest);
    }

    // the object may have been rewritten, or keys moved to another
    // namespace, while it was read
    if ((await this.pinnedVersion(key, namespace)) !== opened.version) {
      return unverified('CHANGED_DURING_READ');
    }

    // Still the very object the evidence was pinned to, with its bytes: that
    // evidence stands as it is (its id, type and method), and nothing is
    // recorded. A new row would replace it as the media's evidence, drop the
    // type it proved and stop matching the revisions bound to it. The media
    // and its evidence are read again first: a path or evidence that moved
    // while the bytes were read is not what they prove
    if (
      pinned &&
      pinned.storageVersion === opened.version &&
      pinned.sha256 === digest.sha256 &&
      pinned.byteLength === digest.byteLength
    ) {
      const [current] = await this._managedRepository.read(
        organizationId,
        (reader) => reader.getMediaWithEvidence([mediaId])
      );
      if (
        !current ||
        current.media.path !== entry.media.path ||
        !current.evidence ||
        current.evidence.id !== pinned.id ||
        current.evidence.storageVersion !== pinned.storageVersion ||
        current.evidence.sha256 !== pinned.sha256 ||
        current.evidence.byteLength !== pinned.byteLength ||
        current.evidence.storageNamespace !== pinned.storageNamespace ||
        current.evidence.storageKey !== pinned.storageKey
      ) {
        return unverified('CHANGED_DURING_READ');
      }

      return {
        status: 'VERIFIED' as const,
        mediaId,
        sha256: pinned.sha256,
        byteLength: pinned.byteLength,
        mimeType: pinned.mimeType,
        method: pinned.method as ManagedMediaEvidenceMethod,
      };
    }

    return this._managedRepository.mutate(organizationId, async (tx) => {
      // the bytes only prove the path they were read from
      const [current] = await tx.getMediaWithEvidence([mediaId]);
      if (!current || current.media.path !== entry.media.path) {
        return unverified('CHANGED_DURING_READ');
      }

      // evidence recorded meanwhile must be pinned to this very object
      if (
        current.evidence &&
        (current.evidence.storageKey !== key ||
          current.evidence.storageNamespace !== namespace)
      ) {
        return unverified('STORAGE_IDENTITY_CHANGED');
      }

      const sequence = tx.nextSequence();
      await tx.createEvidence({
        mediaId,
        storedPath: current.media.path,
        storageVersion: opened!.version,
        storageKey: key,
        storageNamespace: namespace,
        sha256: digest.sha256,
        byteLength: digest.byteLength,
        mimeType: null,
        method: 'PRIVATE_STORAGE_READ',
        sequence,
        credentialId,
      });

      await tx.appendEvent({
        sequence,
        kind: 'MEDIA_EVIDENCE_RECORDED',
        entityType: 'MEDIA',
        entityId: mediaId,
        revision: null,
        bindingGeneration: null,
        operationKey: null,
        data: JSON.stringify({
          sha256: digest.sha256,
          byteLength: digest.byteLength,
          method: 'PRIVATE_STORAGE_READ',
        }),
      });

      return {
        status: 'VERIFIED' as const,
        mediaId,
        sha256: digest.sha256,
        byteLength: digest.byteLength,
        mimeType: null,
        method: 'PRIVATE_STORAGE_READ' as const,
      };
    });
  }

  // Ids of the evidence whose pinned object is still at the recorded version
  // (see isCurrent). Read from storage before the draft transaction (no
  // storage call is made while the organization lock is held); the
  // transaction then only accepts evidence that is in this set, so evidence
  // recorded after this read is not accepted either
  async currentEvidence(organizationId: string, mediaIds: string[]) {
    if (!mediaIds.length) {
      return new Set<string>();
    }

    const entries = await this._managedRepository.read(
      organizationId,
      (reader) => reader.getMediaWithEvidence(mediaIds)
    );

    const current = await Promise.all(
      entries.map(async ({ media, evidence }) =>
        evidence && (await this.isCurrent(media, evidence))
          ? evidence.id
          : null
      )
    );

    return new Set(current.filter((id): id is string => !!id));
  }

  // Observation only: reads the object a revision's evidence was pinned to,
  // by its key in its namespace, and compares digest, size and version with
  // that evidence. Nothing is written to the database or to storage, and
  // nothing is re-pinned or recorded, whatever the read finds. `entry` is
  // what the database holds for the media now; `recorded` is the evidence
  // the revision bound. An aborted `signal` stops the read (READ_FAILED)
  async observeEvidence(
    entry: MediaWithEvidence | undefined,
    recorded: { evidenceId: string; sha256: string; byteLength: number },
    signal?: AbortSignal
  ): Promise<ManagedMediaObservation> {
    const unverified = (reason: ManagedMediaObservationReason) => ({
      status: 'UNVERIFIED' as const,
      reason,
    });

    if (!entry) {
      return unverified('MEDIA_REMOVED');
    }
    if (entry.media.status !== 'ready') {
      return unverified('MEDIA_NOT_READY');
    }

    const evidence = entry.evidence;
    if (!evidence) {
      return unverified('EVIDENCE_MISSING');
    }
    if (
      evidence.id !== recorded.evidenceId ||
      evidence.sha256 !== recorded.sha256 ||
      evidence.byteLength !== recorded.byteLength
    ) {
      return unverified('EVIDENCE_CHANGED_SINCE_REVISION');
    }

    if (!this.canReadByKey()) {
      return unverified('STORAGE_HAS_NO_PRIVATE_READ');
    }
    if (
      !evidence.storageKey ||
      !evidence.storageNamespace ||
      !evidence.storageVersion
    ) {
      return unverified('STORAGE_IDENTITY_UNPROVEN');
    }
    if (this.storage.objectKeyOf!(entry.media.path) !== evidence.storageKey) {
      return unverified('STORAGE_IDENTITY_CHANGED');
    }

    if (
      evidence.byteLength >
      Math.min(managedMaxDigestBytes(), MANAGED_DIGEST_CEILING_BYTES)
    ) {
      return unverified('TOO_LARGE_FOR_BOUNDED_READ');
    }

    const namespace = await this.storageNamespace();
    if (!namespace) {
      return unverified('READ_FAILED');
    }
    if (namespace !== evidence.storageNamespace) {
      return unverified('STORAGE_IDENTITY_CHANGED');
    }

    // bounded by the recorded size: an object that grew is other bytes
    const read = await this.readBackKey(
      evidence.storageKey,
      evidence.byteLength,
      signal
    );
    if ((await this.storageNamespace()) !== evidence.storageNamespace) {
      return unverified('STORAGE_IDENTITY_CHANGED');
    }
    if (read === 'ABSENT') {
      return unverified('NOT_IN_PRIVATE_STORAGE');
    }
    if (read === 'TOO_LARGE_FOR_BOUNDED_READ') {
      return unverified('BYTES_MISMATCH');
    }
    if (typeof read === 'string') {
      return unverified(read);
    }

    if (
      read.sha256 !== evidence.sha256 ||
      read.byteLength !== evidence.byteLength
    ) {
      return unverified('BYTES_MISMATCH');
    }
    if (read.version !== evidence.storageVersion) {
      return unverified('STORAGE_VERSION_CHANGED');
    }

    return { status: 'VERIFIED' };
  }

  // Reserved uploads (docs/managed-extension/README.md, "Reserved media
  // uploads"). The reservation and each attempt's exact object identity are
  // committed before a byte is written; evidence is only recorded for an
  // object read back from storage with the declared digest, size and type.
  // No storage call is made while the organization lock is held.

  private canReserve() {
    return (
      this.canReadByKey() &&
      !!this.storage.objectPath &&
      !!this.storage.createObjectAt
    );
  }

  // null when storage cannot say which namespace its keys resolve in now
  private async storageNamespace() {
    try {
      return await this.storage.objectNamespace!();
    } catch (err) {
      return null;
    }
  }

  // the lease ran out and so did the grace period after it
  private recoverable(upload: MediaUploadRow) {
    return (
      !!upload.leaseExpiresAt &&
      upload.leaseExpiresAt.getTime() + MANAGED_UPLOAD_RECOVERY_GRACE_MS <=
        Date.now()
    );
  }

  private uploadState(
    upload: MediaUploadRow,
    recovery: ManagedMediaUploadState['recovery'] = null
  ): ManagedMediaUploadState {
    return {
      operationKey: upload.operationKey,
      status: upload.status,
      sha256: upload.sha256,
      byteLength: upload.byteLength,
      mimeType: upload.mimeType,
      attempt: upload.attempt,
      leaseExpiresAt: upload.leaseExpiresAt?.toISOString() ?? null,
      recoverable: upload.status === 'RECEIVING' && this.recoverable(upload),
      recovery,
      failureReason: upload.failureReason,
      media:
        upload.status === 'COMPLETED'
          ? {
              mediaId: upload.mediaId!,
              evidenceId: upload.evidenceId!,
              sha256: upload.sha256,
              byteLength: upload.byteLength,
              mimeType: upload.mimeType,
              method: 'UPLOAD_READBACK',
              sequence: upload.completedSequence!,
            }
          : null,
    };
  }

  // the key is bound to the credential that reserved it
  private async ownUpload(
    reader: ManagedReader,
    credentialId: string,
    operationKey: string
  ) {
    const upload = MANAGED_OPERATION_KEY.test(operationKey)
      ? await reader.getMediaUpload(operationKey)
      : null;
    if (!upload) {
      throw new ManagedNotFoundException('Upload reservation not found');
    }

    if (upload.credentialId !== credentialId) {
      throw new ManagedConflictException(
        'OPERATION_KEY_CREDENTIAL_MISMATCH',
        'This operation key was reserved by another credential'
      );
    }

    return upload;
  }

  async reserveUpload(
    organizationId: string,
    credentialId: string,
    body: ReserveManagedMediaUploadDto
  ) {
    if (!this.canReserve()) {
      throw new ManagedConflictException(
        'STORAGE_HAS_NO_PRIVATE_READ',
        'This storage cannot take reserved uploads'
      );
    }

    if (
      body.byteLength > MANAGED_UPLOAD_MAX_BYTES ||
      body.byteLength > getMaxSize(body.mimeType)
    ) {
      throw new ManagedBadRequestException('File is too large.');
    }

    // fixed key order, so the hash is canonical
    const requestHash = sha256Hex(
      JSON.stringify({
        kind: 'MEDIA_UPLOAD',
        byteLength: body.byteLength,
        mimeType: body.mimeType,
        sha256: body.sha256,
      })
    );

    return this._managedRepository.mutate(organizationId, async (tx) => {
      const existing = await tx.getMediaUpload(body.operationKey);
      if (existing) {
        await this.ownUpload(tx, credentialId, body.operationKey);
        if (existing.requestHash !== requestHash) {
          throw new ManagedConflictException(
            'OPERATION_KEY_PAYLOAD_MISMATCH',
            'This operation key was reserved for other bytes'
          );
        }

        return { ...this.uploadState(existing), replayed: true };
      }

      // A new key does not get around an attempt for the same bytes whose
      // effect is unknown (still receiving, or held until it can be read):
      // that attempt is recovered under its own key first
      const ambiguous = await tx.getReceivingMediaUpload(requestHash);
      if (ambiguous) {
        throw this.recoverable(ambiguous)
          ? new ManagedConflictException(
              'UPLOAD_NEEDS_RECOVERY',
              'An earlier reservation of these bytes did not finish; recover it under its own operation key first'
            )
          : new ManagedConflictException(
              'UPLOAD_IN_PROGRESS',
              'An earlier reservation of these bytes is receiving them'
            );
      }

      const created = await tx.createMediaUpload({
        operationKey: body.operationKey,
        credentialId,
        requestHash,
        sha256: body.sha256,
        byteLength: body.byteLength,
        mimeType: body.mimeType,
      });

      return { ...this.uploadState(created), replayed: false };
    });
  }

  async uploadStatus(
    organizationId: string,
    credentialId: string,
    operationKey: string
  ) {
    return this.uploadState(
      await this._managedRepository.read(organizationId, (reader) =>
        this.ownUpload(reader, credentialId, operationKey)
      )
    );
  }

  // A bounded private read of the attempt's object, by the key it was
  // created under, with the type sniffed from the bytes read and the
  // object's version unchanged across the read. ABSENT only when storage
  // says the key does not exist; a storage whose address or namespace for
  // the key moved since the claim, or while the key was read, cannot say
  // where the object went. An attempt without a recorded namespace is never
  // guessed
  private async readBack(
    attempt: MediaUploadAttemptRow,
    maxBytes: number
  ): Promise<ReadBack> {
    const key = attempt.storageKey;
    if (
      this.storage.objectPath!(key) !== attempt.storedPath ||
      !attempt.storageNamespace ||
      (await this.storageNamespace()) !== attempt.storageNamespace
    ) {
      return 'READ_FAILED';
    }

    const read = await this.readBackKey(key, maxBytes);
    return (await this.storageNamespace()) === attempt.storageNamespace
      ? read
      : 'READ_FAILED';
  }

  private async readBackKey(
    key: string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<ReadBack> {
    if (signal?.aborted) {
      return 'READ_FAILED';
    }

    let before: string | null;
    try {
      before = await this.storage.objectVersionAt!(key);
    } catch (err) {
      return 'READ_FAILED';
    }

    if (!before) {
      return 'ABSENT';
    }

    let opened: { stream: Readable; version: string } | null;
    try {
      opened = await this.storage.openObjectAt!(key);
    } catch (err) {
      return 'READ_FAILED';
    }

    if (!opened || opened.version !== before) {
      opened?.stream.destroy();
      return 'CHANGED_DURING_READ';
    }

    const digest = await this.digestBounded(opened.stream, maxBytes, signal);
    if (typeof digest === 'string') {
      return digest;
    }

    let after: string | null;
    try {
      after = await this.storage.objectVersionAt!(key);
    } catch (err) {
      return 'READ_FAILED';
    }

    if (after !== opened.version) {
      return 'CHANGED_DURING_READ';
    }

    let mimeType: string | null = null;
    try {
      mimeType = (await fileTypeFromBuffer(digest.head))?.mime || null;
    } catch (err) {}

    return {
      sha256: digest.sha256,
      byteLength: digest.byteLength,
      mimeType,
      version: opened.version,
    };
  }

  private mismatch(
    upload: MediaUploadRow,
    read: Exclude<ReadBack, string>
  ): 'MEDIA_SIZE_MISMATCH' | 'MEDIA_DIGEST_MISMATCH' | 'MEDIA_TYPE_MISMATCH' | null {
    if (read.byteLength !== upload.byteLength) {
      return 'MEDIA_SIZE_MISMATCH';
    }
    if (read.sha256 !== upload.sha256) {
      return 'MEDIA_DIGEST_MISMATCH';
    }
    if (read.mimeType !== upload.mimeType) {
      return 'MEDIA_TYPE_MISMATCH';
    }
    return null;
  }

  // The attempt provably left nothing usable: the reservation takes another
  // attempt, or fails for good once the attempts are used up. Rejected bytes
  // stay in storage, and the attempt says so
  private async closeAttempt(
    tx: ManagedTx,
    upload: MediaUploadRow,
    attempt: MediaUploadAttemptRow,
    outcome: 'ABSENT' | 'BYTES_REJECTED',
    detail: string
  ) {
    await tx.updateMediaUploadAttempt(attempt.id, {
      outcome,
      detail:
        outcome === 'BYTES_REJECTED' ? `${detail};${OBJECT_RETAINED}` : detail,
    });
    if (upload.attempt < MANAGED_UPLOAD_MAX_ATTEMPTS) {
      return tx.updateMediaUpload(upload.id, {
        status: 'RESERVED',
        leaseExpiresAt: null,
      });
    }

    const sequence = tx.nextSequence();
    await tx.appendEvent({
      sequence,
      kind: 'MEDIA_UPLOAD_FAILED',
      entityType: 'MEDIA_UPLOAD',
      entityId: upload.id,
      revision: null,
      bindingGeneration: null,
      operationKey: upload.operationKey,
      data: JSON.stringify({ reason: detail, attempts: upload.attempt }),
    });

    return tx.updateMediaUpload(upload.id, {
      status: 'FAILED',
      leaseExpiresAt: null,
      failureReason: detail,
      completedSequence: sequence,
    });
  }

  // The terminal record: media, evidence and feed event in the transaction
  // that ends the attempt
  private async completeAttempt(
    tx: ManagedTx,
    upload: MediaUploadRow,
    attempt: MediaUploadAttemptRow,
    version: string
  ) {
    const sequence = tx.nextSequence();
    const media = await tx.createMedia({
      name: attempt.storageKey,
      path: attempt.storedPath,
      originalName: null,
    });

    // pinned to the attempt's key, in the namespace the read-back checked
    // before and after reading it
    const evidence = await tx.createEvidence({
      mediaId: media.id,
      storedPath: media.path,
      storageVersion: version,
      storageKey: attempt.storageKey,
      storageNamespace: attempt.storageNamespace,
      sha256: upload.sha256,
      byteLength: upload.byteLength,
      mimeType: upload.mimeType,
      method: 'UPLOAD_READBACK',
      sequence,
      credentialId: upload.credentialId,
    });

    await tx.appendEvent({
      sequence,
      kind: 'MEDIA_EVIDENCE_RECORDED',
      entityType: 'MEDIA',
      entityId: media.id,
      revision: null,
      bindingGeneration: null,
      operationKey: upload.operationKey,
      data: JSON.stringify({
        sha256: upload.sha256,
        byteLength: upload.byteLength,
        mimeType: upload.mimeType,
        method: 'UPLOAD_READBACK',
      }),
    });

    await tx.updateMediaUploadAttempt(attempt.id, {
      outcome: 'STORED',
      detail: null,
    });

    return tx.updateMediaUpload(upload.id, {
      status: 'COMPLETED',
      leaseExpiresAt: null,
      mediaId: media.id,
      evidenceId: evidence.id,
      completedSequence: sequence,
    });
  }

  // What a read-back proves about an attempt; null when storage could not
  // answer, so the attempt stays held. `streamed` is the digest of the bytes
  // this process handed to storage, when it is the writer
  private decide(
    upload: MediaUploadRow,
    read: ReadBack,
    streamed?: { sha256: string }
  ): SettleDecision | null {
    if (read === 'ABSENT') {
      return { outcome: 'ABSENT', detail: 'NOTHING_STORED' };
    }
    if (read === 'TOO_LARGE_FOR_BOUNDED_READ') {
      return { outcome: 'BYTES_REJECTED', detail: 'MEDIA_SIZE_MISMATCH' };
    }
    if (typeof read === 'string') {
      return null;
    }

    const mismatch =
      streamed && streamed.sha256 !== read.sha256
        ? 'MEDIA_DIGEST_MISMATCH'
        : this.mismatch(upload, read);

    return mismatch
      ? { outcome: 'BYTES_REJECTED', detail: mismatch }
      : { outcome: 'STORED', version: read.version };
  }

  // Applies a decision, but only while the attempt still owns the
  // reservation; `settled` is null when another attempt or a recovery got
  // there first, and `current` is what the reservation is now
  private settleAttempt(
    organizationId: string,
    upload: MediaUploadRow,
    attempt: MediaUploadAttemptRow,
    decision: SettleDecision
  ) {
    return this._managedRepository.mutate(organizationId, async (tx) => {
      const current = await tx.getMediaUpload(upload.operationKey);
      if (
        !current ||
        current.status !== 'RECEIVING' ||
        current.attempt !== attempt.attempt
      ) {
        // a writer that outlived its lease: the attempt was closed without
        // the object it has now. Recorded with what it was closed as; the
        // object is never adopted and never deleted
        const row =
          decision.outcome !== 'ABSENT'
            ? await tx.getMediaUploadAttempt(upload.id, attempt.attempt)
            : null;
        if (row?.outcome === 'ABSENT' || row?.outcome === 'BYTES_REJECTED') {
          await tx.supersedeMediaUploadAttempt(
            row.id,
            row,
            JSON.stringify({
              closedAs: row.outcome,
              closedDetail: row.detail,
              lateObject:
                decision.outcome === 'STORED'
                  ? 'MATCHES_RESERVATION'
                  : decision.detail,
              retention: OBJECT_RETAINED,
            })
          );
        }

        return { settled: null, current };
      }

      return {
        settled:
          decision.outcome === 'STORED'
            ? await this.completeAttempt(tx, current, attempt, decision.version)
            : await this.closeAttempt(
                tx,
                current,
                attempt,
                decision.outcome,
                decision.detail
              ),
        current,
      };
    });
  }

  // Bytes for a reservation, as the raw request body. Only one attempt can
  // hold a reservation; a completed reservation answers with its record and
  // the body is not stored again
  async receiveUploadContent(
    organizationId: string,
    credentialId: string,
    operationKey: string,
    body: Readable,
    contentType: string | undefined,
    contentLength: string | undefined
  ) {
    if (!this.canReserve()) {
      throw new ManagedConflictException(
        'STORAGE_HAS_NO_PRIVATE_READ',
        'This storage cannot take reserved uploads'
      );
    }

    if (
      String(contentType || '').split(';')[0].trim().toLowerCase() !==
      'application/octet-stream'
    ) {
      throw new ManagedBadRequestException(
        'The content must be sent as application/octet-stream'
      );
    }

    const declared = /^\d{1,9}$/.test(String(contentLength))
      ? Number(contentLength)
      : NaN;

    // read before the organization lock; pinned to the attempt below
    const namespace = await this.storageNamespace();

    const claim = await this._managedRepository.mutate(
      organizationId,
      async (tx) => {
        const upload = await this.ownUpload(tx, credentialId, operationKey);
        if (upload.status === 'COMPLETED') {
          return { completed: upload };
        }

        if (upload.status === 'FAILED') {
          throw new ManagedConflictException(
            'UPLOAD_FAILED',
            'This reservation failed; reserve a new operation key'
          );
        }

        if (upload.status === 'RECEIVING') {
          // never a second write while the first one's effect is unknown
          throw this.recoverable(upload)
            ? new ManagedConflictException(
                'UPLOAD_NEEDS_RECOVERY',
                'The previous attempt did not finish; recover it first'
              )
            : new ManagedConflictException(
                'UPLOAD_IN_PROGRESS',
                'Another attempt is receiving this upload'
              );
        }

        if (declared !== upload.byteLength) {
          throw new ManagedUnprocessableException(
            'MEDIA_SIZE_MISMATCH',
            'Content-Length must equal the reserved byteLength'
          );
        }

        // no attempt is claimed without the namespace it will be read in
        if (!namespace) {
          throw new ManagedConflictException(
            'STORAGE_HAS_NO_PRIVATE_READ',
            'Storage could not be identified; nothing was written'
          );
        }

        const number = upload.attempt + 1;
        const storageKey = `managed-${upload.id}-${number}.${
          UPLOAD_EXTENSIONS[upload.mimeType]
        }`;
        const attempt = await tx.createMediaUploadAttempt({
          uploadId: upload.id,
          attempt: number,
          storageKey,
          storedPath: this.storage.objectPath!(storageKey),
          storageNamespace: namespace,
        });

        return {
          upload: await tx.updateMediaUpload(upload.id, {
            status: 'RECEIVING',
            attempt: number,
            leaseExpiresAt: new Date(Date.now() + MANAGED_UPLOAD_LEASE_MS),
          }),
          attempt,
        };
      }
    );

    if ('completed' in claim) {
      return { ...this.uploadState(claim.completed!), replayed: true };
    }

    const { upload, attempt } = claim;
    const needsRecovery = () =>
      new ManagedConflictException(
        'UPLOAD_NEEDS_RECOVERY',
        'Storage may hold bytes of this attempt; recover it once the lease and its grace period end'
      );

    // this process's write ends before the lease does: the abort tears down
    // the body, the pipeline and our side of the storage request
    const deadline = AbortSignal.timeout(this.writeDeadlineMs);

    let handedOver = false;
    let streamed:
      | { sha256: string; byteLength: number }
      | 'UNCONFIRMED'
      | undefined;
    let writeError: unknown = null;
    try {
      streamed = await this.writeAttempt(
        upload,
        attempt,
        body,
        deadline,
        () => (handedOver = true)
      );
    } catch (err) {
      writeError = err;
    }

    if (writeError && !handedOver) {
      // refused before storage was handed a byte: provably nothing stored
      await this.settleAttempt(organizationId, upload, attempt, {
        outcome: 'ABSENT',
        detail:
          writeError instanceof ManagedUnprocessableException
            ? writeError.code
            : 'WRITE_FAILED',
      });
      throw writeError;
    }

    // storage answered before it read the body to its end: neither its
    // acknowledgement nor a read-back now says what the attempt left
    if (streamed === 'UNCONFIRMED') {
      throw needsRecovery();
    }

    // Absence right after storage was handed the bytes proves nothing yet:
    // an acknowledged object that is not there, or a request that may still
    // commit. Recovery reads the key again after the lease and grace period
    const decision = this.decide(
      upload,
      await this.readBack(attempt, upload.byteLength),
      streamed
    );
    if (!decision || decision.outcome === 'ABSENT') {
      throw needsRecovery();
    }

    const { settled, current } = await this.settleAttempt(
      organizationId,
      upload,
      attempt,
      decision
    );

    if (!settled) {
      if (
        current?.status === 'COMPLETED' &&
        current.attempt === attempt.attempt
      ) {
        // a recovery completed this very attempt meanwhile
        return { ...this.uploadState(current), replayed: true };
      }

      throw new ManagedConflictException(
        'UPLOAD_SUPERSEDED',
        'This attempt no longer owns the reservation'
      );
    }

    // decided from what storage holds: the exact reserved bytes complete the
    // upload even when the write itself failed (a lost acknowledgement)
    if (decision.outcome !== 'STORED') {
      throw writeError instanceof HttpException
        ? writeError
        : new ManagedUnprocessableException(
            decision.detail as ManagedUnprocessableCode,
            'The stored bytes do not match the reservation'
          );
    }

    return { ...this.uploadState(settled), replayed: false };
  }

  // Sniffs the type before the first byte is written, caps the body at the
  // reserved size and digests exactly what is handed to storage.
  // `handOver` is called right before storage may receive a byte.
  // UNCONFIRMED when storage resolved before the body was read to its end:
  // the body is torn down and no digest is taken of a partial stream
  private async writeAttempt(
    upload: MediaUploadRow,
    attempt: MediaUploadAttemptRow,
    body: Readable,
    signal: AbortSignal,
    handOver: () => void
  ): Promise<{ sha256: string; byteLength: number } | 'UNCONFIRMED'> {
    // a body that stalls before its first bytes ends at the deadline too
    addAbortSignal(signal, body);

    let sniffed: ReadableStream & { fileType?: { mime: string } };
    try {
      sniffed = await fileTypeStream(Readable.toWeb(body));
    } catch (err) {
      throw new ManagedBadRequestException('Failed to read file');
    }

    if (sniffed.fileType?.mime !== upload.mimeType) {
      await sniffed.cancel();
      throw new ManagedUnprocessableException(
        'MEDIA_TYPE_MISMATCH',
        'The bytes are not of the reserved type'
      );
    }

    // the key is only written in the namespace the attempt was pinned to
    if ((await this.storageNamespace()) !== attempt.storageNamespace) {
      await sniffed.cancel();
      throw new ManagedConflictException(
        'STORAGE_HAS_NO_PRIVATE_READ',
        'Storage moved to another namespace; nothing was written'
      );
    }

    if (signal.aborted) {
      await sniffed.cancel();
      throw new ManagedBadRequestException(
        'The upload did not reach storage before its deadline'
      );
    }

    // the body's own failure (the size cap, the deadline) is the answer, not
    // the storage error it caused
    let bodyError: unknown = null;
    let bodyDone!: () => void;
    const finished = new Promise<void>((resolve) => (bodyDone = resolve));
    const capture = digestStream();
    const stream = pipeline(
      Readable.fromWeb(sniffed as any),
      maxSizeStream(upload.byteLength),
      capture.transform,
      (err) => {
        bodyError = err || null;
        bodyDone();
      }
    );

    handOver();
    try {
      await this.storage.createObjectAt!(
        attempt.storageKey,
        stream,
        upload.mimeType,
        upload.byteLength,
        signal
      );
    } catch (err) {
      stream.destroy();
      throw bodyError || err;
    }

    // an acknowledgement before the body's end is not one: stop the body so
    // nothing is hashed after this, and hold the attempt
    if (!stream.readableEnded) {
      stream.destroy();
      return 'UNCONFIRMED';
    }

    // the digest is only taken once every byte went through it
    await finished;
    return bodyError ? 'UNCONFIRMED' : capture.digest();
  }

  // After the lease of a RECEIVING attempt ran out (the worker died, or its
  // response was lost): reads back the attempt's recorded object and settles
  // it. Nothing is written to storage here
  async recoverUpload(
    organizationId: string,
    credentialId: string,
    operationKey: string
  ) {
    const upload = await this._managedRepository.read(
      organizationId,
      (reader) => this.ownUpload(reader, credentialId, operationKey)
    );

    if (upload.status !== 'RECEIVING') {
      return this.uploadState(upload);
    }

    if (!this.recoverable(upload)) {
      throw new ManagedConflictException(
        'UPLOAD_IN_PROGRESS',
        'The attempt still holds its lease or its grace period'
      );
    }

    if (!this.canReserve()) {
      return this.uploadState(upload, 'READ_FAILED');
    }

    const attempt = await this._managedRepository.read(
      organizationId,
      (reader) => reader.getMediaUploadAttempt(upload.id, upload.attempt)
    );
    if (!attempt) {
      return this.uploadState(upload, 'READ_FAILED');
    }

    const read = await this.readBack(attempt, upload.byteLength);
    const decision = this.decide(upload, read);
    if (!decision) {
      // explicitly held: nothing is decided until storage can answer
      return this.uploadState(
        upload,
        read as 'READ_FAILED' | 'CHANGED_DURING_READ'
      );
    }

    const { settled, current } = await this.settleAttempt(
      organizationId,
      upload,
      attempt,
      decision
    );

    return this.uploadState(settled || current!);
  }
}

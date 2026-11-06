import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import type {
  ManagedMediaCapabilityDraft, ManagedMediaCapabilityRecord,
  ManagedMediaCapabilityStore, ManagedMediaRevokeReason,
} from './managed.lifecycle.media-capability';

const SELECT = {
  capabilityIdSha256: true, keyId: true, organizationId: true,
  dispatchId: true, callId: true, dispatchVersion: true,
  mediaId: true, evidenceId: true, sha256: true, byteLength: true, mimeType: true,
  storageKey: true, storageNamespace: true, storageVersion: true,
  issuedAt: true, expiresAt: true, maxFetches: true, fetchCount: true,
  revokedAt: true, revokeReason: true,
} as const;

// Only the capability service sees these server-private rows. Tokens are
// never stored and no method replaces or deletes a previous capability.
@Injectable()
export class ManagedLifecycleMediaRepository implements ManagedMediaCapabilityStore {
  constructor(private readonly repository: PrismaRepository<'managedMediaCapability'>) {}

  async create(draft: ManagedMediaCapabilityDraft): Promise<ManagedMediaCapabilityRecord | null> {
    try {
      return await this.repository.model.managedMediaCapability.create({
        data: { ...draft, fetchCount: 0, revokedAt: null, revokeReason: null },
        select: SELECT,
      }) as ManagedMediaCapabilityRecord;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }
  }

  async get(capabilityIdSha256: string): Promise<ManagedMediaCapabilityRecord | null> {
    return this.repository.model.managedMediaCapability.findUnique({
      where: { capabilityIdSha256 }, select: SELECT,
    }) as Promise<ManagedMediaCapabilityRecord | null>;
  }

  async claimFetch(capabilityIdSha256: string, expected: number, now: Date): Promise<boolean> {
    if (!Number.isSafeInteger(expected) || expected < 0 || !Number.isFinite(now.getTime())) return false;
    const result = await this.repository.model.managedMediaCapability.updateMany({
      where: {
        capabilityIdSha256, fetchCount: expected, maxFetches: { gt: expected },
        revokedAt: null, expiresAt: { gt: now },
      },
      data: { fetchCount: { increment: 1 } },
    });
    return result.count === 1;
  }

  async revoke(capabilityIdSha256: string, at: Date, reason: ManagedMediaRevokeReason): Promise<number> {
    const result = await this.repository.model.managedMediaCapability.updateMany({
      where: { capabilityIdSha256, revokedAt: null },
      data: { revokedAt: at, revokeReason: reason },
    });
    return result.count;
  }

  async revokeCall(organizationId: string, callId: string, at: Date, reason: ManagedMediaRevokeReason): Promise<number> {
    const result = await this.repository.model.managedMediaCapability.updateMany({
      where: { organizationId, callId, revokedAt: null },
      data: { revokedAt: at, revokeReason: reason },
    });
    return result.count;
  }
}

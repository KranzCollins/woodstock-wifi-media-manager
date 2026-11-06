import type { IUploadProvider } from '@gitroom/nestjs-libraries/upload/upload.interface';
import { STORED_OBJECT_KEY } from '@gitroom/nestjs-libraries/upload/upload.interface';
import type { ManagedRepository } from './managed.repository';
import type {
  ManagedMediaPinnedEvidence, ManagedMediaPinnedStorage,
} from './managed.lifecycle.media-capability';

// Composition over the same retained evidence and private object namespace
// used by DRAFT uploads. A changed public address is never fetched or used to
// select another storage location. This adapter only reads existing objects.
export class ManagedLifecycleMediaStorage implements ManagedMediaPinnedStorage {
  constructor(
    private readonly repository: Pick<ManagedRepository, 'read'>,
    private readonly storage: IUploadProvider
  ) {}

  async pinnedEvidence(organizationId: string, mediaId: string): Promise<ManagedMediaPinnedEvidence | null> {
    if (!this.storage.objectKeyOf || !this.storage.objectNamespace ||
        !this.storage.objectVersionAt || !this.storage.openObjectAt) return null;
    const entries = await this.repository.read(organizationId, reader => reader.getMediaWithEvidence([mediaId]));
    const entry = entries.find(value => value.media.id === mediaId);
    if (!entry || entry.media.status !== 'ready') return null;
    const evidence = entry.evidence;
    if (!evidence || evidence.mediaId !== mediaId || evidence.storedPath !== entry.media.path ||
        !evidence.storageKey || !STORED_OBJECT_KEY.test(evidence.storageKey) ||
        !evidence.storageNamespace || !evidence.storageVersion || !evidence.mimeType ||
        this.storage.objectKeyOf(entry.media.path) !== evidence.storageKey) return null;
    return {
      mediaId, evidenceId: evidence.id, sha256: evidence.sha256,
      byteLength: evidence.byteLength, mimeType: evidence.mimeType,
      storageKey: evidence.storageKey, storageNamespace: evidence.storageNamespace,
      storageVersion: evidence.storageVersion,
    };
  }

  async namespace(): Promise<string | null> {
    return this.storage.objectNamespace ? this.storage.objectNamespace() : null;
  }

  async versionAt(key: string): Promise<string | null> {
    if (!STORED_OBJECT_KEY.test(key) || !this.storage.objectVersionAt) return null;
    return this.storage.objectVersionAt(key);
  }

  async openAt(key: string) {
    if (!STORED_OBJECT_KEY.test(key) || !this.storage.openObjectAt) return null;
    return this.storage.openObjectAt(key);
  }
}

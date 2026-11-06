// FAKE storage factory and sniffer for the modules managed.service.ts loads
// (the real sniffer is ESM-only); no upload, storage or network runs here
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({}));
jest.mock(
  'file-type',
  () => ({ fileTypeStream: jest.fn(), fileTypeFromBuffer: jest.fn() }),
  { virtual: true }
);

// The release builder against an explicit FAKE organization-scoped
// ManagedReader (only its read methods exist) and a FAKE pinned storage
// behind the actual ManagedMediaPinnedStorage interface, with synthetic
// digests. The text decoder, contract parser, settings DTOs, row / identity
// fingerprints and canonical hash are the real ones. No database, storage,
// provider or network is involved; the root composes the actual PostgreSQL
// reader and the actual media storage later
import { createHash } from 'crypto';
import {
  BindingRow,
  IntegrationIdentity,
  ManagedPostRow,
  ManagedReader,
  MediaWithEvidence,
  PostRow,
  RevisionRow,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import {
  fingerprint,
  identityFingerprint,
  ManagedPostSnapshot,
  rowFingerprint,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import {
  ManagedLifecycleException,
  ManagedLifecycleProviderFacts,
  parseManagedLifecycleResponse,
  releaseHashInput,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import {
  managedMediaCapabilityMaxBytes,
  ManagedMediaPinnedEvidence,
  ManagedMediaPinnedStorage,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';
import {
  buildManagedRelease,
  managedReleaseMediaIds,
  ManagedReleaseRequest,
  observeManagedReleaseMedia,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.release';

const ORG = 'org_release_1';
const POST_ID = '5b2f7c1e-3a4d-4e8f-9b0a-1c2d3e4f5a6b';
const GROUP = 'group_release_1';
const INTEGRATION_ID = 'int_ig_1';
const NAMESPACE = 'FAKE-namespace-1';
const CREATED = new Date('2026-11-05T10:00:00.000Z');
const SETTINGS = { post_type: 'post', collaborators: [{ label: 'partner' }] };

// what an adapter would declare; the test states it, nothing assumes it
const INSTAGRAM: ManagedLifecycleProviderFacts = {
  identifier: 'instagram-standalone',
  editor: 'normal',
  requiresMedia: true,
  maxStepUnits: 8,
  maxStepDeadlineMs: 60 * 1000,
};

const sha256 = (seed: string) => createHash('sha256').update(seed).digest('hex');

// the synthetic media library: stored path, pinned key / version and the
// digest of synthetic bytes
const LIBRARY: Record<string, { mimeType: string; ext: string; byteLength: number }> = {
  media_image: { mimeType: 'image/png', ext: 'png', byteLength: 3008 },
  media_image_2: { mimeType: 'image/png', ext: 'png', byteLength: 2048 },
  media_video: { mimeType: 'video/mp4', ext: 'mp4', byteLength: 900000 },
  media_cover: { mimeType: 'image/jpeg', ext: 'jpg', byteLength: 4100 },
  media_gif: { mimeType: 'image/gif', ext: 'gif', byteLength: 1200 },
  media_svg: { mimeType: 'image/svg+xml', ext: 'svg', byteLength: 800 },
};

const storageKey = (mediaId: string) => `managed-${mediaId}.${LIBRARY[mediaId].ext}`;
const mediaPath = (mediaId: string) => `https://uploads.example/${storageKey(mediaId)}`;

function libraryEntry(mediaId: string): MediaWithEvidence {
  const { mimeType, byteLength } = LIBRARY[mediaId];
  return {
    media: {
      id: mediaId,
      organizationId: ORG,
      name: `${mediaId}.${LIBRARY[mediaId].ext}`,
      path: mediaPath(mediaId),
      status: 'ready',
    },
    evidence: {
      id: `evidence_${mediaId}`,
      mediaId,
      storedPath: mediaPath(mediaId),
      storageVersion: `FAKE-v1:${mediaId}`,
      storageKey: storageKey(mediaId),
      storageNamespace: NAMESPACE,
      sha256: sha256(`synthetic bytes of ${mediaId}`),
      byteLength,
      mimeType,
      method: 'UPLOAD_CAPTURE',
      sequence: 1,
    },
  };
}

interface MediaSpec {
  mediaId: string;
  alt?: string;
  thumbnail?: string;
  thumbnailTimestampMs?: number;
}

interface MemberSpec {
  content: string;
  delay?: number;
  media?: MediaSpec[];
}

// FAKE pinned storage with the rules of ManagedLifecycleMediaStorage: only
// ready media whose current evidence is pinned to a key, namespace, version
// and type, at the version a key holds now
class FakePinnedStorage
  implements Pick<ManagedMediaPinnedStorage, 'pinnedEvidence' | 'namespace' | 'versionAt'>
{
  namespaces: string[] = [];
  versions = new Map<string, string>();
  failing = new Set<string>();
  extra: Record<string, unknown> = {};

  constructor(private readonly world: () => World) {}

  async pinnedEvidence(organizationId: string, mediaId: string) {
    if (this.failing.has(mediaId)) {
      throw new Error('FAKE storage failure for s3://secret-bucket/secret-key');
    }
    const entry = this.world().media.find((item) => item.media.id === mediaId);
    const evidence = entry?.evidence;
    if (
      organizationId !== ORG ||
      !entry ||
      entry.media.status !== 'ready' ||
      !evidence ||
      evidence.storedPath !== entry.media.path ||
      !evidence.storageKey ||
      !evidence.storageNamespace ||
      !evidence.storageVersion ||
      !evidence.mimeType
    ) {
      return null;
    }
    return {
      mediaId,
      evidenceId: evidence.id,
      sha256: evidence.sha256,
      byteLength: evidence.byteLength,
      mimeType: evidence.mimeType,
      storageKey: evidence.storageKey,
      storageNamespace: evidence.storageNamespace,
      storageVersion: evidence.storageVersion,
      ...this.extra,
    } as ManagedMediaPinnedEvidence;
  }

  // successive answers when a test queued them, the namespace otherwise
  async namespace() {
    return this.namespaces.length ? this.namespaces.shift()! : NAMESPACE;
  }

  async versionAt(key: string) {
    return this.versions.has(key)
      ? this.versions.get(key)!
      : this.world()
          .media.map((entry) => entry.evidence)
          .find((evidence) => evidence?.storageKey === key)?.storageVersion ?? null;
  }
}

interface World {
  managed: ManagedPostRow;
  revisions: RevisionRow[];
  rows: PostRow[];
  integration: IntegrationIdentity | null;
  binding: BindingRow | null;
  media: MediaWithEvidence[];
  storage: FakePinnedStorage;
}

const evidenceView = (entry: MediaWithEvidence) => ({
  mediaId: entry.media.id,
  evidenceId: entry.evidence!.id,
  sha256: entry.evidence!.sha256,
  byteLength: entry.evidence!.byteLength,
  mimeType: entry.evidence!.mimeType,
  method: entry.evidence!.method,
});

// the Post.image managed.service.ts writes for these references
const imageJson = (media: MediaSpec[]) =>
  JSON.stringify(
    media.map((ref) => ({
      id: ref.mediaId,
      name: libraryEntry(ref.mediaId).media.name,
      path: mediaPath(ref.mediaId),
      ...(ref.alt !== undefined ? { alt: ref.alt } : {}),
      ...(ref.thumbnail ? { thumbnail: mediaPath(ref.thumbnail) } : {}),
      ...(ref.thumbnailTimestampMs !== undefined
        ? { thumbnailTimestamp: ref.thumbnailTimestampMs }
        : {}),
    }))
  );

// A managed post the way createDraft / editDraft leave it: its rows, its
// managed record and its immutable revision 1 snapshot; `retired` trailing
// children an edit soft-deleted
function world(
  members: MemberSpec[],
  options: { settings?: Record<string, any>; retired?: number } = {}
): World {
  const settings = options.settings ?? SETTINGS;
  const integration: IntegrationIdentity = {
    id: INTEGRATION_ID,
    organizationId: ORG,
    providerIdentifier: 'instagram-standalone',
    internalId: '17841400000000001',
    rootInternalId: null,
    profile: 'ww.test.acc',
    name: 'W&W test',
    customName: null,
    disabled: false,
    refreshNeeded: false,
    inBetweenSteps: false,
    deletedAt: null,
  };
  const ids = [
    ...new Set(
      members.flatMap((member) =>
        (member.media || []).flatMap((ref) =>
          ref.thumbnail ? [ref.mediaId, ref.thumbnail] : [ref.mediaId]
        )
      )
    ),
  ];
  const media = ids.map(libraryEntry);
  const find = (mediaId: string) => media.find((entry) => entry.media.id === mediaId)!;

  const rows: PostRow[] = [];
  const all = [
    ...members,
    ...Array.from({ length: options.retired ?? 0 }, () => ({ content: 'retired', media: [] })),
  ];
  all.forEach((member, position) => {
    rows.push({
      id: `post_${position}`,
      group: GROUP,
      organizationId: ORG,
      integrationId: INTEGRATION_ID,
      parentPostId: position ? `post_${position - 1}` : null,
      content: member.content,
      delay: member.delay ?? 0,
      image: imageJson(member.media || []),
      settings: JSON.stringify({ ...settings, __type: 'instagram-standalone' }),
      publishDate: new Date('2026-11-08T12:00:00.000Z'),
      state: 'DRAFT',
      deletedAt: position >= members.length ? CREATED : null,
      createdAt: CREATED,
      updatedAt: CREATED,
    });
  });

  const snapshot: ManagedPostSnapshot = {
    managedPostId: POST_ID,
    group: GROUP,
    integrationId: INTEGRATION_ID,
    revision: 1,
    bindingGeneration: 2,
    state: 'DRAFT',
    intendedPublishDate: '2026-11-08T12:00:00.000Z',
    settings,
    members: members.map((member, position) => ({
      postId: `post_${position}`,
      position,
      role: position === 0 ? 'ROOT' : 'CHILD',
      parentPostId: position ? `post_${position - 1}` : null,
      content: member.content,
      delay: member.delay ?? 0,
      media: (member.media || []).map((ref, index) => ({
        position: index,
        ...evidenceView(find(ref.mediaId)),
        ...(ref.alt !== undefined ? { alt: ref.alt } : {}),
        ...(ref.thumbnail ? { thumbnail: evidenceView(find(ref.thumbnail)) } : {}),
        ...(ref.thumbnailTimestampMs !== undefined
          ? {
              thumbnailTimestampMs: ref.thumbnailTimestampMs,
              thumbnailTimestampBounds: 'UNQUALIFIED_DURATION_UNKNOWN' as const,
            }
          : {}),
      })),
    })),
    ...(options.retired
      ? {
          retiredMembers: Array.from({ length: options.retired }, (_, index) => ({
            postId: `post_${members.length + index}`,
            position: members.length + index,
            retiredAtRevision: 1,
          })),
        }
      : {}),
    operationKey: 'ww-op-create-1',
    payloadHash: fingerprint({ synthetic: true }),
    sequence: 5,
    revisedAt: CREATED.toISOString(),
  };

  const w: World = {
    managed: {
      id: POST_ID,
      organizationId: ORG,
      integrationId: INTEGRATION_ID,
      group: GROUP,
      revision: 1,
      bindingGeneration: 2,
      rowFingerprint: rowFingerprint(rows),
      lastSequence: 5,
      createdOperationKey: 'ww-op-create-1',
      lastOperationKey: 'ww-op-create-1',
      createdAt: CREATED,
      updatedAt: CREATED,
    },
    revisions: [
      {
        managedPostId: POST_ID,
        revision: 1,
        operationKey: 'ww-op-create-1',
        payloadHash: snapshot.payloadHash,
        sequence: 5,
        snapshot: JSON.stringify(snapshot),
        createdAt: CREATED,
      },
    ],
    rows,
    integration,
    binding: {
      id: 'binding_1',
      organizationId: ORG,
      integrationId: INTEGRATION_ID,
      generation: 2,
      status: 'QUALIFIED',
      providerIdentifier: 'instagram-standalone',
      internalId: integration.internalId,
      profile: integration.profile,
      identityFingerprint: identityFingerprint(integration),
      qualifiedAt: CREATED,
      pausedAt: null,
    },
    media,
    storage: null,
  };
  w.storage = new FakePinnedStorage(() => w);
  return w;
}

// FAKE organization-scoped reader: copies of the world's rows, read methods
// only; a method the builder must not need fails the test
function readerOf(w: World): ManagedReader & { calls: string[] } {
  const calls: string[] = [];
  const read =
    <A extends any[], T>(name: string, answer: (...args: A) => T) =>
    async (...args: A) => {
      calls.push(name);
      return structuredClone(answer(...args));
    };
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} is not read by the release builder`);
  };
  return {
    calls,
    getManagedPost: read('getManagedPost', (id: string) =>
      id === w.managed.id ? w.managed : null
    ),
    getRevision: read('getRevision', (id: string, revision: number) =>
      w.revisions.find((row) => row.managedPostId === id && row.revision === revision) ?? null
    ),
    getPostRows: read('getPostRows', (groups: string[]) =>
      w.rows.filter((row) => groups.includes(row.group))
    ),
    getIntegration: read('getIntegration', (id: string) =>
      w.integration?.id === id ? w.integration : null
    ),
    getBinding: read('getBinding', (id: string) =>
      w.binding?.integrationId === id ? w.binding : null
    ),
    getMediaWithEvidence: read('getMediaWithEvidence', (ids: string[]) =>
      w.media.filter((entry) => ids.includes(entry.media.id))
    ),
    headSequence: unused('headSequence'),
    getIntegrations: unused('getIntegrations'),
    getBindings: unused('getBindings'),
    getOperation: unused('getOperation'),
    listManagedPosts: unused('listManagedPosts'),
    countManagedPosts: unused('countManagedPosts'),
    countRootPosts: unused('countRootPosts'),
    getRevisions: unused('getRevisions'),
    getLatestRevisions: unused('getLatestRevisions'),
    listEvents: unused('listEvents'),
    getMediaUpload: unused('getMediaUpload'),
    getReceivingMediaUpload: unused('getReceivingMediaUpload'),
    getMediaUploadAttempt: unused('getMediaUploadAttempt'),
  };
}

// the composition the root performs: media ids of the revision, the pinned
// storage observation outside the read, then the build in the read
async function build(w: World, overrides: Partial<ManagedReleaseRequest> = {}) {
  const reader = readerOf(w);
  const ids = await managedReleaseMediaIds(reader, POST_ID, w.managed.revision);
  const observedMedia = await observeManagedReleaseMedia(w.storage, ORG, ids);
  return buildManagedRelease(reader, {
    managedPostId: POST_ID,
    expectedRevision: w.managed.revision,
    codec: 'ww-plain-escape-v1',
    provider: INSTAGRAM,
    mediaDeliveryReady: true,
    observedMedia,
    ...overrides,
  });
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ManagedLifecycleException) {
      return {
        code: err.code,
        reason: err.reason ?? null,
        body: JSON.stringify(err.getResponse()),
      };
    }
    throw err;
  }
  throw new Error('the release was not refused');
}

// a lifecycle-authorized transition: it changes the rows and keeps
// ManagedPost.rowFingerprint current, as the owned writer does
function authorized(w: World, change: (rows: PostRow[]) => void) {
  change(w.rows);
  w.managed.rowFingerprint = rowFingerprint(w.rows);
}

const IMAGE_POST: MemberSpec[] = [
  { content: 'Hello &amp; welcome', media: [{ mediaId: 'media_image', alt: 'A test card' }] },
  { content: 'First comment', delay: 5 },
];

describe('buildManagedRelease', () => {
  it('derives the contract-valid preview and the immutable internal release from the retained rows', async () => {
    const w = world(IMAGE_POST);
    const snapshotBefore = w.revisions[0].snapshot;
    const rowsBefore = structuredClone(w.rows);
    const reader = readerOf(w);
    const observedMedia = await observeManagedReleaseMedia(
      w.storage,
      ORG,
      await managedReleaseMediaIds(reader, POST_ID, 1)
    );

    const { preview, release } = await buildManagedRelease(reader, {
      managedPostId: POST_ID,
      expectedRevision: 1,
      codec: 'ww-plain-escape-v1',
      provider: INSTAGRAM,
      mediaDeliveryReady: true,
      observedMedia,
    });

    expect(parseManagedLifecycleResponse('RELEASE_PREVIEW', preview)).toEqual(preview);
    const image = libraryEntry('media_image').evidence!;
    expect(preview).toEqual({
      version: 'ww.managed-lifecycle.v1',
      hashVersion: 'ww-release-hash-v1',
      managedPostId: POST_ID,
      revision: 1,
      bindingGeneration: 2,
      integrationId: INTEGRATION_ID,
      providerIdentifier: 'instagram-standalone',
      identityFingerprint: identityFingerprint(w.integration!),
      codec: 'ww-plain-escape-v1',
      settingsHash: fingerprint(SETTINGS),
      members: [
        {
          position: 0,
          delay: 0,
          content: 'Hello &amp; welcome',
          text: 'Hello & welcome',
          media: [
            {
              position: 0,
              mediaId: 'media_image',
              evidenceId: image.id,
              sha256: image.sha256,
              byteLength: image.byteLength,
              mimeType: 'image/png',
              alt: 'A test card',
              thumbnail: null,
              thumbnailTimestampMs: null,
            },
          ],
        },
        { position: 1, delay: 5, content: 'First comment', text: 'First comment', media: [] },
      ],
      releaseHash: preview.releaseHash,
    });
    expect(preview.releaseHash).toBe(fingerprint(releaseHashInput(preview)));

    expect(release).toEqual({
      managedPostId: POST_ID,
      revision: 1,
      bindingGeneration: 2,
      integrationId: INTEGRATION_ID,
      providerIdentifier: 'instagram-standalone',
      identityFingerprint: identityFingerprint(w.integration!),
      codec: 'ww-plain-escape-v1',
      settingsHash: preview.settingsHash,
      releaseHash: preview.releaseHash,
      rowFingerprint: w.managed.rowFingerprint,
      internalId: '17841400000000001',
      profile: 'ww.test.acc',
      settings: SETTINGS,
      members: [
        {
          postId: 'post_0',
          position: 0,
          delay: 0,
          text: 'Hello & welcome',
          media: [
            {
              pin: {
                mediaId: 'media_image',
                evidenceId: image.id,
                sha256: image.sha256,
                byteLength: image.byteLength,
                mimeType: 'image/png',
              },
              alt: 'A test card',
              thumbnail: null,
              thumbnailTimestampMs: null,
            },
          ],
        },
        { postId: 'post_1', position: 1, delay: 5, text: 'First comment', media: [] },
      ],
    });

    // immutable, and nothing was written or rewritten
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(release.settings)).toBe(true);
    expect(Object.isFrozen((release.settings as any).collaborators[0])).toBe(true);
    expect(Object.isFrozen(release.members)).toBe(true);
    expect(Object.isFrozen(release.members[0].media[0].pin)).toBe(true);
    expect(w.revisions[0].snapshot).toBe(snapshotBefore);
    expect(w.rows).toEqual(rowsBefore);
    expect(new Set(reader.calls)).toEqual(
      new Set([
        'getRevision',
        'getManagedPost',
        'getPostRows',
        'getIntegration',
        'getBinding',
        'getMediaWithEvidence',
      ])
    );
  });

  it('gives the hash W&W derives independently from its approved payload and upload bindings', async () => {
    const { preview } = await build(world(IMAGE_POST));
    const image = libraryEntry('media_image').evidence!;

    // W&W side, written out by hand: approved plain text and settings, the
    // retained upload binding, the binding identity it qualified
    const expected = fingerprint({
      v: 'ww-release-hash-v1',
      managedPostId: POST_ID,
      revision: 1,
      integrationId: INTEGRATION_ID,
      providerIdentifier: 'instagram-standalone',
      identityFingerprint: world(IMAGE_POST).binding!.identityFingerprint,
      codec: 'ww-plain-escape-v1',
      settingsHash: fingerprint({ collaborators: [{ label: 'partner' }], post_type: 'post' }),
      members: [
        {
          position: 0,
          delay: 0,
          text: 'Hello & welcome',
          media: [
            {
              position: 0,
              mediaId: 'media_image',
              evidenceId: image.id,
              sha256: image.sha256,
              byteLength: image.byteLength,
              mimeType: 'image/png',
              alt: 'A test card',
              thumbnail: null,
              thumbnailTimestampMs: null,
            },
          ],
        },
        { position: 1, delay: 5, text: 'First comment', media: [] },
      ],
    });
    expect(preview.releaseHash).toBe(expected);
  });

  it('answers no settings, path, URL, storage key, namespace or version', async () => {
    const w = world([
      {
        content: 'Clip',
        media: [{ mediaId: 'media_video', alt: 'A clip', thumbnail: 'media_cover' }],
      },
    ]);
    const { preview, release } = await build(w);
    const answered = JSON.stringify(preview);
    for (const secret of [
      'https://',
      'uploads.example',
      'managed-media',
      NAMESPACE,
      'FAKE-v1',
      'partner',
      'collaborators',
      '__type',
    ]) {
      expect(answered).not.toContain(secret);
    }
    const internal = JSON.stringify(release);
    for (const secret of ['https://', 'managed-media', NAMESPACE, 'FAKE-v1', '__type']) {
      expect(internal).not.toContain(secret);
    }
  });

  describe('thumbnail metadata bound to the reviewed release', () => {
    it('keeps the full pinned cover internally and binds its byte length and MIME in the preview', async () => {
      const w = world([
        {
          content: 'Clip',
          media: [{ mediaId: 'media_video', alt: 'A clip', thumbnail: 'media_cover' }],
        },
      ]);
      const { preview, release } = await build(w);
      const cover = libraryEntry('media_cover').evidence!;

      expect(preview.members[0].media[0].thumbnail).toEqual({
        mediaId: 'media_cover',
        evidenceId: cover.id,
        sha256: cover.sha256,
        byteLength: cover.byteLength,
        mimeType: 'image/jpeg',
      });
      expect(release.members[0].media[0].thumbnail).toEqual({
        mediaId: 'media_cover',
        evidenceId: cover.id,
        sha256: cover.sha256,
        byteLength: cover.byteLength,
        mimeType: 'image/jpeg',
      });
    });

    it('the closed contract requires cover byteLength / mimeType and the release hash binds both', async () => {
      const w = world([
        { content: 'Clip', media: [{ mediaId: 'media_video', thumbnail: 'media_cover' }] },
      ]);
      const { preview } = await build(w);
      const omitted = structuredClone(preview) as any;
      delete omitted.members[0].media[0].thumbnail.byteLength;
      expect(parseManagedLifecycleResponse('RELEASE_PREVIEW', omitted)).toBeNull();
      const changedSize = structuredClone(preview);
      changedSize.members[0].media[0].thumbnail!.byteLength += 1;
      expect(fingerprint(releaseHashInput(changedSize))).not.toEqual(preview.releaseHash);
      const changedType = structuredClone(preview);
      changedType.members[0].media[0].thumbnail!.mimeType = 'image/png';
      expect(fingerprint(releaseHashInput(changedType))).not.toEqual(preview.releaseHash);
    });

    it('releases a video with a frame offset', async () => {
      const w = world([
        { content: 'Clip', media: [{ mediaId: 'media_video', thumbnailTimestampMs: 1500 }] },
      ]);
      const { preview, release } = await build(w);
      expect(preview.members[0].media[0]).toMatchObject({
        thumbnail: null,
        thumbnailTimestampMs: 1500,
      });
      expect(release.members[0].media[0].thumbnailTimestampMs).toBe(1500);
    });
  });

  describe('strict text', () => {
    it('decodes entities once and keeps NBSP, quotes, LF, tab and emoji exactly', async () => {
      const content =
        'Tom &amp; Jerry &lt;b&gt; &amp;lt;i&amp;gt; "double" \'single\'\nline\ttab&nbsp;end 👍🏽 ❤️ 𝕏';
      const w = world([{ content, media: [{ mediaId: 'media_image' }] }]);
      const { preview, release } = await build(w);
      const text =
        'Tom & Jerry <b> &lt;i&gt; "double" \'single\'\nline\ttab end 👍🏽 ❤️ 𝕏';
      expect(preview.members[0].text).toBe(text);
      expect(preview.members[0].content).toBe(content);
      expect(release.members[0].text).toBe(text);
    });

    it('decodes the paragraph codec', async () => {
      const w = world([
        { content: '<p>Hello &amp; welcome&nbsp;🙂</p>', media: [{ mediaId: 'media_image' }] },
      ]);
      const { preview } = await build(w, { codec: 'ww-plain-paragraph-escape-v1' });
      expect(preview.members[0].text).toBe('Hello & welcome 🙂');
    });

    it.each([
      ['a raw no-break space', 'a b', 'ww-plain-escape-v1', 'RAW_NO_BREAK_SPACE'],
      ['a bare ampersand', 'Tom & Jerry', 'ww-plain-escape-v1', 'ENTITY_NOT_CANONICAL'],
      ['an unknown entity', 'a &quot; b', 'ww-plain-escape-v1', 'ENTITY_NOT_CANONICAL'],
      ['a lone surrogate', 'a \ud83d b', 'ww-plain-escape-v1', 'UNREPRESENTABLE_CODE_POINT'],
      ['a carriage return', 'a\r\nb', 'ww-plain-escape-v1', 'UNREPRESENTABLE_CODE_POINT'],
      ['paragraph content under the plain codec', '<p>Hi</p>', 'ww-plain-escape-v1', 'RAW_ANGLE_BRACKET'],
      ['plain content under the paragraph codec', 'Hi', 'ww-plain-paragraph-escape-v1', 'WRAPPER_INVALID'],
      ['an unknown codec', 'Hi', 'ww-html-v9', 'CODEC_NOT_SUPPORTED'],
    ])('refuses %s with the real decoder', async (_, content, codec, reason) => {
      const w = world([{ content, media: [{ mediaId: 'media_image' }] }]);
      const refused = await refusal(build(w, { codec: codec as any }));
      expect(refused).toMatchObject({ code: 'CODEC_REFUSED', reason });
      expect(refused.body).not.toContain(content);
    });

    it('refuses a provider whose editor is not the normal one', async () => {
      const w = world(IMAGE_POST);
      expect(
        await refusal(build(w, { provider: { ...INSTAGRAM, editor: 'markdown' } }))
      ).toMatchObject({
        code: 'CODEC_NOT_QUALIFIED_FOR_PROVIDER',
        reason: 'EDITOR_NOT_SUPPORTED',
      });
    });

    it('refuses a comment that is not a strict value too', async () => {
      const w = world([IMAGE_POST[0], { content: 'Q&A' }]);
      expect(await refusal(build(w))).toMatchObject({
        code: 'CODEC_REFUSED',
        reason: 'ENTITY_NOT_CANONICAL',
      });
    });
  });

  describe('lifecycle-authorized transitions and drift', () => {
    it.each(['QUEUE', 'PUBLISHED'])(
      'releases the same hash after an authorized %s transition, the snapshot untouched',
      async (state) => {
        const w = world(IMAGE_POST);
        const draft = await build(w);
        const snapshot = w.revisions[0].snapshot;
        authorized(w, (rows) =>
          rows.forEach((row) => {
            row.state = state;
            row.publishDate = new Date('2026-11-09T08:00:00.000Z');
            row.updatedAt = new Date('2026-11-06T08:00:00.000Z');
          })
        );

        const after = await build(w);
        expect(after.preview.releaseHash).toBe(draft.preview.releaseHash);
        expect(after.release.rowFingerprint).toBe(w.managed.rowFingerprint);
        expect(after.release.rowFingerprint).not.toBe(draft.release.rowFingerprint);
        expect(w.revisions[0].snapshot).toBe(snapshot);
      }
    );

    it('keeps children an edit retired out of the release', async () => {
      const w = world(IMAGE_POST, { retired: 1 });
      const { preview, release } = await build(w);
      expect(preview.members).toHaveLength(2);
      expect(release.members.map((member) => member.postId)).toEqual(['post_0', 'post_1']);
    });

    it('refuses a state change that did not go through the lifecycle', async () => {
      const w = world(IMAGE_POST);
      w.rows[0].state = 'QUEUE';
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_DRIFTED' });
    });

    it('refuses foreign content changes', async () => {
      const w = world(IMAGE_POST);
      w.rows[1].content = 'Edited elsewhere';
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_DRIFTED' });
    });

    it.each<[string, (rows: PostRow[]) => void]>([
      ['content', (rows) => void (rows[0].content = 'Other &amp; text')],
      ['delay', (rows) => void (rows[1].delay = 10)],
      ['settings', (rows) => void (rows[0].settings = JSON.stringify({ post_type: 'story', __type: 'instagram-standalone' }))],
      ['__type', (rows) => void (rows[1].settings = JSON.stringify({ ...SETTINGS, __type: 'instagram' }))],
      ['an arbitrary media URL', (rows) => void (rows[0].image = rows[0].image!.replace(mediaPath('media_image'), 'https://attacker.example/x.png'))],
      ['an extra image key', (rows) => void (rows[0].image = JSON.stringify([{ ...JSON.parse(rows[0].image!)[0], url: 'https://attacker.example/x.png' }]))],
      ['the image dropped', (rows) => void (rows[0].image = '[]')],
      ['the alt changed', (rows) => void (rows[0].image = rows[0].image!.replace('A test card', 'Other alt'))],
    ])('refuses rows that do not hold the revision (%s), even under a current fingerprint', async (_, change) => {
      const w = world(IMAGE_POST);
      authorized(w, change);
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_DRIFTED' });
    });

    it('refuses media in another order than the revision bound', async () => {
      const w = world([
        { content: 'Two', media: [{ mediaId: 'media_image' }, { mediaId: 'media_image_2' }] },
      ]);
      authorized(w, (rows) => {
        const image = JSON.parse(rows[0].image!);
        rows[0].image = JSON.stringify([image[1], image[0]]);
      });
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_DRIFTED' });
    });

    it('refuses an extra live member', async () => {
      const w = world(IMAGE_POST);
      authorized(w, (rows) =>
        rows.push({ ...rows[1], id: 'post_2', parentPostId: 'post_1', content: 'Extra' })
      );
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_DRIFTED' });
    });

    it('refuses a missing root', async () => {
      const w = world(IMAGE_POST);
      w.rows = [];
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_DRIFTED' });
    });

    it.each([
      ['authorized', true],
      ['foreign', false],
    ])('refuses a deleted post (%s)', async (_, viaLifecycle) => {
      const w = world(IMAGE_POST);
      const remove = (rows: PostRow[]) =>
        rows.forEach((row) => void (row.deletedAt = new Date('2026-11-06T09:00:00.000Z')));
      viaLifecycle ? authorized(w, remove) : remove(w.rows);
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_DELETED' });
    });

    it('refuses an authorized row state no release is made from', async () => {
      const w = world(IMAGE_POST);
      authorized(w, (rows) => void (rows[0].state = 'ERROR'));
      expect(await refusal(build(w))).toMatchObject({ code: 'LIFECYCLE_STATE_CONFLICT' });
    });
  });

  describe('revision', () => {
    it('refuses an invalid request', async () => {
      const w = world(IMAGE_POST);
      expect(
        await refusal(
          buildManagedRelease(readerOf(w), {
            managedPostId: 'not-a-uuid',
            expectedRevision: 1,
            codec: 'ww-plain-escape-v1',
            provider: INSTAGRAM,
            mediaDeliveryReady: true,
            observedMedia: new Map(),
          })
        )
      ).toMatchObject({ code: 'LIFECYCLE_INPUT_INVALID' });
      expect(await refusal(build(w, { expectedRevision: 0 }))).toMatchObject({
        code: 'LIFECYCLE_INPUT_INVALID',
      });
    });

    it('refuses a post of another organization or none', async () => {
      const w = world(IMAGE_POST);
      expect(
        await refusal(build(w, { managedPostId: '00000000-0000-4000-8000-000000000000' }))
      ).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses any revision but the current one', async () => {
      const w = world(IMAGE_POST);
      expect(await refusal(build(w, { expectedRevision: 2 }))).toMatchObject({
        code: 'REVISION_CONFLICT',
      });
    });

    it('refuses a revision record that does not match the managed post', async () => {
      const w = world(IMAGE_POST);
      const snapshot = JSON.parse(w.revisions[0].snapshot);
      w.revisions[0].snapshot = JSON.stringify({ ...snapshot, bindingGeneration: 1 });
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_DRIFTED' });

      w.revisions = [];
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_DRIFTED' });
    });
  });

  describe('channel, point in time', () => {
    it.each<[string, (w: World) => void, string]>([
      ['no binding', (w) => void (w.binding = null), 'CHANNEL_NOT_QUALIFIED'],
      ['a binding pending qualification', (w) => void (w.binding!.status = 'PENDING_QUALIFICATION'), 'CHANNEL_NOT_QUALIFIED'],
      ['a paused binding', (w) => void (w.binding!.status = 'PAUSED_IDENTITY_CHANGED'), 'CHANNEL_IDENTITY_CHANGED'],
      ['a changed recorded identity', (w) => void (w.integration!.internalId = '17841400000000002'), 'CHANNEL_IDENTITY_CHANGED'],
      ['a changed profile', (w) => void (w.integration!.profile = 'other.account'), 'CHANNEL_IDENTITY_CHANGED'],
      ['a deleted channel', (w) => void (w.integration!.deletedAt = CREATED), 'CHANNEL_IDENTITY_CHANGED'],
      ['a disabled channel', (w) => void (w.integration!.disabled = true), 'CHANNEL_UNAVAILABLE'],
      ['a channel that needs a refresh', (w) => void (w.integration!.refreshNeeded = true), 'CHANNEL_UNAVAILABLE'],
      ['a channel in between steps', (w) => void (w.integration!.inBetweenSteps = true), 'CHANNEL_UNAVAILABLE'],
      ['a missing channel', (w) => void (w.integration = null), 'CHANNEL_UNAVAILABLE'],
      ['a requalified binding', (w) => void (w.binding!.generation = 3), 'BINDING_GENERATION_MISMATCH'],
    ])('refuses %s', async (_, change, code) => {
      const w = world(IMAGE_POST);
      change(w);
      expect(await refusal(build(w))).toMatchObject({ code });
    });

    it('never writes or reconciles the binding it refuses', async () => {
      const w = world(IMAGE_POST);
      w.integration!.internalId = '17841400000000002';
      const binding = structuredClone(w.binding);
      await refusal(build(w));
      expect(w.binding).toEqual(binding);
    });
  });

  describe('provider and settings', () => {
    it('refuses without declared adapter facts, or another provider\'s', async () => {
      const w = world(IMAGE_POST);
      expect(await refusal(build(w, { provider: null }))).toMatchObject({
        code: 'PROVIDER_NOT_QUALIFIED',
      });
      expect(
        await refusal(build(w, { provider: { ...INSTAGRAM, identifier: 'instagram' } }))
      ).toMatchObject({ code: 'PROVIDER_NOT_QUALIFIED' });
      expect(
        await refusal(build(w, { provider: { ...INSTAGRAM, maxStepUnits: 99 } }))
      ).toMatchObject({ code: 'PROVIDER_NOT_QUALIFIED' });
    });

    it('refuses a media-only provider while media delivery is not ready', async () => {
      expect(
        await refusal(build(world(IMAGE_POST), { mediaDeliveryReady: false }))
      ).toMatchObject({ code: 'PROVIDER_NOT_QUALIFIED' });
    });

    it('refuses media while media delivery is not ready', async () => {
      expect(
        await refusal(
          build(world(IMAGE_POST), {
            provider: { ...INSTAGRAM, requiresMedia: false },
            mediaDeliveryReady: false,
          })
        )
      ).toMatchObject({ code: 'MEDIA_DELIVERY_NOT_QUALIFIED' });
    });

    it('refuses text-only content for a provider that requires media', async () => {
      const w = world([{ content: 'Only text' }]);
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_NOT_SCHEDULABLE' });
      // and releases it where the adapter declares text-only is taken
      const { preview } = await build(w, { provider: { ...INSTAGRAM, requiresMedia: false } });
      expect(preview.members[0].media).toEqual([]);
    });

    it.each([
      ['an invalid value', { post_type: 'reel' }],
      ['an unknown field', { post_type: 'post', extra: true }],
      ['a missing required field', {}],
    ])('refuses approved settings with %s', async (_, settings) => {
      const w = world(IMAGE_POST, { settings });
      expect(await refusal(build(w))).toMatchObject({ code: 'POST_NOT_SCHEDULABLE' });
    });

    it('hashes the approved settings exactly', async () => {
      const story = await build(world(IMAGE_POST, { settings: { post_type: 'story' } }));
      const post = await build(world(IMAGE_POST));
      expect(story.preview.settingsHash).toBe(fingerprint({ post_type: 'story' }));
      expect(story.preview.releaseHash).not.toBe(post.preview.releaseHash);
      expect(story.release.settings).toEqual({ post_type: 'story' });
    });
  });

  describe('media evidence', () => {
    it('refuses media without a pinned storage observation', async () => {
      const w = world(IMAGE_POST);
      expect(await refusal(build(w, { observedMedia: new Map() }))).toMatchObject({
        code: 'MEDIA_NOT_CURRENT',
      });
    });

    it('refuses an object no longer at the pinned version', async () => {
      const w = world(IMAGE_POST);
      w.storage.versions.set(storageKey('media_image'), 'FAKE-v2');
      expect(await refusal(build(w))).toMatchObject({ code: 'MEDIA_NOT_CURRENT' });
    });

    it('refuses an object whose key is gone', async () => {
      const w = world(IMAGE_POST);
      w.storage.versions.set(storageKey('media_image'), null);
      expect(await refusal(build(w))).toMatchObject({ code: 'MEDIA_NOT_CURRENT' });
    });

    it('refuses an observation that disagrees with the evidence read', async () => {
      const w = world(IMAGE_POST);
      const pinned = (await w.storage.pinnedEvidence(ORG, 'media_image'))!;
      for (const change of [
        { storageVersion: 'FAKE-v0' },
        { storageKey: 'managed-other.png' },
        { storageNamespace: 'FAKE-namespace-2' },
        { sha256: sha256('other bytes') },
        { byteLength: pinned.byteLength + 1 },
        { mimeType: 'image/jpeg' },
        { evidenceId: 'evidence_other' },
      ]) {
        expect(
          await refusal(
            build(w, { observedMedia: new Map([['media_image', { ...pinned, ...change }]]) })
          )
        ).toMatchObject({ code: 'MEDIA_NOT_CURRENT' });
      }
    });

    it.each<[string, (entry: MediaWithEvidence) => void]>([
      ['new evidence since the revision', (entry) => void Object.assign(entry.evidence!, { id: 'evidence_new', sha256: sha256('new'), sequence: 2 })],
      ['other bytes recorded', (entry) => void (entry.evidence!.sha256 = sha256('other'))],
      ['no evidence', (entry) => void (entry.evidence = null)],
      ['media not ready', (entry) => void (entry.media.status = 'processing')],
    ])('refuses %s', async (_, change) => {
      const w = world(IMAGE_POST);
      change(w.media[0]);
      expect(await refusal(build(w))).toMatchObject({ code: 'MEDIA_NOT_CURRENT' });
    });

    it('refuses removed media', async () => {
      const w = world(IMAGE_POST);
      w.media = [];
      expect(await refusal(build(w))).toMatchObject({ code: 'MEDIA_NOT_CURRENT' });
    });

    it('refuses a changed cover like any media', async () => {
      const w = world([
        { content: 'Clip', media: [{ mediaId: 'media_video', thumbnail: 'media_cover' }] },
      ]);
      w.storage.versions.set(storageKey('media_cover'), 'FAKE-v2');
      expect(await refusal(build(w))).toMatchObject({ code: 'MEDIA_NOT_CURRENT' });
    });

    it('refuses a type or size the media delivery does not take', async () => {
      const svg = world([{ content: 'Svg', media: [{ mediaId: 'media_svg' }] }]);
      expect(await refusal(build(svg))).toMatchObject({ code: 'MEDIA_DELIVERY_NOT_QUALIFIED' });

      const large = world(IMAGE_POST);
      const size = managedMediaCapabilityMaxBytes() + 1;
      const snapshot = JSON.parse(large.revisions[0].snapshot);
      snapshot.members[0].media[0].byteLength = size;
      large.revisions[0].snapshot = JSON.stringify(snapshot);
      large.media[0].evidence!.byteLength = size;
      expect(await refusal(build(large))).toMatchObject({
        code: 'MEDIA_DELIVERY_NOT_QUALIFIED',
      });
    });

    it.each<[string, MemberSpec[]]>([
      ['a cover on a picture', [{ content: 'X', media: [{ mediaId: 'media_image', thumbnail: 'media_cover' }] }]],
      ['a frame offset on a picture', [{ content: 'X', media: [{ mediaId: 'media_image', thumbnailTimestampMs: 10 }] }]],
      ['a cover that is not a JPEG or PNG', [{ content: 'X', media: [{ mediaId: 'media_video', thumbnail: 'media_gif' }] }]],
      ['an empty alt the contract cannot carry', [{ content: 'X', media: [{ mediaId: 'media_image', alt: '' }] }]],
    ])('refuses %s', async (_, members) => {
      expect(await refusal(build(world(members)))).toMatchObject({
        code: 'POST_NOT_SCHEDULABLE',
      });
    });
  });
});

describe('observeManagedReleaseMedia', () => {
  const ids = ['media_image', 'media_video'];

  it('keeps only the pin fields of evidence at its pinned version', async () => {
    const w = world([
      { content: 'Two', media: [{ mediaId: 'media_image' }, { mediaId: 'media_video' }] },
    ]);
    w.storage.extra = { path: mediaPath('media_image'), token: 'secret' };
    const observed = await observeManagedReleaseMedia(w.storage, ORG, ids);
    expect([...observed.keys()]).toEqual(ids);
    expect(Object.keys(observed.get('media_image')!).sort()).toEqual([
      'byteLength',
      'evidenceId',
      'mediaId',
      'mimeType',
      'sha256',
      'storageKey',
      'storageNamespace',
      'storageVersion',
    ]);
    expect(Object.isFrozen(observed.get('media_image'))).toBe(true);
  });

  it('drops evidence storage fails to read, without the error', async () => {
    const w = world([
      { content: 'Two', media: [{ mediaId: 'media_image' }, { mediaId: 'media_video' }] },
    ]);
    w.storage.failing.add('media_image');
    const observed = await observeManagedReleaseMedia(w.storage, ORG, ids);
    expect([...observed.keys()]).toEqual(['media_video']);
  });

  it('drops evidence pinned in another namespace', async () => {
    const w = world([{ content: 'One', media: [{ mediaId: 'media_image' }] }]);
    w.storage.namespaces = ['FAKE-namespace-2', 'FAKE-namespace-2'];
    expect((await observeManagedReleaseMedia(w.storage, ORG, ['media_image'])).size).toBe(0);
  });

  it('proves nothing when the namespace moved during the observation', async () => {
    const w = world([{ content: 'One', media: [{ mediaId: 'media_image' }] }]);
    w.storage.namespaces = [NAMESPACE, 'FAKE-namespace-2'];
    expect((await observeManagedReleaseMedia(w.storage, ORG, ['media_image'])).size).toBe(0);
  });

  it('refuses more media ids than a release can reference', async () => {
    const w = world(IMAGE_POST);
    const many = Array.from({ length: 401 }, (_, index) => `media_${index}`);
    expect(await refusal(observeManagedReleaseMedia(w.storage, ORG, many))).toMatchObject({
      code: 'LIFECYCLE_INPUT_INVALID',
    });
  });

  it('reads nothing for a release without media', async () => {
    const w = world([{ content: 'Only text' }]);
    const namespace = jest.spyOn(w.storage, 'namespace');
    expect((await observeManagedReleaseMedia(w.storage, ORG, [])).size).toBe(0);
    expect(namespace).not.toHaveBeenCalled();
  });
});

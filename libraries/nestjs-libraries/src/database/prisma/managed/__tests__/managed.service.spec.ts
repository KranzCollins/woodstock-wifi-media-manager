// a stored object's version is FAKE-v1 unless a test rewrote the object, and
// keys resolve in FAKE-namespace-1 unless a test moved the storage
const mockStorageVersions = new Map<string, string | null>();
const mockStorageNamespace = { value: 'FAKE-namespace-1' };
// the bytes a key holds, by path; a key without bytes cannot be opened
const mockStorageObjects = new Map<string, string>();
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: {
    // FAKE storage: these specs never touch real storage
    createStorage: () => ({
      removeFile: jest.fn(async () => undefined),
      objectKeyOf: jest.fn((path: string) =>
        path.startsWith('https://uploads.example/')
          ? path.slice('https://uploads.example/'.length)
          : null
      ),
      objectNamespace: jest.fn(async () => mockStorageNamespace.value),
      objectVersionAt: jest.fn(async (key: string) => {
        const path = `https://uploads.example/${key}`;
        return mockStorageVersions.has(path)
          ? mockStorageVersions.get(path)
          : `FAKE-v1:${path}`;
      }),
      openObjectAt: jest.fn(async (key: string) => {
        const path = `https://uploads.example/${key}`;
        if (!mockStorageObjects.has(path)) {
          return null;
        }
        const { Readable } = jest.requireActual('stream');
        return {
          stream: Readable.from([Buffer.from(mockStorageObjects.get(path)!)]),
          version: mockStorageVersions.has(path)
            ? mockStorageVersions.get(path)
            : `FAKE-v1:${path}`,
        };
      }),
    }),
  },
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({}));
// FAKE sniffer for the upload helpers ManagedMediaService loads (the real
// one is ESM-only); no upload runs in this spec. Only file-type is faked: the
// content sanitizer below stays the real one
jest.mock(
  'file-type',
  () => ({ fileTypeStream: jest.fn(), fileTypeFromBuffer: jest.fn() }),
  { virtual: true }
);

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { sanitizePostContent } from '@gitroom/helpers/utils/sanitize.post.content';
import { FakePrismaDb } from './fakes/fake.prisma.db';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import {
  fingerprint,
  ManagedService,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import {
  CreateManagedDraftDto,
  EditManagedDraftDto,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.post.dto';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = 'ww-test';

const SECRETS = {
  token: 'FAKE-ACCESS-TOKEN-should-never-leave',
  refreshToken: 'FAKE-REFRESH-TOKEN-should-never-leave',
  customInstanceDetails: '{"privateKey":"FAKE-PRIVATE-KEY-should-never-leave"}',
  additionalSettings: '[{"title":"FAKE-SETTING-should-never-leave"}]',
  picture: 'https://FAKE-picture.example/should-never-leave.png',
};

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err: any) {
    return { status: err.getStatus?.(), code: err.getResponse?.()?.code };
  }
  throw new Error('expected a refusal');
}

const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

describe('ManagedService (FAKE in-memory Prisma, real repository + service)', () => {
  let db: FakePrismaDb;
  let repository: ManagedRepository;
  let service: ManagedService;
  let media: ManagedMediaService;

  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = `${ORG},${OTHER_ORG}`;
    db = new FakePrismaDb();
    repository = new ManagedRepository(
      { model: db.model } as any,
      { model: db.model } as any
    );
    media = new ManagedMediaService(repository);
    service = new ManagedService(repository, media);
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
    mockStorageVersions.clear();
    mockStorageObjects.clear();
    mockStorageNamespace.value = 'FAKE-namespace-1';
  });

  function seedIntegration(organizationId = ORG, overrides: any = {}) {
    return db.insert('integration', {
      organizationId,
      name: 'W&W page',
      customName: null,
      providerIdentifier: 'linkedin-page',
      internalId: `internal-${Math.random()}`,
      rootInternalId: 'root-1',
      profile: 'ww',
      type: 'social',
      disabled: false,
      refreshNeeded: false,
      inBetweenSteps: false,
      deletedAt: null,
      ...SECRETS,
      ...overrides,
    });
  }

  async function qualifiedChannel(organizationId = ORG) {
    const integration = seedIntegration(organizationId);
    const channels = await service.listChannels(organizationId);
    const channel = channels.find((c) => c.integrationId === integration.id)!;
    const qualified = await service.qualifyChannel(
      organizationId,
      CREDENTIAL,
      integration.id,
      {
        expectedGeneration: channel.binding.generation,
        identityFingerprint: channel.identityFingerprint,
      }
    );
    return { integration, generation: qualified.binding.generation };
  }

  async function capturedMedia(
    bytes: string,
    organizationId = ORG,
    mimetype = 'image/png'
  ) {
    const extension = (
      { 'image/png': 'png', 'image/jpeg': 'jpg', 'video/mp4': 'mp4' } as Record<
        string,
        string
      >
    )[mimetype];
    const name = `${Math.random().toString(16).slice(2)}.${extension}`;
    const result = await media.recordCapturedUpload(organizationId, CREDENTIAL, {
      filename: name,
      path: `https://uploads.example/${name}`,
      mimetype,
      originalname: `photo.${extension}`,
      capturedDigest: { sha256: sha(bytes), byteLength: bytes.length },
    } as any);
    return result as { mediaId: string; sha256: string };
  }

  const mediaPath = (mediaId: string) =>
    db.tables.media.find((row) => row.id === mediaId)!.path;

  async function setup() {
    const channel = await qualifiedChannel();
    const first = await capturedMedia('FAKE-BYTES-1');
    const second = await capturedMedia('FAKE-BYTES-2');
    const body = (over: Partial<CreateManagedDraftDto> = {}) =>
      ({
        operationKey: 'ww:approval:1:create',
        integrationId: channel.integration.id,
        expectedBindingGeneration: channel.generation,
        intendedPublishDate: '2026-11-20T09:00:00.000Z',
        settings: { carousel_name: 'Launch' },
        members: [
          {
            content: '<p>Caption</p>',
            media: [
              { mediaId: second.mediaId, sha256: second.sha256 },
              { mediaId: first.mediaId, sha256: first.sha256 },
            ],
          },
          { content: '<p>First comment</p>', media: [] },
        ],
        ...over,
      } as CreateManagedDraftDto);

    const edit = (
      expectedRevision: number,
      operationKey: string,
      over: Partial<EditManagedDraftDto> = {}
    ) =>
      ({
        operationKey,
        expectedRevision,
        expectedBindingGeneration: channel.generation,
        intendedPublishDate: '2026-11-21T10:30:00.000Z',
        settings: { carousel_name: 'Launch v2' },
        members: [
          {
            content: '<p>Caption edited</p>',
            media: [{ mediaId: first.mediaId, sha256: first.sha256 }],
          },
          { content: '<p>First comment edited</p>', media: [] },
        ],
        ...over,
      } as EditManagedDraftDto);

    return { channel, first, second, body, edit };
  }

  describe('channels', () => {
    it('never returns tokens, private keys, settings, pictures or whole rows', async () => {
      seedIntegration();
      const channels = await service.listChannels(ORG);
      const serialized = JSON.stringify(channels);

      for (const secret of Object.values(SECRETS)) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toMatch(/token|privateKey|additionalSettings|picture|email/i);

      // the repository never even asks Prisma for them
      expect(db.integrationSelects.length).toBeGreaterThan(0);
      for (const select of db.integrationSelects) {
        expect(select).toBeDefined();
        for (const field of [
          'token',
          'refreshToken',
          'customInstanceDetails',
          'additionalSettings',
          'picture',
          'postingTimes',
        ]) {
          expect(select).not.toHaveProperty(field);
        }
      }

      expect(channels[0].identityEvidence).toBe(
        'RECORDED_IN_POSTIZ_NOT_UPSTREAM_VERIFIED'
      );
    });

    it('starts a binding as pending and refuses writes until it is qualified', async () => {
      const integration = seedIntegration();
      const [channel] = await service.listChannels(ORG);
      expect(channel.binding).toMatchObject({
        status: 'PENDING_QUALIFICATION',
        generation: 1,
      });

      const file = await capturedMedia('FAKE-BYTES');
      expect(
        await refusal(
          service.createDraft(ORG, CREDENTIAL, {
            operationKey: 'ww:approval:pending',
            integrationId: integration.id,
            expectedBindingGeneration: 1,
            intendedPublishDate: '2026-11-20T09:00:00.000Z',
            members: [
              {
                content: 'x',
                media: [{ mediaId: file.mediaId, sha256: file.sha256 }],
              },
            ],
          } as CreateManagedDraftDto)
        )
      ).toEqual({ status: 409, code: 'CHANNEL_NOT_QUALIFIED' });
    });

    it('qualifies only the exact generation and identity that was confirmed', async () => {
      const integration = seedIntegration();
      const [channel] = await service.listChannels(ORG);

      expect(
        await refusal(
          service.qualifyChannel(ORG, CREDENTIAL, integration.id, {
            expectedGeneration: 1,
            identityFingerprint: `sha256:${'0'.repeat(64)}`,
          })
        )
      ).toEqual({ status: 409, code: 'IDENTITY_FINGERPRINT_MISMATCH' });

      expect(
        await refusal(
          service.qualifyChannel(ORG, CREDENTIAL, integration.id, {
            expectedGeneration: 7,
            identityFingerprint: channel.identityFingerprint,
          })
        )
      ).toEqual({ status: 409, code: 'BINDING_GENERATION_MISMATCH' });

      const qualified = await service.qualifyChannel(
        ORG,
        CREDENTIAL,
        integration.id,
        { expectedGeneration: 1, identityFingerprint: channel.identityFingerprint }
      );
      expect(qualified.binding).toMatchObject({ status: 'QUALIFIED', generation: 2 });
    });

    it('pauses writes when the identity under the same integration id changes, until requalified', async () => {
      const { channel, body } = await setup();
      await service.createDraft(ORG, CREDENTIAL, body());

      // another account ends up behind the same integration id
      db.patch('integration', channel.integration.id, {
        internalId: 'someone-else',
        profile: 'other',
      });

      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            body({ operationKey: 'ww:approval:2:create' })
          )
        )
      ).toEqual({ status: 409, code: 'CHANNEL_IDENTITY_CHANGED' });

      // the pause was committed even though the write was refused
      const [paused] = await service.listChannels(ORG);
      expect(paused.binding).toMatchObject({
        status: 'PAUSED_IDENTITY_CHANGED',
        generation: 3,
        boundIdentity: { internalId: channel.integration.internalId },
      });
      expect(paused.socialIdentity.internalId).toBe('someone-else');

      const feed = await service.changes(ORG, 0, 500);
      expect(feed.events.map((e) => e.kind)).toContain(
        'CHANNEL_PAUSED_IDENTITY_CHANGED'
      );

      const requalified = await service.qualifyChannel(
        ORG,
        CREDENTIAL,
        channel.integration.id,
        { expectedGeneration: 3, identityFingerprint: paused.identityFingerprint }
      );
      expect(requalified.binding).toMatchObject({ status: 'QUALIFIED', generation: 4 });

      // a writer still holding the old generation is refused
      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            body({ operationKey: 'ww:approval:3:create' })
          )
        )
      ).toEqual({ status: 409, code: 'BINDING_GENERATION_MISMATCH' });

      const created = await service.createDraft(
        ORG,
        CREDENTIAL,
        body({ operationKey: 'ww:approval:4:create', expectedBindingGeneration: 4 })
      );
      expect(created.post.bindingGeneration).toBe(4);
    });

    it('pauses a channel that was deleted', async () => {
      const { channel, body } = await setup();
      db.patch('integration', channel.integration.id, { deletedAt: new Date() });

      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, body()))
      ).toEqual({ status: 409, code: 'CHANNEL_IDENTITY_CHANGED' });
    });
  });

  describe('create (operation key + payload hash)', () => {
    it('creates a DRAFT with the exact members, order and media digests', async () => {
      const { body, first, second } = await setup();
      const result = await service.createDraft(ORG, CREDENTIAL, body());

      expect(result.replayed).toBe(false);
      expect(result.revision).toBe(1);
      expect(result.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.post.members.map((m) => m.role)).toEqual(['ROOT', 'CHILD']);
      expect(result.post.members[1].parentPostId).toBe(
        result.post.members[0].postId
      );
      expect(result.post.members[0].media.map((m) => [m.mediaId, m.sha256])).toEqual([
        [second.mediaId, second.sha256],
        [first.mediaId, first.sha256],
      ]);

      const rows = db.tables.post.filter((p) => p.group === result.post.group);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          state: 'DRAFT',
          organizationId: ORG,
          creationMethod: 'API',
        });
        expect(JSON.parse(row.settings)).toEqual({
          carousel_name: 'Launch',
          __type: 'linkedin-page',
        });
      }
      expect(JSON.parse(rows[0].image).map((i: any) => i.id)).toEqual([
        second.mediaId,
        first.mediaId,
      ]);
      // the stored content is byte for byte what was reviewed
      expect(rows.map((row) => row.content).sort()).toEqual(
        ['<p>Caption</p>', '<p>First comment</p>'].sort()
      );
    });

    it('replays a retried create with the same key and payload', async () => {
      const { body } = await setup();
      const first = await service.createDraft(ORG, CREDENTIAL, body());
      const retried = await service.createDraft(ORG, CREDENTIAL, body());

      expect(retried.replayed).toBe(true);
      expect(retried.managedPostId).toBe(first.managedPostId);
      expect(retried.post).toEqual(first.post);
      expect(db.tables.managedPost).toHaveLength(1);
      expect(db.tables.post).toHaveLength(2);
    });

    it('rejects the same key with a changed payload', async () => {
      const { body } = await setup();
      await service.createDraft(ORG, CREDENTIAL, body());

      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            body({ intendedPublishDate: '2026-11-20T09:00:01.000Z' })
          )
        )
      ).toEqual({ status: 409, code: 'OPERATION_KEY_PAYLOAD_MISMATCH' });
      expect(db.tables.managedPost).toHaveLength(1);
    });

    it('hashes the canonical payload, not its key order or date spelling', async () => {
      const { body } = await setup();
      const original = await service.createDraft(ORG, CREDENTIAL, body());
      const reordered = body({
        settings: { carousel_name: 'Launch' },
        intendedPublishDate: '2026-11-20T10:00:00+01:00',
      });
      const shuffled = Object.fromEntries(
        Object.entries(reordered).reverse()
      ) as CreateManagedDraftDto;

      const again = await service.createDraft(ORG, CREDENTIAL, shuffled);
      expect(again.replayed).toBe(true);
      expect(again.payloadHash).toBe(original.payloadHash);
    });

    it('turns concurrent duplicate creates into exactly one post', async () => {
      const { body } = await setup();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => service.createDraft(ORG, CREDENTIAL, body()))
      );

      expect(new Set(results.map((r) => r.managedPostId)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(db.tables.managedPost).toHaveLength(1);
      expect(db.tables.post).toHaveLength(2);
      expect(db.tables.managedOperation).toHaveLength(1);
    });
  });

  describe('edit (expected revision)', () => {
    it('atomically revises the same rows and keeps every revision', async () => {
      const { body, edit, first } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());
      const rowIds = created.post.members.map((m) => m.postId);

      const edited = await service.editDraft(
        ORG,
        CREDENTIAL,
        created.managedPostId,
        edit(1, 'ww:approval:1:edit:1')
      );

      expect(edited.revision).toBe(2);
      expect(edited.post.members.map((m) => m.postId)).toEqual(rowIds);
      expect(edited.post.group).toBe(created.post.group);
      expect(edited.post.members[0].media.map((m) => m.mediaId)).toEqual([
        first.mediaId,
      ]);

      const root = db.tables.post.find((p) => p.id === rowIds[0])!;
      expect(root.content).toBe('<p>Caption edited</p>');
      expect(root.state).toBe('DRAFT');
      expect(new Date(root.publishDate).toISOString()).toBe(
        '2026-11-21T10:30:00.000Z'
      );
      expect(db.tables.post).toHaveLength(2);

      const revisions = await service.listRevisions(ORG, created.managedPostId);
      expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
      expect(revisions[0].post.members[0].content).toBe('<p>Caption</p>');
      expect(revisions[1].post.members[0].content).toBe('<p>Caption edited</p>');
    });

    it('refuses a stale expected revision', async () => {
      const { body, edit } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());
      await service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:edit:a:0001'));

      expect(
        await refusal(
          service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:edit:b:0001'))
        )
      ).toEqual({ status: 409, code: 'REVISION_CONFLICT' });
    });

    it('lets exactly one of two concurrent edits from the same revision win', async () => {
      const { body, edit } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());

      const settled = await Promise.allSettled([
        service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:edit:left:01')),
        service.editDraft(
          ORG,
          CREDENTIAL,
          created.managedPostId,
          edit(1, 'ww:edit:right:1', { settings: { carousel_name: 'Other' } })
        ),
      ]);

      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason.getResponse().code).toBe('REVISION_CONFLICT');
      expect(db.tables.managedPost[0].revision).toBe(2);
    });

    it('replays a retried edit and rejects its key with another payload', async () => {
      const { body, edit } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());
      const once = await service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:edit:retry:1'));
      const twice = await service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:edit:retry:1'));

      expect(twice).toMatchObject({ replayed: true, revision: once.revision });
      expect(
        await refusal(
          service.editDraft(
            ORG,
            CREDENTIAL,
            created.managedPostId,
            edit(1, 'ww:edit:retry:1', { settings: { carousel_name: 'changed' } })
          )
        )
      ).toEqual({ status: 409, code: 'OPERATION_KEY_PAYLOAD_MISMATCH' });

      // a create key can't be reused for an edit either
      expect(
        await refusal(
          service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(2, 'ww:approval:1:create'))
        )
      ).toEqual({ status: 409, code: 'OPERATION_KEY_PAYLOAD_MISMATCH' });
    });

    describe('adding and removing members', () => {
      const members = (...contents: string[]) =>
        contents.map((content) => ({ content, media: [] })) as any;

      it('goes 1 -> 3 -> 2 -> 3 keeping the root and kept children, retiring and never reusing rows', async () => {
        const { body, edit } = await setup();
        const created = await service.createDraft(
          ORG,
          CREDENTIAL,
          body({ members: members('<p>Root</p>') })
        );
        const [rootId] = created.post.members.map((m) => m.postId);

        const three = await service.editDraft(
          ORG,
          CREDENTIAL,
          created.managedPostId,
          edit(1, 'ww:members:grow', {
            members: members('<p>Root v2</p>', '<p>Child one</p>', '<p>Child two</p>'),
          })
        );
        const ids = three.post.members.map((m) => m.postId);
        expect(three.revision).toBe(2);
        expect(ids[0]).toBe(rootId);
        expect(three.post.members.map((m) => [m.role, m.parentPostId])).toEqual([
          ['ROOT', null],
          ['CHILD', ids[0]],
          ['CHILD', ids[1]],
        ]);
        expect(three.post.retiredMembers).toBeUndefined();
        expect(db.tables.post.filter((p) => p.group === created.post.group)).toHaveLength(3);
        for (const id of ids.slice(1)) {
          expect(db.tables.post.find((p) => p.id === id)).toMatchObject({
            state: 'DRAFT',
            deletedAt: null,
            group: created.post.group,
            integrationId: created.post.integrationId,
            organizationId: ORG,
          });
        }

        const two = await service.editDraft(
          ORG,
          CREDENTIAL,
          created.managedPostId,
          edit(2, 'ww:members:shrink', {
            members: members('<p>Root v3</p>', '<p>Child one v3</p>'),
          })
        );
        expect(two.post.members.map((m) => m.postId)).toEqual(ids.slice(0, 2));
        expect(two.post.retiredMembers).toEqual([
          { postId: ids[2], position: 2, retiredAtRevision: 3 },
        ]);

        // retired, not deleted: the row keeps its reviewed content, leaves
        // the chain and is soft-deleted the way Postiz retires a comment
        const retired = db.tables.post.find((p) => p.id === ids[2])!;
        expect(retired).toMatchObject({
          content: '<p>Child two</p>',
          parentPostId: null,
          state: 'DRAFT',
        });
        expect(retired.deletedAt).toBeInstanceOf(Date);
        expect(db.tables.post).toHaveLength(3);

        const view = await service.getPost(ORG, created.managedPostId);
        expect(view.integrity.status).toBe('CONSISTENT');
        expect(view.state).toBe('DRAFT');
        expect(view.members.map((m) => m.postId)).toEqual(ids.slice(0, 2));
        expect(view.retiredMembers.map((m) => m.postId)).toEqual([ids[2]]);

        // growing again makes a new row after the last kept one
        const regrown = await service.editDraft(
          ORG,
          CREDENTIAL,
          created.managedPostId,
          edit(3, 'ww:members:regrow', {
            members: members('<p>Root v4</p>', '<p>Child one v4</p>', '<p>New child</p>'),
          })
        );
        expect(regrown.post.members.map((m) => m.postId).slice(0, 2)).toEqual(ids.slice(0, 2));
        expect(regrown.post.members[2].postId).not.toBe(ids[2]);
        expect(regrown.post.members[2].parentPostId).toBe(ids[1]);
        expect(regrown.post.retiredMembers!.map((m) => m.postId)).toEqual([ids[2]]);
        expect(db.tables.post).toHaveLength(4);
        expect(db.tables.post.find((p) => p.id === ids[2])!.content).toBe('<p>Child two</p>');
        expect((await service.getPost(ORG, created.managedPostId)).integrity.status).toBe(
          'CONSISTENT'
        );

        // every revision is kept with its own members, counts and key
        const revisions = await service.listRevisions(ORG, created.managedPostId);
        expect(
          revisions.map((r) => [
            r.revision,
            r.operationKey,
            r.memberCount,
            r.retiredMemberCount,
            r.current,
          ])
        ).toEqual([
          [1, 'ww:approval:1:create', 1, 0, false],
          [2, 'ww:members:grow', 3, 0, false],
          [3, 'ww:members:shrink', 2, 1, false],
          [4, 'ww:members:regrow', 3, 1, true],
        ]);
        expect(revisions[1].post.members[2]).toMatchObject({
          postId: ids[2],
          content: '<p>Child two</p>',
        });
        expect(revisions[0].post).toEqual(created.post);
        expect(revisions[1].post).toEqual(three.post);
      });

      it('answers a replayed old edit key with its own historical revision, writing nothing', async () => {
        const { body, edit } = await setup();
        const created = await service.createDraft(ORG, CREDENTIAL, body());
        const grow = edit(1, 'ww:members:grow', {
          members: members('<p>a</p>', '<p>b</p>', '<p>c</p>'),
        });
        const three = await service.editDraft(ORG, CREDENTIAL, created.managedPostId, grow);
        await service.editDraft(
          ORG,
          CREDENTIAL,
          created.managedPostId,
          edit(2, 'ww:members:shrink', { members: members('<p>a</p>') })
        );
        const rows = structuredClone(db.tables.post);
        const events = db.tables.managedChangeEvent.length;

        const replay = await service.editDraft(ORG, CREDENTIAL, created.managedPostId, grow);
        expect(replay).toMatchObject({ replayed: true, revision: 2 });
        expect(replay.post).toEqual(three.post);
        expect(db.tables.managedPost[0].revision).toBe(3);
        expect(db.tables.post).toEqual(rows);
        expect(db.tables.managedChangeEvent).toHaveLength(events);
      });

      it('lets one of two concurrent membership edits from the same revision win', async () => {
        const { body, edit } = await setup();
        const created = await service.createDraft(ORG, CREDENTIAL, body());

        const settled = await Promise.allSettled([
          service.editDraft(
            ORG,
            CREDENTIAL,
            created.managedPostId,
            edit(1, 'ww:race:grow:1', { members: members('<p>a</p>', '<p>b</p>', '<p>c</p>') })
          ),
          service.editDraft(
            ORG,
            CREDENTIAL,
            created.managedPostId,
            edit(1, 'ww:race:shrink:1', { members: members('<p>a</p>') })
          ),
        ]);

        const won = settled.filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<any>[];
        expect(won).toHaveLength(1);
        const lost = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
        expect(lost.reason.getResponse().code).toBe('REVISION_CONFLICT');

        const winner = won[0].value;
        const view = await service.getPost(ORG, created.managedPostId);
        expect(view.revision).toBe(2);
        expect(view.integrity.status).toBe('CONSISTENT');
        expect(view.members.map((m) => m.postId)).toEqual(
          winner.post.members.map((m: any) => m.postId)
        );
        // 3 live rows, or 1 live row and 1 retired one; never a mix of both
        expect(db.tables.post).toHaveLength(winner.post.members.length === 3 ? 3 : 2);
        expect(db.tables.managedOperation).toHaveLength(2);
      });

      it('refuses to retire a child that left DRAFT, retiring nothing', async () => {
        const { body, edit } = await setup();
        const created = await service.createDraft(ORG, CREDENTIAL, body());
        const childId = created.post.members[1].postId;
        db.patch('post', childId, { state: 'QUEUE' });

        expect(
          await refusal(
            service.editDraft(
              ORG,
              CREDENTIAL,
              created.managedPostId,
              edit(1, 'ww:members:queued', { members: members('<p>only root</p>') })
            )
          )
        ).toEqual({ status: 409, code: 'POST_NOT_DRAFT' });
        expect(db.tables.post.find((p) => p.id === childId)).toMatchObject({
          deletedAt: null,
          parentPostId: created.post.members[0].postId,
        });
        expect(db.tables.managedPost[0].revision).toBe(1);
      });

      it('shows a retired row changed outside the managed path as drift and refuses the edit', async () => {
        const { body, edit } = await setup();
        const created = await service.createDraft(ORG, CREDENTIAL, body());
        await service.editDraft(
          ORG,
          CREDENTIAL,
          created.managedPostId,
          edit(1, 'ww:members:shrink', { members: members('<p>only root</p>') })
        );

        // FAKE bypass writer: un-deletes the retired row
        db.patch('post', created.post.members[1].postId, { deletedAt: null });

        expect((await service.getPost(ORG, created.managedPostId)).integrity.status).toBe(
          'DRIFTED'
        );
        expect(
          await refusal(
            service.editDraft(
              ORG,
              CREDENTIAL,
              created.managedPostId,
              edit(2, 'ww:members:after:drift', { members: members('<p>x</p>') })
            )
          )
        ).toEqual({ status: 409, code: 'POST_DRIFTED' });
      });
    });

    it('detects rows changed outside the managed path and refuses to edit them', async () => {
      const { body, edit } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());
      expect((await service.getPost(ORG, created.managedPostId)).integrity.status).toBe(
        'CONSISTENT'
      );

      // simulates a writer that bypassed the fence (e.g. raw SQL)
      db.patch('post', created.post.members[1].postId, { content: 'tampered' });

      const view = await service.getPost(ORG, created.managedPostId);
      expect(view.integrity.status).toBe('DRIFTED');
      expect(
        await refusal(
          service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:edit:drift:1'))
        )
      ).toEqual({ status: 409, code: 'POST_DRIFTED' });
    });

    it('refuses to edit a post that left DRAFT', async () => {
      const { body, edit } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());
      db.patch('post', created.post.members[0].postId, { state: 'QUEUE' });

      expect(
        await refusal(
          service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:edit:state:1'))
        )
      ).toEqual({ status: 409, code: 'POST_NOT_DRAFT' });
    });

    it('turns a row that left DRAFT during the write into a 409 and rolls the other rows back', async () => {
      const { body } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());
      const [rootId, childId] = created.post.members.map((m) => m.postId);
      db.patch('post', childId, { state: 'QUEUE' });

      const row = {
        content: '<p>raced</p>',
        delay: 0,
        image: '[]',
        settings: '{}',
        publishDate: new Date(),
      };
      expect(
        await refusal(
          repository.mutate(ORG, async (tx) => {
            await tx.updatePostRow(rootId, row);
            await tx.updatePostRow(childId, row);
          })
        )
      ).toEqual({ status: 409, code: 'POST_NOT_DRAFT' });
      expect(db.tables.post.find((p) => p.id === rootId)!.content).toBe('<p>Caption</p>');
    });
  });

  describe('reviewed content and settings are never changed', () => {
    it('gates on the real editor sanitizer, not a stand-in', () => {
      // DOMPurify on jsdom; a stub returning its input would fail here
      expect(sanitizePostContent('<p onclick="alert(1)">Hi</p>')).toBe('<p>Hi</p>');
      expect(sanitizePostContent('<p>Hi</p><script>alert(1)</script>')).toBe('<p>Hi</p>');
      expect(sanitizePostContent('<p>A & B</p>')).toBe('<p>A &amp; B</p>');
      expect(sanitizePostContent('<div>Hi</div>')).toBe('<p>Hi</p>');
      expect(sanitizePostContent('<p>Caption</p>')).toBe('<p>Caption</p>');
    });

    it.each([
      ['an event handler', '<p onclick="alert(1)">Hi</p>'],
      ['a script', '<p>Hi</p><script>alert(1)</script>'],
      ['a javascript: link', '<p><a href="javascript:alert(1)">x</a></p>'],
      ['a tag the editor rewrites', '<div>Hi</div>'],
      ['an unescaped ampersand', '<p>A & B</p>'],
    ])('refuses content with %s as it is', async (_label, content) => {
      const { body } = await setup();
      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            body({ members: [{ content, media: [] }] as any })
          )
        )
      ).toEqual({ status: 422, code: 'CONTENT_NOT_CANONICAL' });
      expect(db.tables.post).toHaveLength(0);
      expect(db.tables.managedOperation).toHaveLength(0);
    });

    it('refuses a member without text or media', async () => {
      const { body } = await setup();
      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            body({ members: [{ content: '<p></p>', media: [] }] as any })
          )
        )
      ).toMatchObject({ status: 400 });
    });

    it('validates settings against the provider settings DTO, strictly', async () => {
      const { body } = await setup();
      for (const [key, settings] of [
        ['unknown', { title: 'not a linkedin field' }],
        ['wrong-type', { post_as_images_carousel: 'yes' }],
        ['type', { __type: 'x' }],
      ] as const) {
        expect(
          await refusal(
            service.createDraft(
              ORG,
              CREDENTIAL,
              body({ operationKey: `ww:settings:${key}`, settings: settings as any })
            )
          )
        ).toEqual({ status: 422, code: 'SETTINGS_INVALID' });
      }
      expect(db.tables.post).toHaveLength(0);
    });

    it('requires an explicit offset on the intended date', async () => {
      const dto = (intendedPublishDate: string) =>
        plainToInstance(CreateManagedDraftDto, {
          operationKey: 'ww:approval:dto:1',
          integrationId: 'int',
          expectedBindingGeneration: 1,
          intendedPublishDate,
          members: [{ content: 'x', media: [] }],
        });

      const errors = async (date: string) =>
        (await validate(dto(date))).map((error) => error.property);

      expect(await errors('2026-11-20T09:00:00')).toContain('intendedPublishDate');
      expect(await errors('2026-11-20T09:00:00Z')).not.toContain('intendedPublishDate');
      expect(await errors('2026-11-20T10:00:00+01:00')).not.toContain('intendedPublishDate');
    });
  });

  describe('media proof', () => {
    it('refuses unknown, foreign, unproven and mismatched media', async () => {
      const { body, first } = await setup();
      const withMedia = (mediaId: string, sha256: string, key: string) =>
        body({
          operationKey: key,
          members: [{ content: 'x', media: [{ mediaId, sha256 }] }] as any,
        });

      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            withMedia('33333333-3333-4333-8333-333333333333', sha('a'), 'ww:media:unknown')
          )
        )
      ).toEqual({ status: 422, code: 'MEDIA_NOT_FOUND' });

      const foreign = await capturedMedia('FAKE-FOREIGN', OTHER_ORG);
      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            withMedia(foreign.mediaId, foreign.sha256, 'ww:media:foreign')
          )
        )
      ).toEqual({ status: 422, code: 'MEDIA_NOT_FOUND' });

      // a media row with no digest (e.g. uploaded before enrollment)
      const unproven = db.insert('media', {
        organizationId: ORG,
        name: 'old.png',
        path: 'https://uploads.example/old.png',
      });
      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            withMedia(unproven.id, sha('old'), 'ww:media:unproven')
          )
        )
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_MISSING' });

      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            withMedia(first.mediaId, sha('not the approved bytes'), 'ww:media:mismatch')
          )
        )
      ).toEqual({ status: 422, code: 'MEDIA_DIGEST_MISMATCH' });

      expect(db.tables.managedPost).toHaveLength(0);
      expect(db.tables.post).toHaveLength(0);
    });

    it('stops trusting evidence once the stored file path changed', async () => {
      const { body, first } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());

      db.patch('media', first.mediaId, { path: 'https://uploads.example/replaced.png' });

      const view = await service.getPost(ORG, created.managedPostId);
      const statuses = view.members[0].media.map((m) => [m.mediaId, m.status]);
      expect(statuses).toContainEqual([first.mediaId, 'UNVERIFIED_CHANGED_SINCE_REVISION']);

      expect(
        await refusal(
          service.createDraft(ORG, CREDENTIAL, body({ operationKey: 'ww:media:replaced' }))
        )
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_MISSING' });
    });

    it('refuses a remembered digest once the object at the same path was rewritten', async () => {
      const { body, first } = await setup();

      // in place, same path (e.g. a processor overwriting the key)
      mockStorageVersions.set(mediaPath(first.mediaId), 'FAKE-v2');
      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, body()))
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });

      // a version that can't be read is not proof either
      mockStorageVersions.set(mediaPath(first.mediaId), null);
      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, body()))
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });
      expect(db.tables.post).toHaveLength(0);
    });

    it('pins evidence to a key and namespace that no response carries', async () => {
      const { body, first } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());

      expect(
        db.tables.managedMediaEvidence.find((row) => row.mediaId === first.mediaId)
      ).toMatchObject({
        storageKey: mediaPath(first.mediaId).slice('https://uploads.example/'.length),
        storageNamespace: 'FAKE-namespace-1',
      });
      const serialized = JSON.stringify([
        created,
        await service.getPost(ORG, created.managedPostId),
        await service.listRevisions(ORG, created.managedPostId),
      ]);
      expect(serialized).not.toContain('FAKE-namespace-1');
      expect(serialized).not.toMatch(/storageKey|storageNamespace|storageVersion/);
    });

    it('refuses create and edit once the same URLs resolve in another namespace', async () => {
      const { body, edit, first } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());

      // same paths, same versions: only the namespace keys resolve in moved
      mockStorageNamespace.value = 'FAKE-namespace-2';
      expect(
        await refusal(
          service.createDraft(ORG, CREDENTIAL, body({ operationKey: 'ww:ns:create:1' }))
        )
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });
      expect(
        await refusal(
          service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:ns:edit:1'))
        )
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });

      // the acknowledged create is answered as committed; that is not a read
      const replay = await service.createDraft(ORG, CREDENTIAL, body());
      expect(replay).toMatchObject({ replayed: true, managedPostId: created.managedPostId });

      // nor is the media re-pinned to the other namespace by verifying it
      const evidence = db.tables.managedMediaEvidence.length;
      expect(
        await media.verifyStoredMedia(ORG, CREDENTIAL, first.mediaId)
      ).toMatchObject({ status: 'UNVERIFIED', reason: 'STORAGE_IDENTITY_CHANGED' });
      expect(db.tables.managedMediaEvidence).toHaveLength(evidence);

      mockStorageNamespace.value = 'FAKE-namespace-1';
      expect(
        await service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:ns:edit:2'))
      ).toMatchObject({ replayed: false, revision: 2 });
      expect(db.tables.managedPost[0].revision).toBe(2);
    });

    it('holds evidence recorded before it was pinned: no create, edit, re-pin or backfill', async () => {
      const { body, edit, first } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());

      // FAKE rows from before the pin existed
      for (const row of db.tables.managedMediaEvidence) {
        db.patch('managedMediaEvidence', row.id, { storageKey: null, storageNamespace: null });
      }

      expect(
        await refusal(
          service.createDraft(ORG, CREDENTIAL, body({ operationKey: 'ww:old:create:1' }))
        )
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });
      expect(
        await refusal(
          service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:old:edit:1'))
        )
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });

      const storage = (media as any).storage;
      expect(
        await media.verifyStoredMedia(ORG, CREDENTIAL, first.mediaId)
      ).toMatchObject({ status: 'UNVERIFIED', reason: 'STORAGE_IDENTITY_UNPROVEN' });
      expect(storage.openObjectAt).not.toHaveBeenCalled();
      expect(db.tables.managedMediaEvidence).toHaveLength(2);
      for (const row of db.tables.managedMediaEvidence) {
        expect(row).toMatchObject({ storageKey: null, storageNamespace: null });
      }

      expect(await service.createDraft(ORG, CREDENTIAL, body())).toMatchObject({
        replayed: true,
        managedPostId: created.managedPostId,
      });
      expect(db.tables.managedPost).toHaveLength(1);
      expect(db.tables.managedPost[0].revision).toBe(1);
    });

    it('never lets an equal digest of another object stand in for the approved one', async () => {
      const { body, first } = await setup();
      // equal bytes in another object, at the same FAKE version string
      const twin = await capturedMedia('FAKE-BYTES-1');
      expect(twin.sha256).toBe(first.sha256);
      const twinEvidence = db.tables.managedMediaEvidence.find((row) => row.mediaId === twin.mediaId)!;

      // an evidence row of `first` naming the twin's object is not current
      const evidence = db.tables.managedMediaEvidence.find((row) => row.mediaId === first.mediaId)!;
      const ownKey = evidence.storageKey;
      db.patch('managedMediaEvidence', evidence.id, { storageKey: twinEvidence.storageKey });
      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, body()))
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });

      // nor is media pointed at the twin's path carried by its old evidence
      db.patch('managedMediaEvidence', evidence.id, { storageKey: ownKey });
      db.patch('media', first.mediaId, { path: mediaPath(twin.mediaId) });
      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, body({ operationKey: 'ww:twin:1' })))
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_MISSING' });
      expect(db.tables.post).toHaveLength(0);
    });

    it('refuses evidence whose stored path now addresses another key', async () => {
      const { body } = await setup();
      // FAKE: the public address moved, so the same path names another key
      (media as any).storage.objectKeyOf.mockImplementation(() => 'elsewhere.png');
      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, body()))
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });
      expect(db.tables.post).toHaveLength(0);
    });

    it('refuses media that is not ready', async () => {
      const { body, first } = await setup();
      for (const status of ['processing', 'failed']) {
        db.patch('media', first.mediaId, { status });
        expect(
          await refusal(service.createDraft(ORG, CREDENTIAL, body()))
        ).toEqual({ status: 422, code: 'MEDIA_NOT_READY' });
      }
    });

    it('never carries an unproven thumbnail or an unreviewed alt text into the draft', async () => {
      const { body, first, second } = await setup();
      for (const mediaId of [first.mediaId, second.mediaId]) {
        db.patch('media', mediaId, {
          thumbnail: 'https://uploads.example/FAKE-thumbnail.jpg',
          alt: 'FAKE alt nobody reviewed',
        });
      }

      const created = await service.createDraft(ORG, CREDENTIAL, body());
      const root = db.tables.post.find((p) => p.id === created.post.members[0].postId)!;
      for (const image of JSON.parse(root.image)) {
        expect(Object.keys(image).sort()).toEqual(['id', 'name', 'path']);
      }

      const view = await service.getPost(ORG, created.managedPostId);
      // a read only reports what was recorded, it does not look at the bytes
      expect(view.members[0].media.map((m) => m.status)).toEqual([
        'EVIDENCE_RECORDED_AT_REVISION',
        'EVIDENCE_RECORDED_AT_REVISION',
      ]);
    });
  });

  describe('media options (alt, thumbnail, thumbnailTimestampMs)', () => {
    async function optionsSetup() {
      const base = await setup();
      const video = await capturedMedia('FAKE-VIDEO', ORG, 'video/mp4');
      const cover = await capturedMedia('FAKE-COVER', ORG, 'image/jpeg');
      const withMedia = (key: string, ...refs: any[]) =>
        base.body({
          operationKey: key,
          members: [{ content: '<p>Video</p>', media: refs }] as any,
        });
      return { ...base, video, cover, withMedia };
    }

    const nothingWritten = () => {
      expect(db.tables.post).toHaveLength(0);
      expect(db.tables.managedPost).toHaveLength(0);
      expect(db.tables.managedOperation).toHaveLength(0);
    };

    it('writes the reviewed options into Post.image in the shape providers read', async () => {
      const { video, cover, first, body } = await optionsSetup();
      const created = await service.createDraft(
        ORG,
        CREDENTIAL,
        body({
          operationKey: 'ww:options:create:1',
          members: [
            {
              content: '<p>Video</p>',
              media: [
                {
                  mediaId: video.mediaId,
                  sha256: video.sha256,
                  alt: 'A reviewed description',
                  thumbnail: { mediaId: cover.mediaId, sha256: cover.sha256 },
                },
              ],
            },
            {
              content: '<p>Picture</p>',
              media: [{ mediaId: first.mediaId, sha256: first.sha256, alt: 'Second alt' }],
            },
          ] as any,
        })
      );

      const [root, child] = created.post.members.map(
        (m) => db.tables.post.find((p) => p.id === m.postId)!
      );
      expect(JSON.parse(root.image)).toEqual([
        {
          id: video.mediaId,
          name: expect.any(String),
          path: mediaPath(video.mediaId),
          alt: 'A reviewed description',
          thumbnail: mediaPath(cover.mediaId),
        },
      ]);
      expect(JSON.parse(child.image)).toEqual([
        {
          id: first.mediaId,
          name: expect.any(String),
          path: mediaPath(first.mediaId),
          alt: 'Second alt',
        },
      ]);

      // the snapshot binds the options and the cover's own digest
      const ref = created.post.members[0].media[0];
      expect(ref).toMatchObject({
        mediaId: video.mediaId,
        sha256: video.sha256,
        mimeType: 'video/mp4',
        alt: 'A reviewed description',
        thumbnail: {
          mediaId: cover.mediaId,
          sha256: cover.sha256,
          mimeType: 'image/jpeg',
          evidenceId: expect.any(String),
        },
      });
      expect(ref).not.toHaveProperty('thumbnailTimestampMs');

      // current read, inventory and history carry the same options
      const view = await service.getPost(ORG, created.managedPostId);
      expect(view.members[0].media[0]).toMatchObject({
        alt: 'A reviewed description',
        status: 'EVIDENCE_RECORDED_AT_REVISION',
        thumbnail: { mediaId: cover.mediaId, status: 'EVIDENCE_RECORDED_AT_REVISION' },
      });
      const inventory = await service.inventory(ORG);
      expect(inventory.items[0].members[0].media[0].thumbnail).toMatchObject({
        mediaId: cover.mediaId,
        sha256: cover.sha256,
      });
      const [revision] = await service.listRevisions(ORG, created.managedPostId);
      expect(revision.post.members[0].media[0]).toEqual(ref);

      // no stored path, key or namespace in any answer
      const serialized = JSON.stringify([created, view, inventory, revision]);
      expect(serialized).not.toContain('uploads.example');
      expect(serialized).not.toMatch(/storageKey|storageNamespace|storageVersion/);
    });

    it('records a frame offset as given, unqualified against the video length', async () => {
      const { video, withMedia } = await optionsSetup();
      const created = await service.createDraft(
        ORG,
        CREDENTIAL,
        withMedia('ww:options:frame:1', {
          mediaId: video.mediaId,
          sha256: video.sha256,
          thumbnailTimestampMs: 0,
        })
      );

      const root = db.tables.post.find((p) => p.id === created.post.members[0].postId)!;
      expect(JSON.parse(root.image)[0]).toEqual({
        id: video.mediaId,
        name: expect.any(String),
        path: mediaPath(video.mediaId),
        thumbnailTimestamp: 0,
      });
      expect(created.post.members[0].media[0]).toMatchObject({
        thumbnailTimestampMs: 0,
        thumbnailTimestampBounds: 'UNQUALIFIED_DURATION_UNKNOWN',
      });
    });

    it('refuses a thumbnail together with a frame offset', async () => {
      const { video, cover, withMedia } = await optionsSetup();
      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            withMedia('ww:options:both:1', {
              mediaId: video.mediaId,
              sha256: video.sha256,
              thumbnail: { mediaId: cover.mediaId, sha256: cover.sha256 },
              thumbnailTimestampMs: 1000,
            })
          )
        )
      ).toEqual({ status: 400, code: 'INVALID_INPUT' });
      nothingWritten();
    });

    it('refuses a cover on a picture and a cover that is not a JPEG or PNG', async () => {
      const { video, cover, first, withMedia } = await optionsSetup();
      const other = await capturedMedia('FAKE-OTHER-VIDEO', ORG, 'video/mp4');

      for (const [key, ref] of [
        ['ww:options:img:thumb', { mediaId: first.mediaId, sha256: first.sha256, thumbnail: { mediaId: cover.mediaId, sha256: cover.sha256 } }],
        ['ww:options:img:frame', { mediaId: first.mediaId, sha256: first.sha256, thumbnailTimestampMs: 10 }],
        ['ww:options:video:cover', { mediaId: video.mediaId, sha256: video.sha256, thumbnail: { mediaId: other.mediaId, sha256: other.sha256 } }],
      ] as const) {
        expect([key, await refusal(service.createDraft(ORG, CREDENTIAL, withMedia(key, ref)))]).toEqual([
          key,
          { status: 422, code: 'MEDIA_OPTIONS_INVALID' },
        ]);
      }

      // a type is only what was proven with the bytes
      db.patch(
        'managedMediaEvidence',
        db.tables.managedMediaEvidence.find((row) => row.mediaId === video.mediaId)!.id,
        { mimeType: null }
      );
      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            withMedia('ww:options:untyped', { mediaId: video.mediaId, sha256: video.sha256, thumbnailTimestampMs: 10 })
          )
        )
      ).toEqual({ status: 422, code: 'MEDIA_OPTIONS_INVALID' });
      nothingWritten();
    });

    it('proves the cover like any media: unknown, foreign, unproven, mismatched or stale fail before a write', async () => {
      const { video, cover, withMedia } = await optionsSetup();
      const withCover = (key: string, thumbnail: { mediaId: string; sha256: string }) =>
        withMedia(key, { mediaId: video.mediaId, sha256: video.sha256, thumbnail });

      const foreign = await capturedMedia('FAKE-FOREIGN-COVER', OTHER_ORG, 'image/jpeg');
      const unproven = db.insert('media', {
        organizationId: ORG,
        name: 'old.jpg',
        path: 'https://uploads.example/old.jpg',
      });

      expect(
        await refusal(
          service.createDraft(ORG, CREDENTIAL, withCover('ww:cover:unknown', { mediaId: '33333333-3333-4333-8333-333333333333', sha256: cover.sha256 }))
        )
      ).toEqual({ status: 422, code: 'MEDIA_NOT_FOUND' });
      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, withCover('ww:cover:foreign', foreign)))
      ).toEqual({ status: 422, code: 'MEDIA_NOT_FOUND' });
      expect(
        await refusal(
          service.createDraft(ORG, CREDENTIAL, withCover('ww:cover:unproven', { mediaId: unproven.id, sha256: sha('old') }))
        )
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_MISSING' });
      expect(
        await refusal(
          service.createDraft(ORG, CREDENTIAL, withCover('ww:cover:mismatch', { mediaId: cover.mediaId, sha256: sha('other bytes') }))
        )
      ).toEqual({ status: 422, code: 'MEDIA_DIGEST_MISMATCH' });

      // the cover's object was rewritten in place
      mockStorageVersions.set(mediaPath(cover.mediaId), 'FAKE-v2');
      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, withCover('ww:cover:stale', cover)))
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });
      mockStorageVersions.clear();

      // the same URLs now resolve in another namespace
      mockStorageNamespace.value = 'FAKE-namespace-2';
      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, withCover('ww:cover:namespace', cover)))
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });
      nothingWritten();
    });

    it('refuses an edit to a cover whose proof went stale, leaving the rows as they were', async () => {
      const { video, cover, withMedia, edit } = await optionsSetup();
      const created = await service.createDraft(
        ORG,
        CREDENTIAL,
        withMedia('ww:options:edit:create', { mediaId: video.mediaId, sha256: video.sha256 })
      );
      const before = structuredClone(db.tables.post);

      mockStorageVersions.set(mediaPath(cover.mediaId), 'FAKE-v2');
      expect(
        await refusal(
          service.editDraft(
            ORG,
            CREDENTIAL,
            created.managedPostId,
            edit(1, 'ww:options:edit:1', {
              members: [
                {
                  content: '<p>Video</p>',
                  media: [{ mediaId: video.mediaId, sha256: video.sha256, thumbnail: cover }],
                },
              ] as any,
            })
          )
        )
      ).toEqual({ status: 422, code: 'MEDIA_PROOF_STALE' });
      expect(db.tables.post).toEqual(before);
      expect(db.tables.managedPost[0].revision).toBe(1);
    });

    it('bounds the options in the request DTO, strictly', async () => {
      const dto = (ref: any) =>
        plainToInstance(CreateManagedDraftDto, {
          operationKey: 'ww:approval:dto:1',
          integrationId: 'int',
          expectedBindingGeneration: 1,
          intendedPublishDate: '2026-11-20T09:00:00Z',
          members: [{ content: 'x', media: [{ mediaId: 'm1', sha256: sha('x'), ...ref }] }],
        });
      const errors = async (ref: any) =>
        (await validate(dto(ref), { whitelist: true, forbidNonWhitelisted: true })).map(
          (error) => error.property
        );

      expect(await errors({})).toEqual([]);
      expect(await errors({ alt: 'x'.repeat(1000), thumbnailTimestampMs: 86400000 })).toEqual([]);
      for (const bad of [
        { alt: '' },
        { alt: 'x'.repeat(1001) },
        { alt: 'line\nbreak' },
        { alt: 42 },
        { thumbnailTimestampMs: -1 },
        { thumbnailTimestampMs: 1.5 },
        { thumbnailTimestampMs: 86400001 },
        { thumbnail: { mediaId: 'm2' } },
        { thumbnail: { mediaId: 'm2', sha256: sha('y'), path: 'https://elsewhere.example/x.jpg' } },
        { thumbnail: 'https://elsewhere.example/x.jpg' },
        { thumbnailPath: 'https://elsewhere.example/x.jpg' },
      ]) {
        expect([bad, await errors(bad)]).toEqual([bad, ['members']]);
      }
    });
  });

  describe('payload hash of requests without options', () => {
    it('is the hash of the earlier request shape, and explicit nulls change nothing', async () => {
      const { body, channel, first, second } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());

      // the normalized shape before options existed, written out
      expect(created.payloadHash).toBe(
        fingerprint({
          kind: 'CREATE_DRAFT',
          integrationId: channel.integration.id,
          expectedBindingGeneration: channel.generation,
          intendedPublishDate: '2026-11-20T09:00:00.000Z',
          settings: { carousel_name: 'Launch' },
          members: [
            {
              content: '<p>Caption</p>',
              delay: 0,
              media: [
                { mediaId: second.mediaId, sha256: second.sha256 },
                { mediaId: first.mediaId, sha256: first.sha256 },
              ],
            },
            { content: '<p>First comment</p>', delay: 0, media: [] },
          ],
        })
      );
      for (const row of db.tables.post) {
        for (const image of JSON.parse(row.image)) {
          expect(Object.keys(image).sort()).toEqual(['id', 'name', 'path']);
        }
      }

      const nulls = await service.createDraft(
        ORG,
        CREDENTIAL,
        body({
          members: [
            {
              content: '<p>Caption</p>',
              media: [
                { mediaId: second.mediaId, sha256: second.sha256, alt: null, thumbnail: null, thumbnailTimestampMs: null },
                { mediaId: first.mediaId, sha256: first.sha256 },
              ],
            },
            { content: '<p>First comment</p>', media: [] },
          ] as any,
        })
      );
      expect(nulls).toMatchObject({ replayed: true, payloadHash: created.payloadHash });

      // an option added under the same key is another payload
      expect(
        await refusal(
          service.createDraft(
            ORG,
            CREDENTIAL,
            body({
              members: [
                {
                  content: '<p>Caption</p>',
                  media: [
                    { mediaId: second.mediaId, sha256: second.sha256, alt: 'added' },
                    { mediaId: first.mediaId, sha256: first.sha256 },
                  ],
                },
                { content: '<p>First comment</p>', media: [] },
              ] as any,
            })
          )
        )
      ).toEqual({ status: 409, code: 'OPERATION_KEY_PAYLOAD_MISMATCH' });
      expect(db.tables.managedPost).toHaveLength(1);
    });
  });

  describe('operation status (lost acknowledgement recovery)', () => {
    it.each(['SCHEDULE', 'PUBLISH_NOW', 'CANCEL', 'DELETE', 'RESOLVE'])(
      'refuses a %s key through DRAFT lookup and replay without fabricating a snapshot',
      async (kind) => {
        const { body, edit } = await setup();
        const created = await service.createDraft(ORG, CREDENTIAL, body());
        const operationKey = `ww:lifecycle:probe:${kind}`;
        db.insert('managedOperation', {
          organizationId: ORG, operationKey, kind, credentialId: CREDENTIAL,
          payloadHash: created.payloadHash, managedPostId: created.managedPostId,
          revision: 1, sequence: 0,
        });
        const revisions = structuredClone(db.tables.managedPostRevision);
        const posts = structuredClone(db.tables.post);
        const events = structuredClone(db.tables.managedChangeEvent);
        const expected = { status: 409, code: 'OPERATION_KEY_KIND_MISMATCH' };
        expect(await refusal(service.operationStatus(ORG, operationKey))).toEqual(expected);
        expect(await refusal(service.createDraft(ORG, CREDENTIAL, body({ operationKey })))).toEqual(expected);
        expect(await refusal(service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, operationKey)))).toEqual(expected);
        expect(db.tables.managedPostRevision).toEqual(revisions);
        expect(db.tables.post).toEqual(posts);
        expect(db.tables.managedChangeEvent).toEqual(events);
        expect(await service.operationStatus(OTHER_ORG, operationKey)).toMatchObject({ status: 'ABSENT' });
        expect(await service.operationStatus(ORG, created.operationKey)).toMatchObject({ status: 'COMMITTED', kind: 'CREATE_DRAFT' });
      }
    );

    it('answers ABSENT for a key that never committed, and writes nothing', async () => {
      const { body } = await setup();
      await service.createDraft(ORG, CREDENTIAL, body());
      const before = structuredClone(db.tables);

      expect(await service.operationStatus(ORG, 'ww:never:sent:1')).toEqual({
        operationKey: 'ww:never:sent:1',
        status: 'ABSENT',
        asOfSequence: db.tables.managedOrganization.find((o) => o.organizationId === ORG)!
          .sequence,
      });
      expect(db.tables).toEqual(before);
    });

    it('answers a committed key with its own revision, CURRENT or HISTORICAL', async () => {
      const { body, edit } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());

      const fresh = await service.operationStatus(ORG, 'ww:approval:1:create');
      expect(fresh).toMatchObject({
        status: 'COMMITTED',
        kind: 'CREATE_DRAFT',
        managedPostId: created.managedPostId,
        revision: 1,
        currentRevision: 1,
        ack: 'CURRENT',
        payloadHash: created.payloadHash,
        sequence: created.sequence,
      });
      expect((fresh as any).post).toEqual(created.post);

      const edited = await service.editDraft(
        ORG,
        CREDENTIAL,
        created.managedPostId,
        edit(1, 'ww:status:edit:1')
      );
      const before = structuredClone(db.tables);
      const old = await service.operationStatus(ORG, 'ww:approval:1:create');
      expect(old).toMatchObject({ revision: 1, currentRevision: 2, ack: 'HISTORICAL' });
      expect((old as any).post).toEqual(created.post);
      expect(await service.operationStatus(ORG, 'ww:status:edit:1')).toMatchObject({
        kind: 'EDIT_DRAFT',
        revision: 2,
        ack: 'CURRENT',
        post: edited.post,
      });
      expect(db.tables).toEqual(before);

      const serialized = JSON.stringify([fresh, old]);
      expect(serialized).not.toContain('uploads.example');
      expect(serialized).not.toContain(CREDENTIAL);
      expect(serialized).not.toMatch(/storageKey|storageNamespace|storageVersion|credentialId/);
      for (const secret of Object.values(SECRETS)) {
        expect(serialized).not.toContain(secret);
      }
    });

    it('is scoped to the credential organization', async () => {
      const { body } = await setup();
      await service.createDraft(ORG, CREDENTIAL, body());
      const organizations = db.tables.managedOrganization.length;

      expect(await service.operationStatus(OTHER_ORG, 'ww:approval:1:create')).toEqual({
        operationKey: 'ww:approval:1:create',
        status: 'ABSENT',
        asOfSequence: 0,
      });
      expect(db.tables.managedOrganization).toHaveLength(organizations);
    });

    it('refuses a malformed key before reading anything', async () => {
      const read = jest.spyOn(repository, 'read');
      for (const key of ['short', 'has space key', 'x'.repeat(129), '../../etc/passwd']) {
        expect(await refusal(service.operationStatus(ORG, key))).toEqual({
          status: 400,
          code: 'INVALID_INPUT',
        });
      }
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('current-media observation (fresh private read, no writes)', () => {
    const storage = () => (media as any).storage;

    // a video with a cover and a picture used twice, its bytes in storage
    async function observed() {
      const { body, edit, first } = await setup();
      const video = await capturedMedia('FAKE-VIDEO', ORG, 'video/mp4');
      const cover = await capturedMedia('FAKE-COVER', ORG, 'image/jpeg');
      for (const [id, bytes] of [
        [first.mediaId, 'FAKE-BYTES-1'],
        [video.mediaId, 'FAKE-VIDEO'],
        [cover.mediaId, 'FAKE-COVER'],
      ]) {
        mockStorageObjects.set(mediaPath(id), bytes);
      }
      const created = await service.createDraft(
        ORG,
        CREDENTIAL,
        body({
          members: [
            {
              content: '<p>Caption</p>',
              media: [
                {
                  mediaId: video.mediaId,
                  sha256: video.sha256,
                  thumbnail: { mediaId: cover.mediaId, sha256: cover.sha256 },
                },
                { mediaId: first.mediaId, sha256: first.sha256 },
              ],
            },
            {
              content: '<p>First comment</p>',
              media: [{ mediaId: first.mediaId, sha256: first.sha256 }],
            },
          ],
        })
      );
      return { created, edit, first, video, cover };
    }

    // one picture, its bytes in storage
    async function single() {
      const { body, edit, first, channel } = await setup();
      mockStorageObjects.set(mediaPath(first.mediaId), 'FAKE-BYTES-1');
      const created = await service.createDraft(
        ORG,
        CREDENTIAL,
        body({
          members: [
            {
              content: '<p>Caption</p>',
              media: [{ mediaId: first.mediaId, sha256: first.sha256 }],
            },
          ],
        })
      );
      return { created, edit, first, channel };
    }

    it('reads every media and cover of the current revision by its pinned key, and writes nothing', async () => {
      const { created, first, video, cover } = await observed();
      const before = structuredClone(db.tables);
      const opened = storage().openObjectAt.mock.calls.length;
      const removed = storage().removeFile.mock.calls.length;

      const result = await service.observeCurrentMedia(ORG, created.managedPostId, 1);

      expect(db.tables).toEqual(before);
      // three objects, each read once
      expect(storage().openObjectAt.mock.calls.length - opened).toBe(3);
      expect(storage().removeFile.mock.calls.length).toBe(removed);
      expect(result).toMatchObject({
        managedPostId: created.managedPostId,
        revision: 1,
        observation: 'PRIVATE_STORAGE_READ_BY_PINNED_KEY',
        status: 'VERIFIED',
        reasons: [],
        rows: 'CONSISTENT',
        binding: {
          atRevisionGeneration: created.post.bindingGeneration,
          generation: created.post.bindingGeneration,
          status: 'QUALIFIED',
        },
      });
      if (result.status === 'INDETERMINATE') {
        throw new Error('expected an observation');
      }
      expect(
        result.media.map((m) => [m.memberPosition, m.mediaPosition, m.role, m.mediaId, m.status])
      ).toEqual([
        [0, 0, 'MEDIA', video.mediaId, 'VERIFIED'],
        [0, 0, 'THUMBNAIL', cover.mediaId, 'VERIFIED'],
        [0, 1, 'MEDIA', first.mediaId, 'VERIFIED'],
        [1, 0, 'MEDIA', first.mediaId, 'VERIFIED'],
      ]);
      expect(result.media[1]).toEqual({
        memberPosition: 0,
        mediaPosition: 0,
        role: 'THUMBNAIL',
        mediaId: cover.mediaId,
        evidenceId: created.post.members[0].media[0].thumbnail!.evidenceId,
        sha256: cover.sha256,
        byteLength: 'FAKE-COVER'.length,
        mimeType: 'image/jpeg',
        status: 'VERIFIED',
        observedAt: expect.any(String),
      });
      expect(result.startedAt <= result.media[0].observedAt).toBe(true);
      expect(result.media[3].observedAt <= result.finishedAt).toBe(true);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('uploads.example');
      expect(serialized).not.toMatch(
        /storageKey|storageNamespace|storageVersion|credentialId|FAKE-namespace|FAKE-v1/
      );
    });

    it('keeps GET /posts/:id a database read that never calls storage', async () => {
      const { created, first } = await observed();
      mockStorageObjects.set(mediaPath(first.mediaId), 'FAKE-BYTES-X');
      const calls = () =>
        storage().openObjectAt.mock.calls.length + storage().objectVersionAt.mock.calls.length;
      const before = calls();

      const view = await service.getPost(ORG, created.managedPostId);
      expect(view.members[0].media[1].status).toBe('EVIDENCE_RECORDED_AT_REVISION');
      expect(calls()).toBe(before);

      const result = await service.observeCurrentMedia(ORG, created.managedPostId, 1);
      expect(result).toMatchObject({ status: 'UNVERIFIED', reasons: ['MEDIA_UNVERIFIED'] });
    });

    it.each([
      ['NOT_IN_PRIVATE_STORAGE', ({ path }: any) => mockStorageVersions.set(path, null)],
      ['BYTES_MISMATCH', ({ path }: any) => mockStorageObjects.set(path, 'FAKE-BYTES-X')],
      ['BYTES_MISMATCH', ({ path }: any) => mockStorageObjects.set(path, 'FAKE-BYTES-1-and-more')],
      ['STORAGE_VERSION_CHANGED', ({ path }: any) => mockStorageVersions.set(path, 'FAKE-v2')],
      [
        'STORAGE_IDENTITY_CHANGED',
        (_target: any) => (mockStorageNamespace.value = 'FAKE-namespace-2'),
      ],
      [
        'READ_FAILED',
        (_target: any) => storage().openObjectAt.mockRejectedValueOnce(new Error('FAKE outage')),
      ],
      ['MEDIA_REMOVED', ({ mediaId }: any) => db.patch('media', mediaId, { deletedAt: new Date() })],
      ['MEDIA_NOT_READY', ({ mediaId }: any) => db.patch('media', mediaId, { status: 'processing' })],
      [
        'EVIDENCE_MISSING',
        ({ mediaId }: any) =>
          db.patch('media', mediaId, { path: 'https://uploads.example/replaced.png' }),
      ],
      [
        'STORAGE_IDENTITY_UNPROVEN',
        ({ mediaId }: any) =>
          db.patch(
            'managedMediaEvidence',
            db.tables.managedMediaEvidence.find((row) => row.mediaId === mediaId)!.id,
            { storageNamespace: null }
          ),
      ],
    ])('answers %s precisely, re-proving and recording nothing', async (reason, change) => {
      const { created, first } = await single();
      change({ path: mediaPath(first.mediaId), mediaId: first.mediaId });
      const before = structuredClone(db.tables);

      const result = await service.observeCurrentMedia(ORG, created.managedPostId, 1);

      expect(db.tables).toEqual(before);
      expect(result).toMatchObject({
        status: 'UNVERIFIED',
        reasons: ['MEDIA_UNVERIFIED'],
        rows: 'CONSISTENT',
        media: [{ mediaId: first.mediaId, status: 'UNVERIFIED', reason }],
      });
    });

    it.each([
      [
        'POST_CHANGED_DURING_OBSERVATION',
        (ctx: any) =>
          service.editDraft(ORG, CREDENTIAL, ctx.managedPostId, ctx.edit(1, 'ww:observe:race')),
      ],
      [
        'BINDING_CHANGED_DURING_OBSERVATION',
        async (ctx: any) => db.patch('integration', ctx.integrationId, { profile: 'someone-else' }),
      ],
      [
        'MEDIA_RECORD_CHANGED_DURING_OBSERVATION',
        async (ctx: any) => db.patch('media', ctx.mediaId, { status: 'processing' }),
      ],
    ])('answers %s as INDETERMINATE, claiming nothing', async (reason, change) => {
      const { created, edit, first, channel } = await single();
      let during: any;
      const observe = media.observeEvidence.bind(media);
      jest.spyOn(media, 'observeEvidence').mockImplementationOnce(async (entry, recorded) => {
        const found = await observe(entry, recorded);
        await change({
          managedPostId: created.managedPostId,
          edit,
          integrationId: channel.integration.id,
          mediaId: first.mediaId,
        });
        during = structuredClone(db.tables);
        return found;
      });

      const result = await service.observeCurrentMedia(ORG, created.managedPostId, 1);

      expect(result.status).toBe('INDETERMINATE');
      expect(result.reasons).toContain(reason);
      expect(result).not.toHaveProperty('media');
      expect(result).not.toHaveProperty('rows');
      // the observation itself wrote nothing after the change
      expect(db.tables).toEqual(during);
    });

    it('refuses a revision that is not current, an unknown post and another organization, before reading storage', async () => {
      const { created, edit } = await observed();
      await service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:observe:next'));
      const opened = storage().openObjectAt.mock.calls.length;
      const before = structuredClone(db.tables);

      expect(await refusal(service.observeCurrentMedia(ORG, created.managedPostId, 1))).toEqual({
        status: 409,
        code: 'REVISION_CONFLICT',
      });
      expect(
        await refusal(
          service.observeCurrentMedia(ORG, '44444444-4444-4444-8444-444444444444', 1)
        )
      ).toEqual({ status: 404, code: 'NOT_FOUND' });
      expect(
        await refusal(service.observeCurrentMedia(OTHER_ORG, created.managedPostId, 2))
      ).toEqual({ status: 404, code: 'NOT_FOUND' });
      expect(storage().openObjectAt.mock.calls.length).toBe(opened);
      expect(db.tables).toEqual(before);
    });

    it('reports drifted rows as UNVERIFIED and a text-only post as NO_MEDIA_REFERENCED', async () => {
      const { body } = await setup();
      const created = await service.createDraft(
        ORG,
        CREDENTIAL,
        body({ members: [{ content: '<p>Text only</p>', media: [] }] })
      );

      expect(await service.observeCurrentMedia(ORG, created.managedPostId, 1)).toMatchObject({
        status: 'NO_MEDIA_REFERENCED',
        reasons: [],
        rows: 'CONSISTENT',
        media: [],
      });

      // FAKE bypass writer
      db.patch('post', created.post.members[0].postId, { content: '<p>Changed elsewhere</p>' });
      expect(await service.observeCurrentMedia(ORG, created.managedPostId, 1)).toMatchObject({
        status: 'UNVERIFIED',
        reasons: ['ROWS_DRIFTED'],
        rows: 'DRIFTED',
        media: [],
      });
    });

    it('verifying unchanged media keeps its evidence: no write, the video and cover stay authorable and observed', async () => {
      const { created, edit, video, cover } = await observed();
      const before = structuredClone(db.tables);

      expect(await media.verifyStoredMedia(ORG, CREDENTIAL, video.mediaId)).toMatchObject({
        status: 'VERIFIED',
        mimeType: 'video/mp4',
        method: 'UPLOAD_CAPTURE',
      });
      expect(await media.verifyStoredMedia(ORG, CREDENTIAL, cover.mediaId)).toMatchObject({
        status: 'VERIFIED',
        mimeType: 'image/jpeg',
        method: 'UPLOAD_CAPTURE',
      });
      expect(db.tables).toEqual(before);

      expect(await service.observeCurrentMedia(ORG, created.managedPostId, 1)).toMatchObject({
        status: 'VERIFIED',
        reasons: [],
      });
      const view = await service.getPost(ORG, created.managedPostId);
      expect(view.members[0].media[0].status).toBe('EVIDENCE_RECORDED_AT_REVISION');

      // the same video with its cover is still accepted
      const members = [
        {
          content: '<p>Caption</p>',
          media: [
            {
              mediaId: video.mediaId,
              sha256: video.sha256,
              thumbnail: { mediaId: cover.mediaId, sha256: cover.sha256 },
            },
          ],
        },
      ];
      expect(
        await service.editDraft(
          ORG,
          CREDENTIAL,
          created.managedPostId,
          edit(1, 'ww:verify:edit:1', { members } as any)
        )
      ).toMatchObject({ replayed: false, revision: 2 });
    });

    it('re-proves a rewritten object by a new read, never by the evidence it replaced', async () => {
      const { created, video } = await observed();
      // FAKE processor: same key, a new version of the object
      mockStorageVersions.set(mediaPath(video.mediaId), 'FAKE-v2');
      const evidence = db.tables.managedMediaEvidence.length;

      expect(await media.verifyStoredMedia(ORG, CREDENTIAL, video.mediaId)).toMatchObject({
        status: 'VERIFIED',
        mimeType: null,
        method: 'PRIVATE_STORAGE_READ',
      });
      expect(db.tables.managedMediaEvidence).toHaveLength(evidence + 1);

      const result = await service.observeCurrentMedia(ORG, created.managedPostId, 1);
      expect(result).toMatchObject({ status: 'UNVERIFIED', reasons: ['MEDIA_UNVERIFIED'] });
      if (result.status === 'INDETERMINATE') {
        throw new Error('expected an observation');
      }
      expect(result.media[0]).toMatchObject({
        mediaId: video.mediaId,
        status: 'UNVERIFIED',
        reason: 'EVIDENCE_CHANGED_SINCE_REVISION',
      });
    });

    describe('bounds (per process)', () => {
      const waitFor = async (check: () => boolean) => {
        for (let i = 0; i < 200 && !check(); i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(check()).toBe(true);
      };
      const storageCalls = () =>
        storage().objectNamespace.mock.calls.length +
        storage().objectVersionAt.mock.calls.length +
        storage().openObjectAt.mock.calls.length;

      // FAKE evidence of a large object; its bytes are never in storage
      async function large(n: number) {
        const name = `large-${n}.png`;
        return (await media.recordCapturedUpload(ORG, CREDENTIAL, {
          filename: name,
          path: `https://uploads.example/${name}`,
          mimetype: 'image/png',
          originalname: name,
          capturedDigest: { sha256: sha(`FAKE-LARGE-${n}`), byteLength: 130 * 1024 * 1024 },
        } as any)) as { mediaId: string; sha256: string };
      }

      it('refuses distinct media above 256 MiB recorded before any storage call; one object used twice counts once', async () => {
        const { body } = await setup();
        const [a, b] = [await large(1), await large(2)];
        const ref = (m: { mediaId: string; sha256: string }) => ({
          mediaId: m.mediaId,
          sha256: m.sha256,
        });

        const twice = await service.createDraft(
          ORG,
          CREDENTIAL,
          body({
            operationKey: 'ww:bound:twice',
            members: [
              { content: '<p>One</p>', media: [ref(a)] },
              { content: '<p>Two</p>', media: [ref(a)] },
            ],
          })
        );
        expect(await service.observeCurrentMedia(ORG, twice.managedPostId, 1)).toMatchObject({
          status: 'UNVERIFIED',
          media: [{ reason: 'TOO_LARGE_FOR_BOUNDED_READ' }, { reason: 'TOO_LARGE_FOR_BOUNDED_READ' }],
        });

        const both = await service.createDraft(
          ORG,
          CREDENTIAL,
          body({
            operationKey: 'ww:bound:both',
            members: [{ content: '<p>Both</p>', media: [ref(a), ref(b)] }],
          })
        );
        const calls = storageCalls();
        const before = structuredClone(db.tables);
        expect(await refusal(service.observeCurrentMedia(ORG, both.managedPostId, 1))).toEqual({
          status: 422,
          code: 'OBSERVATION_BOUND_EXCEEDED',
        });
        expect(storageCalls()).toBe(calls);
        expect(db.tables).toEqual(before);

        // the refusal freed the organization's slot
        expect(await service.observeCurrentMedia(ORG, twice.managedPostId, 1)).toMatchObject({
          status: 'UNVERIFIED',
        });
      });

      it('runs one observation per organization: the same one is refused before reading, another is not held up', async () => {
        const { created } = await single();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const observe = media.observeEvidence.bind(media);
        const spy = jest
          .spyOn(media, 'observeEvidence')
          .mockImplementationOnce(async (...args) => {
            await gate;
            return observe(...args);
          });

        const running = service.observeCurrentMedia(ORG, created.managedPostId, 1);
        await waitFor(() => spy.mock.calls.length === 1);

        const calls = storageCalls();
        expect(await refusal(service.observeCurrentMedia(ORG, created.managedPostId, 1))).toEqual({
          status: 409,
          code: 'OBSERVATION_IN_PROGRESS',
        });
        expect(storageCalls()).toBe(calls);

        const other = await qualifiedChannel(OTHER_ORG);
        const otherDraft = await service.createDraft(OTHER_ORG, CREDENTIAL, {
          operationKey: 'ww:other:1:create',
          integrationId: other.integration.id,
          expectedBindingGeneration: other.generation,
          intendedPublishDate: '2026-11-20T09:00:00.000Z',
          settings: { carousel_name: 'Launch' },
          members: [{ content: '<p>Other</p>', media: [] }],
        } as CreateManagedDraftDto);
        expect(
          await service.observeCurrentMedia(OTHER_ORG, otherDraft.managedPostId, 1)
        ).toMatchObject({ status: 'NO_MEDIA_REFERENCED' });

        release();
        expect(await running).toMatchObject({ status: 'VERIFIED' });
        expect(await service.observeCurrentMedia(ORG, created.managedPostId, 1)).toMatchObject({
          status: 'VERIFIED',
        });
      });

      it('frees the slot when a read or the database throws', async () => {
        const { created } = await single();

        jest.spyOn(media, 'observeEvidence').mockRejectedValueOnce(new Error('FAKE crash'));
        await expect(
          service.observeCurrentMedia(ORG, created.managedPostId, 1)
        ).rejects.toThrow('FAKE crash');

        jest.spyOn(repository, 'read').mockRejectedValueOnce(new Error('FAKE outage'));
        await expect(
          service.observeCurrentMedia(ORG, created.managedPostId, 1)
        ).rejects.toThrow('FAKE outage');

        expect(await service.observeCurrentMedia(ORG, created.managedPostId, 1)).toMatchObject({
          status: 'VERIFIED',
        });
      });

      it('at the deadline destroys the stream mid-read and claims nothing', async () => {
        const { created, first } = await single();
        const deadline = new AbortController();
        const timeout = jest
          .spyOn(AbortSignal, 'timeout')
          .mockReturnValueOnce(deadline.signal);
        // FAKE object that stalls after its first bytes
        const { PassThrough } = jest.requireActual('stream');
        const stalled = new PassThrough();
        stalled.write('FAKE');
        storage().openObjectAt.mockResolvedValueOnce({
          stream: stalled,
          version: `FAKE-v1:${mediaPath(first.mediaId)}`,
        });
        const opened = storage().openObjectAt.mock.calls.length;
        const before = structuredClone(db.tables);

        const running = service.observeCurrentMedia(ORG, created.managedPostId, 1);
        await waitFor(() => storage().openObjectAt.mock.calls.length > opened);
        deadline.abort();
        const result = await running;
        timeout.mockRestore();

        expect(result).toMatchObject({
          status: 'INDETERMINATE',
          reasons: ['OBSERVATION_DEADLINE_EXCEEDED'],
        });
        expect(result).not.toHaveProperty('media');
        expect(stalled.destroyed).toBe(true);
        expect(db.tables).toEqual(before);

        expect(await service.observeCurrentMedia(ORG, created.managedPostId, 1)).toMatchObject({
          status: 'VERIFIED',
        });
      });

      it('never answers VERIFIED once the deadline passed between objects, and reads nothing after it', async () => {
        const { created } = await observed();
        const deadline = new AbortController();
        const timeout = jest
          .spyOn(AbortSignal, 'timeout')
          .mockReturnValueOnce(deadline.signal);
        const observe = media.observeEvidence.bind(media);
        const spy = jest
          .spyOn(media, 'observeEvidence')
          .mockImplementation(async (...args) => {
            const found = await observe(...args);
            deadline.abort();
            return found;
          });
        const opened = storage().openObjectAt.mock.calls.length;

        const result = await service.observeCurrentMedia(ORG, created.managedPostId, 1);
        timeout.mockRestore();

        expect(spy).toHaveBeenCalledTimes(1);
        expect(storage().openObjectAt.mock.calls.length - opened).toBe(1);
        expect(result).toMatchObject({
          status: 'INDETERMINATE',
          reasons: ['OBSERVATION_DEADLINE_EXCEEDED'],
        });
        expect(result).not.toHaveProperty('media');
      });

      it('reads nothing for a client that already went away', async () => {
        const { created } = await single();
        const cancel = new AbortController();
        cancel.abort();
        const calls = storage().openObjectAt.mock.calls.length;

        expect(
          await service.observeCurrentMedia(ORG, created.managedPostId, 1, cancel.signal)
        ).toMatchObject({ status: 'INDETERMINATE', reasons: ['OBSERVATION_CANCELLED'] });
        expect(storage().openObjectAt.mock.calls.length).toBe(calls);
      });
    });
  });

  describe('capabilities', () => {
    it('qualifies no codec for publication and declares review and draft storage on their own', () => {
      const capabilities = service.capabilities();

      expect(capabilities.posts.states).toEqual(['DRAFT']);
      expect(capabilities.content.publication.qualified).toBe(false);
      for (const codec of capabilities.content.codecs) {
        expect(codec).not.toHaveProperty('recommended');
        expect(codec.publication).toBe('NOT_QUALIFIED');
        expect(codec.publicationDefects.length).toBeGreaterThan(0);
        expect(codec.reviewText).toBe('EXACT');
      }
      expect(
        capabilities.content.codecs.map((codec) => [codec.id, codec.draftStorage])
      ).toEqual([
        ['ww-plain-escape-v1', 'ACCEPTED_UNCHECKED_ESCAPES'],
        ['ww-plain-paragraph-escape-v1', 'RECOMMENDED'],
      ]);
      expect(capabilities.posts.mediaObservation).toMatchObject({
        scope: 'posts:read',
        revision: 'CURRENT_ONLY',
        writes: 'NONE',
        maxIdentities: 400,
      });
    });

    it('publishes the codecs of the canonical caption vectors, at one fixed version', () => {
      const fixture = JSON.parse(
        readFileSync(join(__dirname, '..', 'canonical.caption.vectors.json'), 'utf8')
      );
      const capabilities = service.capabilities();

      expect(capabilities.version).toBe(fixture.capabilities);
      expect(capabilities.content.vectors).toBe(fixture.version);
      expect(capabilities.content.codecs.map((codec) => codec.id).sort()).toEqual(
        Object.keys(fixture.codecs).sort()
      );
      for (const { id, ...declared } of capabilities.content.codecs) {
        expect([id, fixture.codecs[id]]).toEqual([id, JSON.parse(JSON.stringify(declared))]);
      }
      expect(capabilities.posts.edit.members).toMatchObject({
        addChildren: true,
        removeChildren: true,
        identity: 'POSITIONAL',
      });
    });
  });

  describe('channel state', () => {
    it.each([
      ['in between steps', { inBetweenSteps: true }],
      ['disabled', { disabled: true }],
    ])('neither qualifies nor drafts to a channel that is %s', async (_label, state) => {
      const pending = seedIntegration(ORG, state);
      const channels = await service.listChannels(ORG);
      const channel = channels.find((c) => c.integrationId === pending.id)!;
      expect(
        await refusal(
          service.qualifyChannel(ORG, CREDENTIAL, pending.id, {
            expectedGeneration: channel.binding.generation,
            identityFingerprint: channel.identityFingerprint,
          })
        )
      ).toEqual({ status: 409, code: 'CHANNEL_NOT_QUALIFIED' });

      // qualified first, then it changed state
      const { body, channel: qualified } = await setup();
      db.patch('integration', qualified.integration.id, state);
      expect(
        await refusal(service.createDraft(ORG, CREDENTIAL, body()))
      ).toEqual({ status: 409, code: 'CHANNEL_NOT_QUALIFIED' });
    });
  });

  describe('inventory and change feed', () => {
    it('allocates dense sequences in commit order', async () => {
      const { body, edit } = await setup();
      const created = await service.createDraft(ORG, CREDENTIAL, body());
      await service.editDraft(ORG, CREDENTIAL, created.managedPostId, edit(1, 'ww:dense:edit:1'));

      const feed = await service.changes(ORG, 0, 500);
      expect(feed.events.map((e) => e.sequence)).toEqual(
        Array.from({ length: feed.headSequence }, (_, i) => i + 1)
      );
      expect(feed.events.map((e) => e.kind)).toEqual([
        'CHANNEL_BINDING_CREATED',
        'CHANNEL_QUALIFIED',
        'MEDIA_EVIDENCE_RECORDED',
        'MEDIA_EVIDENCE_RECORDED',
        'POST_CREATED',
        'POST_REVISED',
      ]);
      expect(feed.events[5].data.members[0].content).toBe('<p>Caption edited</p>');
      expect(feed.hasMore).toBe(false);
    });

    it('is complete: inventory pages + changes after the snapshot cover concurrent mutations', async () => {
      const { body, edit } = await setup();
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        created.push(
          (await service.createDraft(ORG, CREDENTIAL, body({ operationKey: `ww:inv:before:${i}` })))
            .managedPostId
        );
      }

      const firstPage = await service.inventory(ORG, undefined, 2);
      const snapshot = firstPage.snapshotSequence;
      const items = [...firstPage.items];

      // mutations racing the paging: new posts and edits of seen / unseen posts
      let cursor = firstPage.nextCursor;
      let round = 0;
      while (cursor) {
        const [page] = await Promise.all([
          service.inventory(ORG, cursor, 2),
          service.createDraft(ORG, CREDENTIAL, body({ operationKey: `ww:inv:during:${round}` })),
          service.editDraft(
            ORG,
            CREDENTIAL,
            created[round % created.length],
            edit(
              db.tables.managedPost.find((p) => p.id === created[round % created.length])!
                .revision,
              `ww:inv:edit:${round}`
            )
          ),
        ]);
        // the start sequence stays; each page says where it was read
        expect(page.snapshotSequence).toBe(snapshot);
        expect(page.observedSequence).toBeGreaterThanOrEqual(snapshot);
        expect(page.coverage.observedSequence).toBe(page.observedSequence);
        items.push(...page.items);
        cursor = page.nextCursor;
        round++;
      }

      const merged = new Map<string, number>();
      const keep = (id: string, revision: number) =>
        merged.set(id, Math.max(merged.get(id) ?? 0, revision));
      items.forEach((item) => keep(item.managedPostId, item.revision));

      let after = snapshot;
      for (;;) {
        const page = await service.changes(ORG, after, 3);
        page.events
          .filter((e) => e.kind === 'POST_CREATED' || e.kind === 'POST_REVISED')
          .forEach((e) => keep(e.entityId, e.revision!));
        after = page.nextAfter;
        if (!page.hasMore) {
          break;
        }
      }

      const truth = new Map(
        db.tables.managedPost
          .filter((p) => p.organizationId === ORG)
          .map((p) => [p.id, p.revision])
      );
      expect(truth.size).toBeGreaterThan(5);
      expect(merged).toEqual(truth);
    });

    it('reports coverage of posts it does not manage', async () => {
      const { body, channel } = await setup();
      await service.createDraft(ORG, CREDENTIAL, body());
      // two posts that existed before enrollment
      for (const group of ['legacy-1', 'legacy-2']) {
        db.insert('post', {
          organizationId: ORG,
          integrationId: channel.integration.id,
          group,
          content: 'legacy',
          publishDate: new Date(),
          state: 'QUEUE',
        });
      }

      const page = await service.inventory(ORG);
      expect(page.complete).toBe(true);
      expect(page.observedSequence).toBe(page.snapshotSequence);
      expect(page.coverage).toEqual({
        asOf: 'OBSERVED_SEQUENCE',
        observedSequence: page.observedSequence,
        managedPosts: 1,
        unmanagedRootPostsInOrganization: 2,
      });
      expect(page.items[0]).toMatchObject({
        state: 'DRAFT',
        revision: 1,
        dates: { intendedPublishDate: '2026-11-20T09:00:00.000Z' },
        integrity: { status: 'CONSISTENT' },
      });
      expect(JSON.stringify(page)).not.toContain('uploads.example');
    });

    it('rejects tampered cursors and positions beyond the head', async () => {
      await setup();
      const forged = Buffer.from(
        JSON.stringify({ v: 1, s: 9999, a: 'x' })
      ).toString('base64url');

      expect((await refusal(service.inventory(ORG, forged))).status).toBe(400);
      expect((await refusal(service.inventory(ORG, 'bm90LWpzb24'))).status).toBe(400);
      expect(
        (
          await refusal(
            service.inventory(
              ORG,
              Buffer.from(JSON.stringify({ v: 1, s: 0, a: 'x', org: OTHER_ORG })).toString(
                'base64url'
              )
            )
          )
        ).status
      ).toBe(400);
      expect((await refusal(service.changes(ORG, 9999))).status).toBe(400);
    });

    it('keeps organizations apart', async () => {
      const { body } = await setup();
      const mine = await service.createDraft(ORG, CREDENTIAL, body());

      const other = await qualifiedChannel(OTHER_ORG);
      const otherMedia = await capturedMedia('FAKE-OTHER', OTHER_ORG);
      const theirs = await service.createDraft(OTHER_ORG, CREDENTIAL, {
        operationKey: 'ww:approval:1:create',
        integrationId: other.integration.id,
        expectedBindingGeneration: other.generation,
        intendedPublishDate: '2026-11-20T09:00:00.000Z',
        members: [
          {
            content: 'theirs',
            media: [{ mediaId: otherMedia.mediaId, sha256: otherMedia.sha256 }],
          },
        ],
      } as CreateManagedDraftDto);

      // same operation key in another organization is a different operation
      expect(theirs.replayed).toBe(false);

      const inventory = await service.inventory(ORG);
      expect(inventory.items.map((i) => i.managedPostId)).toEqual([mine.managedPostId]);
      expect((await refusal(service.getPost(ORG, theirs.managedPostId))).status).toBe(404);
      expect(
        (await service.changes(ORG, 0, 500)).events.some(
          (e) => e.entityId === theirs.managedPostId
        )
      ).toBe(false);
    });
  });
});

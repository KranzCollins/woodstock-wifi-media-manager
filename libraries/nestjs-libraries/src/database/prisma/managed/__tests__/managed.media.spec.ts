jest.mock(
  'file-type',
  () => ({
    // FAKE sniffer: the real one is ESM-only; the type is fixed for the test
    fileTypeStream: jest.fn(async (stream: any) =>
      Object.assign(stream, { fileType: { mime: 'image/png', ext: 'png' } })
    ),
    fileTypeFromBuffer: jest.fn(),
  }),
  { virtual: true }
);
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator', () => ({
  isSafePublicHttpsUrl: jest.fn(),
}));
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({
  ssrfSafeDispatcher: {},
}));
jest.mock('@gitroom/nestjs-libraries/upload/data.url', () => ({
  parseDataUrl: jest.fn(),
}));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({}));

import { createHash } from 'crypto';
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import {
  digestStream,
  uploadStreamToStorage,
} from '@gitroom/nestjs-libraries/upload/custom.upload.validation';
import { LocalStorage } from '@gitroom/nestjs-libraries/upload/local.storage';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import { FakePrismaDb } from './fakes/fake.prisma.db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const sha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

const collect = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

describe('upload capture digest', () => {
  it('hashes exactly the bytes that were streamed into storage', async () => {
    const parts = [Buffer.from('FAKE-PNG-HEADER'), Buffer.from('FAKE-PIXELS'.repeat(1000))];
    let stored = Buffer.alloc(0);
    // FAKE storage keeping what it received
    const storage: any = {
      uploadStream: async (stream: Readable, mimetype: string, ext: string) => {
        stored = await collect(stream);
        return { filename: `x.${ext}`, path: `https://fake/x.${ext}`, mimetype, originalname: `x.${ext}` };
      },
    };

    const capture = digestStream();
    await uploadStreamToStorage(
      storage,
      Readable.toWeb(Readable.from(parts)) as any,
      0,
      capture.transform
    );

    const digest = capture.digest();
    expect(stored.length).toBeGreaterThan(0);
    expect(digest).toEqual({ sha256: sha(stored), byteLength: stored.length });
    expect(digest.sha256).toBe(sha(Buffer.concat(parts)));
  });
});

describe('LocalStorage stored keys', () => {
  const uploadDirectory = mkdtempSync(join(tmpdir(), 'managed-uploads-'));
  const outside = mkdtempSync(join(tmpdir(), 'managed-outside-'));
  const storage = new LocalStorage(uploadDirectory);

  beforeAll(() => {
    process.env.FRONTEND_URL = 'https://app.example';
    mkdirSync(join(uploadDirectory, '2026/11/04'), { recursive: true });
    writeFileSync(join(uploadDirectory, '2026/11/04/a.png'), 'FAKE-LOCAL-BYTES');
    writeFileSync(join(outside, 'secret.png'), 'outside');
    symlinkSync(join(outside, 'secret.png'), join(uploadDirectory, '2026/11/04/link.png'));
  });

  afterAll(() => {
    delete process.env.FRONTEND_URL;
  });

  it('maps a public path it stored to its key and reads the file by that key', async () => {
    const key = storage.objectKeyOf('https://app.example/uploads/2026/11/04/a.png');
    expect(key).toBe('2026/11/04/a.png');
    const opened = await storage.openObjectAt(key!);
    expect((await collect(opened!.stream)).toString()).toBe('FAKE-LOCAL-BYTES');
    expect(opened!.version).toMatch(/^local:/);
    expect(await storage.objectVersionAt(key!)).toBe(opened!.version);
    expect(storage.objectPath(key!)).toBe('https://app.example/uploads/2026/11/04/a.png');
  });

  it('gets a new version when the file is rewritten in place', async () => {
    const key = '2026/11/04/rewritten.png';
    const file = join(uploadDirectory, key);
    writeFileSync(file, 'FAKE-BYTES-BEFORE');
    const before = await storage.objectVersionAt(key);

    writeFileSync(file, 'FAKE-BYTES-AFTER!');
    // same size is not enough to hide it: the modification times move
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(await storage.objectVersionAt(key)).not.toBe(before);
    expect(await storage.objectVersionAt('2026/11/04/missing.png')).toBeNull();
    expect(await storage.openObjectAt('2026/11/04/missing.png')).toBeNull();
  });

  it.each([
    'https://evil.example/uploads/2026/11/04/a.png',
    'https://app.example/other/2026/11/04/a.png',
    'https://app.example/uploads/../../../../etc/passwd',
    'https://app.example/uploads/2026/11/../11/04/a.png',
    'https://app.example/uploads/2026/11/04/a.html',
    '/etc/passwd',
  ])('has no key for %s', (path) => {
    expect(storage.objectKeyOf(path)).toBeNull();
  });

  it('refuses a key whose file resolves outside the upload directory', async () => {
    await expect(storage.openObjectAt('2026/11/04/link.png')).rejects.toThrow('Unsafe file path');
    await expect(storage.objectVersionAt('2026/11/04/link.png')).rejects.toThrow('Unsafe file path');
    await expect(storage.objectVersionAt('../x.png')).rejects.toThrow('Unsupported object key.');
  });
});

describe('ManagedMediaService', () => {
  let db: FakePrismaDb;
  let service: ManagedMediaService;
  let fetchSpy: jest.SpyInstance;
  const BYTES = Buffer.from('FAKE-STORED-MEDIA-BYTES');
  const PREFIX = 'https://app.example/uploads/';
  const KEY = '2026/11/04/stored.png';
  const PATH = PREFIX + KEY;
  const NAMESPACE = 'FAKE-namespace-1';

  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = `${ORG},${OTHER_ORG}`;
    db = new FakePrismaDb();
    service = new ManagedMediaService(
      new ManagedRepository({ model: db.model } as any, { model: db.model } as any)
    );
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
    delete process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES;
    // no evidence path may ever fetch a URL
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // FAKE private storage read by key: every object is at FAKE-v1 unless
  // `version` says otherwise, and keys resolve in FAKE-namespace-1 unless
  // `namespace` says otherwise. Without `open` it has no private read
  const fakeStorage = (
    open?: (key: string) => Promise<Readable | null>,
    version: (key: string) => Promise<string | null> = async () => 'FAKE-v1',
    namespace: () => Promise<string> = async () => NAMESPACE
  ) => {
    (service as any).storage = {
      removeFile: jest.fn(async () => undefined),
      objectKeyOf: jest.fn((path: string) =>
        path.startsWith(PREFIX) ? path.slice(PREFIX.length) : null
      ),
      objectNamespace: jest.fn(namespace),
      objectVersionAt: jest.fn(version),
      ...(open
        ? {
            // the version of the object as it was opened
            openObjectAt: jest.fn(async (key: string) => {
              const opened = await version(key);
              const stream = await open(key);
              return stream && opened ? { stream, version: opened } : null;
            }),
          }
        : {}),
    };
    return (service as any).storage;
  };

  const seedMedia = (organizationId = ORG, path = PATH) =>
    db.insert('media', { organizationId, name: 'stored.png', path });

  it('records the server-side digest of a private read', async () => {
    const media = seedMedia();
    fakeStorage(async (key) => (key === KEY ? Readable.from([BYTES]) : null));

    const result = await service.verifyStoredMedia(ORG, 'ww-test', media.id);
    expect(result).toEqual({
      status: 'VERIFIED',
      mediaId: media.id,
      sha256: sha(BYTES),
      byteLength: BYTES.length,
      mimeType: null,
      method: 'PRIVATE_STORAGE_READ',
    });
    // pinned to the key and namespace it was read in; neither is returned
    expect(db.tables.managedMediaEvidence).toEqual([
      expect.objectContaining({
        mediaId: media.id,
        storedPath: PATH,
        storageVersion: 'FAKE-v1',
        storageKey: KEY,
        storageNamespace: NAMESPACE,
        sha256: sha(BYTES),
        method: 'PRIVATE_STORAGE_READ',
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/FAKE-namespace|2026\/11\/04|FAKE-v1/);
  });

  it('does not bind bytes to an object that was rewritten while they were read', async () => {
    const media = seedMedia();
    let version = 'FAKE-v1';
    fakeStorage(
      async () => {
        version = 'FAKE-v2';
        return Readable.from([BYTES]);
      },
      async () => version
    );

    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      status: 'UNVERIFIED',
      reason: 'CHANGED_DURING_READ',
    });
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
  });

  it('is explicitly unverified for media outside private storage', async () => {
    const media = seedMedia(ORG, 'https://somewhere.example/remote.png');
    fakeStorage(async () => null);

    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toEqual({
      status: 'UNVERIFIED',
      mediaId: media.id,
      reason: 'NOT_IN_PRIVATE_STORAGE',
    });
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
  });

  it('stops a read over the bound and stays unverified', async () => {
    process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES = '4';
    const media = seedMedia();
    fakeStorage(async () => Readable.from([BYTES]));

    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      status: 'UNVERIFIED',
      reason: 'TOO_LARGE_FOR_BOUNDED_READ',
    });
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
  });

  it('never reads past the 64 MiB ceiling, whatever the environment asks for', async () => {
    process.env.POSTIZ_MANAGED_MAX_DIGEST_BYTES = String(1024 ** 4);
    const media = seedMedia();
    const chunk = Buffer.alloc(1024 * 1024);
    fakeStorage(async () =>
      Readable.from(
        (function* () {
          for (let i = 0; i < 65; i++) {
            yield chunk;
          }
        })()
      )
    );

    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      status: 'UNVERIFIED',
      reason: 'TOO_LARGE_FOR_BOUNDED_READ',
    });
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
  });

  it('is unverified when the read fails or storage cannot read privately', async () => {
    const media = seedMedia();
    fakeStorage(async () =>
      new Readable({
        read() {
          this.destroy(new Error('FAKE read failure'));
        },
      })
    );
    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      reason: 'READ_FAILED',
    });

    fakeStorage();
    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      reason: 'STORAGE_HAS_NO_PRIVATE_READ',
    });
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
  });

  it('does not bind bytes to a path that changed while they were read', async () => {
    const media = seedMedia();
    fakeStorage(async () => {
      db.patch('media', media.id, { path: 'https://app.example/uploads/replaced.png' });
      return Readable.from([BYTES]);
    });

    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      status: 'UNVERIFIED',
      reason: 'CHANGED_DURING_READ',
    });
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
  });

  it('only verifies media of the credential organization', async () => {
    const media = seedMedia(OTHER_ORG);
    const storage = fakeStorage(async () => Readable.from([BYTES]));

    await expect(service.verifyStoredMedia(ORG, 'ww-test', media.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(storage.openObjectAt).not.toHaveBeenCalled();
  });

  it('never stores an upload without its captured digest', async () => {
    const storage = fakeStorage(async () => null);
    await expect(
      service.recordCapturedUpload(ORG, 'ww-test', {
        filename: 'x.png',
        path: 'https://app.example/uploads/x.png',
        mimetype: 'image/png',
        originalname: 'x.png',
      } as any)
    ).rejects.toMatchObject({ status: 400 });
    expect(storage.removeFile).toHaveBeenCalledWith('https://app.example/uploads/x.png');
    expect(db.tables.media).toHaveLength(0);
  });

  it('records a captured upload as media + evidence + feed event in one step', async () => {
    fakeStorage(async () => null);
    const result = await service.recordCapturedUpload(ORG, 'ww-test', {
      filename: 'x.png',
      path: 'https://app.example/uploads/x.png',
      mimetype: 'image/png',
      originalname: 'photo.png',
      capturedDigest: { sha256: sha(BYTES), byteLength: BYTES.length },
    } as any);

    expect(result).toMatchObject({ status: 'VERIFIED', method: 'UPLOAD_CAPTURE', sha256: sha(BYTES) });
    expect(db.tables.media).toEqual([
      expect.objectContaining({ organizationId: ORG, path: 'https://app.example/uploads/x.png' }),
    ]);
    expect(db.tables.managedMediaEvidence).toEqual([
      expect.objectContaining({
        storageVersion: 'FAKE-v1',
        storageKey: 'x.png',
        storageNamespace: NAMESPACE,
        method: 'UPLOAD_CAPTURE',
      }),
    ]);
    expect(db.tables.managedChangeEvent.map((e) => e.kind)).toEqual(['MEDIA_EVIDENCE_RECORDED']);
  });

  it('never stores an upload whose stored object has no version', async () => {
    const storage = fakeStorage(async () => null, async () => null);
    await expect(
      service.recordCapturedUpload(ORG, 'ww-test', {
        filename: 'x.png',
        path: 'https://app.example/uploads/x.png',
        mimetype: 'image/png',
        originalname: 'photo.png',
        capturedDigest: { sha256: sha(BYTES), byteLength: BYTES.length },
      } as any)
    ).rejects.toMatchObject({ status: 400 });
    expect(storage.removeFile).toHaveBeenCalledWith('https://app.example/uploads/x.png');
    expect(db.tables.media).toHaveLength(0);
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
  });

  it('only accepts evidence whose version is the stored object current one', async () => {
    const media = seedMedia();
    let version = 'FAKE-v1';
    fakeStorage(async () => Readable.from([BYTES]), async () => version);
    await service.verifyStoredMedia(ORG, 'ww-test', media.id);
    const [evidence] = db.tables.managedMediaEvidence;

    expect([...(await service.currentEvidence(ORG, [media.id]))]).toEqual([evidence.id]);
    version = 'FAKE-v2';
    expect([...(await service.currentEvidence(ORG, [media.id]))]).toEqual([]);
  });

  it('same URL in another namespace: the evidence is not current and the media is not re-pinned there', async () => {
    const media = seedMedia();
    let namespace = NAMESPACE;
    const storage = fakeStorage(
      async () => Readable.from([BYTES]),
      undefined,
      async () => namespace
    );
    await service.verifyStoredMedia(ORG, 'ww-test', media.id);
    const [evidence] = db.tables.managedMediaEvidence;

    // FAKE: another directory / bucket behind the same URL, same version
    namespace = 'FAKE-namespace-2';
    expect([...(await service.currentEvidence(ORG, [media.id]))]).toEqual([]);
    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toEqual({
      status: 'UNVERIFIED',
      mediaId: media.id,
      reason: 'STORAGE_IDENTITY_CHANGED',
    });
    expect(storage.openObjectAt).toHaveBeenCalledTimes(1);
    expect(db.tables.managedMediaEvidence).toHaveLength(1);

    namespace = NAMESPACE;
    expect([...(await service.currentEvidence(ORG, [media.id]))]).toEqual([evidence.id]);
  });

  it('binds nothing when keys move to another namespace during a read', async () => {
    const media = seedMedia();
    let moved = false;
    fakeStorage(
      async () => {
        moved = true;
        return Readable.from([BYTES]);
      },
      undefined,
      async () => (moved ? 'FAKE-namespace-2' : NAMESPACE)
    );
    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      status: 'UNVERIFIED',
      reason: 'CHANGED_DURING_READ',
    });
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
  });

  it('is not current when keys move to another namespace while the version is read', async () => {
    const media = seedMedia();
    let moved = false;
    fakeStorage(
      async () => Readable.from([BYTES]),
      async () => 'FAKE-v1',
      async () => (moved ? 'FAKE-namespace-2' : NAMESPACE)
    );
    await service.verifyStoredMedia(ORG, 'ww-test', media.id);
    (service as any).storage.objectVersionAt.mockImplementation(async () => {
      moved = true;
      return 'FAKE-v1';
    });
    expect([...(await service.currentEvidence(ORG, [media.id]))]).toEqual([]);
  });

  it('object content mutated in the same namespace: the old digest is stale and a new read pins the new bytes', async () => {
    const media = seedMedia();
    const CHANGED = Buffer.from('FAKE-STORED-MEDIA-CHANGED');
    let bytes = BYTES;
    let version = 'FAKE-v1';
    fakeStorage(async () => Readable.from([bytes]), async () => version);
    await service.verifyStoredMedia(ORG, 'ww-test', media.id);
    const [old] = db.tables.managedMediaEvidence;

    bytes = CHANGED;
    version = 'FAKE-v2';
    expect([...(await service.currentEvidence(ORG, [media.id]))]).toEqual([]);

    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      status: 'VERIFIED',
      sha256: sha(CHANGED),
    });
    const fresh = db.tables.managedMediaEvidence.find((row) => row.id !== old.id)!;
    expect(fresh).toMatchObject({
      sha256: sha(CHANGED),
      storageVersion: 'FAKE-v2',
      storageKey: KEY,
      storageNamespace: NAMESPACE,
    });
    // only the new digest is current; the old row is kept as history
    expect([...(await service.currentEvidence(ORG, [media.id]))]).toEqual([fresh.id]);
    expect(db.tables.managedMediaEvidence.find((row) => row.id === old.id)).toMatchObject({
      sha256: sha(BYTES),
      storageVersion: 'FAKE-v1',
    });
  });

  it('missing historical proof: unpinned evidence is held, never re-read, re-pinned or backfilled', async () => {
    const media = seedMedia();
    const storage = fakeStorage(async () => Readable.from([BYTES]));
    // FAKE row from before evidence was pinned, of each method
    for (const method of ['UPLOAD_CAPTURE', 'UPLOAD_READBACK', 'PRIVATE_STORAGE_READ']) {
      db.tables.managedMediaEvidence.length = 0;
      const old = db.insert('managedMediaEvidence', {
        organizationId: ORG,
        mediaId: media.id,
        storedPath: PATH,
        storageVersion: 'FAKE-v1',
        sha256: sha(BYTES),
        byteLength: BYTES.length,
        method,
        credentialId: 'ww-test',
        sequence: 1,
      });

      expect([...(await service.currentEvidence(ORG, [media.id]))]).toEqual([]);
      expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toEqual({
        status: 'UNVERIFIED',
        mediaId: media.id,
        reason: 'STORAGE_IDENTITY_UNPROVEN',
      });
      expect(db.tables.managedMediaEvidence).toEqual([
        expect.objectContaining({ id: old.id, storageKey: null, storageNamespace: null }),
      ]);
    }
    expect(storage.openObjectAt).not.toHaveBeenCalled();
  });

  it('a pin without a version is held before any read, never replaced', async () => {
    const media = seedMedia();
    const storage = fakeStorage(async () => Readable.from([BYTES]));
    // FAKE row pinned to key and namespace but not to a version
    const old = db.insert('managedMediaEvidence', {
      organizationId: ORG,
      mediaId: media.id,
      storedPath: PATH,
      storageVersion: null,
      storageKey: KEY,
      storageNamespace: NAMESPACE,
      sha256: sha(BYTES),
      byteLength: BYTES.length,
      mimeType: 'image/png',
      method: 'UPLOAD_CAPTURE',
      credentialId: 'ww-test',
      sequence: 1,
    });

    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toEqual({
      status: 'UNVERIFIED',
      mediaId: media.id,
      reason: 'STORAGE_IDENTITY_UNPROVEN',
    });
    expect(storage.openObjectAt).not.toHaveBeenCalled();
    expect(db.tables.managedMediaEvidence).toEqual([old]);
    expect(db.tables.managedChangeEvent).toHaveLength(0);
  });

  it.each([
    ['the media path moves', (media: any, _: any) =>
      db.patch('media', media.id, { path: PREFIX + 'replaced.png' })],
    ['newer evidence is recorded', (_: any, pinned: any) =>
      db.insert('managedMediaEvidence', { ...pinned, id: `${pinned.id}-newer`, sequence: 99 })],
    ['the pinned evidence is rewritten', (_: any, pinned: any) =>
      db.patch('managedMediaEvidence', pinned.id, { storageNamespace: 'FAKE-namespace-2' })],
  ])('a repeat read of a pinned object is not verified when %s during it', async (_, change) => {
    const media = seedMedia();
    let during = false;
    fakeStorage(async () => {
      if (during) {
        // FAKE concurrent writer, not the service under test
        change(media, db.tables.managedMediaEvidence[0]);
      }
      return Readable.from([BYTES]);
    });
    await service.verifyStoredMedia(ORG, 'ww-test', media.id);
    const events = db.tables.managedChangeEvent.length;
    const mutate = jest.spyOn((service as any)._managedRepository, 'mutate');

    during = true;
    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toEqual({
      status: 'UNVERIFIED',
      mediaId: media.id,
      reason: 'CHANGED_DURING_READ',
    });
    // the service itself wrote nothing: only the FAKE writer's change is there
    expect(mutate).not.toHaveBeenCalled();
    expect(db.tables.managedChangeEvent).toHaveLength(events);
  });

  it('equal bytes in another object: a pin naming that object is never current for this media', async () => {
    const OTHER_KEY = '2026/11/04/twin.png';
    const media = seedMedia();
    const twin = seedMedia(ORG, PREFIX + OTHER_KEY);
    // both objects hold the same bytes at the same FAKE version string
    fakeStorage(async () => Readable.from([BYTES]));
    await service.verifyStoredMedia(ORG, 'ww-test', media.id);
    await service.verifyStoredMedia(ORG, 'ww-test', twin.id);
    const own = db.tables.managedMediaEvidence.find((row) => row.mediaId === media.id)!;
    const other = db.tables.managedMediaEvidence.find((row) => row.mediaId === twin.id)!;
    expect(own.sha256).toBe(other.sha256);
    expect(own.storageVersion).toBe(other.storageVersion);

    db.patch('managedMediaEvidence', own.id, { storageKey: OTHER_KEY });
    expect([...(await service.currentEvidence(ORG, [media.id, twin.id]))]).toEqual([other.id]);
    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      status: 'UNVERIFIED',
      reason: 'STORAGE_IDENTITY_CHANGED',
    });
  });

  it('a stored path that now addresses another key is a changed identity', async () => {
    const media = seedMedia();
    const storage = fakeStorage(async () => Readable.from([BYTES]));
    await service.verifyStoredMedia(ORG, 'ww-test', media.id);

    // FAKE: the public address moved, so the same path names another key
    storage.objectKeyOf.mockImplementation(() => 'elsewhere.png');
    expect([...(await service.currentEvidence(ORG, [media.id]))]).toEqual([]);
    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      reason: 'STORAGE_IDENTITY_CHANGED',
    });
    storage.objectKeyOf.mockImplementation(() => null);
    expect(await service.verifyStoredMedia(ORG, 'ww-test', media.id)).toMatchObject({
      reason: 'STORAGE_IDENTITY_CHANGED',
    });
    expect(storage.openObjectAt).toHaveBeenCalledTimes(1);
  });

  it('a capture whose namespace cannot be pinned is neither recorded nor removed by its URL', async () => {
    const capture = {
      filename: 'x.png',
      path: 'https://app.example/uploads/x.png',
      mimetype: 'image/png',
      originalname: 'photo.png',
      capturedDigest: { sha256: sha(BYTES), byteLength: BYTES.length },
    } as any;

    let storage = fakeStorage(async () => null, undefined, async () => {
      throw Object.assign(new Error('FAKE ENOENT'), { code: 'ENOENT' });
    });
    await expect(service.recordCapturedUpload(ORG, 'ww-test', capture)).rejects.toMatchObject({
      status: 400,
    });
    expect(storage.removeFile).not.toHaveBeenCalled();

    // moved between the two namespace reads around the version read
    let calls = 0;
    storage = fakeStorage(async () => null, undefined, async () =>
      ++calls > 1 ? 'FAKE-namespace-2' : NAMESPACE
    );
    await expect(service.recordCapturedUpload(ORG, 'ww-test', capture)).rejects.toMatchObject({
      status: 400,
    });
    expect(storage.removeFile).not.toHaveBeenCalled();
    expect(db.tables.media).toHaveLength(0);
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
  });
});

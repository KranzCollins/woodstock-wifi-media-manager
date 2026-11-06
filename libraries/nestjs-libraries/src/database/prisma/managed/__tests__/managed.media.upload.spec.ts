jest.mock(
  'file-type',
  () => {
    // FAKE sniffer (the real one is ESM-only): the type comes from the first
    // bytes, so a body of another type is told apart like the real one does
    const { ReadableStream } = require('stream/web');
    const sniff = (head: Buffer) => {
      const magic = head.subarray(0, 7).toString();
      return magic === 'FAKEPNG'
        ? { mime: 'image/png', ext: 'png' }
        : magic === 'FAKEJPG'
        ? { mime: 'image/jpeg', ext: 'jpg' }
        : undefined;
    };

    return {
      fileTypeFromBuffer: async (buffer: Buffer) => sniff(Buffer.from(buffer)),
      fileTypeStream: async (web: any) => {
        const reader = web.getReader();
        const first = await reader.read();
        const stream = new ReadableStream({
          start(controller: any) {
            if (!first.done) {
              controller.enqueue(first.value);
            }
          },
          async pull(controller: any) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
            } else {
              controller.enqueue(next.value);
            }
          },
          cancel(reason: any) {
            return reader.cancel(reason);
          },
        });
        return Object.assign(stream, {
          fileType: first.done ? undefined : sniff(Buffer.from(first.value)),
        });
      },
    };
  },
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
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, Readable } from 'stream';
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { LocalStorage } from '@gitroom/nestjs-libraries/upload/local.storage';
import { CloudflareStorage } from '@gitroom/nestjs-libraries/upload/cloudflare.storage';
import { StorageObjectExistsError } from '@gitroom/nestjs-libraries/upload/upload.interface';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import {
  MANAGED_UPLOAD_RECOVERY_GRACE_MS,
  ManagedMediaService,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import { MANAGED_UPLOAD_LEASE_MS } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { FakePrismaDb } from './fakes/fake.prisma.db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const KEY = 'ww:asset:42:v1';
const WORKER = 'ww-ingest-worker';
const PNG = Buffer.concat([
  Buffer.from('FAKEPNG'),
  Buffer.from('FAKE-PIXELS'.repeat(2000)),
]);
const sha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) {
    await settle();
  }
  expect(check()).toBe(true);
};
const code = (value: string) => ({ response: expect.objectContaining({ code: value }) });
// recovery may only read an attempt once its lease and the grace period ended
const RECOVERABLE = MANAGED_UPLOAD_LEASE_MS + MANAGED_UPLOAD_RECOVERY_GRACE_MS + 1;
const RETAINED = 'OBJECT_RETAINED_UNREFERENCED';
const signal = () => new AbortController().signal;
const asRoot = process.getuid?.() === 0;

describe('reserved managed media uploads', () => {
  let db: FakePrismaDb;
  let repository: ManagedRepository;
  let service: ManagedMediaService;
  let dir: string;
  let local: LocalStorage;
  let storage: Record<string, jest.Mock>;
  let fetchSpy: jest.SpyInstance;
  const realNow = Date.now();

  beforeEach(() => {
    // Freeze the same clock used to create and expire leases; real elapsed milliseconds are not test input.
    jest.spyOn(Date, 'now').mockReturnValue(realNow);
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = `${ORG},${OTHER_ORG}`;
    process.env.FRONTEND_URL = 'https://app.example';
    dir = mkdtempSync(join(tmpdir(), 'managed-reserved-'));
    db = new FakePrismaDb();
    repository = new ManagedRepository(
      { model: db.model } as any,
      { model: db.model } as any
    );
    service = new ManagedMediaService(repository);

    // the REAL local storage in a temp directory, observed through jest.fn
    local = new LocalStorage(dir);
    storage = {
      objectNamespace: jest.fn(() => local.objectNamespace()),
      objectPath: jest.fn((key: string) => local.objectPath(key)),
      createObjectAt: jest.fn((...args: any[]) =>
        (local.createObjectAt as any)(...args)
      ),
      objectKeyOf: jest.fn((path: string) => local.objectKeyOf(path)),
      objectVersionAt: jest.fn((key: string) => local.objectVersionAt(key)),
      openObjectAt: jest.fn((key: string) => local.openObjectAt(key)),
      removeFile: jest.fn((path: string) => local.removeFile(path)),
    };
    (service as any).storage = storage;
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
    delete process.env.FRONTEND_URL;
    // nothing here may fetch a URL, and nothing in storage is ever deleted
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storage.removeFile).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  const reserve = (over: Record<string, any> = {}, credential = WORKER, org = ORG) =>
    service.reserveUpload(org, credential, {
      operationKey: KEY,
      sha256: sha(PNG),
      byteLength: PNG.length,
      mimeType: 'image/png',
      ...over,
    });

  const send = (
    bytes: Buffer = PNG,
    {
      credential = WORKER,
      length = bytes.length,
      key = KEY,
      org = ORG,
    }: { credential?: string; length?: number; key?: string; org?: string } = {}
  ) =>
    service.receiveUploadContent(
      org,
      credential,
      key,
      Readable.from([bytes]),
      'application/octet-stream',
      String(length)
    );

  const later = (ms: number) => jest.spyOn(Date, 'now').mockReturnValue(realNow + ms);
  const storedFiles = () => readdirSync(dir).filter((name) => name.startsWith('managed-'));
  const attempts = () =>
    [...db.tables.managedMediaUploadAttempt].sort((a, b) => a.attempt - b.attempt);
  // FAKE worker death: the call never returns
  const hangWrite = () =>
    storage.createObjectAt.mockImplementationOnce(() => new Promise(() => undefined));
  const gateWrite = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    storage.createObjectAt.mockImplementationOnce(async (...args: any[]) => {
      await gate;
      return (local.createObjectAt as any)(...args);
    });
    return () => release();
  };

  it('a lost successful response is answered by status and by a resend, without a second write', async () => {
    expect(await reserve()).toMatchObject({
      status: 'RESERVED',
      attempt: 0,
      media: null,
      replayed: false,
    });

    const first = await send();
    expect(first).toMatchObject({
      status: 'COMPLETED',
      attempt: 1,
      replayed: false,
      media: {
        sha256: sha(PNG),
        byteLength: PNG.length,
        mimeType: 'image/png',
        method: 'UPLOAD_READBACK',
      },
    });

    // the response is lost: the worker asks, then resends
    const status = await service.uploadStatus(ORG, WORKER, KEY);
    expect(status.media).toEqual(first.media);
    expect(await send()).toMatchObject({ replayed: true, media: first.media });
    expect(await reserve()).toMatchObject({ replayed: true, media: first.media });

    expect(storage.createObjectAt).toHaveBeenCalledTimes(1);
    expect(db.tables.media).toEqual([
      expect.objectContaining({ id: first.media!.mediaId, organizationId: ORG }),
    ]);
    expect(db.tables.managedMediaEvidence).toEqual([
      expect.objectContaining({
        id: first.media!.evidenceId,
        mediaId: first.media!.mediaId,
        sha256: sha(PNG),
        method: 'UPLOAD_READBACK',
        credentialId: WORKER,
        storageVersion: expect.stringMatching(/^local:/),
      }),
    ]);
    expect(db.tables.managedChangeEvent).toEqual([
      expect.objectContaining({
        kind: 'MEDIA_EVIDENCE_RECORDED',
        operationKey: KEY,
        sequence: first.media!.sequence,
      }),
    ]);

    // the bytes in storage are exactly the declared ones, under the identity
    // recorded before the write; no path or key is returned
    const [attempt] = attempts();
    expect(storedFiles()).toEqual([attempt.storageKey]);
    expect(readFileSync(join(dir, attempt.storageKey))).toEqual(PNG);
    expect(db.tables.media[0].path).toBe(attempt.storedPath);
    expect(JSON.stringify([first, status])).not.toMatch(/uploads|managed-/);

    // the attempt is pinned to the directory it was written in, by a digest
    // that names no path and is never returned
    expect(attempt.storageNamespace).toMatch(/^local:[0-9a-f]{64}$/);
    expect(attempt.storageNamespace).toBe(await local.objectNamespace());
    expect(JSON.stringify([first, status])).not.toContain(attempt.storageNamespace);

    // the evidence is current for the draft gate
    expect([...(await service.currentEvidence(ORG, [first.media!.mediaId]))]).toEqual([
      first.media!.evidenceId,
    ]);
  });

  it('concurrent duplicates: one reservation, and only one attempt receives bytes', async () => {
    const reserved = await Promise.all(Array.from({ length: 6 }, () => reserve()));
    expect(reserved.filter((result) => !result.replayed)).toHaveLength(1);
    expect(db.tables.managedMediaUpload).toHaveLength(1);

    const release = gateWrite();
    const first = send();
    await waitFor(() => storage.createObjectAt.mock.calls.length === 1);

    await expect(send()).rejects.toMatchObject(code('UPLOAD_IN_PROGRESS'));
    release();
    expect(await first).toMatchObject({ status: 'COMPLETED' });

    expect(storage.createObjectAt).toHaveBeenCalledTimes(1);
    expect(attempts()).toHaveLength(1);
    expect(db.tables.media).toHaveLength(1);
  });

  it('the same key for other bytes, from another credential or another organization is refused', async () => {
    await reserve();

    for (const over of [
      { sha256: sha('other bytes') },
      { byteLength: PNG.length + 1 },
      { mimeType: 'image/jpeg' },
    ]) {
      await expect(reserve(over)).rejects.toMatchObject(code('OPERATION_KEY_PAYLOAD_MISMATCH'));
    }

    // a second (or replacement) credential of the organization cannot take
    // over a reservation
    await expect(reserve({}, 'ww-other')).rejects.toMatchObject(
      code('OPERATION_KEY_CREDENTIAL_MISMATCH')
    );
    await expect(send(PNG, { credential: 'ww-other' })).rejects.toMatchObject(
      code('OPERATION_KEY_CREDENTIAL_MISMATCH')
    );
    await expect(service.uploadStatus(ORG, 'ww-other', KEY)).rejects.toMatchObject(
      code('OPERATION_KEY_CREDENTIAL_MISMATCH')
    );

    // another organization does not even see it
    await expect(service.uploadStatus(OTHER_ORG, WORKER, KEY)).rejects.toMatchObject({
      status: 404,
    });
    await expect(send(PNG, { org: OTHER_ORG })).rejects.toMatchObject({ status: 404 });

    expect(storage.createObjectAt).not.toHaveBeenCalled();
    expect(db.tables.managedMediaUpload).toHaveLength(1);
    expect(db.tables.managedMediaUpload[0]).toMatchObject({ status: 'RESERVED', attempt: 0 });
  });

  it('refuses declarations over the bound or over the type limit', async () => {
    await expect(reserve({ byteLength: 20 * 1024 * 1024 + 1, mimeType: 'video/mp4' })).rejects.toMatchObject({
      status: 400,
    });
    // images keep the media library's own 10 MB limit
    await expect(reserve({ byteLength: 10 * 1024 * 1024 + 1 })).rejects.toMatchObject({
      status: 400,
    });
    expect(db.tables.managedMediaUpload).toHaveLength(0);
  });

  it('a worker that died before storing anything is recovered to a new attempt, never resent blindly', async () => {
    await reserve();
    hangWrite();
    void send().catch(() => undefined);
    await waitFor(() => storage.createObjectAt.mock.calls.length === 1);

    // within the lease nothing may be resent or recovered
    await expect(send()).rejects.toMatchObject(code('UPLOAD_IN_PROGRESS'));
    await expect(service.recoverUpload(ORG, WORKER, KEY)).rejects.toMatchObject(
      code('UPLOAD_IN_PROGRESS')
    );

    // nor in the grace period right after it
    later(MANAGED_UPLOAD_LEASE_MS + 1);
    expect(await service.uploadStatus(ORG, WORKER, KEY)).toMatchObject({
      status: 'RECEIVING',
      recoverable: false,
    });
    await expect(send()).rejects.toMatchObject(code('UPLOAD_IN_PROGRESS'));
    await expect(service.recoverUpload(ORG, WORKER, KEY)).rejects.toMatchObject(
      code('UPLOAD_IN_PROGRESS')
    );

    later(RECOVERABLE);
    expect(await service.uploadStatus(ORG, WORKER, KEY)).toMatchObject({
      status: 'RECEIVING',
      recoverable: true,
    });
    // no automatic resend once the lease ran out either
    await expect(send()).rejects.toMatchObject(code('UPLOAD_NEEDS_RECOVERY'));

    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
      status: 'RESERVED',
      attempt: 1,
      recoverable: false,
    });
    expect(attempts()).toEqual([
      expect.objectContaining({ attempt: 1, outcome: 'ABSENT', detail: 'NOTHING_STORED' }),
    ]);

    expect(await send()).toMatchObject({ status: 'COMPLETED', attempt: 2 });
    const [one, two] = attempts();
    expect(one.storedPath).not.toBe(two.storedPath);
    expect(storage.createObjectAt.mock.calls.map((call) => call[0])).toEqual([
      one.storageKey,
      two.storageKey,
    ]);
    expect(db.tables.media).toEqual([expect.objectContaining({ path: two.storedPath })]);
  });

  it('a slow stale writer that stores after recovery is recorded as superseded, never adopted or deleted', async () => {
    await reserve();
    // FAKE storage request that outlives the lease and still commits (the
    // in-process deadline only stops this side; storage may commit late)
    const releaseStale = gateWrite();
    const stale = send();
    await waitFor(() => storage.createObjectAt.mock.calls.length === 1);

    later(RECOVERABLE);
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({ status: 'RESERVED' });

    // the replacement attempt holds the reservation while the stale write lands
    const releaseFresh = gateWrite();
    const fresh = send();
    await waitFor(() => storage.createObjectAt.mock.calls.length === 2);

    releaseStale();
    await expect(stale).rejects.toMatchObject(code('UPLOAD_SUPERSEDED'));
    expect(await service.uploadStatus(ORG, WORKER, KEY)).toMatchObject({
      status: 'RECEIVING',
      attempt: 2,
      media: null,
    });

    releaseFresh();
    const completed = await fresh;
    expect(completed).toMatchObject({ status: 'COMPLETED', attempt: 2 });

    // the history keeps what attempt 1 was closed as, and what turned up
    const [one, two] = attempts();
    expect(one.outcome).toBe('SUPERSEDED');
    expect(JSON.parse(one.detail)).toEqual({
      closedAs: 'ABSENT',
      closedDetail: 'NOTHING_STORED',
      lateObject: 'MATCHES_RESERVATION',
      retention: RETAINED,
    });
    expect(two).toMatchObject({ outcome: 'STORED', detail: null });

    // both objects stay; only the replacement is media
    expect(storedFiles().sort()).toEqual([one.storageKey, two.storageKey].sort());
    expect(db.tables.media).toEqual([expect.objectContaining({ path: two.storedPath })]);
    expect(await service.uploadStatus(ORG, WORKER, KEY)).toMatchObject({ media: completed.media });
  });

  it('a worker that died after storing the bytes is completed from a read-back of the recorded object', async () => {
    await reserve();
    // FAKE process death between the storage write and the terminal record:
    // the claim (1st transaction) commits, the terminal one (2nd) never does
    const mutate = repository.mutate.bind(repository);
    let calls = 0;
    const spy = jest
      .spyOn(repository, 'mutate')
      .mockImplementation((org: string, func: any) =>
        ++calls === 2 ? Promise.reject(new Error('FAKE process death')) : mutate(org, func)
      );
    await expect(send()).rejects.toThrow('FAKE process death');
    spy.mockRestore();

    // the stored object is kept: it is the recorded identity of attempt 1
    expect(storedFiles()).toEqual([attempts()[0].storageKey]);
    expect(await service.uploadStatus(ORG, WORKER, KEY)).toMatchObject({
      status: 'RECEIVING',
      media: null,
    });
    expect(db.tables.media).toHaveLength(0);

    later(RECOVERABLE);
    const recovered = await service.recoverUpload(ORG, WORKER, KEY);
    expect(recovered).toMatchObject({
      status: 'COMPLETED',
      attempt: 1,
      media: { sha256: sha(PNG), byteLength: PNG.length, method: 'UPLOAD_READBACK' },
    });
    expect(storage.createObjectAt).toHaveBeenCalledTimes(1);
    expect(db.tables.media).toEqual([
      expect.objectContaining({ path: attempts()[0].storedPath }),
    ]);
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'STORED' })]);

    // recovering or resending again returns the same record
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({ media: recovered.media });
    expect(await send()).toMatchObject({ replayed: true, media: recovered.media });
  });

  it('a lost storage acknowledgement is settled from the read-back by key, without a second write', async () => {
    await reserve();
    // FAKE storage that stores the object and then reports a failure
    storage.createObjectAt.mockImplementationOnce(async (...args: any[]) => {
      await (local.createObjectAt as any)(...args);
      throw new Error('FAKE lost storage response');
    });

    expect(await send()).toMatchObject({ status: 'COMPLETED', attempt: 1, replayed: false });
    expect(storage.createObjectAt).toHaveBeenCalledTimes(1);
    expect(storage.objectVersionAt).toHaveBeenCalledWith(attempts()[0].storageKey);
    // never looked up through the public path
    expect(storage.objectKeyOf).not.toHaveBeenCalled();
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'STORED' })]);
  });

  it('a failed write with no object yet is held: absence is only read after the lease and grace period', async () => {
    await reserve();
    // FAKE request that failed after storage was handed the stream
    storage.createObjectAt.mockImplementationOnce(async (_key: string, stream: Readable) => {
      stream.destroy();
      throw new Error('FAKE connection reset');
    });

    await expect(send()).rejects.toMatchObject(code('UPLOAD_NEEDS_RECOVERY'));
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'RECEIVING' })]);

    later(MANAGED_UPLOAD_LEASE_MS + 1);
    await expect(service.recoverUpload(ORG, WORKER, KEY)).rejects.toMatchObject(
      code('UPLOAD_IN_PROGRESS')
    );

    later(RECOVERABLE);
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
      status: 'RESERVED',
      attempt: 1,
    });
    expect(attempts()).toEqual([
      expect.objectContaining({ outcome: 'ABSENT', detail: 'NOTHING_STORED' }),
    ]);
    expect(await send()).toMatchObject({ status: 'COMPLETED', attempt: 2 });
  });

  it('an acknowledged write whose object is not there is held, not reported as a size mismatch', async () => {
    await reserve();
    // FAKE storage that acknowledges without storing anything
    storage.createObjectAt.mockImplementationOnce(async (_key: string, stream: Readable) => {
      stream.resume();
    });

    await expect(send()).rejects.toMatchObject(code('UPLOAD_NEEDS_RECOVERY'));
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'RECEIVING' })]);
    expect(await service.uploadStatus(ORG, WORKER, KEY)).toMatchObject({ status: 'RECEIVING' });
    // the body was torn down, not left flowing into a finished digest
    for (let i = 0; i < 5; i++) {
      await settle();
    }
    expect(storedFiles()).toEqual([]);
  });

  it('storage that resolves without reading the body is held, without waiting on the body', async () => {
    await reserve();
    // FAKE storage that never touches the stream it was handed
    storage.createObjectAt.mockImplementationOnce(async () => undefined);
    const body = Readable.from([PNG]);

    await expect(
      service.receiveUploadContent(
        ORG,
        WORKER,
        KEY,
        body,
        'application/octet-stream',
        String(PNG.length)
      )
    ).rejects.toMatchObject(code('UPLOAD_NEEDS_RECOVERY'));
    await waitFor(() => body.destroyed);
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'RECEIVING' })]);
    expect(db.tables.media).toHaveLength(0);

    later(RECOVERABLE);
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({ status: 'RESERVED' });
  });

  it('a write is cut off at its deadline: body and write torn down, the partial object recorded and kept', async () => {
    (service as any).writeDeadlineMs = 50;
    await reserve();
    // FAKE client that sends the head of the file and then stalls
    const body = new PassThrough();
    body.write(PNG.subarray(0, 5000));

    await expect(
      service.receiveUploadContent(
        ORG,
        WORKER,
        KEY,
        body,
        'application/octet-stream',
        String(PNG.length)
      )
    ).rejects.toMatchObject(code('MEDIA_SIZE_MISMATCH'));

    expect(body.destroyed).toBe(true);
    expect(storage.createObjectAt.mock.calls[0][4]).toMatchObject({ aborted: true });
    const [attempt] = attempts();
    expect(attempt).toMatchObject({
      outcome: 'BYTES_REJECTED',
      detail: `MEDIA_SIZE_MISMATCH;${RETAINED}`,
    });
    expect(storedFiles()).toEqual([attempt.storageKey]);
    expect(statSync(join(dir, attempt.storageKey)).size).toBeLessThan(PNG.length);
    expect(db.tables.media).toHaveLength(0);
  });

  it('a changed public address is held, never read as nothing stored', async () => {
    await reserve();
    hangWrite();
    void send().catch(() => undefined);
    await waitFor(() => storage.createObjectAt.mock.calls.length === 1);
    later(RECOVERABLE);

    // FAKE config drift: FRONTEND_URL moved after the attempt was claimed
    process.env.FRONTEND_URL = 'https://moved.example';
    for (let i = 0; i < 2; i++) {
      expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
        status: 'RECEIVING',
        recoverable: true,
        recovery: 'READ_FAILED',
      });
    }
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'RECEIVING' })]);
    expect(storage.objectVersionAt).not.toHaveBeenCalled();

    process.env.FRONTEND_URL = 'https://app.example';
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({ status: 'RESERVED' });
  });

  it('a stored object behind a changed public address is held, then completed once the address is back', async () => {
    await reserve();
    const mutate = repository.mutate.bind(repository);
    let calls = 0;
    const spy = jest
      .spyOn(repository, 'mutate')
      .mockImplementation((org: string, func: any) =>
        ++calls === 2 ? Promise.reject(new Error('FAKE process death')) : mutate(org, func)
      );
    await expect(send()).rejects.toThrow('FAKE process death');
    spy.mockRestore();
    later(RECOVERABLE);

    process.env.FRONTEND_URL = 'https://moved.example';
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
      status: 'RECEIVING',
      recovery: 'READ_FAILED',
    });
    expect(db.tables.media).toHaveLength(0);

    process.env.FRONTEND_URL = 'https://app.example';
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
      status: 'COMPLETED',
      attempt: 1,
    });
  });

  // FAKE operator config drift: the storage is rebuilt over another existing
  // directory while FRONTEND_URL, so every stored path, stays the same
  const moveStorage = (directory: string) => (local = new LocalStorage(directory));
  const held = async () => {
    for (let i = 0; i < 2; i++) {
      expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
        status: 'RECEIVING',
        recoverable: true,
        recovery: 'READ_FAILED',
      });
    }
    await expect(send()).rejects.toMatchObject(code('UPLOAD_NEEDS_RECOVERY'));
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'RECEIVING' })]);
    expect(db.tables.media).toHaveLength(0);
  };

  it('an object behind the same URL in another existing directory is held, never read as nothing stored', async () => {
    await reserve();
    const mutate = repository.mutate.bind(repository);
    let calls = 0;
    const spy = jest
      .spyOn(repository, 'mutate')
      .mockImplementation((org: string, func: any) =>
        ++calls === 2 ? Promise.reject(new Error('FAKE process death')) : mutate(org, func)
      );
    await expect(send()).rejects.toThrow('FAKE process death');
    spy.mockRestore();
    later(RECOVERABLE);
    const [attempt] = attempts();
    storage.objectVersionAt.mockClear();

    const other = mkdtempSync(join(tmpdir(), 'managed-other-'));
    moveStorage(other);
    expect(local.objectPath(attempt.storageKey)).toBe(attempt.storedPath);
    await held();
    // the other directory is never asked about the key, and gets no object
    expect(storage.objectVersionAt).not.toHaveBeenCalled();
    expect(readdirSync(other)).toEqual([]);

    moveStorage(dir);
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
      status: 'COMPLETED',
      attempt: 1,
    });
  });

  it('an attempt with nothing stored is held when its directory is swapped or replaced at the same path', async () => {
    await reserve();
    hangWrite();
    void send().catch(() => undefined);
    await waitFor(() => storage.createObjectAt.mock.calls.length === 1);
    later(RECOVERABLE);

    // another existing directory: absence there says nothing about the key
    const other = mkdtempSync(join(tmpdir(), 'managed-other-'));
    moveStorage(other);
    await held();

    // a new directory put in place at the very same path is another namespace
    renameSync(dir, `${dir}-moved`);
    mkdirSync(dir);
    moveStorage(dir);
    await held();
    expect(storage.objectVersionAt).not.toHaveBeenCalled();
    expect(storage.createObjectAt).toHaveBeenCalledTimes(1);
  });

  it('a symlink to the same directory is the same namespace', async () => {
    await reserve();
    hangWrite();
    void send().catch(() => undefined);
    await waitFor(() => storage.createObjectAt.mock.calls.length === 1);
    later(RECOVERABLE);

    const alias = join(mkdtempSync(join(tmpdir(), 'managed-alias-')), 'uploads');
    symlinkSync(dir, alias);
    moveStorage(alias);
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({ status: 'RESERVED' });
    expect(await send()).toMatchObject({ status: 'COMPLETED', attempt: 2 });
    expect(storedFiles()).toEqual([attempts()[1].storageKey]);
  });

  it('an attempt claimed before namespaces were recorded is held, never guessed', async () => {
    await reserve();
    hangWrite();
    void send().catch(() => undefined);
    await waitFor(() => storage.createObjectAt.mock.calls.length === 1);
    later(RECOVERABLE);

    // FAKE row from before the column existed
    db.patch('managedMediaUploadAttempt', attempts()[0].id, { storageNamespace: null });
    await held();
    expect(storage.objectVersionAt).not.toHaveBeenCalled();
  });

  it('storage that moved between the claim and the write is closed before a byte is handed over', async () => {
    await reserve();
    // FAKE: the claim saw one namespace, the write sees another
    storage.objectNamespace.mockResolvedValueOnce('local:FAKE-claimed-elsewhere');
    await expect(send()).rejects.toMatchObject(code('STORAGE_HAS_NO_PRIVATE_READ'));

    expect(storage.createObjectAt).not.toHaveBeenCalled();
    expect(attempts()).toEqual([
      expect.objectContaining({ outcome: 'ABSENT', detail: 'WRITE_FAILED' }),
    ]);
    expect(storedFiles()).toEqual([]);
    expect(await send()).toMatchObject({ status: 'COMPLETED', attempt: 2 });
  });

  it('claims no attempt while storage cannot say which namespace it writes in', async () => {
    await reserve();
    storage.objectNamespace.mockRejectedValueOnce(
      Object.assign(new Error('FAKE ENOENT'), { code: 'ENOENT' })
    );
    await expect(send()).rejects.toMatchObject(code('STORAGE_HAS_NO_PRIVATE_READ'));

    expect(attempts()).toHaveLength(0);
    expect(storage.createObjectAt).not.toHaveBeenCalled();
    expect(await service.uploadStatus(ORG, WORKER, KEY)).toMatchObject({
      status: 'RESERVED',
      attempt: 0,
    });
  });

  it('bytes that drift in digest, size or type are refused until the attempts are used up', async () => {
    await reserve();

    // same size, other digest: stored, read back, refused and kept
    const other = Buffer.concat([Buffer.from('FAKEPNG'), Buffer.from('FAKE-PIXELZ'.repeat(2000))]);
    expect(other.length).toBe(PNG.length);
    await expect(send(other)).rejects.toMatchObject(code('MEDIA_DIGEST_MISMATCH'));

    // a Content-Length other than the reservation: refused before any claim
    await expect(send(PNG, { length: PNG.length - 1 })).rejects.toMatchObject(
      code('MEDIA_SIZE_MISMATCH')
    );

    // another type: refused before the first byte is written
    const jpeg = Buffer.concat([Buffer.from('FAKEJPG'), PNG.subarray(7)]);
    await expect(send(jpeg)).rejects.toMatchObject(code('MEDIA_TYPE_MISMATCH'));

    // fewer bytes than declared: stored short, read back, refused
    await expect(
      send(PNG.subarray(0, PNG.length - 10), { length: PNG.length })
    ).rejects.toMatchObject(code('MEDIA_SIZE_MISMATCH'));

    expect(attempts().map(({ outcome, detail }) => [outcome, detail])).toEqual([
      ['BYTES_REJECTED', `MEDIA_DIGEST_MISMATCH;${RETAINED}`],
      ['ABSENT', 'MEDIA_TYPE_MISMATCH'],
      ['BYTES_REJECTED', `MEDIA_SIZE_MISMATCH;${RETAINED}`],
    ]);
    expect(storage.createObjectAt).toHaveBeenCalledTimes(2);

    // three attempts: the reservation failed for good, in the feed
    expect(await service.uploadStatus(ORG, WORKER, KEY)).toMatchObject({
      status: 'FAILED',
      failureReason: 'MEDIA_SIZE_MISMATCH',
      media: null,
    });
    await expect(send()).rejects.toMatchObject(code('UPLOAD_FAILED'));
    expect(db.tables.managedChangeEvent).toEqual([
      expect.objectContaining({ kind: 'MEDIA_UPLOAD_FAILED', operationKey: KEY }),
    ]);

    expect(db.tables.media).toHaveLength(0);
    expect(db.tables.managedMediaEvidence).toHaveLength(0);
    // the rejected objects stay where they were written; none became media
    const [first, , third] = attempts();
    expect(storedFiles().sort()).toEqual([first.storageKey, third.storageKey].sort());
  });

  it('a body longer than reserved is cut off at the reserved size; the partial object is kept, never media', async () => {
    await reserve();
    await expect(
      send(Buffer.concat([PNG, Buffer.from('EXTRA')]), { length: PNG.length })
    ).rejects.toMatchObject({ status: 400 });

    const [attempt] = attempts();
    expect(attempt).toMatchObject({
      outcome: 'BYTES_REJECTED',
      detail: `MEDIA_SIZE_MISMATCH;${RETAINED}`,
    });
    expect(storedFiles()).toEqual([attempt.storageKey]);
    expect(await send()).toMatchObject({ status: 'COMPLETED', attempt: 2 });
    expect(db.tables.media).toEqual([
      expect.objectContaining({ path: attempts()[1].storedPath }),
    ]);
  });

  it('an unknown key has no status and creates nothing', async () => {
    for (const key of ['ww:asset:unknown', '../../etc/passwd']) {
      await expect(service.uploadStatus(ORG, WORKER, key)).rejects.toMatchObject({ status: 404 });
      await expect(service.recoverUpload(ORG, WORKER, key)).rejects.toMatchObject({ status: 404 });
      await expect(send(PNG, { key })).rejects.toMatchObject({ status: 404 });
    }

    expect(db.tables.managedMediaUpload).toHaveLength(0);
    expect(db.tables.managedMediaUploadAttempt).toHaveLength(0);
    expect(storage.createObjectAt).not.toHaveBeenCalled();
  });

  it('holds an attempt whose storage effect is unknown until storage can answer', async () => {
    await reserve();
    hangWrite();
    void send().catch(() => undefined);
    await waitFor(() => storage.createObjectAt.mock.calls.length === 1);
    later(RECOVERABLE);

    // FAKE permission / I/O failure: not absence
    storage.objectVersionAt.mockRejectedValue(
      Object.assign(new Error('FAKE EACCES'), { code: 'EACCES' })
    );
    for (let i = 0; i < 3; i++) {
      expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
        status: 'RECEIVING',
        attempt: 1,
        recoverable: true,
        recovery: 'READ_FAILED',
      });
    }
    await expect(send()).rejects.toMatchObject(code('UPLOAD_NEEDS_RECOVERY'));
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'RECEIVING' })]);
    expect(storage.createObjectAt).toHaveBeenCalledTimes(1);

    storage.objectVersionAt.mockImplementation((key: string) => local.objectVersionAt(key));
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({ status: 'RESERVED' });
  });

  it('a settled attempt is never rewritten; only one closed without bytes is superseded, keeping what it was', async () => {
    await reserve();
    await send();
    const [stored] = attempts();

    await expect(
      repository.mutate(ORG, (tx) =>
        tx.updateMediaUploadAttempt(stored.id, { outcome: 'ABSENT', detail: 'NOTHING_STORED' })
      )
    ).rejects.toMatchObject(code('UPLOAD_SUPERSEDED'));
    await expect(
      repository.mutate(ORG, (tx) => tx.supersedeMediaUploadAttempt(stored.id, stored, '{}'))
    ).rejects.toMatchObject(code('UPLOAD_SUPERSEDED'));
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'STORED', detail: null })]);

    // a closed attempt is superseded only from the exact state it was read in
    await reserve({}, WORKER, OTHER_ORG);
    hangWrite();
    void send(PNG, { org: OTHER_ORG }).catch(() => undefined);
    await waitFor(() => storage.createObjectAt.mock.calls.length === 2);
    later(RECOVERABLE);
    await service.recoverUpload(OTHER_ORG, WORKER, KEY);
    const absent = attempts().find((row) => row.organizationId === OTHER_ORG)!;
    expect(absent).toMatchObject({ outcome: 'ABSENT', detail: 'NOTHING_STORED' });

    await expect(
      repository.mutate(OTHER_ORG, (tx) =>
        tx.supersedeMediaUploadAttempt(absent.id, { outcome: 'ABSENT', detail: 'OTHER' }, '{}')
      )
    ).rejects.toMatchObject(code('UPLOAD_SUPERSEDED'));
    // and never across organizations
    await expect(
      repository.mutate(ORG, (tx) => tx.supersedeMediaUploadAttempt(absent.id, absent, '{}'))
    ).rejects.toMatchObject(code('UPLOAD_SUPERSEDED'));
    expect(attempts().find((row) => row.id === absent.id)).toMatchObject({
      outcome: 'ABSENT',
      detail: 'NOTHING_STORED',
    });
  });

  it('refuses storage that cannot read back privately, before anything is reserved', async () => {
    delete storage.createObjectAt;
    await expect(reserve()).rejects.toMatchObject(code('STORAGE_HAS_NO_PRIVATE_READ'));
    expect(db.tables.managedMediaUpload).toHaveLength(0);
  });

  it('only takes the raw octet-stream body', async () => {
    await reserve();
    await expect(
      service.receiveUploadContent(
        ORG,
        WORKER,
        KEY,
        Readable.from([PNG]),
        'multipart/form-data; boundary=x',
        String(PNG.length)
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(attempts()).toHaveLength(0);
  });

  describe('LocalStorage.createObjectAt', () => {
    const create = (key: string, bytes: Buffer | Readable, abort = signal()) =>
      local.createObjectAt(
        key,
        Buffer.isBuffer(bytes) ? Readable.from([bytes]) : bytes,
        'image/png',
        PNG.length,
        abort
      );

    it('never replaces an existing object and only takes plain media keys', async () => {
      await create('managed-a-1.png', PNG);
      await expect(create('managed-a-1.png', Buffer.from('FAKEPNG-x'))).rejects.toBeInstanceOf(
        StorageObjectExistsError
      );
      expect(readFileSync(join(dir, 'managed-a-1.png'))).toEqual(PNG);

      for (const key of ['../x.png', 'a/b.png', '/abs.png', 'x.html', 'x.svg']) {
        await expect(create(key, PNG)).rejects.toThrow();
      }
      expect(readdirSync(dir)).toEqual(['managed-a-1.png']);
    });

    it('stops at the deadline: the stream is destroyed and the partial file kept, and nothing starts after it', async () => {
      const deadline = new AbortController();
      const body = new PassThrough();
      body.write(PNG.subarray(0, 100));
      const writing = create('managed-b-1.png', body, deadline.signal);
      await waitFor(() => readdirSync(dir).includes('managed-b-1.png'));

      deadline.abort();
      await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
      expect(body.destroyed).toBe(true);
      expect(readdirSync(dir)).toEqual(['managed-b-1.png']);

      await expect(create('managed-b-2.png', PNG, deadline.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(readdirSync(dir)).toEqual(['managed-b-1.png']);
    });
  });

  it('read-back evidence is pinned to its attempt, captured evidence to its own key; neither follows the URL to another namespace', async () => {
    await reserve();
    const done = await send();
    const [attempt] = attempts();
    expect(db.tables.managedMediaEvidence).toEqual([
      expect.objectContaining({
        method: 'UPLOAD_READBACK',
        storageKey: attempt.storageKey,
        storageNamespace: attempt.storageNamespace,
      }),
    ]);

    // the capture fallback in the same REAL storage: the bytes were streamed
    // through a digest, not read back, and the object is pinned by its key
    const uploaded = await local.uploadStream(Readable.from([PNG]), 'image/png', 'png');
    const captured = await service.recordCapturedUpload(ORG, WORKER, {
      ...uploaded,
      capturedDigest: { sha256: sha(PNG), byteLength: PNG.length },
    } as any);
    const capture = db.tables.managedMediaEvidence.find((row) => row.method === 'UPLOAD_CAPTURE')!;
    expect(capture).toMatchObject({
      storageKey: uploaded.path.slice('https://app.example/uploads/'.length),
      storageNamespace: attempt.storageNamespace,
    });
    expect(capture.storageKey).toMatch(/^\d{4}\/\d{2}\/\d{2}\/[0-9a-f]+\.png$/);
    const ids = [done.media!.mediaId, captured.mediaId];
    expect((await service.currentEvidence(ORG, ids)).size).toBe(2);

    // a private reread of the captured object, by its key in its namespace:
    // the same object, so its capture evidence stands and nothing is recorded
    const evidenceRows = db.tables.managedMediaEvidence.length;
    expect(await service.verifyStoredMedia(ORG, WORKER, captured.mediaId)).toMatchObject({
      status: 'VERIFIED',
      sha256: sha(PNG),
      mimeType: 'image/png',
      method: 'UPLOAD_CAPTURE',
    });
    expect(db.tables.managedMediaEvidence).toHaveLength(evidenceRows);

    // FAKE config drift: the same URLs over another existing directory
    const other = mkdtempSync(join(tmpdir(), 'managed-other-'));
    moveStorage(other);
    expect((await service.currentEvidence(ORG, ids)).size).toBe(0);
    for (const mediaId of ids) {
      expect(await service.verifyStoredMedia(ORG, WORKER, mediaId)).toMatchObject({
        status: 'UNVERIFIED',
        reason: 'STORAGE_IDENTITY_CHANGED',
      });
    }
    expect(readdirSync(other)).toEqual([]);

    moveStorage(dir);
    expect((await service.currentEvidence(ORG, ids)).size).toBe(2);
    expect(storage.removeFile).not.toHaveBeenCalled();
  });

  it('verifying an unchanged uploaded object keeps its read-back evidence and writes nothing; a rewritten one is re-proven, never answered by the old proof', async () => {
    await reserve();
    const done = await send();
    const before = structuredClone(db.tables);

    for (let i = 0; i < 2; i++) {
      expect(await service.verifyStoredMedia(ORG, WORKER, done.media!.mediaId)).toEqual({
        status: 'VERIFIED',
        mediaId: done.media!.mediaId,
        sha256: sha(PNG),
        byteLength: PNG.length,
        mimeType: 'image/png',
        method: 'UPLOAD_READBACK',
      });
    }
    // no evidence, no event, no row: the upload's evidence is still the current one
    expect(db.tables).toEqual(before);
    expect(await service.currentEvidence(ORG, [done.media!.mediaId])).toEqual(
      new Set([done.media!.evidenceId])
    );

    // FAKE processor: other bytes written in place under the same key
    const [attempt] = attempts();
    const other = Buffer.concat([Buffer.from('FAKEPNG'), Buffer.from('FAKE-OTHER')]);
    writeFileSync(join(dir, attempt.storageKey), other);
    expect(await service.currentEvidence(ORG, [done.media!.mediaId])).toEqual(new Set());

    expect(await service.verifyStoredMedia(ORG, WORKER, done.media!.mediaId)).toMatchObject({
      status: 'VERIFIED',
      sha256: sha(other),
      byteLength: other.length,
      mimeType: null,
      method: 'PRIVATE_STORAGE_READ',
    });
    expect(db.tables.managedMediaEvidence).toHaveLength(2);
    expect(await service.currentEvidence(ORG, [done.media!.mediaId])).not.toContain(
      done.media!.evidenceId
    );
  });

  it('a read-back during which keys moved to another namespace is held, never completed', async () => {
    await reserve();
    const namespace = await local.objectNamespace();
    // FAKE: the claim, the write and the start of the read-back see the
    // pinned namespace; the end of the read-back sees another
    let calls = 0;
    storage.objectNamespace.mockImplementation(async () =>
      ++calls > 3 ? 'local:FAKE-moved' : namespace
    );
    await expect(send()).rejects.toMatchObject(code('UPLOAD_NEEDS_RECOVERY'));
    expect(attempts()).toEqual([expect.objectContaining({ outcome: 'RECEIVING' })]);
    expect(db.tables.media).toHaveLength(0);
    expect(db.tables.managedMediaEvidence).toHaveLength(0);

    storage.objectNamespace.mockImplementation(() => local.objectNamespace());
    later(RECOVERABLE);
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
      status: 'COMPLETED',
      attempt: 1,
    });
    expect(storage.createObjectAt).toHaveBeenCalledTimes(1);
  });

  it('a new operation key does not get around an attempt for the same bytes whose effect is unknown', async () => {
    const NEW_KEY = 'ww:asset:42:v2';
    await reserve();
    hangWrite();
    void send().catch(() => undefined);
    await waitFor(() => storage.createObjectAt.mock.calls.length === 1);

    await expect(reserve({ operationKey: NEW_KEY })).rejects.toMatchObject(
      code('UPLOAD_IN_PROGRESS')
    );
    later(RECOVERABLE);
    await expect(reserve({ operationKey: NEW_KEY })).rejects.toMatchObject(
      code('UPLOAD_NEEDS_RECOVERY')
    );

    // a recovery that cannot read the attempt keeps it unknown
    const [attempt] = attempts();
    const originalNamespace = attempt.storageNamespace;
    db.patch('managedMediaUploadAttempt', attempt.id, { storageNamespace: null });
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({
      status: 'RECEIVING',
      recovery: 'READ_FAILED',
    });
    await expect(reserve({ operationKey: NEW_KEY })).rejects.toMatchObject(
      code('UPLOAD_NEEDS_RECOVERY')
    );
    await expect(reserve({ operationKey: NEW_KEY }, 'ww-other-worker')).rejects.toMatchObject(
      code('UPLOAD_NEEDS_RECOVERY')
    );
    expect(db.tables.managedMediaUpload).toHaveLength(1);

    // other bytes are not held up by it
    expect(
      await reserve({ operationKey: 'ww:asset:43:v1', sha256: sha('FAKE-other') })
    ).toMatchObject({ status: 'RESERVED', replayed: false });

    // once the attempt is settled from storage, the same bytes may be
    // reserved again; the settled attempt keeps its history
    db.patch('managedMediaUploadAttempt', attempt.id, {
      storageNamespace: originalNamespace,
    });
    expect(await service.recoverUpload(ORG, WORKER, KEY)).toMatchObject({ status: 'RESERVED' });
    expect(await reserve({ operationKey: NEW_KEY })).toMatchObject({
      status: 'RESERVED',
      replayed: false,
    });
    expect(attempts()).toEqual([
      expect.objectContaining({ outcome: 'ABSENT', detail: 'NOTHING_STORED' }),
    ]);
  });

  describe('LocalStorage objects by key', () => {
    it('is absent only when the key itself does not exist', async () => {
      await local.createObjectAt('managed-c-1.png', Readable.from([PNG]), 'image/png', PNG.length, signal());
      expect(await local.objectVersionAt('managed-c-1.png')).toMatch(/^local:/);
      const opened = await local.openObjectAt('managed-c-1.png');
      expect(opened!.version).toBe(await local.objectVersionAt('managed-c-1.png'));
      opened!.stream.destroy();

      // read by key, so a changed public address does not hide the object
      process.env.FRONTEND_URL = 'https://moved.example';
      expect(await local.objectVersionAt('managed-c-1.png')).toMatch(/^local:/);

      expect(await local.objectVersionAt('managed-none-1.png')).toBeNull();
      expect(await local.openObjectAt('managed-none-1.png')).toBeNull();

      // FAKE config drift: a missing upload directory is not an absent key
      const moved = new LocalStorage(join(dir, 'missing-directory'));
      await expect(moved.objectVersionAt('managed-c-1.png')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(moved.openObjectAt('managed-c-1.png')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(moved.objectNamespace()).rejects.toMatchObject({ code: 'ENOENT' });

      for (const key of ['../x.png', 'a/../b.png', 'x.html']) {
        await expect(local.objectVersionAt(key)).rejects.toThrow();
      }
      // a key in a folder is read inside the upload directory (stored media
      // sits in YYYY/MM/DD); only createObjectAt is limited to plain names
      expect(await local.objectVersionAt('a/b.png')).toBeNull();
      await expect(
        local.createObjectAt('a/b.png', Readable.from([PNG]), 'image/png', PNG.length, signal())
      ).rejects.toThrow('Unsupported object key or file type.');
    });

    (asRoot ? it.skip : it)('an unreadable upload directory is a failure, not absence', async () => {
      await local.createObjectAt('managed-d-1.png', Readable.from([PNG]), 'image/png', PNG.length, signal());
      chmodSync(dir, 0o000);
      try {
        for (const key of ['managed-d-1.png', 'managed-none-1.png']) {
          await expect(local.objectVersionAt(key)).rejects.toMatchObject({ code: 'EACCES' });
          await expect(local.openObjectAt(key)).rejects.toMatchObject({ code: 'EACCES' });
        }
      } finally {
        chmodSync(dir, 0o700);
      }
    });
  });

  // FAKE S3 client: only what the adapter sends is checked; R2 itself
  // (If-None-Match, 404 shapes, abort behaviour) is not qualified here
  describe('CloudflareStorage objects by key', () => {
    const r2 = () => {
      const r2Storage = new CloudflareStorage(
        'FAKE-account',
        'FAKE-access-key',
        'FAKE-secret',
        'auto',
        'FAKE-bucket',
        'https://cdn.example'
      );
      const send = jest.fn();
      (r2Storage as any)._client = { send };
      return { r2Storage, send };
    };
    const httpError = (status: number, name: string) =>
      Object.assign(new Error(`FAKE ${name}`), { name, $metadata: { httpStatusCode: status } });

    // only the descriptor the adapter computes; whether a bucket name still
    // names the same bucket is not something a fake can show
    it('names the namespace by account and bucket, never by credentials or public URL', async () => {
      const namespace = (account: string, bucket: string, secret = 'FAKE-secret', url = 'https://cdn.example') =>
        new CloudflareStorage(account, 'FAKE-access-key', secret, 'auto', bucket, url).objectNamespace();

      const base = await namespace('FAKE-account', 'FAKE-bucket');
      expect(base).toMatch(/^r2:[0-9a-f]{64}$/);
      expect(base).not.toMatch(/FAKE/);
      expect(await namespace('FAKE-account', 'FAKE-bucket', 'FAKE-rotated-secret')).toBe(base);
      // the same public URL in front of another bucket or account
      expect(await namespace('FAKE-account', 'FAKE-other-bucket')).not.toBe(base);
      expect(await namespace('FAKE-other-account', 'FAKE-bucket')).not.toBe(base);
      // a changed public URL is caught by the stored path, not the namespace
      expect(await namespace('FAKE-account', 'FAKE-bucket', 'FAKE-secret', 'https://moved.example')).toBe(base);
    });

    it('is absent only on a 404 that the bucket itself confirms', async () => {
      const { r2Storage, send } = r2();

      send.mockRejectedValueOnce(httpError(404, 'NotFound')).mockResolvedValueOnce({});
      expect(await r2Storage.objectVersionAt('managed-a-1.png')).toBeNull();
      expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
      expect(send.mock.calls[1][0]).toBeInstanceOf(HeadBucketCommand);

      // FAKE config drift: a missing / renamed bucket answers 404 as well
      send
        .mockRejectedValueOnce(httpError(404, 'NotFound'))
        .mockRejectedValueOnce(httpError(404, 'NotFound'));
      await expect(r2Storage.objectVersionAt('managed-a-1.png')).rejects.toThrow();

      send.mockRejectedValueOnce(httpError(403, 'AccessDenied'));
      await expect(r2Storage.objectVersionAt('managed-a-1.png')).rejects.toThrow();

      // an object that is there but has no version is not absent
      send.mockResolvedValueOnce({ ContentLength: 3 });
      await expect(r2Storage.objectVersionAt('managed-a-1.png')).rejects.toThrow();

      send.mockRejectedValueOnce(httpError(404, 'NoSuchKey')).mockResolvedValueOnce({});
      expect(await r2Storage.openObjectAt('managed-a-1.png')).toBeNull();
      send.mockRejectedValueOnce(httpError(500, 'InternalError'));
      await expect(r2Storage.openObjectAt('managed-a-1.png')).rejects.toThrow();

      await expect(r2Storage.objectVersionAt('../managed-a-1.png')).rejects.toThrow();
    });

    it('passes the deadline to the conditional PUT, starts nothing after it and never deletes', async () => {
      const { r2Storage, send } = r2();
      send.mockResolvedValue({});
      const deadline = new AbortController();

      await r2Storage.createObjectAt(
        'managed-a-1.png',
        Readable.from([PNG]),
        'image/png',
        PNG.length,
        deadline.signal
      );
      const [command, options] = send.mock.calls[0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({
        Key: 'managed-a-1.png',
        IfNoneMatch: '*',
        ContentLength: PNG.length,
      });
      expect(options.abortSignal).toBe(deadline.signal);

      deadline.abort();
      await expect(
        r2Storage.createObjectAt(
          'managed-a-2.png',
          Readable.from([PNG]),
          'image/png',
          PNG.length,
          deadline.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls.some(([sent]) => sent instanceof DeleteObjectCommand)).toBe(false);
    });
  });
});

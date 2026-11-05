import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import type { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import type { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import type { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';

/** Actual PostgreSQL + production local storage + real file-type; only crash/expired leases are injected. */
export async function verifyReservedUploads(input: { admin: PrismaClient; repository: ManagedRepository; mediaService: ManagedMediaService;
  service: ManagedService; integrationId: string; bindingGeneration: number;
  organizationId: string; otherOrganizationId: string; credential: string; bytes: Buffer; sha256: string }) {
  const { admin, repository, mediaService, service, integrationId, bindingGeneration, organizationId: org, otherOrganizationId: other, credential, bytes, sha256 } = input;
  const reserve = (key: string) => mediaService.reserveUpload(org, credential, { operationKey: key, sha256, byteLength: bytes.length, mimeType: 'image/png' });
  const send = (key: string, body: Readable = Readable.from([bytes])) => mediaService.receiveUploadContent(org, credential, key, body, 'application/octet-stream', String(bytes.length));
  const errorCode = async (promise: Promise<unknown>, expected: string) => assert.rejects(promise, (e: any) => e.getResponse?.().code === expected, expected);
  const status = (key: string) => mediaService.uploadStatus(org, credential, key);
  const row = (key: string) => admin.managedMediaUpload.findUniqueOrThrow({ where: { organizationId_operationKey: { organizationId: org, operationKey: key } } });
  const expire = (key: string) => admin.managedMediaUpload.update({ where: { organizationId_operationKey: { organizationId: org, operationKey: key } }, data: { leaseExpiresAt: new Date(0) } });
  const count = () => admin.media.count({ where: { organizationId: org } });
  const initialCount = await count();
  const key = 'ww:db:upload:concurrent';
  const reservations = await Promise.all(Array.from({ length: 6 }, () => reserve(key)));
  assert.equal(reservations.filter(r => !r.replayed).length, 1);
  assert.equal(await admin.managedMediaUpload.count({ where: { organizationId: org, operationKey: key } }), 1);
  await errorCode(mediaService.reserveUpload(org, credential, { operationKey: key, sha256: 'a'.repeat(64), byteLength: bytes.length, mimeType: 'image/png' }), 'OPERATION_KEY_PAYLOAD_MISMATCH');
  await errorCode(mediaService.uploadStatus(org, 'foreign-credential', key), 'OPERATION_KEY_CREDENTIAL_MISMATCH');
  await assert.rejects(mediaService.uploadStatus(other, credential, key));
  const sends = await Promise.allSettled([send(key), send(key)]);
  const stored = (sends.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof send>>>).value;
  for (const r of sends) if (r.status === 'rejected') assert.equal(r.reason.getResponse?.().code, 'UPLOAD_IN_PROGRESS');
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(stored.media!.sha256, sha256);
  assert.equal(stored.media!.method, 'UPLOAD_READBACK');
  assert.equal(await count(), initialCount + 1);
  const current = await status(key);
  assert.deepEqual(current.media, stored.media);
  let readReplayBody = false;
  const replay = await send(key, new Readable({ read() { readReplayBody = true; this.destroy(new Error('Replay must not read bytes')); } }));
  assert.equal(replay.replayed, true); assert.equal(readReplayBody, false);
  assert.deepEqual(replay.media, stored.media);
  const declarationReplay = await reserve(key);
  assert.deepEqual(declarationReplay.media, stored.media);
  assert.equal(await count(), initialCount + 1);
  console.log('PASS real reserved uploads: six concurrent reservations and duplicate PUTs create one media row; lost reply recovers exact identity without reading another body');

  const crashKey = 'ww:db:upload:crash-after-storage';
  await reserve(crashKey);
  const mutate = repository.mutate.bind(repository);
  let mutationCalls = 0;
  // The claim commits and real storage completes; the terminal DB transaction is interrupted before it starts.
  (repository as any).mutate = (organization: string, callback: any) => ++mutationCalls === 2
    ? Promise.reject(new Error('INJECTED_PROCESS_DEATH_AFTER_STORAGE')) : mutate(organization, callback);
  try { await assert.rejects(send(crashKey), /INJECTED_PROCESS_DEATH_AFTER_STORAGE/); }
  finally { (repository as any).mutate = mutate; }
  const receiving = await status(crashKey);
  assert.equal(receiving.status, 'RECEIVING');
  assert.equal(await count(), initialCount + 1);
  await errorCode(mediaService.recoverUpload(org, credential, crashKey), 'UPLOAD_IN_PROGRESS');
  await expire(crashKey);
  const recovered = await mediaService.recoverUpload(org, credential, crashKey);
  assert.equal(recovered.status, 'COMPLETED'); assert.equal(recovered.attempt, 1);
  assert.equal(recovered.media!.sha256, sha256);
  assert.equal(await count(), initialCount + 2);
  assert.deepEqual((await send(crashKey)).media, recovered.media);
  assert.equal((await admin.managedMediaUploadAttempt.findMany({ where: { uploadId: (await row(crashKey)).id } })).length, 1);
  console.log('PASS real upload crash: recorded object is read back after lease expiry, completing the same attempt and media identity');

  const staleKey = 'ww:db:upload:stale-writer';
  await reserve(staleKey);
  const paused = new PassThrough();
  // Attach a rejection handler immediately; the stream intentionally remains open until the replacement completed.
  const stale = send(staleKey, paused).then(value => ({ value }), error => ({ error }));
  let receivingStarted = false;
  for (let n = 0; n < 100; n++) {
    if ((await row(staleKey)).status === 'RECEIVING') { receivingStarted = true; break; }
    await delay(10);
  }
  assert(receivingStarted, 'Reservation claim must commit before the request body is read');
  await expire(staleKey);
  const absent = await mediaService.recoverUpload(org, credential, staleKey);
  assert.equal(absent.status, 'RESERVED'); assert.equal(absent.attempt, 1);
  const fresh = await send(staleKey);
  assert.equal(fresh.status, 'COMPLETED'); assert.equal(fresh.attempt, 2);
  paused.end(bytes);
  const oldResult = await stale;
  assert('error' in oldResult); assert.equal(oldResult.error.getResponse?.().code, 'UPLOAD_SUPERSEDED');
  assert.deepEqual((await status(staleKey)).media, fresh.media);
  assert.equal(await count(), initialCount + 3);
  const history = await admin.managedMediaUploadAttempt.findMany({ where: { uploadId: (await row(staleKey)).id }, orderBy: { attempt: 'asc' } });
  assert.deepEqual(history.map(a => [a.attempt, a.outcome]), [[1, 'SUPERSEDED'], [2, 'STORED']]);
  assert.notEqual(history[0].storedPath, history[1].storedPath);
  console.log('PASS real concurrent stale writer: expired absent attempt cannot overwrite or adopt replacement bytes; immutable attempt history retains both identities');
  const failedKey = 'ww:db:upload:failed-digest';
  await mediaService.reserveUpload(org, credential, { operationKey: failedKey, sha256: 'f'.repeat(64), byteLength: bytes.length, mimeType: 'image/png' });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await errorCode(send(failedKey), 'MEDIA_DIGEST_MISMATCH');
    const outcome = await status(failedKey);
    assert.equal(outcome.attempt, attempt);
    assert.equal(outcome.status, attempt < 3 ? 'RESERVED' : 'FAILED');
  }
  const failed = await status(failedKey);
  await errorCode(send(failedKey), 'UPLOAD_FAILED');
  assert.equal(failed.failureReason, 'MEDIA_DIGEST_MISMATCH');
  assert.equal(await count(), initialCount + 3);
  const readbackPost = await service.createDraft(org, credential, { operationKey: 'ww:db:create:reserved-media', integrationId,
    expectedBindingGeneration: bindingGeneration, intendedPublishDate: '2026-11-08T09:00:00.000Z', settings: {},
    members: [{ content: 'FAKE reserved media post', delay: 0, media: [{ mediaId: fresh.media!.mediaId, sha256 }] }] });
  const readbackCurrent = await service.getPost(org, readbackPost.managedPostId);
  const uploadFeed = await service.changes(org, 0, 500);
  assert(uploadFeed.events.some(event => event.kind === 'MEDIA_UPLOAD_FAILED'));
  console.log('PASS real terminal upload: three rejected digests fail the same reservation; no media adoption; actual DRAFT records reserved read-back evidence and feed');
  const fixturePath = process.env.POSTIZ_TEST_CONTRACT_OUTPUT;
  if (fixturePath) {
    const evidence = { fixture: 'ISOLATED_POSTGRES_LOCAL_STORAGE_REAL_SNIFFER', reserve: reservations.find(r => !r.replayed),
      complete: stored, status: current, replay, declarationReplay, recover: recovered, absent, staleReplacement: fresh, receiving, failed, readbackPost, readbackCurrent, uploadFeed,
      fixturePngBase64: bytes.toString('base64') };
    const serialized = JSON.stringify(evidence, null, 2);
    assert(!serialized.includes('storedPath') && !serialized.includes('storageKey') && !serialized.includes('FAKE-never-used'));
    writeFileSync(fixturePath.replace(/\.json$/, '.uploads.json'), serialized + '\n', { mode: 0o600 });
  }
}

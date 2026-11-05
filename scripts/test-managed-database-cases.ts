import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import { MulterStreamEngine, CapturedUploadFile } from '@gitroom/nestjs-libraries/upload/multer.stream.engine';
import { verifyReservedUploads } from './test-managed-upload-database';
import { verifyManagedObservationDatabase } from './test-managed-observation-database';
import { verifyManagedHttpDatabase } from './test-managed-http-database';
import { verifyManagedNestDatabase } from './test-managed-nest-database';
import { verifyManagedCreativeDatabase } from './test-managed-creative-database';
import { verifyManagedCreativeHttp } from './test-managed-creative-http';
import { verifyManagedConnectionDatabase } from './test-managed-connection-database';
import { assertManagedEnrollment } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { MediaRepository } from '@gitroom/nestjs-libraries/database/prisma/media/media.repository';
import { LocalStorage } from '@gitroom/nestjs-libraries/upload/local.storage';

const socket = process.env.POSTIZ_TEST_PRIVATE_SOCKET;
const url = new URL(process.env.DATABASE_URL || 'https://invalid');
assert(socket && socket.includes('/ww-postiz-db-') && socket.endsWith('/s'));
assert.equal(url.searchParams.get('host'), socket);
assert.equal(url.protocol, 'postgresql:');
const ORG = 'a1111111-1111-4111-8111-111111111111';
const OTHER = 'b2222222-2222-4222-8222-222222222222';
const credential = 'isolated-db-test';
process.env.POSTIZ_MANAGED_MODE = 'enabled';
process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
// Fixture administrator has no fence. Only used to set up synthetic rows and simulate bypass drift.
const admin = new PrismaClient();
const db = new PrismaService();
const repository = new ManagedRepository({ model: db } as any, { model: db } as any);
const mediaService = new ManagedMediaService(repository);
const service = new ManagedService(repository, mediaService);
async function code(promise: Promise<unknown>, expected: string) {
  await assert.rejects(promise, (error: any) => error.getResponse?.().code === expected, expected);
}
async function main() {
  await admin.organization.createMany({ data: [{ id: ORG, name: 'FAKE TEST-001' }, { id: OTHER, name: 'FAKE foreign' }] });
  const integration = await admin.integration.create({ data: { organizationId: ORG, internalId: 'FAKE-social-account',
    providerIdentifier: 'linkedin-page', name: 'FAKE ww.test.acc', type: 'social', token: 'FAKE-never-used', profile: 'FAKE' } });
  const [channel] = await service.listChannels(ORG);
  const qualified = await service.qualifyChannel(ORG, credential, integration.id, {
    expectedGeneration: channel.binding.generation, identityFingerprint: channel.identityFingerprint });
  await assertManagedEnrollment(db);
  if (process.env.POSTIZ_TEST_CREATIVE_ONLY === '1') {
    await verifyManagedCreativeDatabase(admin);
    await verifyManagedCreativeHttp({ admin, service, media: mediaService, repository, transaction: { model: db } as any });
    return;
  }
  if (process.env.POSTIZ_TEST_CONNECTION_ONLY === '1') {
    await verifyManagedConnectionDatabase({ admin, db, repository, service, organizationId: ORG });
    console.log('PASS targeted account connection database scenarios; no live social provider or token exchange');
    return;
  }
  const enrolledMode = process.env.POSTIZ_MANAGED_MODE, enrolledOrganizations = process.env.POSTIZ_MANAGED_ORGANIZATIONS;
  try {
    delete process.env.POSTIZ_MANAGED_MODE;
    await assert.rejects(assertManagedEnrollment(db), /durably enrolled managed organizations/);
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = OTHER;
    await assert.rejects(assertManagedEnrollment(db), /durably enrolled managed organizations/);
  } finally {
    process.env.POSTIZ_MANAGED_MODE = enrolledMode;
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = enrolledOrganizations;
  }
  console.log('PASS real durable enrollment: missing mode or incomplete allowlist refuses startup qualification against actual retained rows');
  // Actual bytes pass through the production capture stream, private local storage and relational evidence.
  // This proves local storage/capture integration, not hosted storage or an external social provider.
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL9sAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storage = new LocalStorage(process.env.UPLOAD_DIRECTORY!);
  const engine = new MulterStreamEngine(storage, true);
  const uploaded = await new Promise<CapturedUploadFile>((resolve, reject) => engine._handleFile({} as any,
    { originalname: 'fixture.png', stream: Readable.from([bytes]) } as Express.Multer.File,
    (error, file) => error ? reject(error) : resolve(file as CapturedUploadFile)));
  assert.equal(uploaded.capturedDigest!.sha256, sha256);
  const capture = await mediaService.recordCapturedUpload(ORG, credential, uploaded);
  assert.equal(capture.status, 'VERIFIED');
  const mediaId = capture.mediaId;
  const ordinaryMedia = new MediaRepository({ model: db } as any);
  await code(ordinaryMedia.saveFile(OTHER, uploaded.originalname, uploaded.path), 'MANAGED_EFFECT_REFUSED');
  assert.equal(await admin.media.count({ where: { organizationId: OTHER } }), 0);
  console.log('PASS real media ownership: another organization cannot adopt a legacy captured managed object path');
  const privateRead = await mediaService.verifyStoredMedia(ORG, credential, mediaId);
  assert.equal(privateRead.status, 'VERIFIED');
  assert.equal(privateRead.status === 'VERIFIED' ? privateRead.sha256 : null, sha256);
  console.log('PASS real local storage: production upload capture and bounded private reread have identical digest and byte count');
  const body = (key: string) => ({ operationKey: key, integrationId: integration.id,
    expectedBindingGeneration: qualified.binding.generation, intendedPublishDate: '2026-11-08T09:00:00.000Z',
    settings: {}, members: [{ content: 'FAKE reviewed caption', delay: 0, media: [{ mediaId, sha256 }] },
      { content: 'FAKE first comment', delay: 0, media: [] }] });
  const creates = await Promise.all(Array.from({ length: 6 }, () => service.createDraft(ORG, credential, body('ww:db:create:1'))));
  assert.equal(new Set(creates.map(x => x.managedPostId)).size, 1);
  assert.equal(creates.filter(x => !x.replayed).length, 1);
  assert.equal(await admin.post.count({ where: { organizationId: ORG } }), 2);
  const first = creates[0];
  const originalIds = first.post.members.map(x => x.postId);
  await code(service.createDraft(ORG, credential, { ...body('ww:db:create:1'), members: [{ content: 'Different valid content', delay: 0, media: [] }] }), 'OPERATION_KEY_PAYLOAD_MISMATCH');
  const attempts = await Promise.allSettled(['2a', '2b'].map(key => service.editDraft(ORG, credential, first.managedPostId,
    { ...body(`ww:db:edit:${key}`), expectedRevision: 1, members: body('unused').members.map((member, index) => ({ ...member, content: `${key}:${index}` })) })));
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  const rejected = attempts.find(x => x.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.getResponse().code, 'REVISION_CONFLICT');
  const current = await service.getPost(ORG, first.managedPostId);
  assert.equal(current.revision, 2);
  assert.deepEqual(current.members.map(x => x.postId), originalIds);
  assert.equal((await service.listRevisions(ORG, first.managedPostId)).length, 2);
  assert.equal(await admin.post.count({ where: { organizationId: ORG } }), 2);
  console.log('PASS real PostgreSQL: six concurrent creates are one group; competing revisions have one winner and retain same row IDs/history');

  // Fence is exercised on the actual PrismaClient, including interactive transactions.
  await code(db.post.update({ where: { id: originalIds[0] }, data: { content: 'unauthorized' } }), 'MANAGED_WRITE_REFUSED');
  await code(db.$transaction(tx => tx.post.update({ where: { id: originalIds[0] }, data: { content: 'unauthorized transaction' } })), 'MANAGED_WRITE_REFUSED');
  await code(db.integration.update({ where: { id: integration.id }, data: { profile: 'changed' } }), 'MANAGED_WRITE_REFUSED');
  await code(db.media.update({ where: { id: mediaId }, data: { path: '/FAKE/replaced' } }), 'MANAGED_WRITE_REFUSED');
  assert.equal((await admin.post.findUnique({ where: { id: originalIds[0] } }))!.state, 'DRAFT');
  console.log('PASS real Prisma middleware/AsyncLocalStorage: direct and interactive-transaction competing writes refused; managed writes succeeded');

  const initial = await service.inventory(ORG, undefined, 1);
  await Promise.all(['3', '4', '5'].map(key => service.createDraft(ORG, credential, body(`ww:db:create:${key}`))));
  const all = new Map(initial.items.map(x => [x.managedPostId, x.revision]));
  let cursor = initial.nextCursor;
  while (cursor) {
    const page = await service.inventory(ORG, cursor, 1);
    for (const item of page.items) all.set(item.managedPostId, Math.max(all.get(item.managedPostId) || 0, item.revision));
    cursor = page.nextCursor;
  }
  const changes = await service.changes(ORG, initial.snapshotSequence, 500);
  for (const event of changes.events) if (event.entityType === 'MANAGED_POST' && event.revision !== null)
    all.set(event.entityId, Math.max(all.get(event.entityId) || 0, event.revision));
  assert.equal(all.size, await admin.managedPost.count({ where: { organizationId: ORG } }));
  const feed = await service.changes(ORG, 0, 500);
  assert.deepEqual(feed.events.map(x => x.sequence), Array.from({ length: feed.headSequence }, (_, index) => index + 1));
  assert.equal((await service.inventory(OTHER)).items.length, 0);
  await assert.rejects(service.getPost(OTHER, first.managedPostId));
  console.log('PASS real PostgreSQL: inventory plus dense committed change feed covers racing creates; foreign organization has no rows');

  if (process.env.POSTIZ_TEST_CONTRACT_OUTPUT) {
    const evidence = JSON.stringify({ fixture: 'ISOLATED_POSTGRES_NO_PROVIDER', channels: await service.listChannels(ORG),
      qualification: qualified, mediaCapture: capture, mediaPrivateRead: privateRead, create: first, edit: (attempts.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<any>).value, replay: creates.find(item => item.replayed), post: current,
      revisions: await service.listRevisions(ORG, first.managedPostId), inventory: initial, changes: feed }, null, 2);
    assert(!evidence.includes('FAKE-never-used'), 'Provider token must not enter the public contract fixture');
    writeFileSync(process.env.POSTIZ_TEST_CONTRACT_OUTPUT, evidence + '\n', { mode: 0o600 });
  }

  await verifyReservedUploads({ admin, repository, mediaService, service, integrationId: integration.id, bindingGeneration: qualified.binding.generation, organizationId: ORG, otherOrganizationId: OTHER, credential, bytes, sha256 });

  const prefix = process.env.FRONTEND_URL + '/uploads/';
  assert(uploaded.path.startsWith(prefix));
  const localPath = join(process.env.UPLOAD_DIRECTORY!, uploaded.path.slice(prefix.length));
  // A second real directory behind the identical public URL is a different private storage namespace.
  const originalDirectory = process.env.UPLOAD_DIRECTORY!;
  const otherDirectory = join(dirname(originalDirectory), 'different-uploads');
  const otherFile = join(otherDirectory, uploaded.path.slice(prefix.length));
  mkdirSync(dirname(otherFile), { recursive: true });
  writeFileSync(otherFile, readFileSync(localPath));
  let movedMedia: ManagedMediaService;
  try {
    process.env.UPLOAD_DIRECTORY = otherDirectory;
    movedMedia = new ManagedMediaService(repository);
  } finally { process.env.UPLOAD_DIRECTORY = originalDirectory; }
  assert.deepEqual(await movedMedia!.verifyStoredMedia(ORG, credential, mediaId), {
    status: 'UNVERIFIED', mediaId, reason: 'STORAGE_IDENTITY_CHANGED',
  });
  const movedService = new ManagedService(repository, movedMedia!);
  await code(movedService.createDraft(ORG, credential, body('ww:db:moved-namespace')), 'MEDIA_PROOF_STALE');
  assert.equal(await admin.managedOperation.count({ where: { operationKey: 'ww:db:moved-namespace' } }), 0);
  assert.equal((await mediaService.verifyStoredMedia(ORG, credential, mediaId)).status, 'VERIFIED');
  console.log('PASS real private namespace: same URL and equal bytes in a different directory are refused; original binding remains verifiable');

  // Real rows, immutable revision snapshots and operation-key lookup across thread resize.
  const single = await service.createDraft(ORG, credential, { ...body('ww:db:resize:create'), members: [body('unused').members[0]] });
  const initialRevision = JSON.stringify((await service.listRevisions(ORG, single.managedPostId)).find(row => row.revision === 1)!.post);
  const expanded = await service.editDraft(ORG, credential, single.managedPostId, { ...body('ww:db:resize:expand'), expectedRevision: 1,
    members: [body('unused').members[0], { content: 'Retained first comment', delay: 1, media: [] }, { content: 'Later retired second comment', delay: 2, media: [] }] });
  assert.equal(expanded.post.members.length, 3);
  assert.equal(expanded.post.members[0].postId, single.post.members[0].postId);
  const reduced = await service.editDraft(ORG, credential, single.managedPostId, { ...body('ww:db:resize:reduce'), expectedRevision: 2,
    members: [body('unused').members[0], { content: 'Edited first comment', delay: 1, media: [] }] });
  assert.deepEqual(reduced.post.members.map(member => member.postId), expanded.post.members.slice(0, 2).map(member => member.postId));
  assert.equal((reduced.post as any).retiredMembers[0].postId, expanded.post.members[2].postId);
  assert.equal(await admin.post.count({ where: { group: single.post.group } }), 3, 'Retired rows must remain in the retained group');
  assert.equal(JSON.stringify((await service.listRevisions(ORG, single.managedPostId)).find(row => row.revision === 1)!.post), initialRevision);
  const historical = await service.operationStatus(ORG, 'ww:db:resize:create');
  assert.equal(historical.status, 'COMMITTED');
  assert.equal((historical as any).ack, 'HISTORICAL');
  assert.deepEqual((historical as any).post, single.post);
  const currentLookup = await service.operationStatus(ORG, 'ww:db:resize:reduce');
  assert.equal((currentLookup as any).ack, 'CURRENT');
  assert.equal((currentLookup as any).revision, 3);
  assert.equal((await service.operationStatus(ORG, 'ww:db:resize:absent')).status, 'ABSENT');
  assert.equal((await service.operationStatus(OTHER, 'ww:db:resize:create')).status, 'ABSENT');
  assert.equal((await service.getPost(ORG, single.managedPostId)).integrity.status, 'CONSISTENT');
  console.log('PASS real authoring resize: one-to-three-to-two members retain root and kept child IDs, retired rows and immutable history; read-only scoped operation lookup distinguishes historical/current/absent');

  await verifyManagedObservationDatabase({ admin, service, media: mediaService, organizationId: ORG, otherOrganizationId: OTHER, credential,
    managedPostId: single.managedPostId, revision: 3, integrationId: integration.id, generation: qualified.binding.generation, mediaId, sha256, byteLength: bytes.length });

  await verifyManagedHttpDatabase({ admin, service, media: mediaService, organizationId: ORG, credential, integrationId: integration.id, generation: qualified.binding.generation, bytes });

  await verifyManagedNestDatabase({ admin, service, media: mediaService, repository, transaction: { model: db } as any, organizationId: ORG, otherOrganizationId: OTHER, credential, integrationId: integration.id, generation: qualified.binding.generation, bytes });

  const beforeChange = readFileSync(localPath);
  writeFileSync(localPath, Buffer.concat([beforeChange, Buffer.from('changed-after-approval')]));
  const changedObservation = await service.observeCurrentMedia(ORG, single.managedPostId, 4);
  assert.equal(changedObservation.status, 'UNVERIFIED'); assert('media' in changedObservation);
  assert.equal(changedObservation.media[0].reason, 'BYTES_MISMATCH');
  await code(service.createDraft(ORG, credential, body('ww:db:changed-media')), 'MEDIA_PROOF_STALE');
  assert.equal(await admin.managedOperation.count({ where: { operationKey: 'ww:db:changed-media' } }), 0);
  console.log('PASS real local storage: bytes replaced at the same URL invalidate old evidence and prevent another post');

  await admin.integration.update({ where: { id: integration.id }, data: { internalId: 'FAKE-other-identity' } });
  await code(service.createDraft(ORG, credential, body('ww:db:drift')), 'CHANNEL_IDENTITY_CHANGED');
  const binding = await admin.managedChannelBinding.findUnique({ where: { integrationId: integration.id } });
  assert.equal(binding!.status, 'PAUSED_IDENTITY_CHANGED');
  assert.equal(await admin.managedOperation.count({ where: { operationKey: 'ww:db:drift' } }), 0);
  console.log('PASS real PostgreSQL: identity drift pause is committed without the refused post operation');
  await verifyManagedConnectionDatabase({ admin, db, repository, service, organizationId: ORG });
  console.log('No provider, Redis, email, production or external storage was used. Actual local upload/capture/read and changed-file refusal were exercised; hosted storage remains unqualified.');
}
main().finally(async () => { await db.$disconnect(); await admin.$disconnect(); }).catch(error => { console.error(error); process.exitCode = 1; });

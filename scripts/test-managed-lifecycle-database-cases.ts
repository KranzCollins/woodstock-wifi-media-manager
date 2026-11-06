import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import { ManagedLifecycleMediaStorage } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-storage';
import { ManagedLifecycleMediaRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-repository';
import { ManagedMediaCapabilityService, ManagedMediaPin } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';
import { MulterStreamEngine, CapturedUploadFile } from '@gitroom/nestjs-libraries/upload/multer.stream.engine';
import { LocalStorage } from '@gitroom/nestjs-libraries/upload/local.storage';
import { ManagedService, fingerprint, identityFingerprint } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedLifecycleService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.service';
import { ManagedLifecycleRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.repository';
import { ManagedLifecycleDispatchAuthority } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.dispatch-authority';
import { ManagedDispatchJournal } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.dispatch-journal';
import { lifecycleAffectedHashInput } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.contracts';
import { buildManagedRelease, managedReleaseMediaIds, observeManagedReleaseMedia } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.release';
import { InstagramStandalonePublishAdapter, ManagedPublishCredential } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.provider';
import { ManagedPublishTransport } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.transport';
import { verifyLifecycleHttp } from './test-managed-lifecycle-http';

// Real, disposable PostgreSQL and private local bytes. The call authority and
// budget ports below are explicit fakes: this proves capability persistence,
// concurrency and storage integration, not dispatcher or hosted acceptance.
const socket = process.env.POSTIZ_TEST_PRIVATE_SOCKET;
const url = new URL(process.env.DATABASE_URL || 'https://invalid');
assert(socket && socket.includes('/ww-postiz-lifecycle-db-') && socket.endsWith('/s'));
assert.equal(url.searchParams.get('host'), socket);
assert.equal(url.protocol, 'postgresql:');
assert(process.env.UPLOAD_DIRECTORY?.startsWith(socket.slice(0, -2)));
globalThis.fetch = async () => { throw new Error('External network is forbidden in this isolated test'); };
const ORG = 'a1111111-1111-4111-8111-111111111111';
process.env.POSTIZ_MANAGED_MODE = 'enabled';
process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
const admin = new PrismaClient();
const db = new PrismaService();
const second = new PrismaService();
const repository = new ManagedRepository({ model: db } as any, { model: db } as any);
const mediaService = new ManagedMediaService(repository);
const stored = new ManagedLifecycleMediaRepository({ model: db } as any);
const secondStore = new ManagedLifecycleMediaRepository({ model: second } as any);
const storage = new LocalStorage(process.env.UPLOAD_DIRECTORY!);
const pinnedStorage = new ManagedLifecycleMediaStorage(repository, storage);
const NOW = new Date('2026-11-06T12:00:00Z');
let at = NOW;
let active = true;
let budgetAvailable = true;
let pin: ManagedMediaPin;
const keys = { activeKeyId: 'isolated-test', keys: [{ id: 'isolated-test', secret: randomBytes(32) }] };
const policy = { grantedAt: new Date('2026-11-04T00:00:00Z'), expiresAt: new Date('2026-11-10T23:00:00Z') };
const authority = { activeCall: async (organizationId: string, callId: string) => ({
  organizationId, dispatchId: 'isolated-dispatch', callId, dispatchVersion: 1,
  active, activeUntil: new Date(NOW.getTime() + 3_600_000), media: [pin],
}) };
const service = (store = stored) => new ManagedMediaCapabilityService({
  store, storage: pinnedStorage, authority, keys,
  budget: { reserve: async () => budgetAvailable }, clock: { now: () => at },
});
const request = (callId: string, maxFetches = 3) => ({
  organizationId: ORG, dispatchId: 'isolated-dispatch', callId, dispatchVersion: 1,
  media: pin, policy, ttlMs: 600_000, maxFetches,
});
const expectCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: any) => {
    const actual = error.getResponse?.().code ?? error.code;
    assert.equal(actual, code, JSON.stringify(error.getResponse?.()));
    return true;
  }, code);

async function main() {
  await admin.organization.create({ data: { id: ORG, name: 'FAKE TEST-001 lifecycle media' } });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL9sAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const engine = new MulterStreamEngine(storage, true);
  const uploaded = await new Promise<CapturedUploadFile>((resolve, reject) => engine._handleFile({} as any,
    { originalname: 'synthetic.png', stream: Readable.from([bytes]) } as Express.Multer.File,
    (error, file) => error ? reject(error) : resolve(file as CapturedUploadFile)));
  const capture = await mediaService.recordCapturedUpload(ORG, 'isolated-lifecycle', uploaded);
  assert.equal(capture.status, 'VERIFIED');
  const evidence = await pinnedStorage.pinnedEvidence(ORG, capture.mediaId);
  assert(evidence && evidence.mimeType === 'image/png');
  pin = { mediaId: evidence.mediaId, evidenceId: evidence.evidenceId, sha256, byteLength: bytes.length, mimeType: 'image/png' };
  assert.equal(await pinnedStorage.pinnedEvidence('foreign-organization', capture.mediaId), null);
  const primary = service();
  const grant = await primary.mint(request('read-and-race'));
  const token = grant.token();
  const record = await admin.managedMediaCapability.findFirstOrThrow();
  assert.equal(record.sha256, sha256);
  assert(!JSON.stringify(record).includes(token));
  assert(!JSON.stringify(grant).includes(token));
  await expectCode(primary.mint(request('read-and-race')), 'ALREADY_MINTED');
  const first = await primary.fetch({ token });
  assert(first.body.equals(bytes));
  assert.equal(first.headers['content-type'], 'image/png');
  assert.equal(first.headers['cache-control'], 'private, no-store');
  console.log('PASS actual PNG sniffer, upload capture, retained evidence, private local storage and PostgreSQL capability; no token in record or grant JSON');

  const restarted = service(secondStore);
  const races = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? primary : restarted).fetch({ token, range: 'bytes=0-7' })));
  const succeeded = races.filter(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>[];
  assert.equal(succeeded.length, 2, 'Two remaining quota units across two independent Prisma clients');
  succeeded.forEach(result => assert(result.value.body.equals(bytes.subarray(0, 8))));
  assert.equal((await stored.get(record.capabilityIdSha256))!.fetchCount, 3);
  await expectCode(restarted.fetch({ token }), 'CAPABILITY_EXHAUSTED');
  assert.equal(await restarted.revokeCall(ORG, 'read-and-race', 'CALL_SETTLED'), 1);
  assert.equal(await restarted.revokeCall(ORG, 'read-and-race', 'CALL_SETTLED'), 0);
  assert.equal(await admin.managedMediaCapability.count(), 1);
  await expectCode(primary.fetch({ token }), 'CAPABILITY_REVOKED');
  console.log('PASS PostgreSQL compare-and-set quota across independent clients, restart persistence and retained idempotent revocation');

  // Actual retained draft -> release builder -> actual upstream request
  // construction -> isolated scripted provider. Only admission authority,
  // budget and provider answers are fakes; private PNG bytes are real.
  const drafts = new ManagedService(repository, mediaService);
  const integration = await admin.integration.create({ data: { organizationId: ORG,
    internalId: '17841400000000001', providerIdentifier: 'instagram-standalone',
    name: 'FAKE ww.test.acc', type: 'social', token: 'FAKE-not-used-from-database', profile: 'ww.test_account' } });
  const [channel] = await drafts.listChannels(ORG);
  const binding = await drafts.qualifyChannel(ORG, 'isolated-lifecycle', integration.id, {
    expectedGeneration: channel.binding.generation, identityFingerprint: channel.identityFingerprint,
  });
  const plain = 'Literal &amp; <b> NBSP\u00a0 emoji 👩‍💻 & + %';
  const encoded = plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
  const draft = await drafts.createDraft(ORG, 'isolated-lifecycle', {
    operationKey: 'ww:lifecycle:real-media-draft', integrationId: integration.id,
    expectedBindingGeneration: binding.binding.generation, intendedPublishDate: '2026-11-08T09:00:00.000Z',
    settings: { post_type: 'post' }, members: [{ content: encoded, delay: 0, media: [{ mediaId: pin.mediaId, sha256: pin.sha256 }] }],
  });
  const historicalRevision = await admin.managedPostRevision.findFirstOrThrow({ where: { managedPostId: draft.managedPostId } });
  const ids = await repository.read(ORG, reader => managedReleaseMediaIds(reader, draft.managedPostId, 1));
  const observedMedia = await observeManagedReleaseMedia(pinnedStorage, ORG, ids);
  const adapter = new InstagramStandalonePublishAdapter({ mediaOrigin: 'https://media.ww.test' });
  const facts = { identifier: adapter.identifier, editor: adapter.editor, requiresMedia: adapter.requiresMedia,
    maxStepUnits: adapter.maxStepUnits, maxStepDeadlineMs: adapter.maxStepDeadlineMs };
  const requestRelease = { managedPostId: draft.managedPostId, expectedRevision: 1, codec: 'ww-plain-escape-v1' as const,
    provider: facts, mediaDeliveryReady: true, observedMedia };
  const built = await repository.read(ORG, reader => buildManagedRelease(reader, requestRelease));
  assert.equal(built.preview.members[0].text, plain);
  assert.equal(built.preview.settingsHash, fingerprint({ post_type: 'post' }));
  assert.equal(built.preview.identityFingerprint, identityFingerprint(integration as any));
  assert.equal(built.preview.members[0].media[0].sha256, sha256);
  const prepared = adapter.prepare({ internalId: built.release.internalId, profile: built.release.profile!,
    settings: { ...built.release.settings }, members: built.release.members.map(member => ({
      postId: member.postId, text: member.text, media: [...member.media],
    })) });
  const cap = await primary.mint(request('adapter-post'));
  const mediaUrl = `https://media.ww.test/managed-media/${cap.token()}.png`;
  const calls: string[] = [];
  const fakeProvider = (async (input: string | URL | Request, init: RequestInit) => {
    const url = new URL(String(input)); const method = init.method ?? 'GET';
    calls.push(method + ' ' + url.pathname);
    if (method === 'POST' && url.pathname.endsWith('/media')) {
      assert.equal(url.searchParams.get('caption'), plain);
      assert.equal(url.searchParams.get('image_url'), mediaUrl);
      const fetched = await primary.fetch({ token: cap.token() });
      assert(fetched.body.equals(bytes));
      return new Response(JSON.stringify({ id: '17900000000000011' }));
    }
    if (method === 'GET' && url.searchParams.get('fields')?.includes('status_code')) {
      return new Response(JSON.stringify({ status_code: 'FINISHED', status: 'FINISHED' }));
    }
    if (method === 'POST' && url.pathname.endsWith('/media_publish')) {
      assert.equal(url.searchParams.get('creation_id'), '17900000000000011');
      return new Response(JSON.stringify({ id: '17950000000000031' }));
    }
    if (method === 'GET' && url.searchParams.get('fields') === 'permalink') {
      return new Response(JSON.stringify({ permalink: 'https://www.instagram.com/p/DFakePost01/' }));
    }
    throw new Error('Unexpected isolated provider request');
  }) as typeof fetch;
  const step = (units: number) => {
    const transport = new ManagedPublishTransport({ reservedUnits: units, deadlineAt: new Date(Date.now() + 60_000),
      now: () => new Date(), verifyAdmission: async () => true, recordAttempt: async () => true, fetch: fakeProvider });
    return { credential: new ManagedPublishCredential('FAKE-only-isolated-token'), fetch: transport.adapterFetch(), ledger: () => transport.ledger() };
  };
  const submitted = await adapter.postPending(prepared, { ...step(adapter.stepUnits(prepared, 'POST')), media: { url: async () => mediaUrl } });
  assert.equal(submitted.status, 'pending');
  if (submitted.status !== 'pending') throw new Error('Expected pending fixture');
  const ready = await adapter.poll(prepared, submitted.continuation.sealed(), step(adapter.stepUnits(prepared, 'POLL', submitted.continuation.sealed())));
  assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') throw new Error('Expected ready fixture');
  const published = await adapter.finalize(prepared, ready.continuation.sealed(), step(adapter.stepUnits(prepared, 'FINALIZE', ready.continuation.sealed())));
  assert.equal(published.status, 'success');
  assert.equal(calls.length, 4);
  assert.equal(await primary.revokeCall(ORG, 'adapter-post', 'CALL_SETTLED'), 1);
  assert.deepEqual(await admin.managedPostRevision.findFirstOrThrow({ where: { managedPostId: draft.managedPostId } }), historicalRevision);
  // No lifecycle service or dispatcher ran: actual stored post remains DRAFT.
  assert.equal((await admin.post.findFirstOrThrow({ where: { id: draft.post.members[0].postId } })).state, 'DRAFT');
  console.log('PASS actual retained PostgreSQL draft and private PNG -> strict release builder -> real InstagramStandalone request construction -> fake pending/poll/finalize; exact literal text and bytes, original revision/DRAFT unchanged');

  // Real owned acceptance and projection on PostgreSQL. Configuration here
  // is deliberately synthetic: no runtime dispatcher or external IO runs.
  const lifecycleRepository = new ManagedLifecycleRepository({ model: db } as any);
  let lifecycleEnabled = true;
  const configuration = {
    gates: async () => ({ organizationEnabled: lifecycleEnabled, dispatcherAvailable: true,
      mediaDeliveryReady: true, policy, providers: ['instagram-standalone'] }),
  };
  const adapters = new Map([[adapter.identifier, adapter]]);
  const lifecycle = new ManagedLifecycleService(lifecycleRepository, pinnedStorage, configuration,
    { now: () => at }, adapters);
  const principal = { organizationId: ORG, credentialId: 'isolated-lifecycle',
    scopes: ['posts:read', 'posts:schedule', 'posts:publish'] };
  const body = { version: 'ww.managed-lifecycle.v1', operationKey: 'ww:lifecycle:real-schedule',
    expectedRevision: 1, expectedBindingGeneration: binding.binding.generation, expectedScheduleGeneration: 0,
    releaseHash: built.preview.releaseHash, contentSha256: '7'.repeat(64),
    codec: 'ww-plain-escape-v1', maxLatenessMs: 600000,
    publishAt: '2026-11-08T09:00:00.000Z', repeat: null };
  const oldSequence = (await admin.managedOrganization.findUniqueOrThrow({ where: { organizationId: ORG } })).sequence;
  const preview = await lifecycle.releasePreview(principal, draft.managedPostId, { revision: 1, codec: body.codec });
  assert.equal(preview.releaseHash, built.preview.releaseHash);
  lifecycleEnabled = false;
  await expectCode(lifecycle.schedule(principal, draft.managedPostId, body), 'LIFECYCLE_NOT_ENABLED');
  assert.equal(await admin.managedSchedule.count({ where: { organizationId: ORG } }), 0);
  lifecycleEnabled = true;
  await expectCode(lifecycle.schedule(principal, draft.managedPostId,
    { ...body, releaseHash: 'sha256:' + '9'.repeat(64) }), 'RELEASE_HASH_MISMATCH');
  const accepted = await lifecycle.schedule(principal, draft.managedPostId, body);
  assert.equal(accepted.lifecycle, 'SCHEDULED');
  assert.equal(accepted.scheduleGeneration, 1);
  assert.equal(accepted.dispatches[0].status, 'PENDING');
  assert.equal(accepted.schedule.mode, 'AT');
  assert.equal((await admin.post.findUniqueOrThrow({ where: { id: draft.post.members[0].postId } })).state, 'QUEUE');
  lifecycleEnabled = false;
  const replay = await lifecycle.schedule(principal, draft.managedPostId, body);
  assert.deepEqual(replay, { ...accepted, replayed: true });
  lifecycleEnabled = true;
  assert.equal((await lifecycle.operation(principal, body.operationKey)).result.sequence, accepted.sequence);
  const feed = await lifecycle.events(principal, 0);
  assert.equal(feed.events.length, 1);
  assert.equal(feed.events[0].kind, 'POST_SCHEDULED');
  assert.equal((await lifecycle.lifecycle(principal, draft.managedPostId)).lifecycle, 'SCHEDULED');
  assert.equal((await lifecycle.dispatch(principal, accepted.dispatches[0].dispatchId)).status, 'PENDING');
  const { publishAt: _publishAt, repeat: _repeat, ...nowBody } = body;
  await expectCode(lifecycle.publishNow(principal, draft.managedPostId, nowBody), 'OPERATION_KEY_KIND_MISMATCH');
  assert.equal(await admin.managedSchedule.count({ where: { organizationId: ORG } }), 1);
  assert.equal(await admin.managedDispatchCall.count({ where: { organizationId: ORG } }), 0);
  assert.equal((await admin.managedOrganization.findUniqueOrThrow({ where: { organizationId: ORG } })).sequence, oldSequence);
  assert.deepEqual(await admin.managedPostRevision.findFirstOrThrow({ where: { managedPostId: draft.managedPostId } }), historicalRevision);
  console.log('PASS actual PostgreSQL lifecycle acceptance, atomic shared key/replay, closed gates/hash mismatch, typed read/feed/operation projections, QUEUE fingerprint and byte-identical immutable revision/legacy cursor; no provider call');

  // The actual policy/release validator and event projection now guard the
  // real journal; only operator configuration, clock and budget are fixtures.
  at = new Date(body.publishAt);
  const realAuthority = new ManagedLifecycleDispatchAuthority(lifecycleRepository, pinnedStorage, configuration, adapters, () => at);
  const actualObservation = await realAuthority.observe(ORG, accepted.dispatches[0].dispatchId);
  const journal = new ManagedDispatchJournal({ repository: lifecycleRepository,
    budget: { reserveDetailed: async () => ({ accepted: true, retryAfterMs: 0 }) } as any, now: () => at,
    validate: (store, dispatch, admission, deadline) => realAuthority.validate(store, dispatch, admission, deadline, actualObservation),
    event: lifecycle.recordDispatchEvent.bind(lifecycle) });
  const admission = { dispatchId: accepted.dispatches[0].dispatchId, expectedVersion: 1,
    member: 0, step: 'POST' as const, stage: 0 as const, attempt: 1 as const,
    reservedUnits: adapter.stepUnits(prepared, 'POST'), deadlineMs: adapter.steps.POST.deadlineMs,
    requestHash: prepared.requestHash };
  assert.equal((await journal.admit(ORG, { ...admission, requestHash: 'sha256:' + '0'.repeat(64) })).status, 'STATE_REFUSED');
  assert.equal((await journal.admit(ORG, { ...admission, reservedUnits: admission.reservedUnits + 1 })).status, 'STATE_REFUSED');
  const admitted = await journal.admit(ORG, admission);
  assert.equal(admitted.status, 'ADMITTED');
  if (admitted.status !== 'ADMITTED') throw new Error('The real dispatch authority refused its retained approved release');
  assert.equal(await journal.verifyAdmission(admitted.handle, new Date(admitted.handle.deadlineAt)), true);
  assert.equal((await lifecycle.lifecycle(principal, draft.managedPostId)).lifecycle, 'DISPATCHING');
  const actualMediaService = new ManagedMediaCapabilityService({ store: stored, storage: pinnedStorage,
    authority: realAuthority, keys, budget: { reserve: async () => true }, clock: { now: () => at } });
  const actualGrant = await actualMediaService.mint({ organizationId: ORG, dispatchId: admission.dispatchId,
    callId: admitted.handle.callId, dispatchVersion: admitted.handle.dispatchVersion, media: pin, policy, ttlMs: 600000, maxFetches: 4 });
  assert((await actualMediaService.fetch({ token: actualGrant.token() })).body.equals(bytes));
  await verifyLifecycleHttp({ organizationId: ORG, credentialId: principal.credentialId,
    managedPostId: draft.managedPostId, dispatchId: admission.dispatchId, operationKey: body.operationKey,
    service: lifecycle, media: actualMediaService, capabilityToken: actualGrant.token(), bytes });
  lifecycleEnabled = false;
  assert.equal(await journal.verifyAdmission(admitted.handle, new Date(admitted.handle.deadlineAt)), false);
  await expectCode(actualMediaService.fetch({ token: actualGrant.token() }), 'CALL_INACTIVE');
  lifecycleEnabled = true;
  at = new Date(admitted.handle.deadlineAt + 30_001);
  assert.equal(await journal.recoverExpired(ORG, admission.dispatchId), true);
  assert.equal((await lifecycle.dispatch(principal, admission.dispatchId)).status, 'UNKNOWN');
  assert.equal((await lifecycle.lifecycle(principal, draft.managedPostId)).lifecycle, 'REVIEW');
  assert.deepEqual(await admin.managedPostRevision.findFirstOrThrow({ where: { managedPostId: draft.managedPostId } }), historicalRevision);
  console.log('PASS actual DB release/policy/byte authority -> durable journal -> validated feed, actual capability fetch, revoked gate and expired UNKNOWN/REVIEW; no provider request');

  const unknown = await lifecycle.dispatch(principal, admission.dispatchId);
  const resolved = await lifecycle.resolve(principal, admission.dispatchId, {
    version: body.version, operationKey: 'ww:lifecycle:real-resolve', expectedDispatchVersion: unknown.dispatchVersion,
    expectedStatus: 'UNKNOWN', expectedScheduleGeneration: 1, resolution: 'RESOLVED_NOT_PUBLISHED',
    evidence: { source: 'HUMAN_OBSERVATION', observedAt: at.toISOString(), note: 'Isolated human-evidence fixture; no provider call occurred.' },
    members: unknown.members.map(member => ({ position: member.position, postId: member.postId, expectedStatus: member.status,
      outcome: member.status === 'UNKNOWN' ? 'NOT_PUBLISHED' : null, releaseId: null, releaseURL: null })),
  });
  assert.equal(resolved.lifecycle, 'FAILED');
  assert.equal((await admin.managedDispatchCall.findUniqueOrThrow({ where: { id: admitted.handle.callId } })).status, 'UNKNOWN');
  const nowAccepted = await lifecycle.publishNow(principal, draft.managedPostId,
    { ...nowBody, operationKey: 'ww:lifecycle:real-publish-now', expectedScheduleGeneration: 1 });
  assert.equal(nowAccepted.schedule.mode, 'NOW');
  assert.equal(nowAccepted.dispatches[0].status, 'PENDING');
  const scope = { scheduleId: nowAccepted.schedule.scheduleId, expectedScheduleVersion: nowAccepted.schedule.scheduleVersion,
    affected: [{ state: 'PENDING' as const, occurrence: 0, dueAt: nowAccepted.dispatches[0].dueAt,
      dispatchId: nowAccepted.dispatches[0].dispatchId, expectedDispatchVersion: nowAccepted.dispatches[0].dispatchVersion }], inFlight: null };
  const { inFlight: _inFlight, ...cancelScope } = scope;
  const cancelled = await lifecycle.cancel(principal, draft.managedPostId, {
    version: body.version, operationKey: 'ww:lifecycle:real-cancel', expectedRevision: 1, expectedScheduleGeneration: 2,
    scope: 'SERIES', ...cancelScope, affectedHash: fingerprint(lifecycleAffectedHashInput('SERIES', scope)),
  });
  assert.equal(cancelled.lifecycle, 'DRAFT');
  assert.equal(cancelled.schedule.status, 'CANCELLED');
  const removed = await lifecycle.delete(principal, draft.managedPostId, {
    version: body.version, operationKey: 'ww:lifecycle:real-delete', expectedRevision: 1, expectedScheduleGeneration: 2,
    expectedLifecycle: 'DRAFT', effect: 'RETAINED_SOFT_DELETE', cancels: null,
  });
  assert.equal(removed.lifecycle, 'DELETED');
  assert((await admin.post.findUniqueOrThrow({ where: { id: draft.post.members[0].postId } })).deletedAt);
  assert.deepEqual(await admin.managedPostRevision.findFirstOrThrow({ where: { managedPostId: draft.managedPostId } }), historicalRevision);
  assert.equal(await admin.managedDispatchCall.count({ where: { organizationId: ORG } }), 1, 'NOW acceptance never invoked a provider');
  assert.equal((await lifecycle.lifecycle(principal, draft.managedPostId)).lifecycle, 'DELETED');
  console.log('PASS actual PostgreSQL human-fixture resolution -> separate NOW acceptance -> exact-scope cancellation -> retained soft deletion; all immutable revisions/calls retained, zero provider IO');
  at = NOW;

  const expired = await primary.mint({ ...request('expires'), ttlMs: 1000 });
  at = new Date(NOW.getTime() + 1000);
  await expectCode(primary.fetch({ token: expired.token() }), 'CAPABILITY_EXPIRED');
  at = NOW;
  const inactive = await primary.mint(request('inactive'));
  active = false;
  await expectCode(primary.fetch({ token: inactive.token() }), 'CALL_INACTIVE');
  active = true;
  await expectCode(primary.fetch({ token: inactive.token() }), 'CAPABILITY_REVOKED');
  const noBudget = await primary.mint(request('budget'));
  budgetAvailable = false;
  await expectCode(primary.fetch({ token: noBudget.token() }), 'BUDGET_EXHAUSTED');
  budgetAvailable = true;
  const changed = await primary.mint(request('changed-bytes'));
  appendFileSync(join(process.env.UPLOAD_DIRECTORY!, evidence.storageKey), Buffer.from('changed'));
  await expectCode(primary.fetch({ token: changed.token(), range: 'bytes=0-7' }), 'MEDIA_CHANGED');
  assert.equal(await admin.managedMediaCapability.count(), 7);
  console.log('PASS exclusive expiry, inactive-call revocation, refused budget and changed bytes outside a requested range; retained records preserved');
  console.log('NOT QUALIFIED: full dispatcher/polling/runtime HTTP/TLS, live provider or real publication; clock/configuration/budget are isolated fixtures');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.all([admin.$disconnect(), db.$disconnect(), second.$disconnect()]);
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import { fetch as loopbackFetch } from 'undici';
import { PrismaClient } from '@prisma/client';

// The full production module is imported only after the fixture environment
// is installed. Only time and the provider network boundary are substituted.
const ORG = 'b1111111-1111-4111-8111-111111111111';
const socket = process.env.POSTIZ_TEST_PRIVATE_SOCKET;
assert(socket?.includes('/ww-postiz-lifecycle-db-') && socket.endsWith('/s'));
assert.equal(new URL(process.env.DATABASE_URL!).searchParams.get('host'), socket);
assert(/^redis:\/\/127\.0\.0\.1:\d+$/.test(process.env.REDIS_URL!));
assert(process.env.POSTIZ_TEST_RUNTIME_RESOURCE?.startsWith('ww-lifecycle-runtime-'));
const token = 'synthetic-production-module-only-no-live-credential';
Object.assign(process.env, {
  POSTIZ_MANAGED_MODE: 'enabled', POSTIZ_MANAGED_ORGANIZATIONS: `${ORG},retained-fixture`,
  POSTIZ_MANAGED_CREDENTIALS: JSON.stringify([{ id: 'runtime-proof', organizationId: ORG,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
    scopes: ['posts:read', 'posts:write', 'media:write', 'channels:read', 'channels:qualify', 'posts:schedule', 'posts:publish'] }]),
  POSTIZ_MANAGED_LIFECYCLE_ORGANIZATIONS: ORG, POSTIZ_MANAGED_LIFECYCLE_PROVIDERS: 'instagram-standalone',
  POSTIZ_MANAGED_LIFECYCLE_GRANTED_AT: '2026-11-04T00:00:00.000Z', POSTIZ_MANAGED_LIFECYCLE_EXPIRES_AT: '2026-11-10T23:00:00.000Z',
  POSTIZ_MANAGED_DISPATCHER: 'enabled', POSTIZ_MANAGED_MEDIA_PUBLIC_ORIGIN: 'https://media.ww.test',
  POSTIZ_MANAGED_MEDIA_CAPABILITY_KEYS: JSON.stringify({ activeKeyId: 'fixture', keys: [{ id: 'fixture', secretHex: randomBytes(32).toString('hex') }] }),
});
globalThis.fetch = async () => { throw new Error('External network forbidden'); };
let at = new Date('2026-11-06T12:00:00.000Z');
let base = '';
let providerCalls: string[] = [], mediaPaths: string[] = [];
let processing = true;
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL9sAAAAASUVORK5CYII=', 'base64');
const plain = 'Runtime exact &amp; <b> NBSP\u00a0 emoji 👩‍💻 & + %';
const fakeFetch = (async (input: string | URL | Request, init: RequestInit) => {
  const url = new URL(String(input)); const method = init.method ?? 'GET';
  assert.equal(url.origin, 'https://graph.instagram.com');
  providerCalls.push(method + ' ' + url.pathname);
  if (method === 'POST' && url.pathname.endsWith('/media')) {
    assert.equal(url.searchParams.get('caption'), plain);
    const mediaUrl = new URL(url.searchParams.get('image_url')!);
    assert.equal(mediaUrl.origin, 'https://media.ww.test'); mediaPaths.push(mediaUrl.pathname);
    const response = await loopbackFetch(base + mediaUrl.pathname);
    assert.equal(response.status, 200); assert(Buffer.from(await response.arrayBuffer()).equals(bytes));
    return new Response(JSON.stringify({ id: '17900000000000011' }));
  }
  if (method === 'GET' && url.searchParams.get('fields')?.includes('status_code'))
    return new Response(JSON.stringify({ status_code: processing ? 'IN_PROGRESS' : 'FINISHED', status: processing ? 'IN_PROGRESS' : 'FINISHED' }));
  if (method === 'POST' && url.pathname.endsWith('/media_publish')) {
    assert.equal(url.searchParams.get('creation_id'), '17900000000000011');
    return new Response(JSON.stringify({ id: '17950000000000031' }));
  }
  if (method === 'GET' && url.searchParams.get('fields') === 'permalink')
    return new Response(JSON.stringify({ permalink: 'https://www.instagram.com/p/DFakePost01/' }));
  throw new Error('Unexpected fake provider request');
}) as typeof fetch;

async function main() {
  const { ManagedRuntimeModule } = await import('../apps/backend/src/managed-runtime/managed-runtime.module');
  const { MANAGED_LIFECYCLE_CLOCK, MANAGED_LIFECYCLE_FETCH, MANAGED_LIFECYCLE_BUDGET } = await import('../apps/backend/src/managed-runtime/managed-lifecycle.providers');
  const { ManagedLifecycleEnvironmentConfiguration } = await import('../libraries/nestjs-libraries/src/database/prisma/managed/managed.lifecycle.configuration');
  const { ManagedLifecycleDispatcher } = await import('../libraries/nestjs-libraries/src/database/prisma/managed/managed.lifecycle.dispatcher');
  const { ManagedLifecycleMediaStorage } = await import('../libraries/nestjs-libraries/src/database/prisma/managed/managed.lifecycle.media-storage');
  const { ManagedService } = await import('../libraries/nestjs-libraries/src/database/prisma/managed/managed.service');
  const { ManagedMediaService } = await import('../libraries/nestjs-libraries/src/database/prisma/managed/managed.media.service');
  const { MulterStreamEngine } = await import('../libraries/nestjs-libraries/src/upload/multer.stream.engine');
  const { LocalStorage } = await import('../libraries/nestjs-libraries/src/upload/local.storage');
  const { ioRedis } = await import('../libraries/nestjs-libraries/src/redis/redis.service');
  const { managedStorageNamespace, acquireManagedRuntimeLease, releaseManagedRuntimeLease,
    refreshManagedRuntimeLease, MANAGED_STORAGE_MARKER } = await import('../apps/backend/src/managed-runtime/managed-runtime.config');
  const directory = process.env.UPLOAD_DIRECTORY!;
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  writeFileSync(directory + '/' + MANAGED_STORAGE_MARKER, 'isolated fixture');
  const state = { instanceId: process.env.POSTIZ_TEST_RUNTIME_RESOURCE!, storageNamespace: await managedStorageNamespace(directory) };
  const admin = new PrismaClient();
  let app: any;
  const start = async () => {
    assert(await acquireManagedRuntimeLease(ioRedis, state.instanceId));
    const module = await Test.createTestingModule({ imports: [ManagedRuntimeModule.register(state)] })
      .overrideProvider(MANAGED_LIFECYCLE_CLOCK).useValue(() => at)
      .overrideProvider(MANAGED_LIFECYCLE_FETCH).useValue(fakeFetch).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address(); assert(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
    app.get(ManagedLifecycleEnvironmentConfiguration).setRuntimePresenceUntil(new Date(at.getTime() + 30000));
  };
  const stop = async () => {
    if (!app) return;
    app.get(ManagedLifecycleEnvironmentConfiguration).setRuntimePresenceUntil(null);
    app.getHttpServer().closeAllConnections?.(); await app.close(); app = null;
    await releaseManagedRuntimeLease(ioRedis, state.instanceId);
  };
  const http = async (path: string, body?: unknown, authenticated = true) => {
    const response = await loopbackFetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(authenticated ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); return { status: response.status, value: value as any };
  };
  const cycle = async () => {
    assert(await refreshManagedRuntimeLease(ioRedis, state.instanceId));
    app.get(ManagedLifecycleEnvironmentConfiguration).setRuntimePresenceUntil(new Date(at.getTime() + 30000));
    await app.get(ManagedLifecycleDispatcher).runOnce();
  };
  try {
    await admin.organization.create({ data: { id: ORG, name: 'FAKE TEST-001 production runtime' } });
    await start();
    assert.equal((await http('/managed-runtime/ready', undefined, false)).status, 200);
    assert.equal((await http('/managed/v1/lifecycle/capabilities', undefined, false)).status, 401);
    const drafts = app.get(ManagedService), media = app.get(ManagedMediaService);
    const integration = await admin.integration.create({ data: { organizationId: ORG, internalId: '17841400000000001',
      providerIdentifier: 'instagram-standalone', name: 'FAKE ww.test.acc', type: 'social', token: 'FAKE-only-loopback', profile: 'ww.test_account' } });
    const [channel] = await drafts.listChannels(ORG);
    const binding = await drafts.qualifyChannel(ORG, 'runtime-proof', integration.id,
      { expectedGeneration: channel.binding.generation, identityFingerprint: channel.identityFingerprint });
    const engine = new MulterStreamEngine(new LocalStorage(directory), true);
    const uploaded = await new Promise<any>((resolve, reject) => engine._handleFile({} as any,
      { originalname: 'runtime.png', stream: Readable.from([bytes]) } as Express.Multer.File,
      (error, value) => error ? reject(error) : resolve(value)));
    const captured = await media.recordCapturedUpload(ORG, 'runtime-proof', uploaded);
    const pinned = await app.get(ManagedLifecycleMediaStorage).pinnedEvidence(ORG, captured.mediaId); assert(pinned);
    const content = plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
    const draft = await drafts.createDraft(ORG, 'runtime-proof', { operationKey: 'ww:runtime:retained-draft', integrationId: integration.id,
      expectedBindingGeneration: binding.binding.generation, intendedPublishDate: at.toISOString(), settings: { post_type: 'post' },
      members: [{ content, delay: 0, media: [{ mediaId: pinned.mediaId, sha256: pinned.sha256 }] }] });
    const revision = await admin.managedPostRevision.findFirstOrThrow({ where: { managedPostId: draft.managedPostId } });
    const preview = await http(`/managed/v1/lifecycle/release-preview/${draft.managedPostId}?revision=1&codec=ww-plain-escape-v1`);
    assert.equal(preview.status, 200, JSON.stringify(preview)); assert.equal(preview.value.members[0].text, plain);
    const body = { version: 'ww.managed-lifecycle.v1', operationKey: 'ww:runtime:publish-now', expectedRevision: 1,
      expectedBindingGeneration: binding.binding.generation, expectedScheduleGeneration: 0,
      releaseHash: preview.value.releaseHash, contentSha256: '7'.repeat(64), codec: 'ww-plain-escape-v1', maxLatenessMs: 600000 };
    const accepted = await http(`/managed/v1/posts/${draft.managedPostId}/publish-now`, body);
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    const dispatchId = accepted.value.dispatches[0].dispatchId ?? accepted.value.dispatches[0].id;
    assert(dispatchId, JSON.stringify(accepted));
    app.get(ManagedLifecycleEnvironmentConfiguration).setRuntimePresenceUntil(null);
    await app.get(ManagedLifecycleDispatcher).runOnce();
    assert.equal(providerCalls.length, 0);
    assert.equal((await admin.managedDispatch.findUniqueOrThrow({ where: { id: dispatchId } })).status, 'PENDING');
    await cycle();
    let row = await admin.managedDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
    assert.equal(row.status, 'ADMITTED', JSON.stringify(row));
    const pendingCall = await admin.managedDispatchCall.findUniqueOrThrow({ where: { id: row.activeCallId! } });
    assert.equal(pendingCall.status, 'PENDING_PROVIDER', JSON.stringify(pendingCall)); assert.equal(providerCalls.length, 1);
    await stop(); await start(); // Actual module/service instances replaced; no in-memory queue survives.
    at = new Date(row.nextActionAt!); await cycle();
    row = await admin.managedDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
    assert.equal(row.status, 'ADMITTED'); assert.equal(providerCalls.length, 2);
    at = new Date(row.nextActionAt!); processing = false; await cycle();
    row = await admin.managedDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
    assert.equal(row.nextStep, 'FINALIZE', JSON.stringify(row));
    await stop(); await start(); await cycle();
    row = await admin.managedDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
    assert.equal(row.status, 'PUBLISHED', JSON.stringify(row));
    assert.equal(providerCalls.length, 5); assert.equal(providerCalls.filter(call => call.includes('/media_publish')).length, 1);
    const view = await http(`/managed/v1/posts/${draft.managedPostId}/lifecycle`);
    assert.equal(view.status, 200); assert.equal(view.value.lifecycle, 'PUBLISHED', JSON.stringify(view));
    assert.equal((await http(`/managed/v1/dispatches/${dispatchId}`)).value.status, 'PUBLISHED');
    assert.equal((await loopbackFetch(base + mediaPaths[0])).status, 410);
    assert.deepEqual(await admin.managedPostRevision.findFirstOrThrow({ where: { managedPostId: draft.managedPostId } }), revision);
    const before = providerCalls.length; await stop(); await start(); await cycle();
    assert.equal(providerCalls.length, before, 'Published dispatch never sends again after restart');
    assert.equal((await http('/managed/v1/lifecycle/events?after=0')).status, 200);
    // A delayed next member must stop once its original ready time is too old.
    // The already-published root remains visible; neither a retry nor a new
    // budget reservation is allowed for the overdue comment.
    const makeNext = async (key: string, comment: boolean) => {
      const service = app.get(ManagedService);
      const next = await service.createDraft(ORG, 'runtime-proof', { operationKey: key, integrationId: integration.id,
        expectedBindingGeneration: binding.binding.generation, intendedPublishDate: at.toISOString(), settings: { post_type: 'post' },
        members: [{ content, delay: 0, media: [{ mediaId: pinned.mediaId, sha256: pinned.sha256 }] },
          ...(comment ? [{ content: 'Only in an isolated fake fixture', delay: 1, media: [] }] : [])] });
      const release = await http(`/managed/v1/lifecycle/release-preview/${next.managedPostId}?revision=1&codec=ww-plain-escape-v1`);
      assert.equal(release.status, 200, JSON.stringify(release));
      const accepted = await http(`/managed/v1/posts/${next.managedPostId}/publish-now`,
        { ...body, operationKey: key + ':publish', releaseHash: release.value.releaseHash });
      assert.equal(accepted.status, 200, JSON.stringify(accepted));
      return accepted.value.dispatches[0].dispatchId as string;
    };
    const partialId = await makeNext('ww:runtime:late-comment', true);
    await cycle();
    let partial = await admin.managedDispatch.findUniqueOrThrow({ where: { id: partialId } });
    at = new Date(partial.nextActionAt!); await cycle(); await cycle();
    partial = await admin.managedDispatch.findUniqueOrThrow({ where: { id: partialId } });
    assert.equal(partial.nextStep, 'COMMENT', JSON.stringify(partial));
    const countBeforeLate = providerCalls.length;
    at = new Date(partial.nextActionAt!.getTime() + body.maxLatenessMs + 1); await cycle();
    partial = await admin.managedDispatch.findUniqueOrThrow({ where: { id: partialId } });
    assert.equal(partial.status, 'PARTIAL', JSON.stringify(partial));
    assert.equal(partial.code, 'LATE_BEYOND_TOLERANCE'); assert.equal(providerCalls.length, countBeforeLate);
    assert.equal(JSON.parse(partial.members)[0].status, 'PUBLISHED');
    const exhaustedId = await makeNext('ww:runtime:exhausted-budget', false);
    const budget = app.get(MANAGED_LIFECYCLE_BUDGET);
    assert.equal(await budget.reserve(ORG, 200), false); // Shared HTTP/provider counter is already nonempty.
    await cycle();
    const deferred = await admin.managedDispatch.findUniqueOrThrow({ where: { id: exhaustedId } });
    assert.equal(deferred.status, 'PENDING'); assert.equal(deferred.deferralCode, 'BUDGET_EXHAUSTED');
    assert.equal(deferred.deferralCount, 1); assert.equal(providerCalls.length, countBeforeLate);
    at = new Date(deferred.nextActionAt!); await cycle();
    const expired = await admin.managedDispatch.findUniqueOrThrow({ where: { id: exhaustedId } });
    assert.equal(expired.status, 'EXPIRED', JSON.stringify(expired));
    assert.equal(providerCalls.length, countBeforeLate);
    console.log('PASS runtime presence lapse defers without effects; overdue comment retains published root as PARTIAL; real shared Redis exhaustion defers then expires without provider IO');
    console.log('PASS actual ManagedRuntimeModule + private PostgreSQL + Redis shared budget + real provider request construction + signed private PNG HTTP: pending poll, restart, ready, restart, fake publication, visible lifecycle/feed and no duplicate send; historical revision preserved');
  } finally { await stop(); await admin.$disconnect(); ioRedis.disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

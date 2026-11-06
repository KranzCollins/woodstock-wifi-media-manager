import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Test } from '@nestjs/testing';
import { fetch as loopbackFetch } from 'undici';
import { PrismaClient } from '@prisma/client';

// Child of W&W's private-cluster lifecycle runner. The actual
// ManagedRuntimeModule is booted; only the clock and the provider network
// boundary are substituted. No external database, Redis or provider is accepted.
//
// Scope note: MANAGED_SCOPES (managed.mode.ts) currently defines only
// posts:schedule and posts:publish as lifecycle scopes. posts:cancel,
// posts:delete and posts:resolve are not constants there, and an unknown scope
// makes assertManagedCredentials refuse to boot, so the credential holds
// exactly MANAGED_SCOPES and the driver reports which lifecycle scopes exist.
const LIFECYCLE_SCOPES = ['posts:schedule', 'posts:publish', 'posts:cancel', 'posts:delete', 'posts:resolve'];
const ORG = 'a1111111-1111-4111-8111-111111111111';
const CREDENTIAL = 'isolated-lifecycle-workflow';
const token = 'synthetic-workflow-token-never-live-credential';
const CUTOFF = Date.parse('2026-11-10T23:00:00.000Z');
const GRANT_MS = 2 * 24 * 3_600_000;
const MAX_REQUESTS = 180;
const MAX_REPLY = 20_000;
const DEADLINE_MS = 240_000;
const CONTAINER_ID = '17900000000000011';
const PUBLICATION_ID = '17950000000000031';
const PERMALINK = 'https://www.instagram.com/p/DFakePost01/';

const socket = process.env.POSTIZ_TEST_PRIVATE_SOCKET;
const dbUrl = new URL(process.env.DATABASE_URL || 'https://invalid');
assert(socket && socket.includes('/ww-workflow-test-') && socket.endsWith('/s'));
assert.equal(dbUrl.protocol, 'postgresql:');
assert.equal(dbUrl.searchParams.get('host'), socket);
assert.equal(dbUrl.pathname, '/owned_workflow_fixture');
assert(/^redis:\/\/127\.0\.0\.1:\d+$/.test(process.env.REDIS_URL || ''));
assert(process.env.POSTIZ_TEST_RUNTIME_RESOURCE?.startsWith('ww-lifecycle-workflow-'));
assert(process.env.UPLOAD_DIRECTORY);
const LOSE_COMMENT = process.env.POSTIZ_TEST_LOSE_COMMENT_RESPONSE ?? '';
assert(LOSE_COMMENT === '' || LOSE_COMMENT === '1', 'POSTIZ_TEST_LOSE_COMMENT_RESPONSE must be unset or 1');
const loseCommentResponse = LOSE_COMMENT === '1';

globalThis.fetch = async () => { throw new Error('External network forbidden'); };

type FakeCall = { method: string; path: string; caption?: string; imageSha256?: string; imageBytes?: number; message?: string; releaseId?: string };
let at = new Date(Date.now());
let base = '';
let requests = 0;
const calls: FakeCall[] = [];
// Process-level, so a driver restart keeps the injected fault and its evidence.
let commentLossInjected = false;
let fakeCommentId: string | null = null;
const commentCount = () => calls.filter(c => c.method === 'POST' && c.path.endsWith('/comments')).length;

const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input)); const method = init.method ?? 'GET';
  assert.equal(url.origin, 'https://graph.instagram.com');
  const call: FakeCall = { method, path: url.pathname };
  calls.push(call);
  if (method === 'POST' && url.pathname.endsWith('/media')) {
    const caption = url.searchParams.get('caption'); assert(typeof caption === 'string');
    const mediaUrl = new URL(url.searchParams.get('image_url')!);
    assert.equal(mediaUrl.origin, 'https://media.ww.test');
    // Signed capability served by the actual runtime over loopback only.
    const response = await loopbackFetch(base + mediaUrl.pathname + mediaUrl.search);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    call.caption = caption; call.imageBytes = bytes.length;
    call.imageSha256 = createHash('sha256').update(bytes).digest('hex');
    return new Response(JSON.stringify({ id: CONTAINER_ID }));
  }
  if (method === 'GET' && url.searchParams.get('fields')?.includes('status_code'))
    return new Response(JSON.stringify({ status_code: 'FINISHED', status: 'FINISHED' }));
  if (method === 'POST' && url.pathname.endsWith('/media_publish')) {
    assert.equal(url.searchParams.get('creation_id'), CONTAINER_ID);
    assert.equal(calls.filter(c => c.path.endsWith('/media_publish')).length, 1, 'Publication must never be sent twice');
    return new Response(JSON.stringify({ id: PUBLICATION_ID }));
  }
  if (method === 'GET' && url.searchParams.get('fields') === 'permalink')
    return new Response(JSON.stringify({ permalink: PERMALINK }));
  if (method === 'POST' && url.pathname.endsWith('/comments')) {
    const message = url.searchParams.get('message'); assert(typeof message === 'string');
    call.message = message;
    const id = '1790000000000' + String(calls.length).padStart(4, '0');
    if (loseCommentResponse) {
      assert.equal(commentCount(), 1, 'Comment must never be sent twice in lost-response mode');
      call.releaseId = id; fakeCommentId = id; commentLossInjected = true;
      // Fake effect happened; the response is lost in transit.
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify({ id }));
  }
  throw new Error('Unexpected fake provider request');
}) as typeof fetch;

const reply = (value: unknown) => {
  const line = JSON.stringify(value);
  assert(Buffer.byteLength(line) < MAX_REPLY, 'Reply exceeds 20KB');
  process.stdout.write(line + '\n');
};

async function main() {
  const lines = createInterface({ input: process.stdin });
  const messages = lines[Symbol.asyncIterator]();
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('Driver exceeded 4 minutes')), DEADLINE_MS);
  });
  const next = () => Promise.race([messages.next(), deadline]);

  const admin = new PrismaClient();
  let ioRedis: any;
  let app: any = null;
  try {
    const first = await next();
    assert(!first.done);
    const seed = JSON.parse(first.value);
    assert(/^[0-9a-f-]{36}$/.test(seed.tenant));

    const { MANAGED_SCOPES } = await import('../libraries/nestjs-libraries/src/database/prisma/managed/managed.mode');
    const grantedAt = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
    const expiresAt = new Date(Math.floor(Math.min(Date.now() + GRANT_MS, CUTOFF) / 1000) * 1000);
    assert(expiresAt > grantedAt, 'Lifecycle window is past the cutoff');
    Object.assign(process.env, {
      POSTIZ_MANAGED_MODE: 'enabled', POSTIZ_MANAGED_ORGANIZATIONS: ORG,
      POSTIZ_MANAGED_CREDENTIALS: JSON.stringify([{ id: CREDENTIAL, organizationId: ORG,
        tokenSha256: createHash('sha256').update(token).digest('hex'), scopes: [...MANAGED_SCOPES] }]),
      POSTIZ_MANAGED_LIFECYCLE_ORGANIZATIONS: ORG, POSTIZ_MANAGED_LIFECYCLE_PROVIDERS: 'instagram-standalone',
      POSTIZ_MANAGED_LIFECYCLE_GRANTED_AT: grantedAt.toISOString(), POSTIZ_MANAGED_LIFECYCLE_EXPIRES_AT: expiresAt.toISOString(),
      POSTIZ_MANAGED_DISPATCHER: 'enabled', POSTIZ_MANAGED_MEDIA_PUBLIC_ORIGIN: 'https://media.ww.test',
      POSTIZ_MANAGED_MEDIA_CAPABILITY_KEYS: JSON.stringify({ activeKeyId: 'fixture', keys: [{ id: 'fixture', secretHex: randomBytes(32).toString('hex') }] }),
    });

    const { ManagedRuntimeModule } = await import('../apps/backend/src/managed-runtime/managed-runtime.module');
    const { MANAGED_LIFECYCLE_CLOCK, MANAGED_LIFECYCLE_FETCH } = await import('../apps/backend/src/managed-runtime/managed-lifecycle.providers');
    const { ManagedLifecycleEnvironmentConfiguration } = await import('../libraries/nestjs-libraries/src/database/prisma/managed/managed.lifecycle.configuration');
    const { ManagedLifecycleDispatcher } = await import('../libraries/nestjs-libraries/src/database/prisma/managed/managed.lifecycle.dispatcher');
    const { ManagedService } = await import('../libraries/nestjs-libraries/src/database/prisma/managed/managed.service');
    ({ ioRedis } = await import('../libraries/nestjs-libraries/src/redis/redis.service'));
    const { managedStorageNamespace, acquireManagedRuntimeLease, releaseManagedRuntimeLease,
      refreshManagedRuntimeLease, MANAGED_STORAGE_MARKER } = await import('../apps/backend/src/managed-runtime/managed-runtime.config');

    const directory = process.env.UPLOAD_DIRECTORY!;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    writeFileSync(directory + '/' + MANAGED_STORAGE_MARKER, 'isolated fixture');
    const state = { instanceId: process.env.POSTIZ_TEST_RUNTIME_RESOURCE!, storageNamespace: await managedStorageNamespace(directory) };
    const leases = { acquired: 0, refreshed: 0, released: 0 };

    // Mirror the successful runtime lease in the injected clock. The production module does not start the dispatcher
    // timer; main.ts starts it explicitly. This test calls runOnce only through the step command.
    const presence = (until: Date | null) => app.get(ManagedLifecycleEnvironmentConfiguration).setRuntimePresenceUntil(until);
    const start = async () => {
      assert(await acquireManagedRuntimeLease(ioRedis, state.instanceId)); leases.acquired++;
      const module = await Test.createTestingModule({ imports: [ManagedRuntimeModule.register(state)] })
        .overrideProvider(MANAGED_LIFECYCLE_CLOCK).useValue(() => new Date(at))
        .overrideProvider(MANAGED_LIFECYCLE_FETCH).useValue(fakeFetch).compile();
      app = module.createNestApplication({ logger: false });
      app.use((_req: unknown, _res: unknown, nextFn: () => void) => { assert(++requests <= MAX_REQUESTS, 'Request budget exceeded'); nextFn(); });
      await app.listen(0, '127.0.0.1');
      presence(new Date(at.getTime() + 30_000));
      const gates = await app.get(ManagedLifecycleEnvironmentConfiguration).gates(ORG);
      assert(gates?.organizationEnabled && gates.dispatcherAvailable && gates.mediaDeliveryReady, 'Actual runtime lifecycle configuration must be qualified');
      const address = app.getHttpServer().address(); assert(address && typeof address !== 'string');
      base = `http://127.0.0.1:${address.port}`;
      return address.port as number;
    };
    const stop = async () => {
      if (!app) return;
      try { presence(null); app.getHttpServer().closeAllConnections?.(); await app.close(); }
      finally { app = null; if (await releaseManagedRuntimeLease(ioRedis, state.instanceId)) leases.released++; }
    };
    const http = async (path: string) => {
      const response = await loopbackFetch(base + path, { headers: { Authorization: 'Bearer ' + token } });
      return { status: response.status, value: await response.json() as any };
    };
    const step = async () => {
      assert(await refreshManagedRuntimeLease(ioRedis, state.instanceId)); leases.refreshed++;
      presence(new Date(at.getTime() + 30_000));
      await app.get(ManagedLifecycleDispatcher).runOnce();
    };
    const dispatchRows = () => admin.managedDispatch.findMany({ where: { organizationId: ORG }, orderBy: { id: 'asc' },
      select: { id: true, managedPostId: true, status: true, nextStep: true, code: true, deferralCode: true,
        deferralCount: true, nextActionAt: true, members: true } });
    const snapshot = async () => {
      const rows = await dispatchRows();
      const dtos = [];
      for (const row of rows.slice(0, 5)) dtos.push((await http(`/managed/v1/dispatches/${row.id}`)).value);
      const posts = await admin.managedPost.findMany({ where: { organizationId: ORG }, select: { id: true, revision: true } });
      const service = app.get(ManagedService);
      const snapshots = [];
      for (const post of posts.slice(0, 5)) snapshots.push(await service.getPost(ORG, post.id));
      return { at: at.toISOString(), requests, leases, calls, dispatches: rows, dtos, posts, snapshots,
        publishCount: calls.filter(c => c.path.endsWith('/media_publish')).length,
        loseCommentResponse, commentLossInjected, fakeCommentId, commentCount: commentCount() };
    };

    let port = await start();
    assert.equal(calls.length, 0, 'No provider IO before the first manual step');
    await admin.organization.create({ data: { id: ORG, name: 'FAKE isolated W&W lifecycle workflow' } });
    await admin.integration.create({ data: { id: 'ig-' + seed.tenant, organizationId: ORG, internalId: '17841400000000001',
      providerIdentifier: 'instagram-standalone', name: 'FAKE ww.test.acc', type: 'social', token: 'FAKE-unused-token', profile: 'ww.test.acc' } });
    const drafts = app.get(ManagedService);
    const channel = (await drafts.listChannels(ORG)).find((c: any) => c.integrationId === 'ig-' + seed.tenant);
    assert(channel);
    const qualified = await drafts.qualifyChannel(ORG, CREDENTIAL, channel.integrationId,
      { expectedGeneration: channel.binding.generation, identityFingerprint: channel.identityFingerprint });
    reply({ port, channel: qualified, grantedAt: grantedAt.toISOString(), expiresAt: expiresAt.toISOString(),
      loseCommentResponse,
      lifecycleScopes: LIFECYCLE_SCOPES.filter(s => (MANAGED_SCOPES as readonly string[]).includes(s)),
      missingLifecycleScopes: LIFECYCLE_SCOPES.filter(s => !(MANAGED_SCOPES as readonly string[]).includes(s)) });

    for (;;) {
      const message = await next();
      if (message.done) break;
      const command = JSON.parse(message.value);
      if (command.command === 'step') {
        const advance = command.advanceMs ?? 0;
        assert(Number.isInteger(advance) && advance >= 0);
        at = new Date(at.getTime() + advance);
        const before = calls.length;
        await step();
        reply({ at: at.toISOString(), newCalls: calls.slice(before).map(({ method, path }) => ({ method, path })),
          dispatches: (await dispatchRows()).map(({ id, status, nextStep, code, deferralCode, nextActionAt }) =>
            ({ id, status, nextStep, code, deferralCode, nextActionAt })) });
      } else if (command.command === 'restart') {
        const publishes = calls.filter(c => c.path.endsWith('/media_publish')).length;
        const comments = commentCount(); const injected = commentLossInjected;
        await stop(); port = await start();
        assert.equal(calls.filter(c => c.path.endsWith('/media_publish')).length, publishes);
        assert.equal(commentCount(), comments); assert.equal(commentLossInjected, injected);
        reply({ port, loseCommentResponse, commentLossInjected, fakeCommentId });
      } else if (command.command === 'disable_channel') {
        await admin.integration.update({ where: { id: 'ig-' + seed.tenant }, data: { disabled: true } });
        reply({ disabled: true });
      } else if (command.command === 'state') {
        reply(await snapshot());
      } else if (command.command === 'stop') {
        const final = await snapshot();
        assert(final.publishCount <= 1, 'Publication sent more than once');
        if (loseCommentResponse) assert(final.commentCount <= 1, 'Comment sent more than once');
        await stop();
        reply({ ...final, leases, stopped: true });
        break;
      } else {
        throw new Error('Unknown command');
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    try { if (app) { app.getHttpServer()?.closeAllConnections?.(); await app.close(); } } catch {}
    await admin.$disconnect().catch(() => undefined);
    ioRedis?.disconnect();
    lines.close();
    process.stdin.destroy();
  }
}

main().catch(error => { process.stderr.write(String(error?.stack || error) + '\n'); process.exitCode = 1; });

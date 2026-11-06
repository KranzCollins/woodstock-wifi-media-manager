import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetch as loopbackFetch } from 'undici';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { ManagedLifecycleController } from '@gitroom/backend/managed-api/managed.lifecycle.controller';
import { ManagedLifecycleMediaController } from '@gitroom/backend/managed-api/managed.lifecycle.media.controller';
import { ManagedAuthMiddleware } from '@gitroom/backend/services/auth/managed.auth.middleware';
import { ManagedScopeGuard } from '@gitroom/backend/services/auth/managed.scope.guard';
import { ManagedLifecycleService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.service';
import { ManagedMediaCapabilityService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';

// Production Nest controllers/pipes/auth/scope guards, actual service/DB and
// private bytes. Explicit in-process HTTP counter, no hosted TLS or Redis
// qualification. The only transport here is a literal loopback listener.
export async function verifyLifecycleHttp(input: {
  organizationId: string; credentialId: string; managedPostId: string;
  dispatchId: string; operationKey: string;
  service: ManagedLifecycleService; media: ManagedMediaCapabilityService;
  capabilityToken: string; bytes: Buffer;
}) {
  const oldCredentials = process.env.POSTIZ_MANAGED_CREDENTIALS;
  const fullToken = 'synthetic-lifecycle-http-full-never-real';
  const readToken = 'synthetic-lifecycle-http-read-never-real';
  process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([
    { id: input.credentialId, organizationId: input.organizationId,
      tokenSha256: createHash('sha256').update(fullToken).digest('hex'), scopes: ['posts:read', 'posts:schedule', 'posts:publish'] },
    { id: 'lifecycle-http-read', organizationId: input.organizationId,
      tokenSha256: createHash('sha256').update(readToken).digest('hex'), scopes: ['posts:read'] },
  ]);
  const module = await Test.createTestingModule({ imports: [ThrottlerModule.forRoot([{ ttl: 3600000, limit: 200 }])],
    controllers: [ManagedLifecycleController, ManagedLifecycleMediaController],
    providers: [ManagedAuthMiddleware, ManagedScopeGuard,
      { provide: ManagedLifecycleService, useValue: input.service },
      { provide: ManagedMediaCapabilityService, useValue: input.media }],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  const auth = app.get(ManagedAuthMiddleware);
  app.use('/managed/v1', auth.use.bind(auth));
  try {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const call = async (path: string, status: number, options: { token?: string | null; method?: string; body?: unknown } = {}) => {
      const response = await loopbackFetch(base + '/managed/v1' + path, {
        method: options.method ?? 'GET', headers: { ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? fullToken}` }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const body = await response.json() as any;
      assert.equal(response.status, status, JSON.stringify(body));
      return body;
    };
    await call('/lifecycle/capabilities', 401, { token: null });
    const caps = await call('/lifecycle/capabilities', 200, { token: readToken });
    assert.equal(caps.version, 'ww.managed-lifecycle.v1');
    await call('/lifecycle/capabilities?organizationId=other', 400);
    await call(`/posts/${input.managedPostId}/schedule`, 403, { token: readToken, method: 'POST', body: {} });
    await call(`/posts/${input.managedPostId}/schedule`, 400, { method: 'POST', body: { organizationId: 'foreign' } });
    const preview = await call(`/lifecycle/release-preview/${input.managedPostId}?revision=1&codec=ww-plain-escape-v1`, 200);
    assert.equal(preview.managedPostId, input.managedPostId);
    await call(`/lifecycle/release-preview/${input.managedPostId}?revision=1&codec=ww-plain-escape-v1&extra=true`, 400);
    assert.equal((await call(`/posts/${input.managedPostId}/lifecycle`, 200)).lifecycle, 'DISPATCHING');
    assert.equal((await call(`/dispatches/${input.dispatchId}`, 200)).status, 'ADMITTED');
    assert.equal((await call(`/lifecycle/operations/${encodeURIComponent(input.operationKey)}`, 200)).status, 'COMMITTED');
    assert((await call('/lifecycle/events?after=0', 200)).events.length >= 2);
    await call('/lifecycle/events?after=0&after=1', 400);

    const mediaPath = base + `/managed-media/${input.capabilityToken}.png`;
    const quotaBefore = await loopbackFetch(mediaPath.replace(/\.png$/, '.jpg'));
    assert.equal(quotaBefore.status, 404); await quotaBefore.arrayBuffer();
    const media = await loopbackFetch(mediaPath);
    assert.equal(media.status, 200); assert.equal(media.headers.get('cache-control'), 'private, no-store');
    assert(Buffer.from(await media.arrayBuffer()).equals(input.bytes));
    const range = await loopbackFetch(mediaPath, { headers: { range: 'bytes=0-7' } });
    assert.equal(range.status, 206); assert(Buffer.from(await range.arrayBuffer()).equals(input.bytes.subarray(0, 8)));
    const head = await loopbackFetch(mediaPath, { method: 'HEAD' });
    assert.equal(head.status, 405); await head.arrayBuffer();
    process.env.POSTIZ_MANAGED_CREDENTIALS = '[]';
    await call('/lifecycle/capabilities', 401);
    console.log('PASS production Nest lifecycle read/feed/preview/lookup, exact DTO/query/scopes/auth revocation, signed media HTTP/range/extension/HEAD on actual PG and private bytes; loopback only');
  } finally {
    app.getHttpServer()?.closeAllConnections?.(); await app.close();
    if (oldCredentials === undefined) delete process.env.POSTIZ_MANAGED_CREDENTIALS;
    else process.env.POSTIZ_MANAGED_CREDENTIALS = oldCredentials;
  }
}

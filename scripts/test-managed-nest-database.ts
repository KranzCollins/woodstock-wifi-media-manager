import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { Global, Module, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { PrismaClient } from '@prisma/client';
import { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MANAGED_SCOPES } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

// Real Nest controller, DTO pipes, authentication middleware, scopes and organization throttler over the isolated real
// database/private storage. Nest's in-process counter is deliberate: this does not qualify Redis, proxies or hosted TLS.
@Global()
@Module({})
class IsolatedManagedServices {
  static configure(service: ManagedService, media: ManagedMediaService, repository: ManagedRepository, transaction: PrismaTransaction) {
    return { module: IsolatedManagedServices, providers: [
      { provide: ManagedService, useValue: service }, { provide: ManagedMediaService, useValue: media },
      { provide: ManagedRepository, useValue: repository }, { provide: PrismaTransaction, useValue: transaction },
    ], exports: [ManagedService, ManagedMediaService, ManagedRepository, PrismaTransaction] };
  }
}

export async function verifyManagedNestDatabase(input: { admin: PrismaClient; service: ManagedService; media: ManagedMediaService;
  repository: ManagedRepository; transaction: PrismaTransaction;
  organizationId: string; otherOrganizationId: string; credential: string; integrationId: string; generation: number; bytes: Buffer }) {
  const root = process.env.POSTIZ_TEST_WW_CLIENT_ROOT;
  if (!root) { console.log('SKIP actual Nest/HTTP: POSTIZ_TEST_WW_CLIENT_ROOT is not configured'); return; }
  assert(isAbsolute(root));
  const probe = join(root, 'scripts/content-workflow/probe-managed-postiz-http.ts');
  const loader = join(root, 'node_modules/tsx/dist/loader.mjs');
  assert(existsSync(probe) && existsSync(loader));
  const originalCredentials = process.env.POSTIZ_MANAGED_CREDENTIALS;
  const originalOrganizations = process.env.POSTIZ_MANAGED_ORGANIZATIONS;
  const originalConnectProviders = process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS;
  let app: INestApplication | undefined;
  let testModule: TestingModule | undefined;
  try {
  process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS = '';
  process.env.POSTIZ_MANAGED_ORGANIZATIONS = [...new Set([...(originalOrganizations ?? "").split(","), input.otherOrganizationId])].filter(Boolean).join(",");
  const fullToken = 'synthetic-nest-full-token-never-live-credential';
  const readToken = 'synthetic-nest-read-token-never-live-credential';
  const otherToken = 'synthetic-nest-other-token-never-live-credential';
  process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([
    { id: input.credential, organizationId: input.organizationId, tokenSha256: createHash('sha256').update(fullToken).digest('hex'), scopes: [...MANAGED_SCOPES] },
    { id: 'nest-reader', organizationId: input.organizationId, tokenSha256: createHash('sha256').update(readToken).digest('hex'), scopes: ['posts:read', 'channels:read'] },
    { id: 'nest-other', organizationId: input.otherOrganizationId, tokenSha256: createHash('sha256').update(otherToken).digest('hex'), scopes: [...MANAGED_SCOPES] },
  ]);
  const before = { posts: await input.admin.managedPost.count(), media: await input.admin.media.count() };
  const { ManagedApiModule } = await import('@gitroom/backend/managed-api/managed.api.module');
  testModule = await Test.createTestingModule({ imports: [
    ThrottlerModule.forRoot([{ ttl: 3_600_000, limit: 90 }]), IsolatedManagedServices.configure(input.service, input.media, input.repository, input.transaction), ManagedApiModule,
  ] }).compile();
  app = testModule.createNestApplication({ logger: false });
  let requestsSeen = 0;
  app.use((_req: unknown, _res: unknown, next: () => void) => { requestsSeen++; next(); });
  const evidence: { case: string; status: number }[] = [];
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/managed/v1`;
    const call = async (label: string, path: string, token: string | null, expected: number, init: RequestInit = {}) => {
      const response = await fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } });
      const body = await response.json();
      assert.equal(response.status, expected, label + ': ' + JSON.stringify(body));
      evidence.push({ case: label, status: response.status }); return body;
    };
    await call('missing credential', '/capabilities', null, 401);
    await call('wrong credential', '/capabilities', 'synthetic-invalid-token-with-enough-length', 401);
    await call('organization override', '/capabilities', fullToken, 400, { headers: { 'x-postiz-org': input.otherOrganizationId } });
    await call('read scope cannot write', '/posts', readToken, 403, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await call('DTO refuses unknown field', '/posts', fullToken, 400, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId: input.otherOrganizationId }) });
    await call('invalid route identity', '/posts/not-a-uuid', readToken, 400);
    await call('strict observation query', '/posts/11111111-1111-4111-8111-111111111111/media-observation?revision=1&organizationId=other', readToken, 400);
    await call('read credential cannot request account connection', '/connections/intents', readToken, 403,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const disabled = await call('account provider stays disabled', '/connections/intents', fullToken, 409,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationKey: 'ww:nest:connect:disabled',
        providerIdentifier: 'instagram-standalone', mode: 'CONNECT', expectedAccount: { profile: 'FAKE' } }) });
    assert.equal(disabled.code, 'CONNECT_PROVIDER_UNAVAILABLE');
    const combined = await call('combined service credential cannot act as consent relay', '/connections/intents/11111111-1111-4111-8111-111111111111/authorization', fullToken, 403,
      { method: 'POST' });
    assert.equal(combined.code, 'RELAY_CREDENTIAL_REQUIRED');
    await call('callback rejects extra authority fields', '/connections/intents/11111111-1111-4111-8111-111111111111/callback', fullToken, 400,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'A'.repeat(43), code: 'FAKE', organizationId: input.otherOrganizationId }) });
    assert.equal(await input.admin.managedConnectionIntent.count(), 0);
    assert.equal(await input.admin.managedPost.count(), before.posts);
    assert.equal(await input.admin.media.count(), before.media);

    // The same client probe uses different operation keys for this independent route run, so it creates its own exact
    // synthetic draft/media and never edits the earlier test-router records.
    const beforeProbeRequests = requestsSeen;
    const child = spawn(process.execPath, ['--import', loader, probe], { cwd: root, env: {
      PATH: process.env.PATH, TSX_TSCONFIG_PATH: join(root, 'tsconfig.base.json'),
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
    child.stdin.on('error', error => errors.push(Buffer.from(error.message)));
    const deadline = setTimeout(() => child.kill('SIGKILL'), 45_000);
    let code: number | null;
    try {
    child.stdin.end(JSON.stringify({ port: address.port, token: fullToken, integrationId: input.integrationId, generation: input.generation,
      png: input.bytes.toString('base64'), keyPrefix: 'ww:nest-contract' }));
    [code] = await once(child, 'close');
    } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill('SIGKILL'); }
    assert.equal(code, 0, Buffer.concat(errors).toString('utf8'));
    const result = JSON.parse(Buffer.concat(output).toString('utf8'));
    assert.equal(requestsSeen - beforeProbeRequests, result.requests, 'independent server request count');
    assert.equal(result.revision, 3); assert.equal(result.retiredMembers, 1); assert.equal(result.mediaObserved, 1);
    assert.equal(await input.admin.managedPost.count(), before.posts + 1);
    assert.equal(await input.admin.media.count(), before.media + 2);
    const newest = await input.admin.managedPost.findFirstOrThrow({ where: { organizationId: input.organizationId }, orderBy: { createdAt: 'desc' } });
    await call('foreign organization cannot read post', `/posts/${newest.id}`, otherToken, 404);
    await call('foreign organization cannot observe media', `/posts/${newest.id}/media-observation?revision=3`, otherToken, 404);
    assert.equal(await input.admin.managedOperation.count({ where: { organizationId: input.organizationId, operationKey: 'ww:nest-contract:create' } }), 1);
    const foreignLookup = await call('foreign operation lookup is absent', '/operations/ww:nest-contract:create', otherToken, 200);
    assert.equal(foreignLookup.status, 'ABSENT');

    // Existing test calls consumed eight organization-admitted requests; two credentials and two route handlers now
    // exhaust exactly the same 200-request bucket. Failed scope/DTO checks count because throttling runs first.
    let remainingSuccess = 0;
    for (let i = 0; i < 201; i++) {
      const response = await fetch(base + (i % 2 ? '/channels' : '/capabilities'), { headers: { authorization: `Bearer ${i % 2 ? readToken : fullToken}` } });
      const resultBody = await response.json();
      if (response.status === 429) { assert.equal(resultBody.message, 'ThrottlerException: Too Many Requests'); assert.equal(resultBody.code, undefined); break; }
      assert.equal(response.status, 200); remainingSuccess++;
    }
    assert.equal(remainingSuccess + result.requests + 8, 200, 'one organization budget across both credentials and all routes');
    assert.equal((await call('same organization stays rate limited', '/capabilities', readToken, 429)).message, 'ThrottlerException: Too Many Requests');
    await call('other organization retains its own budget', '/capabilities', otherToken, 200);
    process.env.POSTIZ_MANAGED_CREDENTIALS = '[]';
    await call('credential revocation takes effect immediately', '/capabilities', otherToken, 401);
    if (process.env.POSTIZ_TEST_CONTRACT_OUTPUT) writeFileSync(process.env.POSTIZ_TEST_CONTRACT_OUTPUT + '.nest.json', JSON.stringify({
      source: 'Production Nest routes, DTOs, managed authentication/scopes and organization throttler, isolated PostgreSQL18/private storage',
      limits: ['Controller module only, not main.ts/AppModule bootstrap', 'In-process rate counter only, not Redis or multiprocess', 'Loopback HTTP only, not hosted proxy/TLS', 'Synthetic identities/media, no social provider effects'],
      checks: evidence, clientRequests: result.requests, organizationBudget: 200, revision: result.revision,
    }, null, 2) + '\n', { mode: 0o600 });
    console.log('PASS actual Nest/HTTP: production W&W PNG/video/edit/lookup/media client; exact DTO and scope refusal; cross-organization isolation; immediate credential revocation; shared 200/hour bucket across routes and credentials (in-process counter only)');
  } finally {
    try {
      app?.getHttpServer()?.closeAllConnections?.();
      if (app) await app.close(); else await testModule?.close();
    } finally {
    if (originalCredentials === undefined) delete process.env.POSTIZ_MANAGED_CREDENTIALS;
    else process.env.POSTIZ_MANAGED_CREDENTIALS = originalCredentials;
    if (originalOrganizations === undefined) delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
    else process.env.POSTIZ_MANAGED_ORGANIZATIONS = originalOrganizations;
    if (originalConnectProviders === undefined) delete process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS;
    else process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS = originalConnectProviders;
    }
  }
}

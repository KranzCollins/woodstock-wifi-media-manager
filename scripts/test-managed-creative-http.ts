import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { PrismaClient } from '@prisma/client';
import { PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { MANAGED_CREATIVE_RUNTIME } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.service';
import type { ManagedCreativeRuntime } from '@gitroom/nestjs-libraries/managed-creative/creative.runtime';

@Global()
@Module({})
class CreativeFixtureServices {
  static configure(input: any) {
    const providers = [{ provide: ManagedService, useValue: input.service }, { provide: ManagedMediaService, useValue: input.media },
      { provide: ManagedRepository, useValue: input.repository }, { provide: PrismaTransaction, useValue: input.transaction }];
    return { module: CreativeFixtureServices, providers, exports: providers.map(p => p.provide) };
  }
}

// Production DTO -> controller -> service -> PostgreSQL repository, and production W&W HTTP client.
// Only provider execution/private object storage and the organization counter's backend are isolated fakes.
export async function verifyManagedCreativeHttp(input: { admin: PrismaClient; service: ManagedService; media: ManagedMediaService;
  repository: ManagedRepository; transaction: PrismaTransaction }) {
  const root = process.env.POSTIZ_TEST_WW_CLIENT_ROOT;
  if (!root) { console.log('SKIP creative cross-repository HTTP: POSTIZ_TEST_WW_CLIENT_ROOT absent'); return; }
  assert(isAbsolute(root));
  const probe = join(root, 'scripts/content-workflow/probe-managed-creative-http.ts');
  const loader = join(root, 'node_modules/tsx/dist/loader.mjs'); assert(existsSync(probe) && existsSync(loader));
  const org = 'a1111111-1111-4111-8111-111111111111', other = 'b2222222-2222-4222-8222-222222222222';
  const token = 'synthetic-creative-http-token-never-live', readToken = 'synthetic-creative-reader-token-never-live';
  const otherToken = 'synthetic-creative-other-token-never-live', mixedToken = 'synthetic-creative-mixed-token-never-live';
  const credentials = [[token, org, ['creative:run']], [readToken, org, ['channels:read']], [otherToken, other, ['creative:run']],
    [mixedToken, org, ['creative:run', 'channels:read']]].map(([t, organizationId, scopes], i) => ({ id: 'creative-http-' + i,
    organizationId, scopes, tokenSha256: createHash('sha256').update(t as string).digest('hex') }));
  const env = { POSTIZ_MANAGED_CREDENTIALS: JSON.stringify(credentials), POSTIZ_MANAGED_ORGANIZATIONS: org + ',' + other,
    POSTIZ_MANAGED_CREATIVE_ORGANIZATIONS: org + ',' + other, POSTIZ_MANAGED_CREATIVE_KINDS: 'image,video.seedance,video.image_text_slides',
    POSTIZ_MANAGED_CREATIVE_EXPIRES_AT: '2026-11-10T23:00:00Z' };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL9sAAAAASUVORK5CYII=', 'base64');
  const mp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50]);
  let sends = 0, polls = 0, retained = 0, requests = 0;
  const fake = {
    prepare: async (ctx: any) => ({ ok: true, send: async () => {
      sends++;
      if (ctx.stage === 'image.generate') return { answer: { outcome: 'completed', result: null } };
      assert.equal(ctx.stage, 'video.submit'); assert.equal(ctx.objects.filter((o: any) => o.role === 'source').length, 1);
      return { answer: { outcome: 'accepted', handle: { kind: 'evolink', taskId: 'synthetic-' + ctx.operationId } },
        handle: { kind: 'evolink', taskId: 'synthetic-' + ctx.operationId } };
    } }),
    poll: async () => { polls++; return { answer: { status: 'completed', result: null }, final: true }; },
    readArtifact: async (ctx: any) => {
      const bytes = ctx.kind === 'image' ? png : mp4;
      return { kind: 'bytes', bytes, contentType: ctx.kind === 'image' ? 'image/png' : 'video/mp4', sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    retainSource: async (operationId: string, slot: number, asset: any, bytes: Buffer, contentType: string) => {
      retained++; assert.deepEqual(bytes, png);
      return { role: 'source', slot, storageKey: 'synthetic/' + operationId, sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length, contentType, assetId: asset.assetId, assetVersion: asset.version };
    },
    voices: async () => [{ id: 'SyntheticVoice01', label: 'Synthetic voice' }],
  } as unknown as ManagedCreativeRuntime;
  let app: any, module: any;
  try {
    const { ManagedApiModule } = await import('@gitroom/backend/managed-api/managed.api.module');
    module = await Test.createTestingModule({ imports: [ThrottlerModule.forRoot([{ ttl: 3_600_000, limit: 200 }]),
      CreativeFixtureServices.configure(input), ManagedApiModule] }).overrideProvider(MANAGED_CREATIVE_RUNTIME).useValue(fake).compile();
    app = module.createNestApplication({ logger: false });
    app.use((_req: unknown, _res: unknown, next: () => void) => { requests++; next(); });
    await app.listen(0, '127.0.0.1'); const port = app.getHttpServer().address().port;
    const child = spawn(process.execPath, ['--import', loader, probe], { cwd: root,
      env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: join(root, 'tsconfig.base.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = []; child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
    child.stdin.on('error', e => err.push(Buffer.from(e.message)));
    const deadline = setTimeout(() => child.kill('SIGKILL'), 45_000);
    let code: number | null;
    try { child.stdin.end(JSON.stringify({ port, token, png: png.toString('base64') })); [code] = await once(child, 'close'); }
    finally { clearTimeout(deadline); if (child.exitCode === null) child.kill('SIGKILL'); }
    assert.equal(code, 0, Buffer.concat(err).toString());
    const result = JSON.parse(Buffer.concat(out).toString()); assert.equal(requests, result.requests); assert.equal(sends, 3);
    assert.equal(retained, 1); assert.equal(polls, 1, 'completed polls are durably replayed');
    for (const jobId of [result.imageJobId, result.lostJobId, result.videoJobId])
      assert.equal(await input.admin.managedCreativeJob.count({ where: { organizationId: org, jobId } }), 1);
    const base = `http://127.0.0.1:${port}/managed/v1`;
    const call = async (path: string, bearer: string, expected: number, body?: unknown) => {
      const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + bearer,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const b = await r.json(); assert.equal(r.status, expected, JSON.stringify(b)); return b;
    };
    await call('/creative/voices', readToken, 403);
    await call('/creative/voices', mixedToken, 403);
    await call('/creative/calls', token, 400, { version: 'ww.creative-runtime.v1', organizationId: other });
    const missing = await call('/creative/polls', otherToken, 404, { version: 'ww.creative-runtime.v1', handle: result.handle });
    assert.equal(missing.code, 'CREATIVE_HANDLE_NOT_OWNED'); assert.equal(polls, 1);
    let remaining = 0;
    for (; remaining < 201; remaining++) {
      const r = await fetch(base + (remaining % 2 ? '/channels' : '/creative/voices'),
        { headers: { authorization: 'Bearer ' + (remaining % 2 ? readToken : token) } });
      await r.arrayBuffer(); if (r.status === 429) break; assert.equal(r.status, 200);
    }
    assert.equal(result.requests + 3 + remaining, 200, 'creative and existing routes share one organization budget');
    await call('/creative/voices', otherToken, 200);
    assert.equal(sends, 3); assert.equal(polls, 1);
    console.log('PASS creative actual Nest/PostgreSQL + production W&W client: exact source bytes, image/video readback, lost-reply durable replay, owned handles, DTO/dedicated scope isolation and shared 200/hour across routes; providers/storage/counter backend are fakes');
  } finally {
    app?.getHttpServer()?.closeAllConnections?.(); if (app) await app.close(); else await module?.close();
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

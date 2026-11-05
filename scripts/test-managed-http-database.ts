import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import type { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import type { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';

/** Explicit test-only loopback router over production services. This does NOT qualify Nest auth, Redis or hosted TLS. */
export async function verifyManagedHttpDatabase(input: { admin: PrismaClient; service: ManagedService; media: ManagedMediaService;
  organizationId: string; credential: string; integrationId: string; generation: number; bytes: Buffer }) {
  const root = process.env.POSTIZ_TEST_WW_CLIENT_ROOT;
  if (!root) { console.log('SKIP cross-repository HTTP: POSTIZ_TEST_WW_CLIENT_ROOT is not configured'); return; }
  assert(isAbsolute(root));
  const probe = join(root, 'scripts/content-workflow/probe-managed-postiz-http.ts');
  const loader = join(root, 'node_modules/tsx/dist/loader.mjs');
  assert(existsSync(probe) && existsSync(loader), 'W&W test client and TS loader must exist');
  const token = 'synthetic-http-contract-token-not-a-real-credential';
  const { service, media, organizationId: org, credential } = input;
  const beforeMedia = await input.admin.media.count({ where: { organizationId: org } });
  const beforePosts = await input.admin.managedPost.count({ where: { organizationId: org } });
  const requests: { method: string; path: string; length: string | undefined; lengthHeaders: number }[] = [];
  const responses: { method: string; path: string; query: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const url = new URL(req.url!, 'http://127.0.0.1');
      const path = url.pathname.replace(/^\/managed\/v1/, '');
      requests.push({ method: req.method!, path, length: req.headers['content-length'],
        lengthHeaders: req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === 'content-length').length });
      const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
      const json = async () => {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) { length += chunk.length; assert(length <= 100_000); chunks.push(Buffer.from(chunk)); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      };
      let result: unknown;
      if (req.method === 'GET' && path === '/channels') result = await service.listChannels(org);
      else if (req.method === 'GET' && path === '/capabilities') result = service.capabilities();
      else if (req.method === 'GET' && segments[0] === 'operations' && segments.length === 2) result = await service.operationStatus(org, segments[1]);
      else if (req.method === 'GET' && segments[0] === 'posts' && segments.length === 3 && segments[2] === 'media-observation')
        result = await service.observeCurrentMedia(org, segments[1], Number(url.searchParams.get('revision')));
      else if (req.method === 'POST' && path === '/media/uploads') result = await media.reserveUpload(org, credential, await json());
      else if (req.method === 'POST' && segments[0] === 'media' && segments[2] === 'verify' && segments.length === 3)
        result = await media.verifyStoredMedia(org, credential, segments[1]);
      else if (segments[0] === 'media' && segments[1] === 'uploads' && segments[2] && req.method === 'GET') result = await media.uploadStatus(org, credential, segments[2]);
      else if (segments[0] === 'media' && segments[1] === 'uploads' && segments[3] === 'content' && req.method === 'PUT')
        result = await media.receiveUploadContent(org, credential, segments[2], req as any, req.headers['content-type'], req.headers['content-length']);
      else if (req.method === 'POST' && path === '/posts') result = await service.createDraft(org, credential, await json());
      else if (segments[0] === 'posts' && segments.length === 2 && req.method === 'GET') result = await service.getPost(org, segments[1]);
      else if (segments[0] === 'posts' && segments.length === 2 && req.method === 'PUT') result = await service.editDraft(org, credential, segments[1], await json());
      else throw new Error('TEST_ROUTE_NOT_ALLOWED');
      responses.push({ method: req.method!, path, query: url.search, body: result });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error: any) {
      const code = error.getResponse?.()?.code || 'TEST_ROUTE_FAILURE';
      res.writeHead(error.getStatus?.() || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const child = spawn(process.execPath, ['--import', loader, probe], { cwd: root, env: {
      PATH: process.env.PATH, TSX_TSCONFIG_PATH: join(root, 'tsconfig.base.json'),
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
    child.stdin.on('error', error => errors.push(Buffer.from(error.message)));
    const deadline = setTimeout(() => child.kill('SIGKILL'), 45_000);
    let code: number | null;
    try {
    child.stdin.end(JSON.stringify({ port: address.port, token, integrationId: input.integrationId, generation: input.generation, png: input.bytes.toString('base64') }));
    [code] = await once(child, 'close');
    } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill('SIGKILL'); }
    assert.equal(code, 0, Buffer.concat(errors).toString('utf8'));
    const result = JSON.parse(Buffer.concat(output).toString('utf8'));
    assert.equal(result.requests, requests.length);
    assert.equal(await input.admin.media.count({ where: { organizationId: org } }), beforeMedia + 2);
    assert.equal(await input.admin.managedPost.count({ where: { organizationId: org } }), beforePosts + 1);
    const put = requests.filter(r => r.method === 'PUT' && r.path.endsWith('/content'));
    assert.equal(put.length, 2); assert.equal(put[0].length, String(input.bytes.length)); assert(put.every(item => item.lengthHeaders === 1));
    assert.equal(result.revision, 3);
    assert.equal(result.retiredMembers, 1); assert.equal(result.mediaObserved, 1);
    if (process.env.POSTIZ_TEST_CONTRACT_OUTPUT) writeFileSync(process.env.POSTIZ_TEST_CONTRACT_OUTPUT + '.authoring.json', JSON.stringify({
      source: 'Production managed services on isolated PostgreSQL18 and private local storage through a test-only HTTP router',
      limitations: ['No Nest authentication, Redis, hosted TLS or upstream social-provider qualification', 'All identities and media are synthetic'],
      responses,
    }, null, 2) + '\n');
    console.log('PASS cross-repository real HTTP: production W&W client uploads PNG/playable MP4, preserves upload evidence on repeat verify, replays one DRAFT, edits 1→3→2 under the same root, reads exact alt/cover/frame fields, recovers historical/current/absent operation status and observes current private bytes; test router only, no Nest/Redis/TLS qualification');
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

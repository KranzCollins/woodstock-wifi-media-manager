import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { ManagedMediaService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service';
import { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { MANAGED_SCOPES } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

async function main() {
// Child of W&W's private-cluster runner. No external database or provider is accepted.
const socket = process.env.POSTIZ_TEST_PRIVATE_SOCKET;
const url = new URL(process.env.DATABASE_URL || 'https://invalid');
assert(socket && socket.includes('/ww-workflow-test-') && socket.endsWith('/s'));
assert.equal(url.searchParams.get('host'), socket);
assert.equal(url.protocol, 'postgresql:');
assert.equal(url.pathname, '/owned_workflow_fixture');
const lines = createInterface({ input: process.stdin });
const messages = lines[Symbol.asyncIterator]();
const first = await messages.next();
assert(!first.done);
const seed = JSON.parse(first.value);
assert(/^[0-9a-f-]{36}$/.test(seed.tenant));
const organizationId = 'a1111111-1111-4111-8111-111111111111';
const credential = 'isolated-workflow';
const token = 'synthetic-workflow-token-never-live-credential';
process.env.POSTIZ_MANAGED_MODE = 'enabled';
process.env.POSTIZ_MANAGED_ORGANIZATIONS = organizationId;
process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([{ id: credential, organizationId,
  tokenSha256: createHash('sha256').update(token).digest('hex'), scopes: [...MANAGED_SCOPES] }]);
const admin = new PrismaClient();
const db = new PrismaService();
const repository = new ManagedRepository({ model: db } as any, { model: db } as any);
const media = new ManagedMediaService(repository);
const service = new ManagedService(repository, media);
@Global()
@Module({ providers: [{ provide: ManagedService, useValue: service }, { provide: ManagedMediaService, useValue: media },
  { provide: ManagedRepository, useValue: repository }, { provide: PrismaTransaction, useValue: { model: db } }],
  exports: [ManagedService, ManagedMediaService, ManagedRepository, PrismaTransaction] })
class IsolatedServices {}
let app: any;
try {
  await admin.organization.create({ data: { id: organizationId, name: 'FAKE isolated W&W workflow' } });
  await admin.integration.create({ data: { id: 'ig-' + seed.tenant, organizationId, internalId: 'ig-' + seed.tenant,
    providerIdentifier: 'instagram-standalone', name: 'FAKE ww.test.acc', type: 'social', token: 'FAKE-unused-token', profile: 'FAKE' } });
  const [channel] = await service.listChannels(organizationId);
  const qualified = await service.qualifyChannel(organizationId, credential, channel.integrationId,
    { expectedGeneration: channel.binding.generation, identityFingerprint: channel.identityFingerprint });
  const { ManagedApiModule } = await import('@gitroom/backend/managed-api/managed.api.module');
  const module = await Test.createTestingModule({ imports: [ThrottlerModule.forRoot([{ ttl: 3_600_000, limit: 200 }]),
    IsolatedServices, ManagedApiModule] }).compile();
  app = module.createNestApplication({ logger: false });
  let requests = 0;
  app.use((_req: unknown, _res: unknown, next: () => void) => { assert(++requests <= 150); next(); });
  await app.listen(0, '127.0.0.1');
  process.stdout.write(JSON.stringify({ port: app.getHttpServer().address().port, channel: qualified }) + '\n');
  const stop = await messages.next();
  assert(stop.done || stop.value === 'stop');
  const posts = await admin.managedPost.findMany({ where: { organizationId }, select: { id: true, revision: true } });
  const rowStates = await admin.post.findMany({ where: { organizationId }, select: { id: true, state: true } });
  const operations = await admin.managedOperation.count({ where: { organizationId } });
  const snapshot = posts.length === 1 ? await service.getPost(organizationId, posts[0].id) : null;
  process.stdout.write(JSON.stringify({ posts, rowStates, operations, requests, snapshot }) + '\n');
} finally {
  app?.getHttpServer()?.closeAllConnections?.();
  await app?.close();
  await db.$disconnect();
  await admin.$disconnect();
  lines.close();
}

}
main().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });

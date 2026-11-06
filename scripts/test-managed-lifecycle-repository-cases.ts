import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ManagedLifecycleRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.repository';

const socket = process.env.POSTIZ_TEST_PRIVATE_SOCKET;
assert(socket?.includes('/ww-postiz-lifecycle-db-') && socket.endsWith('/s'));
assert.equal(new URL(process.env.DATABASE_URL!).searchParams.get('host'), socket);
globalThis.fetch = async () => { throw new Error('External IO is forbidden'); };
const ORG = 'b1111111-1111-4111-8111-111111111111';
const OTHER = 'b2222222-2222-4222-8222-222222222222';
process.env.POSTIZ_MANAGED_MODE = 'enabled';
process.env.POSTIZ_MANAGED_ORGANIZATIONS = `${ORG},${OTHER}`;
const admin = new PrismaClient();
const first = new PrismaService();
const second = new PrismaService();
const repo = new ManagedLifecycleRepository({ model: first } as any);
const peer = new ManagedLifecycleRepository({ model: second } as any);
const postId = randomUUID();
const foreignPostId = randomUUID();
const AT = new Date('2026-11-06T12:00:00.000Z');

async function main() {
  for (const [organizationId, id] of [[ORG, postId], [OTHER, foreignPostId]]) {
    await admin.managedOrganization.create({ data: { organizationId, sequence: 17 } });
    await admin.managedPost.create({ data: {
      id, organizationId, integrationId: 'fake-integration', group: randomUUID(), revision: 1,
      bindingGeneration: 1, rowFingerprint: 'retained-fingerprint', lastSequence: 17,
      createdOperationKey: 'ww:retained:create', lastOperationKey: 'ww:retained:create',
    } });
  }
  const oldPost = await admin.managedPost.findUniqueOrThrow({ where: { id: postId } });
  const event = (key: string) => ({ kind: 'POST_DELETED', entityType: 'POST', entityId: postId,
    managedPostId: postId, operationKey: key, data: JSON.stringify({ fixture: 'storage-only' }), createdAt: AT });
  const operation = (key: string, sequence: number) => ({ operationKey: key, kind: 'DELETE', payloadHash: 'fixture-payload',
    credentialId: 'fixture-credential', managedPostId: postId, revision: 1, scheduleGeneration: 0,
    sequence, result: JSON.stringify({ fixture: 'storage-only', sequence }), committedAt: AT });

  // A no-op write/replay must not create a lifecycle counter or change a
  // legacy feed position. This test exercises storage, not wire validation.
  await repo.mutate(ORG, async tx => assert.equal(await tx.headSequence(), 0));
  assert.equal(await admin.managedLifecycleOrganization.count({ where: { organizationId: ORG } }), 0);
  await assert.rejects(repo.read(ORG, tx => tx.createPost({ managedPostId: postId })));
  await assert.rejects(repo.mutate(ORG, tx => tx.createPost({ managedPostId: foreignPostId })));
  await repo.mutate(ORG, tx => tx.createPost({ managedPostId: postId }));
  assert.equal(await repo.read(OTHER, tx => tx.getPost(postId)), null);
  assert.equal(await repo.mutate(OTHER, tx => tx.updatePost(postId, 1, { lifecycle: 'DELETED' })), false);

  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? repo : peer).mutate(ORG, async tx => {
    const key = `ww:lifecycle:storage:${index}`;
    const sequence = await tx.appendEvent(event(key));
    await tx.createOperation(operation(key, sequence));
  })));
  const events = await repo.read(ORG, tx => tx.listEvents(0, 100));
  assert.deepEqual(events.map(e => e.sequence), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(await repo.read(ORG, tx => tx.headSequence()), 12);
  const claims = await admin.managedOperation.findMany({ where: { organizationId: ORG } });
  assert.equal(claims.length, 12);
  assert(claims.every(claim => claim.sequence === 0 && claim.kind === 'DELETE'));
  assert.equal((await admin.managedOrganization.findUniqueOrThrow({ where: { organizationId: ORG } })).sequence, 17);
  assert.deepEqual(await admin.managedPost.findUniqueOrThrow({ where: { id: postId } }), oldPost);
  assert.equal(await admin.managedChangeEvent.count({ where: { organizationId: ORG } }), 0);
  assert.equal(await repo.read(OTHER, tx => tx.getClaim(claims[0].operationKey)), null);
  assert.equal(await repo.read(OTHER, tx => tx.getOperation(claims[0].operationKey)), null);
  assert.deepEqual(await repo.read(OTHER, tx => tx.listEvents(0, 100)), []);
  console.log('PASS real PostgreSQL organization lock, dense lifecycle feed across two Prisma clients, shared key claims, legacy feed/history preservation and tenant scoping');

  await assert.rejects(repo.mutate(ORG, async tx => {
    const sequence = await tx.appendEvent(event('ww:lifecycle:storage:rollback'));
    await tx.createOperation(operation('ww:lifecycle:storage:rollback', sequence));
    throw new Error('injected failure before transaction commit');
  }));
  assert.equal(await repo.read(ORG, tx => tx.headSequence()), 12);
  assert.equal(await repo.read(ORG, tx => tx.getClaim('ww:lifecycle:storage:rollback')), null);
  const collided = await Promise.allSettled([repo, peer].map(r => r.mutate(ORG, async tx => {
    const key = 'ww:lifecycle:storage:same-key';
    const sequence = await tx.appendEvent(event(key));
    await tx.createOperation(operation(key, sequence));
  })));
  assert.equal(collided.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await repo.read(ORG, tx => tx.headSequence()), 13);
  assert.equal((await repo.read(ORG, tx => tx.listEvents(0, 100))).length, 13);
  const versions = await Promise.all([repo, peer].map(r => r.mutate(ORG,
    tx => tx.updatePost(postId, 1, { lifecycle: 'DRAFT' }))));
  assert.equal(versions.filter(Boolean).length, 1);
  assert.equal((await repo.read(ORG, tx => tx.getPost(postId)))!.version, 2);
  console.log('PASS rollback leaves no operation/event/sequence hole; concurrent same-key claim commits once; stale version cannot overwrite');
  console.log('NOT QUALIFIED: lifecycle business policy, dispatch IO, call recovery, service/HTTP composition or actual publication');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.all([admin.$disconnect(), first.$disconnect(), second.$disconnect()]);
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ManagedLifecycleRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.repository';
import { ManagedDispatchJournal, ManagedDispatchAdmission, ManagedDispatchHandle } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.dispatch-journal';
import { ManagedPublishTransport } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.transport';

const socket = process.env.POSTIZ_TEST_PRIVATE_SOCKET;
assert(socket?.includes('/ww-postiz-lifecycle-db-') && socket.endsWith('/s'));
assert.equal(new URL(process.env.DATABASE_URL!).searchParams.get('host'), socket);
globalThis.fetch = async () => { throw new Error('External HTTP is forbidden'); };
const ORG = 'c1111111-1111-4111-8111-111111111111';
process.env.POSTIZ_MANAGED_MODE = 'enabled';
process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
const admin = new PrismaClient();
const db = new PrismaService();
const repository = new ManagedLifecycleRepository({ model: db } as any);
const NOW = new Date('2026-11-06T12:00:00.000Z');
let time = NOW;
const sends = join(socket.slice(0, -2), 'isolated-provider-sends.jsonl');
const HASH = `sha256:${'a'.repeat(64)}`;

// Authority and reservation are explicit fixtures here. The real shared
// Redis budget has a separate integration proof. The event callback uses
// storage-only data; this is journal durability, not full business/HTTP proof.
const journal = new ManagedDispatchJournal({ repository, now: () => time,
  budget: { reserve: async () => true, reserveDetailed: async () => ({ accepted: true, code: 'RESERVED', retryAfterMs: null }) },
  validate: async () => true,
  event: async (store, kind, dispatch) => {
    await store.appendEvent({ kind, entityType: 'DISPATCH', entityId: dispatch.id,
      managedPostId: dispatch.managedPostId, scheduleId: dispatch.scheduleId, dispatchId: dispatch.id,
      scheduleGeneration: dispatch.scheduleGeneration, dispatchVersion: dispatch.version, data: '{"fixture":"journal-only"}' });
  },
});
const body = (dispatchId: string, expectedVersion = 1): ManagedDispatchAdmission => ({
  dispatchId, expectedVersion, member: 0, step: 'POST', stage: 0, attempt: 1,
  reservedUnits: 2, deadlineMs: 60_000, requestHash: HASH,
});

function child(mode: string, value: unknown): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register',
      __filename, mode, JSON.stringify(value)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; proc.stdout.on('data', value => { text += value; }); proc.stderr.on('data', value => { text += value; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Isolated journal child timed out')); }, 20000);
    proc.on('error', reject); proc.on('close', code => { clearTimeout(timer); resolve({ code, text }); });
  });
}

async function seed() {
  const post = randomUUID(); const schedule = randomUUID(); const dispatch = randomUUID();
  await admin.managedPost.create({ data: { id: post, organizationId: ORG, integrationId: 'fixture-account', group: randomUUID(),
    revision: 1, bindingGeneration: 1, rowFingerprint: HASH, lastSequence: 1,
    createdOperationKey: `fixture:create:${post}`, lastOperationKey: `fixture:create:${post}` } });
  await admin.managedPostLifecycle.create({ data: { managedPostId: post, organizationId: ORG,
    lifecycle: 'SCHEDULED', scheduleGeneration: 1, activeScheduleId: schedule } });
  await admin.managedSchedule.create({ data: { id: schedule, organizationId: ORG, managedPostId: post,
    scheduleGeneration: 1, mode: 'NOW', status: 'ACTIVE', revision: 1, bindingGeneration: 1,
    integrationId: 'fixture-account', providerIdentifier: 'instagram-standalone', identityFingerprint: HASH,
    contentSha256: 'b'.repeat(64), releaseHash: HASH, releaseHashVersion: 'ww-release-hash-v1', codec: 'ww-plain-escape-v1',
    release: '{"fixture":"journal-only"}', anchorAt: NOW, maxOccurrences: 1, lastOccurrence: 0, maxLatenessMs: 600000,
    policyGrantedAt: new Date('2026-11-04T00:00:00Z'), policyExpiresAt: new Date('2026-11-10T23:00:00Z'),
    operationKey: `fixture:schedule:${post}`, credentialId: 'fixture-credential' } });
  await admin.managedDispatch.create({ data: { id: dispatch, organizationId: ORG, managedPostId: post,
    scheduleId: schedule, occurrence: 0, dueAt: NOW, admissibleUntil: new Date(NOW.getTime() + 600000),
    revision: 1, bindingGeneration: 1, scheduleGeneration: 1, contentSha256: 'b'.repeat(64), releaseHash: HASH,
    members: JSON.stringify([{ position: 0, postId: 'fixture-root', status: 'WAITING', code: null, release: null }]),
    nextActionAt: NOW, lastLifecycleSequence: 0 } });
  return dispatch;
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--child-admit') {
    const result = await journal.admit(ORG, JSON.parse(process.argv[3]));
    console.log('JOURNAL_CHILD_RESULT=' + JSON.stringify(result)); return;
  }
  if (mode === '--child-send-crash') {
    const handle: ManagedDispatchHandle = JSON.parse(process.argv[3]);
    const transport = new ManagedPublishTransport({ reservedUnits: 2, deadlineAt: new Date(handle.deadlineAt), now: () => time,
      verifyAdmission: deadline => journal.verifyAdmission(handle, deadline),
      recordAttempt: (ordinal, mutation) => journal.recordAttempt(handle, ordinal, mutation),
      fetch: (async () => {
        const call = await admin.managedDispatchCall.findUniqueOrThrow({ where: { id: handle.callId } });
        assert.equal(call.status, 'DISPATCHING'); assert.equal(call.consumedUnits, 1);
        assert.equal(JSON.parse(call.sentLedger!).mutationMayHaveLeft, true);
        appendFileSync(sends, '{"fakeProviderReceived":true}\n');
        process.exit(73); // crash after fake provider effect, before settlement
      }) as typeof fetch,
    });
    await transport.adapterFetch()('https://graph.instagram.com/v22.0/17841400000000001/media?access_token=FAKE&image_url=https://media.example/fixture.png', { method: 'POST' });
    throw new Error('Crash fixture unexpectedly returned');
  }
  await admin.managedOrganization.create({ data: { organizationId: ORG, sequence: 41 } });
  const id = await seed();
  const raced = await Promise.all([child('--child-admit', body(id)), child('--child-admit', body(id))]);
  raced.forEach(result => assert.equal(result.code, 0, result.text));
  const values = raced.map(result => JSON.parse(result.text.split('\n').find(line => line.startsWith('JOURNAL_CHILD_RESULT='))!.slice(21)));
  assert.equal(values.filter(value => value.status === 'ADMITTED').length, 1);
  assert.equal(values.filter(value => value.status === 'STATE_REFUSED').length, 1);
  const handle = values.find(value => value.status === 'ADMITTED').handle as ManagedDispatchHandle;
  assert.equal(await admin.managedDispatchCall.count({ where: { dispatchId: id } }), 1);
  assert.equal(await journal.recoverExpired(ORG, id), false);
  assert.equal(await journal.verifyAdmission({ ...handle, holder: randomUUID() }, new Date(handle.deadlineAt)), false);
  assert.equal(await journal.recordAttempt(handle, 2, true), false, 'Skipped ordinal must not be recorded');
  const crash = await child('--child-send-crash', handle);
  assert.equal(crash.code, 73, crash.text);
  assert.equal((await admin.managedDispatchCall.findUniqueOrThrow({ where: { id: handle.callId } })).status, 'DISPATCHING');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 1);
  const retained = await admin.managedDispatch.findUniqueOrThrow({ where: { id } });
  time = new Date(retained.leaseExpiresAt!.getTime() + 1);
  assert.equal(await journal.recoverExpired(ORG, id), true);
  assert.equal(await journal.recoverExpired(ORG, id), false);
  assert.equal(await journal.verifyAdmission(handle, new Date(handle.deadlineAt)), false);
  assert.equal((await journal.admit(ORG, body(id, retained.version + 1))).status, 'STATE_REFUSED');
  assert.equal((await admin.managedDispatch.findUniqueOrThrow({ where: { id } })).status, 'UNKNOWN');
  assert.equal(readFileSync(sends, 'utf8').trim().split('\n').length, 1, 'Unknown effect never resent');
  assert.equal(await journal.recordLateEvidence(handle, { releaseId: 'fixture-published-id', releaseURL: 'https://www.instagram.com/p/DFakePost01/' }), true);
  assert.equal(await journal.recordLateEvidence(handle, { releaseId: 'another-id', releaseURL: null }), false);
  const late = await admin.managedDispatchCall.findUniqueOrThrow({ where: { id: handle.callId } });
  assert.equal(late.status, 'UNKNOWN'); assert.equal(JSON.parse(late.result!).changesOutcome, false);
  assert.equal((await admin.managedOrganization.findUniqueOrThrow({ where: { organizationId: ORG } })).sequence, 41);
  console.log('PASS two independent Node processes race one durable admission; real transport journals before fake provider effect; process exits73; expired lease becomes UNKNOWN with no resend; stale holder refused and late evidence retained without changing outcome');

  // Carousel container creation and publication are separate stages, each
  // with its own possible NOT_SENT retry. They must not collide as retries.
  time = NOW; const carousel = await seed(); const owner = randomUUID();
  await admin.managedDispatch.update({ where: { id: carousel }, data: { status: 'ADMITTED', version: 3,
    nextStep: 'FINALIZE', nextMember: 0, admittedAt: NOW,
    members: JSON.stringify([{ position: 0, postId: 'fixture-root', status: 'PENDING_PROVIDER', code: null, release: null }]) } });
  const row = await admin.managedDispatch.findUniqueOrThrow({ where: { id: carousel } });
  await admin.managedDispatchCall.create({ data: { organizationId: ORG, managedPostId: row.managedPostId,
    dispatchId: carousel, member: 0, postId: 'fixture-root', step: 'FINALIZE', stage: 0, attempt: 1,
    status: 'OK', holder: owner, dispatchVersion: 2, fencingToken: 1, leaseExpiresAt: NOW, deadlineAt: NOW,
    requestHash: HASH, reservedUnits: 1, admittedAt: NOW, settledAt: NOW } });
  const secondStage = await journal.admit(ORG, { ...body(carousel, 3), step: 'FINALIZE', stage: 1 });
  assert.equal(secondStage.status, 'ADMITTED');
  assert.deepEqual((await admin.managedDispatchCall.findMany({ where: { dispatchId: carousel }, orderBy: { stage: 'asc' } })).map(call => [call.stage, call.attempt]), [[0, 1], [1, 1]]);
  console.log('PASS distinct carousel FINALIZE stages each retain their own attempt identity');
  console.log('NOT QUALIFIED: real policy validator/event projections, full step settlement/poll/repeat/cancel, live provider, W&W integration or hosted runtime');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.all([admin.$disconnect(), db.$disconnect()]);
});

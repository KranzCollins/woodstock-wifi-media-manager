import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ManagedCreativeRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.repository';
import { ManagedCreativeService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.service';
import type { ManagedCreativeRuntime } from '@gitroom/nestjs-libraries/managed-creative/creative.runtime';
import { MANAGED_CREATIVE_VERSION } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.contracts';

// Actual private PostgreSQL and production repository/service. Provider preparation/send are isolated fakes.
// No provider SDK, HTTP request, storage bucket, credit or live identity is used by these cases.
export async function verifyManagedCreativeDatabase(admin: PrismaClient) {
  const org = 'a1111111-1111-4111-8111-111111111111', other = 'b2222222-2222-4222-8222-222222222222';
  const env = { POSTIZ_MANAGED_CREATIVE_ORGANIZATIONS: org + ',' + other, POSTIZ_MANAGED_CREATIVE_KINDS: 'image',
    POSTIZ_MANAGED_CREATIVE_EXPIRES_AT: '2026-11-10T23:00:00.000Z' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  let sends = 0, throwAfterSend = false, notSent = false;
  const fake = { prepare: async () => notSent ? { ok: false, code: 'SYNTHETIC_DISABLED' } : ({ ok: true,
    send: async () => { sends++; if (throwAfterSend) throw Error('SYNTHETIC lost reply');
      return { answer: { outcome: 'completed', result: null }, intermediate: { retained: 'synthetic-private-value' } }; } }) } as unknown as ManagedCreativeRuntime;
  const credential = { id: 'synthetic-creative-only', organizationId: org, tokenSha256: 'f'.repeat(64), scopes: ['creative:run'] } as any;
  const repository = () => new ManagedCreativeRepository({ model: admin } as any);
  const service = () => new ManagedCreativeService(repository(), fake);
  const body = () => { const jobId = randomUUID(); return { version: MANAGED_CREATIVE_VERSION, jobId,
    tenantId: randomUUID(), workspaceId: randomUUID(), input: { kind: 'image', provider: 'openai', model: 'chatgpt-image-latest',
      orientation: 'square', prompt: 'Synthetic database-only image' }, stage: 'image.generate' as const, item: 0, attempt: 1 as const,
    callKey: jobId + ':image.generate:0:1' }; };
  try {
    const input = body(), api = service();
    const answers = await Promise.all(Array.from({ length: 8 }, () => api.call(credential, input)));
    assert.equal(sends, 1); assert.ok(answers.some(a => a.outcome === 'completed'));
    assert.ok(answers.every(a => ['completed', 'unknown'].includes(a.outcome)));
    assert.equal(await admin.managedCreativeCall.count({ where: { organizationId: org, callKey: input.callKey } }), 1);
    assert.equal(await admin.managedCreativeJob.count({ where: { organizationId: org, jobId: input.jobId } }), 1);
    // Recreate production repository/service: the answer and intermediate data come from PostgreSQL.
    assert.deepEqual(await service().call(credential, input), { outcome: 'completed', result: null }); assert.equal(sends, 1);
    const bound = await repository().getJob(org, input.jobId); assert.ok(bound);
    assert.equal((await repository().listCalls(org, bound.id))[0].intermediate, '{"retained":"synthetic-private-value"}');
    assert.equal(await repository().getJob(other, input.jobId), null);
    assert.equal(await repository().getCall(other, input.callKey), null);
    await assert.rejects(service().call(credential, { ...input, input: { ...input.input, prompt: 'changed' } }),
      (e: any) => e.getResponse().code === 'CREATIVE_CALL_KEY_CONFLICT'); assert.equal(sends, 1);
    await assert.rejects(service().bindJob(credential, input.jobId, { ...input, workspaceId: randomUUID() }),
      (e: any) => e.getResponse().code === 'CREATIVE_JOB_BINDING_MISMATCH');
    throwAfterSend = true;
    const lost = body(); assert.equal((await service().call(credential, lost)).outcome, 'unknown'); assert.equal(sends, 2);
    throwAfterSend = false;
    assert.equal((await service().call(credential, lost)).outcome, 'unknown'); assert.equal(sends, 2);
    // A simulated crash after the durable before-send gate cannot cause a resend in a new service instance.
    const crash = body(); await service().call(credential, crash); assert.equal(sends, 3);
    await admin.managedCreativeCall.updateMany({ where: { organizationId: org, callKey: crash.callKey },
      data: { status: 'DISPATCHING', answer: null, intermediate: null, code: null } });
    assert.equal((await service().call(credential, crash)).outcome, 'unknown'); assert.equal(sends, 3);
    notSent = true; const refused = body(); assert.equal((await service().call(credential, refused)).outcome, 'not_sent');
    notSent = false; assert.equal((await service().call(credential, refused)).outcome, 'not_sent'); assert.equal(sends, 3);
    console.log('PASS actual creative PostgreSQL: concurrent one-send gate, durable response/intermediate replay, scope/input isolation, unknown crash hold and permanent before-send refusal');
  } finally {
    for (const key of Object.keys(env)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

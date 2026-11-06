import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { ManagedService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.service';
import { ManagedConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.repository';
import { ManagedConnectionService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.service';
import type { ManagedConnectionGrant } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.connection.provider';
import type { ManagedCredential } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

// Actual Prisma transactions/locks/fence/history, with an explicitly isolated fake social provider. No provider network.
export async function verifyManagedConnectionDatabase(input: { admin: PrismaClient; db: PrismaClient;
  repository: ManagedRepository; service: ManagedService; organizationId: string }) {
  const { admin, db, repository, service, organizationId } = input;
  const url = new URL(process.env.DATABASE_URL || 'https://invalid');
  assert(url.searchParams.get('host')?.includes('/ww-postiz-db-'));
  const previous = process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS;
  process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS = 'fake-social';
  const request = { id: 'test-connect', organizationId, tokenSha256: 'a'.repeat(64), scopes: ['channels:connect'] } as ManagedCredential;
  const relay = { id: 'test-relay', organizationId, tokenSha256: 'b'.repeat(64), scopes: ['channels:connect-callback'] } as ManagedCredential;
  const connectionRepository = new ManagedConnectionRepository(repository, { model: db } as any);
  const issued: string[] = [];
  let exchange: (code: string, signal: AbortSignal) => Promise<ManagedConnectionGrant>;
  const connection = new ManagedConnectionService(connectionRepository, [{ identifier: 'fake-social', available: () => true,
    authorizationUrl: state => 'https://consent.example.test/?state=' + state,
    exchange: async (code, signal) => { issued.push(code); return exchange(code, signal); } }]);
  const grant = (id: string): ManagedConnectionGrant => ({ account: { internalId: id, profile: 'fake.account', displayName: 'Fake account' },
    credential: { accessToken: 'FAKE-CONNECTION-TOKEN-' + id, refreshToken: null, expiresInSeconds: 3600 }, grantedScopes: ['fake-basic'] });
  const create = (key: string, expectedId: string) => connection.createIntent(organizationId, request.id, { operationKey: key,
    providerIdentifier: 'fake-social', mode: 'CONNECT', expectedAccount: { internalId: expectedId, profile: 'fake.account' } });
  const authorize = async (id: string) => {
    const result = await connection.authorize(relay, id);
    const state = new URL(result.authorizationUrl).searchParams.get('state')!; assert.equal(state.length, 43);
    return state;
  };
  const refused = (expected: string) => (error: any) => error.getResponse?.().code === expected;
  try {
    const initial = await create('ww:connect:database:one', 'fake-account-one');
    assert.equal((await create('ww:connect:database:one', 'fake-account-one')).intentId, initial.intentId);
    const state = await authorize(initial.intentId);
    let answer!: (value: ManagedConnectionGrant) => void;
    let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    exchange = async () => { entered(); return new Promise(resolve => { answer = resolve; }); };
    const first = connection.callback(relay, initial.intentId, { state, code: 'FAKE-CODE-ONE' });
    await called;
    await assert.rejects(connection.callback(relay, initial.intentId, { state, code: 'FAKE-CODE-ONE' }), refused('EXCHANGE_IN_PROGRESS'));
    answer(grant('fake-account-one'));
    const completed = await first;
    assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.receipt!.binding.status, 'PENDING_QUALIFICATION');
    const replay = await connection.callback(relay, initial.intentId, { state, code: 'FAKE-CODE-ONE' });
    assert.equal(replay.replayed, true); assert.equal(issued.length, 1);
    assert.equal(await admin.integration.count({ where: { organizationId, internalId: 'fake-account-one' } }), 1);
    const integrationId = completed.receipt!.integrationId;
    const channels = await service.listChannels(organizationId);
    const channel = channels.find(item => item.integrationId === integrationId)!;
    const qualified = await service.qualifyChannel(organizationId, request.id, integrationId,
      { expectedGeneration: channel.binding.generation, identityFingerprint: channel.identityFingerprint });
    console.log('PASS real account connection: concurrent callbacks exchange once; replay preserves receipt; binding remains unqualified until explicit qualification');

    const mismatch = await create('ww:connect:database:mismatch', 'expected-only');
    const mismatchState = await authorize(mismatch.intentId);
    exchange = async () => grant('wrong-account');
    const mismatchResult = await connection.callback(relay, mismatch.intentId, { state: mismatchState, code: 'FAKE-CODE-MISMATCH' });
    assert.equal(mismatchResult.status, 'FAILED'); assert.equal(mismatchResult.failure!.code, 'ACCOUNT_MISMATCH');
    assert.equal(await admin.integration.count({ where: { organizationId, internalId: { in: ['expected-only', 'wrong-account'] } } }), 0);

    const uncertain = await create('ww:connect:database:unknown', 'unknown-account');
    const uncertainState = await authorize(uncertain.intentId);
    let late!: (value: ManagedConnectionGrant) => void;
    let lateEntered!: () => void;
    const lateCalled = new Promise<void>(resolve => { lateEntered = resolve; });
    exchange = async () => { lateEntered(); return new Promise(resolve => { late = resolve; }); };
    const pending = connection.callback(relay, uncertain.intentId, { state: uncertainState, code: 'FAKE-CODE-UNKNOWN' });
    await lateCalled;
    await admin.managedConnectionIntent.update({ where: { id: uncertain.intentId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const recovered = await connection.recoverIntent(organizationId, request.id, uncertain.intentId);
    assert.equal(recovered.status, 'UNKNOWN');
    late(grant('unknown-account'));
    assert.equal((await pending).status, 'UNKNOWN');
    await assert.rejects(connection.retryIntent(organizationId, request.id, uncertain.intentId), refused('INTENT_NOT_RETRYABLE'));
    assert.equal(await admin.integration.count({ where: { organizationId, internalId: 'unknown-account' } }), 0);
    console.log('PASS real account connection: wrong account never binds; recovered expired exchange discards a late grant and cannot be retried');

    // Both claims can reach the provider, but only one may write the target at the expected generation.
    const reconnects = await Promise.all(['a', 'b'].map(suffix => connection.createIntent(organizationId, request.id, {
      operationKey: 'ww:reconnect:database:' + suffix, providerIdentifier: 'fake-social', mode: 'RECONNECT', integrationId,
      expectedBindingGeneration: qualified.binding.generation, expectedAccount: { internalId: 'fake-account-one', profile: 'fake.account' } })));
    const states = await Promise.all(reconnects.map(item => authorize(item.intentId)));
    const release: ((value: ManagedConnectionGrant) => void)[] = [];
    let bothEntered!: () => void;
    const both = new Promise<void>(resolve => { bothEntered = resolve; });
    exchange = async () => new Promise(resolve => { release.push(resolve); if (release.length === 2) bothEntered(); });
    const finishes = reconnects.map((item, index) => connection.callback(relay, item.intentId, { state: states[index], code: 'FAKE-RECONNECT-' + index }));
    await both; for (const resolve of release) resolve(grant('fake-account-one'));
    const results = await Promise.all(finishes);
    assert.equal(results.filter(item => item.status === 'COMPLETED').length, 1);
    assert.equal(results.filter(item => item.status === 'FAILED' && item.failure?.code === 'BINDING_GENERATION_MISMATCH').length, 1);
    const after = (await service.listChannels(organizationId)).find(item => item.integrationId === integrationId)!;
    assert.equal(after.binding.generation, qualified.binding.generation + 1);
    assert.equal(after.binding.status, 'PENDING_QUALIFICATION');
    const history = JSON.stringify({ intents: await admin.managedConnectionIntent.findMany(), attempts: await admin.managedConnectionAttempt.findMany(),
      events: await admin.managedChangeEvent.findMany(), results });
    assert(!history.includes('FAKE-CONNECTION-TOKEN') && !history.includes('FAKE-CODE-') && !history.includes(state));
    console.log('PASS real account reconnect: competing grants have one generation winner; retained attempts/events expose no token/code/state');
  } finally {
    if (previous === undefined) delete process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS;
    else process.env.POSTIZ_MANAGED_CONNECT_PROVIDERS = previous;
  }
}

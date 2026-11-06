import 'reflect-metadata';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { managedRequestBudgetKey, SharedManagedRequestBudget } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.request.budget';

const redisUrl = process.env.POSTIZ_TEST_LIFECYCLE_REDIS_URL;
assert(/^ww-lifecycle-budget-[a-f0-9-]+$/.test(process.env.POSTIZ_TEST_BUDGET_RESOURCE ?? ''));
assert.equal(redisUrl, `redis://${process.env.POSTIZ_TEST_BUDGET_RESOURCE}:6379`);
globalThis.fetch = async () => { throw new Error('External HTTP is forbidden'); };
const first = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
const second = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
const storage = new ThrottlerStorageRedisService(first);
const peerStorage = new ThrottlerStorageRedisService(second);
const budget = new SharedManagedRequestBudget(storage, () => 200);
const peerBudget = new SharedManagedRequestBudget(peerStorage, () => 200);

async function main() {
  await Promise.all([first.connect(), second.connect()]);
  assert.equal(await first.dbsize(), 0, 'Harness must own an empty isolated Redis');
  // Same increment contract as ManagedThrottlerGuard. HTTP consumes 40;
  // 250 simultaneous provider reservations can admit exactly 160 more.
  const org = 'isolated-org-shared';
  for (let i = 0; i < 40; i++) {
    const result = await storage.increment(managedRequestBudgetKey(org), 3_600_000, 200, 3_600_000, 'default');
    assert.equal(result.isBlocked, false);
  }
  const result = await Promise.all(Array.from({ length: 250 }, (_, i) =>
    (i % 2 ? budget : peerBudget).reserveDetailed(org, 1)));
  assert.equal(result.filter(r => r.accepted).length, 160);
  assert(result.filter(r => !r.accepted).every(r => r.code === 'BUDGET_EXHAUSTED' && r.retryAfterMs! >= 3_590_000));
  assert.equal(Number(await first.get(`{${managedRequestBudgetKey(org)}:default}:hits`)), 290);
  const deniedHttp = await peerStorage.increment(managedRequestBudgetKey(org), 3_600_000, 200, 3_600_000, 'default');
  assert.equal(deniedHttp.isBlocked, true);
  console.log('PASS actual Redis: HTTP and provider reservations share one 200/hour bucket across independent clients; exhaustion returns persistent-window backoff');

  // Large step reservations can lose partial units to concurrent admission,
  // but their accepted total can never exceed the common ceiling.
  const batchOrg = 'isolated-org-steps';
  const batches = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    (i % 2 ? budget : peerBudget).reserveDetailed(batchOrg, 32)));
  assert(batches.filter(r => r.accepted).length * 32 <= 200);
  const spent = Number(await first.get(`{${managedRequestBudgetKey(batchOrg)}:default}:hits`));
  assert(spent >= 200);
  assert.equal((await budget.reserveDetailed(batchOrg, 1)).accepted, false);
  assert.equal((await budget.reserveDetailed('isolated-org-other', 1)).accepted, true);
  const reduced = new SharedManagedRequestBudget(storage, () => 2);
  assert.equal((await reduced.reserveDetailed('isolated-reduced', 3)).code, 'INVALID_REQUEST');
  assert.equal(await first.exists(`{${managedRequestBudgetKey('isolated-reduced')}:default}:hits`), 0);
  first.disconnect();
  assert.equal((await budget.reserveDetailed('isolated-disconnected', 1)).code, 'BUDGET_UNAVAILABLE');
  console.log('PASS reserved partial units are retained, lowered limits refuse before consumption, tenants are separate and disconnected Redis fails closed');
  console.log('NOT QUALIFIED: dispatch admission, actual provider request, hosted Redis or public endpoint');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  first.disconnect(); second.disconnect();
});

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local qualification of the BUILT managed runtime (docs/managed-extension/deployment.md) against its own private
// PostgreSQL cluster and private Redis (unix sockets only, no TCP listener), with a private local upload directory.
// No caller-supplied database or Redis is accepted, no operator environment is passed to the runtime, and every
// identity, credential and byte is synthetic. Build first: pnpm --filter ./apps/backend run build:managed-runtime
//   node scripts/managed-runtime-local-test.mjs [--pg-bin <dir>] [--redis-bin <dir>]

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const flag = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  if (!process.argv[index + 1]) throw new Error(`${name} requires a directory`);
  return process.argv[index + 1];
};
const pgBin = flag('--pg-bin');
const redisBin = flag('--redis-bin');
const main = join(root, 'apps/backend/dist-managed-runtime/apps/backend/src/managed-runtime/main.js');
if (!existsSync(main)) throw new Error('Build first: pnpm --filter ./apps/backend run build:managed-runtime');
const schema = join(root, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma');

const scratch = mkdtempSync(join(tmpdir(), 'ww-mrt-'));
const pgSocket = join(scratch, 's');
const pgData = join(scratch, 'data');
const redisSocket = join(scratch, 'r.sock');
const uploads = join(scratch, 'uploads');
const unmarked = join(scratch, 'unmarked');
mkdirSync(pgSocket);
for (const dir of [uploads, unmarked]) { mkdirSync(dir); chmodSync(dir, 0o700); }
writeFileSync(join(uploads, '.postiz-managed-storage'), 'synthetic local volume\n', { mode: 0o600 });

// trust authentication ignores the password; it is only here to prove no output ever contains it
const SECRET = 'synthetic-db-password-never-live-' + randomBytes(6).toString('hex');
const databaseUrl = `postgresql://postgres:${SECRET}@localhost:5432/postgres?host=${encodeURIComponent(pgSocket)}`;
const token = 'synthetic-runtime-token-' + randomBytes(16).toString('hex');
const tokenSha256 = createHash('sha256').update(token).digest('hex');
// a 1x1 PNG
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pngSha256 = createHash('sha256').update(png).digest('hex');
const LEASE_KEY = 'managed_runtime_instance';
const READY_CACHE_MS = 2000;
const AUTH_ATTEMPTS_PER_HOUR = 300;

let transcript = '';
const children = new Set();
let pgStarted = false;
let redisServer;
let admin;
let redis;

function run(command, args, env = { PATH: process.env.PATH }) {
  const result = spawnSync(command, args, { cwd: root, env: { LC_ALL: 'C', LANG: 'C', ...env }, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  transcript += (result.stdout ?? '') + (result.stderr ?? '');
  return result;
}
const pg = (name, args) => {
  const result = run(pgBin ? join(pgBin, name) : name, args);
  if (result.status !== 0) {
    const log = join(scratch, 'postgres.log');
    const detail = existsSync(log) ? readFileSync(log, 'utf8') : '';
    throw new Error(`${name} failed\n${result.stderr}\n${detail}`);
  }
  return result.stdout;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

function runtimeEnv(organizationId, port, overrides = {}) {
  const env = {
    PATH: process.env.PATH, TZ: 'UTC', NODE_ENV: 'production',
    POSTIZ_MANAGED_MODE: 'enabled',
    POSTIZ_MANAGED_ORGANIZATIONS: organizationId,
    POSTIZ_MANAGED_CREDENTIALS: JSON.stringify([{ id: 'ww-runtime-local', organizationId, tokenSha256,
      scopes: ['channels:read', 'channels:qualify', 'posts:read', 'posts:write', 'media:write', 'media:upload'] }]),
    DATABASE_URL: databaseUrl, REDIS_URL: redisSocket,
    STORAGE_PROVIDER: 'local', UPLOAD_DIRECTORY: uploads, FRONTEND_URL: 'http://managed-storage.invalid',
    PORT: String(port), POSTIZ_MANAGED_RUNTIME_HOST: '127.0.0.1',
    ...overrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

function startRuntime(env) {
  const child = spawn(process.execPath, ['--experimental-require-module', main], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  const collect = (chunk) => { output += chunk; transcript += chunk; };
  child.stdout.setEncoding('utf8').on('data', collect);
  child.stderr.setEncoding('utf8').on('data', collect);
  const exited = new Promise((done) => child.once('exit', (code, signal) => { children.delete(child); done({ code, signal }); }));
  return { child, exited, output: () => output, port: Number(env.PORT) };
}

async function waitExit(runtime, ms, label) {
  const timer = sleep(ms).then(() => null);
  const result = await Promise.race([runtime.exited, timer]);
  if (!result) { runtime.child.kill('SIGKILL'); throw new Error(`${label}: did not exit within ${ms} ms\n${runtime.output()}`); }
  return result;
}

async function expectRefusal(label, env, text) {
  const runtime = startRuntime(env);
  const { code } = await waitExit(runtime, 60000, label);
  assert.equal(code, 1, `${label}: exit code\n${runtime.output()}`);
  assert(runtime.output().includes(text), `${label}: expected "${text}"\n${runtime.output()}`);
  console.log(`PASS refusal: ${label}`);
}

async function waitHealthy(runtime) {
  for (let i = 0; i < 120; i++) {
    if (runtime.child.exitCode !== null) throw new Error(`runtime exited during startup\n${runtime.output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/managed-runtime/health`);
      if (response.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`runtime did not become healthy\n${runtime.output()}`);
}

async function call(runtime, path, init = {}, auth = true) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${path}`, { ...init,
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...init.headers } });
  const text = await response.text();
  transcript += text;
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

async function stop(runtime, label) {
  runtime.child.kill('SIGTERM');
  const { code } = await waitExit(runtime, 30000, label);
  assert.equal(code, 0, `${label}: graceful exit\n${runtime.output()}`);
}

function prismaDiffStatus(to) {
  const result = run(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'diff',
    '--from-schema-datasource', schema, ...to, '--exit-code'], { PATH: process.env.PATH, DATABASE_URL: databaseUrl, CHECKPOINT_DISABLE: '1' });
  assert([0, 2].includes(result.status), `migrate diff failed\n${result.stderr}`);
  return result.status;
}

function schemaScript(args) {
  return run(process.execPath, [join(root, 'scripts/managed-runtime-schema.mjs'), ...args],
    { PATH: process.env.PATH, DATABASE_URL: databaseUrl });
}

// the token-attempt counters (throttler storage keys contain the counter name)
async function authKeys() {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', '*managed_auth*', 'COUNT', 1000);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

function storedFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return storedFiles(path);
    return entry.name === '.postiz-managed-storage' ? [] : [path];
  });
}

try {
  console.log(pg('postgres', ['--version']).trim());
  pg('initdb', ['-D', pgData, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
  pg('pg_ctl', ['-D', pgData, '-l', join(scratch, 'postgres.log'), '-o', `-k ${pgSocket} -p 5432 -h ''`, '-w', 'start']);
  pgStarted = true;

  redisServer = spawn(redisBin ? join(redisBin, 'redis-server') : 'redis-server',
    ['--port', '0', '--unixsocket', redisSocket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no'],
    { cwd: scratch, env: { PATH: process.env.PATH }, stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(redisSocket); i++) await sleep(100);
  assert(existsSync(redisSocket), 'redis-server did not open its socket');
  const { Redis } = require('ioredis');
  redis = new Redis(redisSocket, { maxRetriesPerRequest: 1 });
  redis.on('error', () => {});
  assert.equal(await redis.ping(), 'PONG');

  // 1. Refusals before anything is served. The database has no schema yet
  const placeholder = 'ww-runtime-placeholder';
  let port = await freePort();
  await expectRefusal('managed mode off', runtimeEnv(placeholder, port, { POSTIZ_MANAGED_MODE: undefined }), 'POSTIZ_MANAGED_MODE must be');
  await expectRefusal('no allowlist', runtimeEnv(placeholder, port, { POSTIZ_MANAGED_ORGANIZATIONS: undefined }), 'POSTIZ_MANAGED_ORGANIZATIONS is empty');
  await expectRefusal('no credentials', runtimeEnv(placeholder, port, { POSTIZ_MANAGED_CREDENTIALS: undefined }), 'POSTIZ_MANAGED_CREDENTIALS is not set');
  await expectRefusal('empty credential list', runtimeEnv(placeholder, port, { POSTIZ_MANAGED_CREDENTIALS: '[]' }), 'has no usable credential');
  // the raw token pasted beside its digest: refused, and the final check proves it is in no output
  await expectRefusal('credential with an extra raw token field', runtimeEnv(placeholder, port, {
    POSTIZ_MANAGED_CREDENTIALS: JSON.stringify([{ id: 'ww-runtime-local', organizationId: placeholder, tokenSha256, token, scopes: ['posts:read'] }]),
  }), 'entry 1 has a field other than');
  await expectRefusal('trust every proxy', runtimeEnv(placeholder, port, { POSTIZ_MANAGED_TRUST_PROXY: 'true' }), 'POSTIZ_MANAGED_TRUST_PROXY must be unset');
  await expectRefusal('no Redis', runtimeEnv(placeholder, port, { REDIS_URL: undefined }), 'REDIS_URL is not set');
  await expectRefusal('unreachable Redis', runtimeEnv(placeholder, port, { REDIS_URL: join(scratch, 'absent.sock') }), 'did not answer');
  await expectRefusal('R2 storage', runtimeEnv(placeholder, port, { STORAGE_PROVIDER: 'cloudflare' }), 'STORAGE_PROVIDER must be exactly');
  await expectRefusal('volume not mounted', runtimeEnv(placeholder, port, { UPLOAD_DIRECTORY: unmarked }), 'has no .postiz-managed-storage');
  chmodSync(uploads, 0o755);
  await expectRefusal('shared upload directory', runtimeEnv(placeholder, port), 'group or others');
  chmodSync(uploads, 0o700);
  await expectRefusal('missing managed schema', runtimeEnv(placeholder, port), 'Managed enrollment check failed');
  assert.equal(prismaDiffStatus(['--to-empty']), 0, 'startup must not create any schema object');
  assert.deepEqual(storedFiles(uploads), []);
  assert.equal(await redis.get(LEASE_KEY), null);
  console.log('PASS no schema mutation, no stored object and no lease after refusals');

  // 2. The explicit schema path for a new empty database
  const baseline = join(scratch, 'baseline.sql');
  const generated = schemaScript(['baseline', '--out', baseline]);
  assert.equal(generated.status, 0, generated.stderr);
  const baselineSha256 = /^sha256 ([a-f0-9]{64})$/m.exec(generated.stdout)?.[1];
  assert(baselineSha256, generated.stdout);
  const reviewed = join(root, 'scripts/managed-runtime-baseline.sql');
  if (existsSync(reviewed)) {
    assert.equal(createHash('sha256').update(readFileSync(reviewed)).digest('hex'), baselineSha256,
      'scripts/managed-runtime-baseline.sql is not what schema.prisma produces now; review again');
    console.log('PASS reviewed baseline equals the current schema.prisma output');
  } else console.log('NOTE scripts/managed-runtime-baseline.sql is not committed yet');
  const wrongSha = schemaScript(['apply-empty', '--file', baseline, '--sha256', '0'.repeat(64)]);
  assert.notEqual(wrongSha.status, 0);
  assert(wrongSha.stderr.includes('not the reviewed one'), wrongSha.stderr);
  assert.equal(prismaDiffStatus(['--to-empty']), 0);
  // Atomicity: the reviewed statements followed by one that fails at the very end leave the database empty
  const failingAtEnd = join(scratch, 'baseline-failing-at-end.sql');
  writeFileSync(failingAtEnd, `${readFileSync(baseline, 'utf8')}\nSELECT 1 / 0;\n`);
  const failingSha256 = createHash('sha256').update(readFileSync(failingAtEnd)).digest('hex');
  const partial = schemaScript(['apply-empty', '--file', failingAtEnd, '--sha256', failingSha256]);
  assert.notEqual(partial.status, 0, 'a baseline failing at its last statement must fail');
  assert.equal(prismaDiffStatus(['--to-empty']), 0, 'a failed baseline must leave no table, type or index');
  console.log('PASS baseline is applied in one transaction: a statement failing at the end leaves the database empty');
  const ownTransaction = join(scratch, 'baseline-own-transaction.sql');
  writeFileSync(ownTransaction, `BEGIN;\n${readFileSync(baseline, 'utf8')}\nCOMMIT;\n`);
  const ownSha256 = createHash('sha256').update(readFileSync(ownTransaction)).digest('hex');
  const refusedOwn = schemaScript(['apply-empty', '--file', ownTransaction, '--sha256', ownSha256]);
  assert.notEqual(refusedOwn.status, 0);
  assert(refusedOwn.stderr.includes('transaction control'), refusedOwn.stderr);
  assert.equal(prismaDiffStatus(['--to-empty']), 0);
  console.log('PASS baseline with its own transaction control is refused before anything runs');

  // Prisma's datamodel comparison can ignore these. The catalog guard must refuse each one and leave it untouched.
  const { PrismaClient: PredecessorClient } = require('@prisma/client');
  const predecessor = new PredecessorClient({ datasources: { db: { url: databaseUrl } } });
  const occupiedBy = async (label, create, present, drop) => {
    for (const statement of create) await predecessor.$executeRawUnsafe(statement);
    const occupied = schemaScript(['apply-empty', '--file', baseline, '--sha256', baselineSha256]);
    assert.notEqual(occupied.status, 0, label);
    assert(occupied.stderr.includes('not empty'), `${label}\n${occupied.stderr}`);
    assert.deepEqual(await predecessor.$queryRawUnsafe(present), [{ present: true }], `${label} was altered`);
    for (const statement of drop) await predecessor.$executeRawUnsafe(statement);
    console.log(`PASS baseline refuses ${label} without altering it`);
  };
  try {
    await occupiedBy('a view in public', ['CREATE VIEW public.ww_unmanaged_preexisting AS SELECT 1 AS value'],
      `SELECT EXISTS(SELECT 1 FROM public.ww_unmanaged_preexisting WHERE value = 1) AS present`,
      ['DROP VIEW public.ww_unmanaged_preexisting']);
    // "pg" followed by any character used to be taken for a system schema
    await occupiedBy('a user schema whose name starts with pg', ['CREATE SCHEMA pgx_unmanaged'],
      `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'pgx_unmanaged') AS present`,
      ['DROP SCHEMA pgx_unmanaged']);
    await occupiedBy('a database setting (search_path)', ['ALTER DATABASE postgres SET search_path TO public'],
      `SELECT EXISTS(SELECT 1 FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = 'postgres') AS present`,
      ['ALTER DATABASE postgres RESET search_path']);
    await occupiedBy('a role setting', ['ALTER ROLE postgres SET search_path TO public'],
      `SELECT EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setdatabase = 0) AS present`,
      ['ALTER ROLE postgres RESET search_path']);
    await occupiedBy('a publication', ['CREATE PUBLICATION ww_unmanaged_publication'],
      `SELECT EXISTS(SELECT 1 FROM pg_publication WHERE pubname = 'ww_unmanaged_publication') AS present`,
      ['DROP PUBLICATION ww_unmanaged_publication']);
    await occupiedBy('a foreign server', ['CREATE FOREIGN DATA WRAPPER ww_unmanaged_fdw', 'CREATE SERVER ww_unmanaged_server FOREIGN DATA WRAPPER ww_unmanaged_fdw'],
      `SELECT EXISTS(SELECT 1 FROM pg_foreign_server WHERE srvname = 'ww_unmanaged_server') AS present`,
      ['DROP SERVER ww_unmanaged_server', 'DROP FOREIGN DATA WRAPPER ww_unmanaged_fdw']);
    await occupiedBy('default privileges', ['ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC'],
      `SELECT EXISTS(SELECT 1 FROM pg_default_acl) AS present`,
      ['ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC']);
  } finally { await predecessor.$disconnect(); }
  const applied = schemaScript(['apply-empty', '--file', baseline, '--sha256', baselineSha256]);
  assert.equal(applied.status, 0, applied.stderr);
  assert(applied.stdout.includes('PASS verify'), applied.stdout);
  const again = schemaScript(['apply-empty', '--file', baseline, '--sha256', baselineSha256]);
  assert.notEqual(again.status, 0);
  assert(again.stderr.includes('not empty'), again.stderr);
  console.log('PASS baseline: sha256-pinned, empty database only, verified equal to schema.prisma, refused twice');

  const { PrismaClient } = require('@prisma/client');
  admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const organization = await admin.organization.create({ data: { name: 'W&W runtime synthetic organization' } });

  // 3. The built runtime serves only the managed API and its health routes
  port = await freePort();
  let runtime = startRuntime(runtimeEnv(organization.id, port));
  await waitHealthy(runtime);
  assert.deepEqual((await call(runtime, '/managed-runtime/health', {}, false)).body, { status: 'ok' });
  const ready = await call(runtime, '/managed-runtime/ready', {}, false);
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.deepEqual(ready.body, { status: 'ok', checks: { enrollment: 'ok', redis: 'ok', lease: 'ok', storage: 'ok' } });
  for (const path of ['/uploads/2026/11/04/x.png', '/public/v1/integrations', '/integrations/list', '/posts', '/api', '/media']) {
    assert.equal((await call(runtime, path)).status, 404, path);
  }
  assert.equal((await call(runtime, '/managed/v1/capabilities', {}, false)).status, 401);
  assert.equal((await call(runtime, '/managed/v1/capabilities')).status, 200);
  console.log('PASS health/readiness, managed authentication, nothing else mounted (uploads, dashboard, public API, swagger)');

  const operationKey = 'ww:runtime-local:png';
  const reserved = await call(runtime, '/managed/v1/media/uploads', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationKey, sha256: pngSha256, byteLength: png.length, mimeType: 'image/png' }) });
  assert.equal(reserved.status, 201, JSON.stringify(reserved.body));
  const sent = await call(runtime, `/managed/v1/media/uploads/${operationKey}/content`, { method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' }, body: png });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const status = await call(runtime, `/managed/v1/media/uploads/${operationKey}`);
  assert.equal(status.body.status, 'COMPLETED', JSON.stringify(status.body));
  assert.equal(status.body.media.sha256, pngSha256);
  const files = storedFiles(uploads);
  assert.equal(files.length, 1);
  assert(readFileSync(files[0]).equals(png), 'the stored object keeps the original bytes');
  assert.equal(statSync(uploads).mode & 0o777, 0o700);
  assert.equal(await admin.managedOrganization.count(), 1);
  console.log('PASS reserved upload over HTTP: exact bytes in the private local volume, durable enrollment recorded');

  // it retries for longer than a lease lives, and the live runtime keeps renewing, so it is still refused
  await expectRefusal('second instance on the same Redis', runtimeEnv(organization.id, await freePort()), 'single-instance lease');
  await stop(runtime, 'graceful stop');
  assert.equal(await redis.get(LEASE_KEY), null);
  console.log('PASS graceful stop releases the lease');

  // A managed table without one of its columns (a partial or drifted schema) refuses the start, before any lease
  await admin.$executeRawUnsafe('ALTER TABLE "ManagedChangeEvent" RENAME COLUMN "data" TO "ww_moved_data"');
  await expectRefusal('managed table missing a column', runtimeEnv(organization.id, port), 'no complete ManagedChangeEvent table');
  await admin.$executeRawUnsafe('ALTER TABLE "ManagedChangeEvent" RENAME COLUMN "ww_moved_data" TO "data"');
  assert.equal(await redis.get(LEASE_KEY), null);
  console.log('PASS startup schema check: a managed table missing a column refuses the start');

  await expectRefusal('enrolled organization left out of the allowlist', runtimeEnv('ww-other-organization', port), 'Managed enrollment check failed');

  // 4. Restart: state persists; one 200 / hour budget per organization in Redis survives the restart
  runtime = startRuntime(runtimeEnv(organization.id, port));
  await waitHealthy(runtime);
  assert.equal((await call(runtime, `/managed/v1/media/uploads/${operationKey}`)).body.status, 'COMPLETED');
  const used = 5; // capabilities, reserve, content, status (first run) and status (this run)
  let admitted = 0;
  for (let i = 0; i < 250; i++) {
    const response = await call(runtime, '/managed/v1/capabilities');
    if (response.status === 429) break;
    assert.equal(response.status, 200);
    admitted++;
  }
  assert.equal(admitted + used, 200, 'one 200 / hour organization budget');
  await stop(runtime, 'stop after budget');
  runtime = startRuntime(runtimeEnv(organization.id, port));
  await waitHealthy(runtime);
  assert.equal((await call(runtime, '/managed/v1/capabilities')).status, 429, 'the Redis budget outlives the process');
  console.log('PASS persistence across restarts; Redis-backed 200 / hour organization budget survives a restart');

  // 4b. Hostile forwarding headers: with no trusted proxy (the default) the bound keys on the socket address, so
  // rotating them neither escapes the bound nor creates Redis keys; every address key has one fixed length
  for (const key of await authKeys()) await redis.del(key);
  const rotating = (i) => ({ authorization: `Bearer ${token}-wrong`, 'x-forwarded-for': `198.51.100.${i % 250}, ${'f'.repeat(8000)}`,
    'x-real-ip': `192.0.2.${i % 250}`, forwarded: `for=203.0.113.${i % 250}`, 'cf-connecting-ip': `203.0.113.${i % 250}` });
  for (let i = 0; i < AUTH_ATTEMPTS_PER_HOUR; i++) {
    assert.equal((await call(runtime, '/managed/v1/capabilities', { headers: rotating(i) })).status, 401);
  }
  // the organization budget is spent too, so the code tells the attempt bound's 429 from the budget's
  const overBound = await call(runtime, '/managed/v1/capabilities', { headers: { 'x-forwarded-for': '192.0.2.200' } });
  assert.equal(overBound.status, 429);
  assert.equal(overBound.body.code, 'TOO_MANY_ATTEMPTS', 'over the bound even the valid token gets no answer of its own');
  const counters = await authKeys();
  assert(counters.length <= 4, `token-attempt counters grew: ${counters.length}`);
  for (const key of counters) {
    assert(/^\{managed_auth_(failures|[a-f0-9]{64}):managed-auth\}:(hits|blocked)$/.test(key), key);
  }
  for (const key of counters) await redis.del(key);
  console.log('PASS spoofed forwarding headers: one bound per socket address, fixed-length keys, no key growth');

  // 5. A crashed instance keeps the lease until it expires; a new start waits for that, then takes it
  runtime.child.kill('SIGKILL');
  await waitExit(runtime, 10000, 'crash');
  const remaining = await redis.pttl(LEASE_KEY);
  assert(remaining > 0, 'the crashed instance lease is still live');
  const crashedAt = Date.now();
  runtime = startRuntime(runtimeEnv(organization.id, port));
  await waitHealthy(runtime);
  assert(Date.now() - crashedAt >= remaining - 1000, 'a new instance started before the crashed instance lease expired');
  console.log('PASS after a crash, a new start waits for the lease to expire, then takes it (no overlap)');

  // A signal while a start waits for the lease ends it cleanly and leaves the live runtime's lease alone
  const holder = await redis.get(LEASE_KEY);
  const waiting = startRuntime(runtimeEnv(organization.id, await freePort()));
  await sleep(8000);
  assert.equal(waiting.child.exitCode, null, `the waiting start exited early\n${waiting.output()}`);
  waiting.child.kill('SIGTERM');
  const ended = await waitExit(waiting, 15000, 'SIGTERM during startup');
  assert.equal(ended.code, 0, waiting.output());
  assert.equal(await redis.get(LEASE_KEY), holder);
  console.log('PASS SIGTERM during startup exits 0 and leaves the live lease untouched');

  // 6. A volume that goes away is not ready; it is ready again once it is back (one readiness result serves
  // probes for READY_CACHE_MS, so each check waits that long)
  const marker = join(uploads, '.postiz-managed-storage');
  const moved = join(scratch, 'moved-marker');
  writeFileSync(moved, readFileSync(marker));
  rmSync(marker);
  await sleep(READY_CACHE_MS + 100);
  const unmounted = await call(runtime, '/managed-runtime/ready', {}, false);
  assert.equal(unmounted.status, 503);
  assert.deepEqual(unmounted.body.checks, { enrollment: 'ok', redis: 'ok', lease: 'ok', storage: 'error' });
  writeFileSync(marker, readFileSync(moved), { mode: 0o600 });
  await sleep(READY_CACHE_MS + 100);
  assert.equal((await call(runtime, '/managed-runtime/ready', {}, false)).status, 200);
  console.log('PASS readiness 503 without the storage marker, 200 once it is back');

  // 7. Losing Redis: the runtime stops itself rather than run without its lease, budget and attempt bound
  redis.disconnect();
  redisServer.kill('SIGTERM');
  await once(redisServer, 'exit');
  redisServer = undefined;
  const { code } = await waitExit(runtime, 45000, 'Redis loss');
  assert.equal(code, 1);
  assert(runtime.output().includes('Lost the single-instance lease or Redis'), runtime.output());
  assert(!runtime.output().includes('Unhandled error event'), runtime.output());
  assert(!runtime.output().includes(redisSocket), 'the Redis address reached the output');
  console.log('PASS Redis loss: the runtime exits 1, logging fixed text only');

  assert(!transcript.includes(SECRET), 'a database password reached the output');
  assert(!transcript.includes(token), 'a managed token reached the output');
  console.log('PASS no database password or managed token in any output');
} finally {
  for (const child of children) child.kill('SIGKILL');
  redis?.disconnect();
  await admin?.$disconnect().catch(() => {});
  redisServer?.kill('SIGKILL');
  if (pgStarted) pg('pg_ctl', ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
  rmSync(scratch, { recursive: true, force: true });
}

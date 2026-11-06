import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// No caller-supplied database URL is accepted. This owns only its private cluster.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeOnly = process.argv.includes('--runtime-only');
const flag = process.argv.indexOf('--pg-bin');
const bin = flag < 0 ? '' : process.argv[flag + 1];
if (flag >= 0 && !bin) throw new Error('--pg-bin requires a directory');
const scratch = mkdtempSync(join(tmpdir(), 'ww-postiz-lifecycle-db-'));
const socket = join(scratch, 's');
const data = join(scratch, 'data');
mkdirSync(socket);
const databaseUrl = `postgresql://postgres@localhost:5432/postgres?host=${encodeURIComponent(socket)}`;
const env = { ...process.env, DATABASE_URL: databaseUrl, POSTIZ_TEST_PRIVATE_SOCKET: socket,
  TS_NODE_PROJECT: join(root, 'tsconfig.managed.spec.json'), TS_NODE_TRANSPILE_ONLY: 'true',
  UPLOAD_DIRECTORY: join(scratch, 'uploads'), STORAGE_PROVIDER: 'local', FRONTEND_URL: 'http://127.0.0.1:1' };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 120000,
    maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout ?? ''}\n${result.stderr ?? result.error?.message ?? ''}`);
  return result.stdout;
}
const pg = (name, args) => run(bin ? join(bin, name) : name, args);
const sql = (statement) => pg('psql', ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement]);
let started = false;
let redisStarted = false;
const resource = 'ww-lifecycle-runtime-' + scratch.split('-').pop();
try {
  console.log(pg('postgres', ['--version']).trim());
  pg('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
  pg('pg_ctl', ['-D', data, '-l', join(scratch, 'postgres.log'), '-o', `-k ${socket} -p 5432 -h ''`, '-w', 'start']);
  started = true;
  const schema = join(root, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma');
  const current = readFileSync(schema, 'utf8');
  const start = current.indexOf('\nmodel ManagedLifecycleOrganization {');
  assert(start > 0, 'Additive lifecycle section must be present');
  const previousSchema = join(scratch, 'before-lifecycle.prisma');
  writeFileSync(previousSchema, current.slice(0, start));
  run(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', previousSchema]);
  sql(`INSERT INTO "ManagedOrganization" ("id", "organizationId", "sequence", "updatedAt")
    VALUES ('retained-org', 'retained-fixture', 7, '2026-11-04T12:00:00Z');
    INSERT INTO "ManagedPostRevision" ("id", "managedPostId", "organizationId", "revision", "operationKey", "payloadHash", "sequence", "snapshot")
    VALUES ('retained-revision', 'retained-post', 'retained-fixture', 1, 'ww:retained:create', 'fake-hash', 7, '{"content":"Retained &nbsp; historical draft","state":"DRAFT"}');`);
  const retainedQuery = `SELECT row_to_json(t)::text FROM "ManagedOrganization" t ORDER BY "id";
    SELECT row_to_json(t)::text FROM "ManagedPostRevision" t ORDER BY "id";`;
  const before = sql(retainedQuery);
  pg('psql', ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-1', '-f', join(root, 'scripts/managed-lifecycle-additive.sql')]);
  assert.equal(sql(retainedQuery), before, 'Historical rows must be byte-identical after additive upgrade');
  run(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'diff',
    '--from-schema-datasource', schema, '--to-schema-datamodel', schema, '--exit-code']);
  for (const model of ['ManagedLifecycleOrganization', 'ManagedPostLifecycle', 'ManagedLifecycleOperation',
    'ManagedLifecycleChangeEvent', 'ManagedSchedule', 'ManagedDispatch', 'ManagedDispatchCall', 'ManagedMediaCapability']) {
    assert.equal(sql(`SELECT count(*) FROM "${model}"`).trim(), '0');
  }
  console.log('PASS additive SQL on an occupied private PostgreSQL: exact schema, byte-identical retained rows, eight empty new tables and no activation seed');
  if (runtimeOnly) {
    const image = 'sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232';
    run('docker', ['image', 'inspect', image]);
    run('docker', ['run', '--pull', 'never', '-d', '--name', resource, '--read-only', '--tmpfs', '/data',
      '--publish', '127.0.0.1::6379', image, 'redis-server', '--save', '', '--appendonly', 'no']);
    redisStarted = true;
    const address = run('docker', ['port', resource, '6379/tcp']).trim();
    assert(/^127\.0\.0\.1:\d+$/.test(address));
    env.REDIS_URL = 'redis://' + address; env.POSTIZ_TEST_RUNTIME_RESOURCE = resource;
    console.log(run(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register',
      'scripts/test-managed-lifecycle-runtime-cases.ts']).trim());
  } else {
  console.log(run(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register',
    'scripts/test-managed-lifecycle-database-cases.ts']).trim());
  console.log(run(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register',
    'scripts/test-managed-lifecycle-repository-cases.ts']).trim());
  console.log(run(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register',
    'scripts/test-managed-lifecycle-dispatch-cases.ts']).trim());
  }
} finally {
  if (redisStarted) run('docker', ['rm', '--force', resource]);
  if (started) pg('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
  rmSync(scratch, { recursive: true, force: true });
}

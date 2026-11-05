import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Qualifies an already-built local image, never a hosted service. All identities,
// passwords and bytes are synthetic. PostgreSQL/Redis have no host ports; an
// internal Docker network prevents provider traffic. Only task-created resources
// are removed. Images must already exist locally: this harness does not pull.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  if (!process.argv[i + 1]) throw Error(`${name} requires a value`);
  return process.argv[i + 1];
};
const image = flag('--image', 'ww-managed-postiz:local-20261104');
const postgresImage = flag('--postgres-image', 'postgres:18.6');
const redisImage = flag('--redis-image', 'mirror.gcr.io/library/redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232');
const task = `ww-managed-test-${randomBytes(6).toString('hex')}`;
const network = `${task}-net`, volume = `${task}-uploads`;
const scratch = mkdtempSync(join(tmpdir(), 'ww-container-test-'));
const password = randomBytes(24).toString('hex');
const token = 'synthetic-container-token-' + randomBytes(24).toString('hex');
const organizationId = `${task}-org`;
const sha = b => createHash('sha256').update(b).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const envFile = join(scratch, 'runtime.env'), dbEnv = join(scratch, 'database.env');
const children = new Set();
let networkCreated = false, volumeCreated = false;
let transcript = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = text => String(text).replaceAll(password, '[synthetic-password]').replaceAll(token, '[synthetic-token]');
function docker(args, { allowFailure = false, timeout = 180000, input } = {}) {
  const r = spawnSync('docker', args, { cwd: root, encoding: 'utf8', input, timeout, maxBuffer: 8 * 1024 * 1024 });
  const out = (r.stdout ?? '') + (r.stderr ?? ''); transcript += out;
  if (!allowFailure && (r.error || r.status !== 0)) throw Error(`Docker ${args[0]} failed: ${clean(r.error?.message ?? out)}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function oneShot(name, args, command, options = {}) {
  const id = `${task}-${name}`; children.add(id);
  return docker(['run', '--rm', '--name', id, '--label', `ww.task=${task}`, '--network', network,
    '--env-file', envFile, ...args, '--entrypoint', 'node', image, ...command], options);
}
function start(name, selectedImage, args, command = []) {
  const id = `${task}-${name}`; children.add(id);
  docker(['run', '-d', '--name', id, '--label', `ww.task=${task}`, '--network', network, ...args, selectedImage, ...command]);
  return id;
}
async function ready(id) {
  for (let i = 0; i < 100; i++) {
    const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', id]).stdout);
    if (!state.Running) throw Error(`Runtime exited: ${clean(docker(['logs', id]).stdout)}`);
    try {
      const r = await call({ id }, '/managed-runtime/ready', {}, false);
      if (r.status === 200) return;
    } catch {}
    await sleep(500);
  }
  throw Error('Container did not become ready');
}
async function launch(suffix) {
  const id = start(suffix, image, ['--env-file', envFile, '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev',
    '--mount', `type=volume,src=${volume},dst=/data/uploads`, '--stop-timeout', '30']);
  // No published host ports. Exercise real HTTP from inside the isolated container.
  await ready(id); return { id };
}
function stop(id) {
  docker(['stop', '--time', '30', id], { timeout: 45000 });
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', id]).stdout.trim(), '0', 'SIGTERM must exit cleanly');
}
let authorizedRequests = 0;
async function call(runtime, path, init = {}, auth = true) {
  if (auth) authorizedRequests++;
  const { body: requestBody, ...options } = init;
  const input = { path, init: { ...options, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...init.headers } },
    body: requestBody === undefined ? null : Buffer.from(requestBody).toString('base64') };
  const program = 'const x=JSON.parse(require("node:fs").readFileSync(0,"utf8"));fetch("http://127.0.0.1:3000"+x.path,{...x.init,...(x.body===null?{}:{body:Buffer.from(x.body,"base64")}),signal:AbortSignal.timeout(10000)}).then(async r=>console.log(JSON.stringify({status:r.status,text:await r.text()})),()=>process.exit(1));';
  const result = docker(['exec', '-i', runtime.id, 'node', '-e', program], { input: JSON.stringify(input), timeout: 15000 });
  const { status, text } = JSON.parse(result.stdout);
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status, body };
}
try {
  const runtimeMetadata = JSON.parse(docker(['image', 'inspect', image]).stdout)[0];
  docker(['image', 'inspect', postgresImage]); docker(['image', 'inspect', redisImage]);
  assert.equal(runtimeMetadata.Config.User, 'node');
  docker(['network', 'create', '--internal', '--label', `ww.task=${task}`, network]); networkCreated = true;
  docker(['volume', 'create', '--label', `ww.task=${task}`, volume]); volumeCreated = true;
  writeFileSync(dbEnv, `POSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
  writeFileSync(envFile, Object.entries({
    DATABASE_URL: `postgresql://postgres:${password}@wwdb:5432/postgres`, REDIS_URL: 'redis://wwredis:6379',
    POSTIZ_MANAGED_MODE: 'enabled', POSTIZ_MANAGED_ORGANIZATIONS: organizationId,
    POSTIZ_MANAGED_CREDENTIALS: JSON.stringify([{ id: 'ww-container-test', organizationId, tokenSha256: sha(token),
      scopes: ['channels:read', 'channels:qualify', 'posts:read', 'posts:write', 'media:write', 'media:upload'] }]),
    POSTIZ_MANAGED_CONNECT_PROVIDERS: '', STORAGE_PROVIDER: 'local', UPLOAD_DIRECTORY: '/data/uploads',
    FRONTEND_URL: 'https://managed-storage.invalid', POSTIZ_MANAGED_RUNTIME_HOST: '0.0.0.0', PORT: '3000',
    CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1',
  }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  const db = start('db', postgresImage, ['--network-alias', 'wwdb', '--env-file', dbEnv, '--tmpfs', '/var/lib/postgresql:rw']);
  start('redis', redisImage, ['--network-alias', 'wwredis', '--tmpfs', '/data:rw'], ['redis-server', '--save', '', '--appendonly', 'no']);
  for (let i = 0; i < 60; i++) {
    if (docker(['exec', db, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) break;
    await sleep(500); if (i === 59) throw Error('Private PostgreSQL did not become ready');
  }
  oneShot('volume-init', ['--user', '0', '--mount', `type=volume,src=${volume},dst=/data/uploads`], ['-e',
    'const f=require("node:fs");f.chownSync("/data/uploads",1000,1000);f.chmodSync("/data/uploads",0o700);f.writeFileSync("/data/uploads/.postiz-managed-storage","synthetic container volume\\n",{mode:0o600});f.chownSync("/data/uploads/.postiz-managed-storage",1000,1000);']);
  const baselineSha = sha(readFileSync(join(root, 'scripts/managed-runtime-baseline.sql')));
  oneShot('schema', [], ['scripts/managed-runtime-schema.mjs', 'apply-empty', '--file', 'scripts/managed-runtime-baseline.sql', '--sha256', baselineSha]);
  oneShot('seed', [], ['-e', 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.organization.create({data:{id:process.env.POSTIZ_MANAGED_ORGANIZATIONS,name:"Synthetic container organization"}}).then(()=>p.$disconnect(),async()=>{await p.$disconnect();process.exit(1)});']);
  let runtime = await launch('runtime-one');
  assert.equal((await call(runtime, '/managed/v1/capabilities', {}, false)).status, 401);
  assert.equal((await call(runtime, '/posts', {}, false)).status, 404);
  assert.equal((await call(runtime, '/managed/v1/capabilities')).status, 200);
  const key = 'ww:container-test:png';
  const declaration = { operationKey: key, sha256: sha(png), byteLength: png.length, mimeType: 'image/png' };
  assert.equal((await call(runtime, '/managed/v1/media/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(declaration) })).status, 201);
  assert.equal((await call(runtime, `/managed/v1/media/uploads/${key}/content`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: png })).status, 200);
  const before = await call(runtime, `/managed/v1/media/uploads/${key}`);
  assert.equal(before.body.status, 'COMPLETED'); assert.equal(before.body.media.sha256, sha(png));
  console.log('PASS container: image bootstrap, non-root readonly runtime, health, authentication and private PNG upload');
  stop(runtime.id); runtime = await launch('runtime-two');
  const after = await call(runtime, `/managed/v1/media/uploads/${key}`);
  assert.deepEqual(after.body, before.body, 'restart must preserve the upload receipt');
  const digest = docker(['exec', runtime.id, 'node', '-e', 'const f=require("node:fs"),p=require("node:path"),c=require("node:crypto");function walk(d){return f.readdirSync(d).flatMap(n=>{const x=p.join(d,n);return f.statSync(x).isDirectory()?walk(x):n===".postiz-managed-storage"?[]:[x]})}const a=walk("/data/uploads");if(a.length!==1)process.exit(1);console.log(c.createHash("sha256").update(f.readFileSync(a[0])).digest("hex"));']).stdout.trim();
  assert.equal(digest, sha(png));
  while (authorizedRequests < 200) assert.equal((await call(runtime, '/managed/v1/capabilities')).status, 200);
  assert.equal((await call(runtime, '/managed/v1/capabilities')).status, 429);
  stop(runtime.id);
  console.log('PASS container: exact bytes and shared 200/hour budget survive restart; graceful SIGTERM releases the lease');
  assert.ok(!transcript.includes(password) && !transcript.includes(token), 'synthetic secrets must not appear in tool or HTTP output');
  console.log(JSON.stringify({ imageId: runtimeMetadata.Id, architecture: runtimeMetadata.Architecture,
    baselineSha256: baselineSha, providerTraffic: false, scope: 'isolated local Docker only' }));
} finally {
  for (const id of [...children].reverse()) docker(['rm', '-f', '-v', id], { allowFailure: true, timeout: 45000 });
  if (volumeCreated) docker(['volume', 'rm', volume], { allowFailure: true });
  if (networkCreated) docker(['network', 'rm', network], { allowFailure: true });
  rmSync(scratch, { recursive: true, force: true });
}

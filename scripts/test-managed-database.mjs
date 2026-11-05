import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// No caller-supplied database URL is accepted. This owns only its private cluster.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = process.argv.indexOf('--pg-bin');
const bin = flag < 0 ? '' : process.argv[flag + 1];
if (flag >= 0 && !bin) throw new Error('--pg-bin requires a directory');
const scratch = mkdtempSync(join(tmpdir(), 'ww-postiz-db-'));
const socket = join(scratch, 's');
const data = join(scratch, 'data');
mkdirSync(socket);
const databaseUrl = `postgresql://postgres@localhost:5432/postgres?host=${encodeURIComponent(socket)}`;
const env = { ...process.env, DATABASE_URL: databaseUrl, POSTIZ_TEST_PRIVATE_SOCKET: socket,
  POSTIZ_TEST_CONNECTION_ONLY: process.argv.includes('--connection-only') ? '1' : '',
  POSTIZ_TEST_CREATIVE_ONLY: process.argv.includes('--creative-only') ? '1' : '',
  TS_NODE_PROJECT: join(root, 'tsconfig.managed.spec.json'), TS_NODE_TRANSPILE_ONLY: 'true',
  UPLOAD_DIRECTORY: join(scratch, 'uploads'), STORAGE_PROVIDER: 'local', FRONTEND_URL: 'http://127.0.0.1:1' };
const outputIndex = process.argv.indexOf('--contract-output');
if (outputIndex >= 0) {
  const output = process.argv[outputIndex + 1];
  if (!output || !resolve(output).startsWith('/Users/herrehettema/.codex/tmp/ww-mcp-build-20261104/'))
    throw new Error('Contract output must be inside the private task evidence directory');
  env.POSTIZ_TEST_CONTRACT_OUTPUT = resolve(output);
} else delete env.POSTIZ_TEST_CONTRACT_OUTPUT;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 120000,
    maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout ?? ''}\n${result.stderr ?? result.error?.message ?? ''}`);
  return result.stdout;
}
const pg = (name, args) => run(bin ? join(bin, name) : name, args);
let started = false;
try {
  console.log(pg('postgres', ['--version']).trim());
  pg('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
  pg('pg_ctl', ['-D', data, '-l', join(scratch, 'postgres.log'), '-o', `-k ${socket} -p 5432 -h ''`, '-w', 'start']);
  started = true;
  run(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema',
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma']);
  console.log(run(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register',
    'scripts/test-managed-database-cases.ts']).trim());
} finally {
  if (started) pg('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
  rmSync(scratch, { recursive: true, force: true });
}

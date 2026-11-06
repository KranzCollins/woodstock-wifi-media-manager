import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imageIndex = process.argv.indexOf('--redis-image');
const image = imageIndex < 0 ? null : process.argv[imageIndex + 1];
if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Pass the already-present Redis image digest with --redis-image');
const name = `ww-lifecycle-budget-${randomUUID().slice(0, 12)}`;
// Existing qualified runtime image, used only as a Node runner. Its app is
// never started. Source is mounted read-only; no credentials are passed.
const nodeImage = 'sha256:fd2f8a130f195c598ee7db9a36f2145e1b6d622f0134c49968565c714321a2a9';
let container = false;
let network = false;
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};
try {
  run('docker', ['image', 'inspect', image]); // no image pull
  run('docker', ['image', 'inspect', nodeImage]);
  run('docker', ['network', 'create', '--internal', name]); network = true;
  run('docker', ['run', '--pull', 'never', '-d', '--name', name, '--network', name,
    '--read-only', '--tmpfs', '/data',
    image, 'redis-server', '--save', '', '--appendonly', 'no']); container = true;
  console.log(run('docker', ['exec', name, 'redis-server', '--version']));
  console.log(run('docker', ['run', '--pull', 'never', '--name', `${name}-client`, '--network', name,
    '--read-only', '--tmpfs', '/tmp', '--entrypoint', 'node', '--workdir', '/source',
    '--mount', `type=bind,source=${root},target=/source,readonly`,
    '--env', `POSTIZ_TEST_LIFECYCLE_REDIS_URL=redis://${name}:6379`, '--env', `POSTIZ_TEST_BUDGET_RESOURCE=${name}`,
    '--env', 'TS_NODE_PROJECT=/source/tsconfig.managed.spec.json', '--env', 'TS_NODE_TRANSPILE_ONLY=true',
    nodeImage, '-r', '/source/node_modules/ts-node/register', '-r', '/source/node_modules/tsconfig-paths/register',
    'scripts/test-managed-lifecycle-budget-cases.ts']));
} finally {
  // This exact name belongs to this invocation, including a timed-out client.
  spawnSync('docker', ['rm', '--force', `${name}-client`], { encoding: 'utf8', timeout: 15000 });
  if (container) run('docker', ['rm', '--force', name]);
  if (network) run('docker', ['network', 'rm', name]);
}

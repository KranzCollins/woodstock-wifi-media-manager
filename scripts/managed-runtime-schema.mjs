import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit, operator-run schema steps of the W&W managed runtime
// (docs/managed-extension/deployment.md). Never run at startup.
//
//   baseline [--out <file>]                 schema.prisma -> SQL for an EMPTY database (no database needed)
//   apply-empty --file <sql> --sha256 <hex>  applies the reviewed SQL in one transaction, only to a database with no schema objects
//   verify                                   the database equals schema.prisma (read-only)
//
// The database comes from DATABASE_URL through the schema's datasource, so no
// URL is ever put on a command line; output is shown with it redacted. Nothing
// here calls prisma db push or prisma migrate deploy.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = join(root, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma');
const prismaCli = join(root, 'node_modules/prisma/build/index.js');
const PRISMA_VERSION = '6.5.0';

const [command, ...args] = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
};

const installed = createRequire(join(root, 'package.json'))('prisma/package.json').version;
if (installed !== PRISMA_VERSION) throw new Error(`prisma ${PRISMA_VERSION} is required, found ${installed}`);
if (!existsSync(schema)) throw new Error('schema.prisma not found');

// The URL, its password, user and host (also a ?host= socket path) never reach the output. The password is
// replaced whatever its length; the other parts from 4 characters, so a short user name doesn't garble the text
const redact = (text) => {
  let out = String(text ?? '');
  const url = process.env.DATABASE_URL;
  if (!url) return out;
  const parts = [[url, '<DATABASE_URL>']];
  try {
    const parsed = new URL(url);
    const decoded = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
    if (parsed.password) parts.push([parsed.password, '<password>'], [decoded(parsed.password), '<password>']);
    for (const [value, label] of [[parsed.host, '<host>'], [parsed.hostname, '<host>'],
      [parsed.searchParams.get('host'), '<host>'], [parsed.username, '<user>']]) {
      if (value && value.length >= 4) parts.push([value, label], [decoded(value), label]);
    }
  } catch {}
  for (const [value, label] of parts.sort(([a], [b]) => b.length - a.length)) {
    if (value) out = out.split(value).join(label);
  }
  return out;
};

// status is returned, not thrown: migrate diff --exit-code answers 2 for "differs"
function prisma(cliArgs, input) {
  // CHECKPOINT_DISABLE: no Prisma update/telemetry request from this step
  const result = spawnSync(process.execPath, [prismaCli, ...cliArgs], { cwd: root, input,
    env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`prisma could not run: ${redact(result.error.message)}`);
  // stdout is the baseline SQL (byte-exact, hashed) and is never printed
  return { status: result.status, stdout: result.stdout, stderr: redact(result.stderr) };
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function requireDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
}

// 0: no difference; 2: differs; anything else: the comparison failed
function diffStatus(to) {
  const result = prisma(['migrate', 'diff', '--from-schema-datasource', schema, ...to, '--exit-code']);
  if (result.status !== 0 && result.status !== 2) throw new Error(`prisma migrate diff failed\n${result.stderr}`);
  return result.status;
}

// Prisma diff ignores unsupported objects such as views/functions. Inspect the catalog too; a reviewed baseline
// is never permission to mutate an existing database that Prisma happens to consider empty. One read-only query
// of the system catalog (operator-authorized for this guard only). A hosted database that ships its own schemas,
// extensions, settings or default privileges is refused: emptiness is never relaxed for a provider.
//   - any schema but public, information_schema and PostgreSQL's own (pg_catalog, pg_toast, pg_temp_N,
//     pg_toast_temp_N, matched exactly: a user schema such as "pgx" or "pg1" is not a system one)
//   - any object in public: a dependency on it, a relation, function or type
//   - extensions other than plpgsql, large objects
//   - event triggers, publications, this database's subscriptions, foreign data wrappers and servers
//   - settings of this database or of the current role (ALTER DATABASE / ROLE ... SET search_path, ...)
//   - default privileges
const CATALOG_OCCUPIED = `SELECT
  EXISTS(SELECT 1 FROM pg_catalog.pg_namespace
    WHERE nspname NOT IN ('public', 'information_schema', 'pg_catalog', 'pg_toast')
      AND nspname !~ '^pg_(toast_)?temp_[0-9]+$')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_namespace n ON n.oid = d.refobjid
    WHERE d.refclassid = 'pg_catalog.pg_namespace'::regclass AND n.nspname = 'public')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_largeobject_metadata)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_publication)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_subscription s JOIN pg_catalog.pg_database d ON d.oid = s.subdbid
    WHERE d.datname = current_database())
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_foreign_data_wrapper)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_foreign_server)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_db_role_setting s
    WHERE s.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
       OR (s.setdatabase = 0 AND s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl)
  AS occupied`;

async function assertCatalogEmpty() {
  const { PrismaClient } = createRequire(join(root, 'package.json'))('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: [] });
  try {
    const [row] = await client.$queryRawUnsafe(CATALOG_OCCUPIED);
    if (row?.occupied !== false) throw new Error('occupied');
  } catch {
    throw new Error('The database is not empty or its catalog could not be verified; refusing to apply the baseline');
  } finally { await client.$disconnect(); }
}

// The reviewed file runs inside one explicit transaction that this script adds, so a statement that fails
// anywhere, including the last one, leaves the database as it was (the local test proves it with a statement
// that fails at the end). A file with its own transaction control, or a statement that can't run inside a
// transaction, is refused before anything runs.
const NOT_TRANSACTIONAL = /^\s*(BEGIN|COMMIT|ROLLBACK|END|ABORT|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b|\bCONCURRENTLY\b|\bVACUUM\b|^\s*(CREATE|DROP|ALTER)\s+(DATABASE|TABLESPACE|SUBSCRIPTION)\b/im;

function verify() {
  requireDatabase();
  if (diffStatus(['--to-schema-datamodel', schema]) !== 0)
    throw new Error('The database schema differs from schema.prisma; do not start the runtime against it');
  console.log('PASS verify: the database schema equals schema.prisma');
}

if (command === 'baseline') {
  const out = resolve(option('--out') ?? join(root, 'scripts/managed-runtime-baseline.sql'));
  const result = prisma(['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schema, '--script']);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`prisma migrate diff failed\n${result.stderr}`);
  writeFileSync(out, result.stdout);
  console.log(`baseline ${out}\nsha256 ${sha256(Buffer.from(result.stdout))}\nschema.prisma sha256 ${sha256(readFileSync(schema))}`);
} else if (command === 'apply-empty') {
  requireDatabase();
  const file = option('--file');
  const expected = option('--sha256');
  if (!file || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('apply-empty requires --file <sql> and --sha256 <reviewed lowercase hex>');
  const sql = readFileSync(resolve(file));
  if (sha256(sql) !== expected) throw new Error('The SQL file is not the reviewed one (sha256 mismatch)');
  if (NOT_TRANSACTIONAL.test(sql.toString('utf8')))
    throw new Error('The SQL file has transaction control or a statement that cannot run in one transaction; refusing it');
  // a database with any schema object is refused: this path is for a new empty database only
  await assertCatalogEmpty();
  if (diffStatus(['--to-empty']) !== 0) throw new Error('The database is not empty; refusing to apply the baseline');
  const applied = prisma(['db', 'execute', '--schema', schema, '--stdin'], `BEGIN;\n${sql.toString('utf8')}\nCOMMIT;\n`);
  if (applied.status !== 0)
    throw new Error(`prisma db execute failed; inspect the database before any retry\n${applied.stderr}`);
  console.log('applied the reviewed baseline to the empty database in one transaction');
  verify();
} else if (command === 'verify') {
  verify();
} else {
  throw new Error('usage: managed-runtime-schema.mjs baseline [--out <file>] | apply-empty --file <sql> --sha256 <hex> | verify');
}

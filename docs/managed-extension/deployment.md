# W&W managed runtime: isolated deployment package (DRAFT staging)

This package runs the managed API (`/managed/v1`, see `README.md`) as an isolated service. The local built process and Linux container have been qualified with disposable PostgreSQL, Redis and private storage. No hosted service, production credential, DNS name or paid resource has been created. Hosting and real account consent remain owner decisions; see "Open decisions".

Post/media writes remain DRAFT-only. There is no publication, scheduling (`QUEUE`), deletion or payment dispatcher. Creative generation routes and concrete provider adapters are present behind separate default-OFF kind/organization/window/credential gates; their tests use isolated fakes and do not authorize paid execution. The account-connection module now includes a separately scoped owner-consent protocol and one Instagram adapter; `POSTIZ_MANAGED_CONNECT_PROVIDERS` is empty by default and remains OFF. No account was connected or reconnected in qualification. This distinction matters: disabled consent code is present, while live account consent is not qualified.

## What runs

| | Isolated runtime | Upstream backend (`apps/backend/src/main.ts`) |
| --- | --- | --- |
| Entrypoint | `apps/backend/src/managed-runtime/main.ts` | `apps/backend/src/main.ts` |
| Root module | `ManagedRuntimeModule` | `AppModule` |
| HTTP routes | `ManagedApiModule` (`/managed/v1/*`) plus `GET /managed-runtime/health` and `GET /managed-runtime/ready` | dashboard, public API, MCP, copilot, swagger, ... |
| Providers | `PrismaService`, `PrismaRepository`, `PrismaTransaction`, `ManagedRepository`, `ManagedService`, `ManagedMediaService`, managed connection repository/service and default-off provider factory, `ThrottlerModule` on Redis | `DatabaseModule` (all services, `IntegrationManager`, Stripe, OpenAI, ...), agent, chat, video, third-party, Temporal |
| Temporal | none | client, search-attribute and workflow registration |
| Uploads | stored in a private local volume, **not served** | served publicly under `FRONTEND_URL/uploads` by the frontend/nginx |
| Schema | never changed at startup | `pm2-run` runs `prisma db push` |
| Process manager | none (one `node` process under `tini` as PID 1 in the container) | pm2 (`pm2 delete all`) |

The managed controller, services, repository, guards, write fence and enrollment check are the existing ones; this package adds only the module wiring, startup preconditions and health routes. Sentry is not initialized, so no error telemetry leaves the process.

## Build

The Prisma client must be generated first, for the schema of this fork.

```sh
pnpm install --frozen-lockfile
pnpm run prisma-generate
pnpm --filter ./apps/backend run build:managed-runtime
# -> apps/backend/dist-managed-runtime/apps/backend/src/managed-runtime/main.js
pnpm --filter ./apps/backend run start:managed-runtime   # needs the environment below
```

- `build:managed-runtime` runs `nest build --path ./tsconfig.managed-runtime.json`. That tsconfig has `files: ["src/managed-runtime/main.ts"]`, so only the runtime and what it imports is compiled. Its output directory is `dist-managed-runtime`, so the existing `dist` is never deleted. Nest's tsc compiler rewrites the `@gitroom/*` aliases to relative paths (static `import`s only), as it does for the upstream build.
- `start:managed-runtime` does not load `.env` (unlike `start`): configuration comes from the process environment only.
- The existing `build`, `start`, `dev` and `pm2` scripts are unchanged. The upstream `nest build` also compiles `src/managed-runtime/*.ts` into `dist` (it compiles every file of `apps/backend`), but nothing there runs it.

Container image (`Dockerfile.ww-managed`, multi-stage, `node:22.23.4-bookworm-slim`, `pnpm@10.6.1`):

```sh
DOCKER_BUILDKIT=1 docker build -f Dockerfile.ww-managed -t ww-managed-runtime:<git-sha> .
```

- **BuildKit is required.** The build context is filtered by `Dockerfile.ww-managed.dockerignore`, an allowlist: everything is excluded, then only the root manifests, the lockfile, `.npmrc`, `tsconfig*.json`, `apps/backend`, the other `apps/*/package.json`, `libraries`, `scripts/managed-runtime-schema.mjs` and `scripts/managed-runtime-baseline.sql` are let back in. Inside them `node_modules`, `.git`, `.env`, `.env.*`, `.secrets`, `*.pem`, `*.key`, `dist`, `dist-managed-runtime`, `*.tsbuildinfo`, tests and reports are excluded again, so they don't reach build-stage layers either (which `--target build` or a `mode=max` cache export would expose). The root `.dockerignore` is unchanged and isn't used by this build. A builder that ignores the dedicated file fails the build: a step refuses any `.env*`, `.secrets`, `dist*` or `*.tsbuildinfo` under `apps`/`libraries`.
- Install is `pnpm install --frozen-lockfile --ignore-scripts`. The copied manifests are exactly the lockfile's importers (the root and `apps/*`; `libraries/*` have no `package.json`). The frontend's `postinstall` (a tag-manager fetch) and native builds are skipped, because this runtime needs neither. The Prisma client is then generated with the locked local `prisma` 6.5.0 CLI, not `pnpm dlx`. Both stages set `CHECKPOINT_DISABLE=1`, so neither `prisma generate`, `prisma version` nor a one-off schema step sends a Prisma update/telemetry request.
- The runtime stage copies exactly `package.json`, `node_modules`, `apps/backend/dist-managed-runtime`, `schema.prisma`, `scripts/managed-runtime-schema.mjs` and `scripts/managed-runtime-baseline.sql`. The local test harness isn't in the image.
- It runs as `node` (uid 1000) under `tini` (`ENTRYPOINT ["/usr/bin/tini", "--"]`, `CMD node --experimental-require-module .../main.js`), so `SIGTERM` reaches node at any time, including during startup. It doesn't use pnpm, dotenv, pm2, nginx or Prisma at startup. `HEALTHCHECK` calls the liveness route.
- **Stop grace period: at least 30 s** (`docker run --stop-timeout 30`, compose `stop_grace_period: 30s`, or the platform's equivalent). The runtime needs up to 20 s to close and release its lease. Docker's default of 10 s kills it first, and the next start then waits for the lease to expire.
- The image still contains the whole hoisted `node_modules`, including dev tooling and the Prisma CLI. The image is large and has more tooling than it needs; nothing runs that tooling unless an operator does.
- The Prisma engine is native: build the image on the target's architecture, or with `--platform`. The engine target is `native` (no `binaryTargets` in the schema).
- Both stages use the pinned official `node:22.23.4-bookworm-slim` digest recorded in `Dockerfile.ww-managed`. Tag images by commit, and record the image digest you deploy.
- The earlier container build and qualification are recorded below. Later creative/runtime changes require a fresh reviewed source build and qualification; the earlier image is not evidence for later source.

## Configuration

Names only. Values are secrets or operator choices and do not belong in this repository, the image or a log.

| Variable | Required | Meaning |
| --- | --- | --- |
| `POSTIZ_MANAGED_MODE` | yes | Exactly `enabled`. Anything else refuses startup (this runtime serves only the managed API). |
| `POSTIZ_MANAGED_ORGANIZATIONS` | yes | Exact organization ids, comma-separated (see `README.md`). Every durably enrolled organization must be listed, or startup exits. |
| `POSTIZ_MANAGED_CREDENTIALS` | yes | JSON array of `{ id, organizationId, tokenSha256, scopes }`; only SHA-256 digests of tokens (64 lowercase hex). This runtime starts only if every entry is used exactly as written and at least one authenticates. It refuses invalid JSON, a non-array, an empty list, an entry for an organization off the allowlist, an invalid id or digest, an unknown scope, any extra field (such as a raw token pasted beside its digest), and an id or digest shared by two entries. The refusal names entry positions and reasons only, never an id, a digest or a token. (The upstream backend, when it runs the managed API, stays lenient. It drops unusable and ambiguous entries, uses the others without their unknown scopes or extra fields, and logs each problem by position.) |
| `POSTIZ_MANAGED_RATE_LIMIT` | no | Requests per hour per organization; default and ceiling `200`. |
| `POSTIZ_MANAGED_MAX_DIGEST_BYTES` | no | Bound of a private storage read for `/verify` (default 64 MiB). |
| `DATABASE_URL` | yes | The dedicated PostgreSQL database (below). Use TLS (`sslmode=require` or stricter) on any non-local network. |
| `REDIS_URL` | yes | The dedicated Redis. Without it the shared client is an in-memory stand-in, so startup refuses. Use `rediss://` and a password/ACL on any non-local network. |
| `STORAGE_PROVIDER` | yes | Exactly `local`. `cloudflare` (R2) is refused until it is qualified on hosted infrastructure. |
| `UPLOAD_DIRECTORY` | yes | Absolute path of the private persistent volume (image default `/data/uploads`). |
| `FRONTEND_URL` | yes | Only the prefix of stored media paths (`<FRONTEND_URL>/uploads/<key>`); nothing is served there. Choose it once for the database and never change it, because earlier evidence is addressed by it. A non-resolving name such as `https://ww-managed-storage.invalid` makes clear it is not a public URL. |
| `PORT` | no | Default `3000`. |
| `POSTIZ_MANAGED_RUNTIME_HOST` | no | Bind address; default `127.0.0.1`, image default `0.0.0.0` (the container network is the boundary). |
| `POSTIZ_MANAGED_TRUST_PROXY` | no | Express `trust proxy` for the token-attempt bound (see "Reverse proxy"). **Unset (default): no proxy is trusted.** The client is the socket peer, and `X-Forwarded-For` and every other forwarding header is ignored. Otherwise use one of: **(a)** up to 16 comma-separated proxy IP addresses or CIDR ranges (no wider than `/8` for IPv4 or `/32` for IPv6), trusted only when the connection comes from them; **(b)** a hop count from `1` to `3`, trusted whatever the peer's address, so only for a runtime that nothing but its proxy can reach. `true`, `0`, named ranges (`loopback`, `uniquelocal`, ...) and anything else are refused, without echoing the value. |
| `MCP_ONLY` | must be unset | It unmounts the managed API; startup refuses it. |

The default DRAFT runtime needs no `JWT_SECRET`, payment, AI, email, Temporal or Sentry configuration. Its separate account-consent adapter is OFF by default; enabling that adapter would require its explicit OAuth app configuration and qualification. The local container qualification did not enable it or perform provider login.

### Initializing the private volume (once)

```sh
install -d -m 700 -o 1000 -g 1000 <volume>/uploads   # the container's node user
touch <volume>/uploads/.postiz-managed-storage
chown 1000:1000 <volume>/uploads/.postiz-managed-storage
```

The marker is never in the image. A volume that is not mounted leaves the image's empty `/data/uploads`, which has no marker, so startup refuses instead of writing to the container layer.

## Startup (fails closed, exit code 1)

In this order, before the port is opened:

1. Configuration: `POSTIZ_MANAGED_MODE=enabled`, `MCP_ONLY` unset, a valid allowlist (`assertManagedModeConfig`), strictly valid credentials (`assertManagedCredentials`), `DATABASE_URL`, `REDIS_URL`, `STORAGE_PROVIDER=local`, a valid `FRONTEND_URL`, the upload directory (step 2), `PORT` and `POSTIZ_MANAGED_TRUST_PROXY`.
2. Storage: `UPLOAD_DIRECTORY` is absolute, a real directory (not a symlink), mode with no group or other bits (`700`), readable and writable, and holds a regular-file `.postiz-managed-storage`. The storage namespace is recorded (`LocalStorage.objectNamespace`: a digest of the directory's real path, device and inode; see "Backup and restore").
3. Redis answers `PING` within 5 s.
4. Nest init: `PrismaService` connects and runs `assertManagedEnrollment`. A missing managed schema, an unreachable database or an enrolled organization absent from the allowlist exits (inside `PrismaService`).
5. Schema projection: every `Managed*` model of the Prisma client this build was generated with is read once with `findFirst()` and no `select`, so every column the client expects is selected. A missing table or column refuses the start, naming the model. It is read-only and Prisma-only (no SQL), with 30 s for the whole check. It does **not** check indexes, unique constraints, foreign keys, enum values or column types. Those are only covered by `managed-runtime-schema.mjs verify`, which stays a required step before every deployment.
6. Single-instance lease: `SET managed_runtime_instance <uuid> EX 30 NX` on Redis, retried every 2 s for up to 18 attempts (about 36 s, longer than a lease lives). `SET NX` never takes a lease that exists, so a runtime that is still renewing keeps it and the new start is refused. A crashed runtime's lease expires within 30 s, and the waiting start then takes it.
7. Listen. A failed listen releases the lease and exits; it isn't swallowed as in the upstream `main.ts`.

While running, the lease is renewed every 10 s. A renewal that fails, times out (5 s) or finds another holder exits the process with 1.

On `SIGTERM`/`SIGINT`, whether during startup or later, the process does the following:

- It lets the startup step in flight finish (the lease wait gives up at its next attempt) and stops before the next step.
- It closes the app while it **keeps renewing the lease**, so in-flight requests finish under a live lease.
- It then stops renewing, releases the lease (only if it holds it) and exits 0.

A hard deadline of 20 s exits 1. In that case the lease isn't released and expires on its own.

Startup refusals and the runtime's own log lines name a variable, a model or a condition, never a configured value. A Redis client error is logged as the fixed text `Redis connection error`, once per outage; without that listener, ioredis would print the Redis host and port. This does **not** cover errors raised while serving a request. Nest logs those with the dependency's own message, and a Prisma connection error names the database host and port. The local test asserts that no database password or managed token appears in any output it captures. Hosts can still appear in request-time logs.

## Health

Both routes are unauthenticated and are not rate limited. Expose them only on the private network or to the proxy's health checker, never publicly.

- `GET /managed-runtime/health` -> `200 { "status": "ok" }`. Liveness only; nothing is contacted.
- `GET /managed-runtime/ready` -> `200` or `503` with `{ "status": "ok" | "error", "checks": { "enrollment", "redis", "lease", "storage" } }`, each `ok` or `error` (2 s per check). It shows no reason, count, organization, host or namespace. It is sent with `Cache-Control: no-store`. Inside the process one result serves every probe for 2 s, and concurrent probes share one check. So probes can't multiply database, Redis and filesystem work, and a change shows up at most 2 s late. It's deliberately light: the full schema projection runs once, at startup.
  - `enrollment`: `assertManagedEnrollment` reads the `ManagedOrganization` table, and every durable enrollment is in this process's allowlist. It logs nothing on success.
  - `redis`: `PING`.
  - `lease`: this process still holds the single-instance lease.
  - `storage`: the marker is present, the mode is private, and the namespace equals the one recorded at startup.

## Service dependencies and private boundaries

| Dependency | Requirement |
| --- | --- |
| PostgreSQL | A **new, dedicated, empty** database for this runtime. PostgreSQL 18 is what was qualified locally. Not shared with Postiz Cloud or another Postiz. Private network only, TLS, a role limited to that database. Backups and restore are the operator's to design; they are not qualified. |
| Redis | Dedicated to this runtime (the lease key and throttler keys are not namespaced per deployment). Private network only. **Mandatory:** `maxmemory-policy noeviction`, and persistence (AOF or RDB) that survives a restart. Under any eviction policy Redis can drop the lease key or the counters. Under `noeviction` with memory full, the lease renewal is refused and the runtime exits, so size `maxmemory` with headroom. Its keys are bounded: the lease, one 200 / hour key per organization, one failure counter, and per client address two fixed-length (64-hex digest) keys that live one hour. New address keys stop once 3,000 failed authentications in the hour are reached. A Redis that loses its data resets the hourly budget and the token-attempt counters. The managed Redis must also allow `EVAL` (the lease and the counters are Lua scripts). |
| Volume | One private persistent volume, mode `700`, owned by uid 1000, mounted at `UPLOAD_DIRECTORY`, attached to exactly one host. See "Backup and restore": the volume's identity is part of every evidence pin. |
| Reverse proxy | TLS termination in front of `/managed/v1/*` only. Do not route `/managed-runtime/*` publicly. Its idle timeout should be shorter than Node's keep-alive (5 s by default; not changed here), or it may reuse a closed connection. The token-attempt bound (300 / hour) keys on Express `req.ip`, and no forwarding header is read directly. With `POSTIZ_MANAGED_TRUST_PROXY` unset, every request through the proxy counts against the proxy's own address: one shared bound, which fails closed. To key on the client, set it to the proxy's exact addresses or ranges. Express then uses the `X-Forwarded-For` entry that proxy **appended**, so a caller-set prefix is ignored and a caller that bypasses the proxy is keyed on its own address. Use a hop count only if the runtime can't be reached except through the proxy. How the hosted proxy actually forwards is unverified. |
| Outbound network | None needed at runtime. |

Data boundaries:

- Stored media is never served. There is no `/uploads` route, no static file serving, no CORS and no cookie handling. Objects are written create-only with their original bytes (`open(..., 'wx')`) and are never deleted by the runtime, including rejected, partial and superseded attempts.
- Previews: there is no media read route. A preview in W&W would need a new **authenticated** read route that is scoped to the credential's organization. That is not built, and uploads must not be published to provide one.
- Only W&W's service credentials reach `/managed/v1`. Credentials hold token digests only. The plain tokens live in W&W's own secret store, never in this repository or image.
- JSON bodies are bounded at 100 kB (Nest default), and reserved upload bodies at the declared size (≤ 20 MiB).

## Single instance

The runtime is **single-instance**. Run exactly one process per database, Redis and volume until R2 storage and distributed concurrency are qualified. The media observation bound and the in-flight set are per process, and the volume is local.

The Redis lease refuses an accidental second replica **on the same Redis**, and nothing more. Its limits:

- It isn't fenced. After a long pause or a partition from Redis, the process that lost the lease can still finish a request it already started. It exits at its next renewal, at most about 15 s later. Database and storage writes carry no lease token, so neither refuses a write from that process.
- It is per Redis, not per database or volume. Two deployments with different Redis instances and the same database or volume aren't detected. The database, the volume and the Redis must be configured as one coherent set; that is operator discipline, not a check.
- A Redis failover that loses the lease key (asynchronous replication) can admit a second runtime while the first still runs.

Deploy with stop-then-start ("recreate"), never rolling or blue/green. After an unclean stop, a new start waits up to about 36 s for the old lease to expire.

## Backup and restore (not qualified)

Every reserved-upload attempt and every pinned media evidence row stores a server-private storage namespace. It is the digest that `LocalStorage.objectNamespace` computes from the upload directory's real path, **device number and inode number**. Each evidence row's `storageVersion` also includes the object file's device, inode, size, mtime and ctime. These values are persisted and their meaning is unchanged here.

Restoring the volume from a backup, re-attaching a cloud block volume, moving hosts or changing the mount path can change those numbers. After that, startup records a different namespace, existing attempts and evidence no longer match it, and reading them answers `READ_FAILED` (unverified, never `ABSENT`). They are never silently accepted, re-pinned or backfilled. A restore is therefore **not** a transparent operation: it needs an explicit requalification before the runtime serves the restored data. No requalification procedure exists yet.

A storage identity that survives a restore (for example a random id in the storage marker, as an additive "v2" next to the current value) is a persisted-data design decision for the root/owner. It must keep the current tamper-evidence: a different or substituted volume must still never verify as the original. It isn't built.

Back up the database and the volume together and consistently. A backup is still useful for forensic recovery, but restoring it isn't qualified.

## Schema: a new empty database only

The runtime never changes the schema. Upstream deployments run `prisma db push` from `pm2-run` on every start. That is not used here, and it is **not** claimed to be safe on an existing database: it can drop or alter columns without review. This fork's schema adds the `Managed*` models to upstream's, and no migration history exists (upstream has no `migrations` directory).

The path for a **new, empty** database (`scripts/managed-runtime-schema.mjs`, Prisma 6.5.0 local CLI only, `DATABASE_URL` from the environment through the schema datasource, never on a command line):

```sh
# 1. Generate the baseline (no database needed), review it, commit it
node scripts/managed-runtime-schema.mjs baseline        # writes scripts/managed-runtime-baseline.sql, prints its sha256
# 2. Apply the reviewed file, pinned by its sha256; refused unless the database has no schema objects
DATABASE_URL=... node scripts/managed-runtime-schema.mjs apply-empty --file scripts/managed-runtime-baseline.sql --sha256 <reviewed sha256>
# 3. Read-only check that the database equals schema.prisma (also run before every deployment)
DATABASE_URL=... node scripts/managed-runtime-schema.mjs verify
```

- `baseline` is `prisma migrate diff --from-empty --to-schema-datamodel schema.prisma --script`.
- `apply-empty` runs these steps in order:
  - It refuses a file whose sha256 isn't the reviewed one.
  - It refuses a file that has its own transaction control (`BEGIN`, `COMMIT`, `SAVEPOINT`, ...) or a statement that can't run in a transaction (`CONCURRENTLY`, `VACUUM`, `CREATE DATABASE`, ...).
  - It refuses a database whose catalog isn't empty (below).
  - It refuses a database that `migrate diff --from-schema-datasource --to-empty --exit-code` finds non-empty.
  - It sends the file through `prisma db execute --stdin`, wrapped in one explicit `BEGIN; ... COMMIT;`, so a statement that fails anywhere leaves the database as it was. The local test proves this with a copy of the baseline whose last statement fails.
  - It runs `verify`. If `db execute` reports a failure, inspect the database before any retry.
- The catalog check is one read-only query of the PostgreSQL system catalog, operator-authorized for this guard only (the runtime itself runs no SQL). It refuses the database if it finds any of these:
  - a schema other than `public`, `information_schema` and PostgreSQL's own (`pg_catalog`, `pg_toast`, `pg_temp_N`, `pg_toast_temp_N`, matched exactly, so a user schema such as `pgx` is not mistaken for a system one)
  - any object in `public` (a dependency on it, a relation, function or type)
  - an extension other than `plpgsql`, or a large object
  - an event trigger, a publication, a subscription of this database, a foreign data wrapper or server
  - a setting of this database or of the current role (`ALTER DATABASE/ROLE ... SET`, such as `search_path`)
  - default privileges

  The check is never relaxed for a hosted provider. One that pre-installs schemas, extensions, role settings or default privileges is refused, which blocks the deployment there. It is qualified on PostgreSQL 18 only.
- `verify` is `migrate diff --from-schema-datasource --to-schema-datamodel --exit-code` (0 = equal). Run it before every deployment. The runtime's own startup check covers tables and columns only.
- These steps run with Prisma telemetry disabled (`CHECKPOINT_DISABLE=1`). They redact the `DATABASE_URL`, its password, and its user and host (from 4 characters) in what they print. The image contains the script, the schema and the reviewed baseline, so step 2 can run as a one-off `docker run --rm ... node scripts/managed-runtime-schema.mjs ...` against the private database. Nothing runs it at startup. The image build runs `prisma version` to fetch the engines. The container qualification ran this step as the `node` user, using the image's root-owned dependencies, on an internal network without outbound access; it succeeded.
- A later schema change needs its own reviewed diff (`migrate diff --from-schema-datasource --to-schema-datamodel --script`). No such path is provided or qualified.
- The current baseline was regenerated after the connection tables were added. Its SHA256 is `ffc90c18d69ebef25d57fa4a121e9beb43106e0c392067372c2a8f91290c522e`; the schema SHA256 is `df25bd9a8b2f0ed67a36858abd221de0e15a4e716be448ddfb0a305077c84848`. Local equality and actual container application passed. A later schema change must regenerate/review this baseline; never apply the empty-database bootstrap to an existing database.
- No data is migrated from Postiz Cloud. No Postiz Cloud credential, token, OAuth app secret or database export is copied or assumed. Organizations and channels in the new database come only from the separate, future account-consent flow.

## Operating constraints (operator-stated, unchanged by this package)

- Access window: 7-day access; the customer's Postiz expiry is **2026-11-10 23:00 UTC**. This package does not extend, depend on or migrate anything from it.
- Rate: 200 requests / hour per organization, shared across every managed route and credential (Redis). Token attempts: 300 / hour per client address (`req.ip`, counting authenticated requests too, so one address serving more than one organization shares it). Failed authentications: 3,000 / hour across all addresses. A valid credential is never counted there, so exhausting it doesn't take the organizations' budget, though failing requests then get `429` instead of `401`.
- W&W's auto-deploy triggers are empty and stay empty. This package adds no CI/CD, webhook or deploy trigger.
- No spending limit is changed. No paid resource is created.
- No live publishing, scheduling, deleting, reconnecting or spending.

## Local qualification (actual PostgreSQL, Redis and the built artifact)

```sh
pnpm run prisma-generate
pnpm --filter ./apps/backend run build:managed-runtime
node scripts/managed-runtime-local-test.mjs [--pg-bin <dir>] [--redis-bin <dir>]
pnpm exec jest -c jest.managed.config.js --testMatch '**/managed-runtime/__tests__/*.spec.ts'
```

The local test creates its own PostgreSQL cluster (`initdb`, unix socket only) and its own `redis-server` (unix socket, no TCP, no persistence) in a temporary directory, and removes them afterwards. It starts the built `main.js` with a minimal environment (no operator variable is passed). It checks:

- Refusals: mode off, no allowlist, no credentials, an empty credential list, a credential with an extra raw-token field, `POSTIZ_MANAGED_TRUST_PROXY=true`, no Redis, unreachable Redis, R2, an unmarked volume, a group-readable volume and a missing managed schema. After them, the database is still empty and nothing is stored.
- The baseline:
  - A wrong sha256 is refused.
  - A copy whose last statement fails leaves the database empty (atomicity).
  - A copy with its own `BEGIN`/`COMMIT` is refused.
  - Each of these is refused and left untouched: a view in `public`, a `pgx_*` schema, a database setting, a role setting, a publication, a foreign server, default privileges.
  - The real baseline applies to the empty database, `verify` passes, and a second apply is refused.
- Liveness and readiness. Uploads, dashboard, public API, swagger and media routes are not mounted. Managed authentication works.
- A reserved PNG upload over HTTP keeps its exact bytes in the `700` volume and records the durable enrollment.
- Single-instance refusal (after the bounded lease wait), graceful lease release, a managed table missing a column refusing the start, and enrollment-mismatch refusal.
- After a restart: persistence, and the 200 / hour organization budget held in Redis.
- Spoofed `X-Forwarded-For`, `X-Real-IP`, `Forwarded` and `CF-Connecting-IP` headers (rotating, 8 KB): one bound per socket address, at most four fixed-length counter keys, and a valid token gets `429 TOO_MANY_ATTEMPTS` over the bound.
- After a crash, a new start waits until the crashed lease expires (no overlap), then becomes healthy. A `SIGTERM` while a start waits for the lease exits 0 and leaves the live lease untouched.
- Readiness `503` without the storage marker. Exit 1 after Redis loss, logging fixed text only (no `Unhandled error event`, no Redis address).
- No database password or managed token appears in any output.
- Not covered: event triggers (they need a function, which the `public` check already refuses, so their own check isn't isolated), TLS, password authentication, hosted Redis/PostgreSQL. The separate container harness below covers the image.

## Open decisions (not completed)

- **Owner and hosting**: who runs it, where, which provider, region, machine size, cost owner, and the backup/restore and incident process. None was chosen. No resource was created.
- **Provider account consent**: how a customer's social accounts are connected to the new database. This is a separate future flow with the account owner's consent. Until it exists the runtime has no channels, so `POST /managed/v1/posts` has nothing it can target.
- **Credentials**: generating the W&W service tokens, storing them in W&W's secret store, and rotating them (changing `POSTIZ_MANAGED_CREDENTIALS` needs a restart).
- **Database, Redis and network**: provisioning, TLS, private networking, the proxy, and the `FRONTEND_URL` prefix value.
- **Baseline review**: regenerating, reviewing and re-pinning `scripts/managed-runtime-baseline.sql` whenever `schema.prisma` changes (the root operator, after the schema owner's review).
- **Storage identity across restore**: see "Backup and restore". Whether an additive restore-stable storage identity is needed, and its design, is open.
- **Proxy topology**: the hosted proxy's addresses or hop count for `POSTIZ_MANAGED_TRUST_PROXY`, and whether the runtime is reachable other than through it.
- **AGPL-3.0 §13**: the runtime is a modified network service. Offering its source to its remote users (W&W) is the owner's to arrange.
- **R2, multiple instances, hosted proxy behavior, backups and load**: not qualified.

## Local container qualification (4 November 2026)

`node scripts/managed-runtime-container-test.mjs` uses already-present local images. It creates a uniquely labeled internal Docker network, synthetic PostgreSQL18.6 and Redis8.2.1, and one private upload volume. No port is published. HTTP requests run over loopback inside the actual runtime container; no provider is reachable. The harness removes only resources it created.

The image bootstrap, non-root read-only filesystem, readiness, authentication, absence of upstream routes, exact PNG storage, retained upload receipt after restart, shared 200/hour budget across restart and graceful SIGTERM passed. This proves local Linux container behavior, not hosted TLS, backup restoration, upstream identity or personal OAuth consent. The initially attempted host-port harness was corrected to use internal loopback; no application change was needed.

For the qualified local build, the canonical Node22.23.4 image index was pinned to `sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da`. Docker Hub/npm TLS resets required public cache download arguments. `WW_MANAGED_NODE_IMAGE` may use a mirror only at that same digest. `WW_MANAGED_PNPM_URL` is checked against the official pnpm10.6.1 SHA512 before installation; `WW_MANAGED_NPM_REGISTRY` changes dependency transport while `--frozen-lockfile --ignore-scripts` retains dependency integrity. Defaults remain the canonical registries. No daemon-wide mirror configuration was changed.

The qualified image is a local working-tree build, not a committed/deployed release. Record its source manifest and image digest, then build from the reviewed commit before hosted deployment. Documentation or test-only changes after a build do not change which source the image contains.

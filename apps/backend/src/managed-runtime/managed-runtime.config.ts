import { accessSync, constants, lstatSync, Stats } from 'fs';
import { isIP } from 'net';
import { isAbsolute, join } from 'path';
import type { Redis } from 'ioredis';
import { Prisma } from '@prisma/client';
import {
  assertManagedCredentials,
  assertManagedModeConfig,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';

// Startup preconditions of the isolated W&W managed runtime
// (docs/managed-extension/deployment.md). Every refusal names the variable or
// the condition, never a configured value, so no URL, password or token can
// reach a log line.

// Created once by the operator on the persistent volume. A volume that is not
// mounted leaves an empty directory in its place, which has no marker
export const MANAGED_STORAGE_MARKER = '.postiz-managed-storage';

// One runtime per Redis: the observation bound, the local volume and the
// reserved-upload leases are only qualified for a single process
export const MANAGED_RUNTIME_LEASE_KEY = 'managed_runtime_instance';
export const MANAGED_RUNTIME_LEASE_SECONDS = 30;
export const MANAGED_RUNTIME_LEASE_REFRESH_MS = 10000;
export const MANAGED_RUNTIME_CHECK_TIMEOUT_MS = 5000;
// A start retries the lease a little longer than a crashed runtime's lease
// lives, then refuses. SET NX never takes a live lease, so waiting can't
// start a second runtime beside one that still renews
export const MANAGED_RUNTIME_LEASE_RETRY_MS = 2000;
export const MANAGED_RUNTIME_LEASE_ATTEMPTS =
  Math.ceil((MANAGED_RUNTIME_LEASE_SECONDS * 1000) / MANAGED_RUNTIME_LEASE_RETRY_MS) + 3;
// shorter than the lease renewal's, so a readiness probe answers before a
// runtime that lost Redis stops itself
export const MANAGED_RUNTIME_READY_TIMEOUT_MS = 2000;
// one readiness result serves every probe for this long, so unauthenticated
// probes can't multiply database, Redis and filesystem work
export const MANAGED_RUNTIME_READY_CACHE_MS = 2000;
// the whole startup schema check
export const MANAGED_RUNTIME_SCHEMA_TIMEOUT_MS = 30000;

// Trusted proxy hops are bounded: more than this is not a topology this
// runtime is qualified behind
export const MANAGED_RUNTIME_MAX_PROXY_HOPS = 3;
const MAX_TRUSTED_PROXIES = 16;
// no trusted range wider than this, so no entry amounts to "trust everyone"
const MIN_TRUSTED_PREFIX = { 4: 8, 6: 32 } as const;

export const MANAGED_RUNTIME_STATE = 'MANAGED_RUNTIME_STATE';

export class ManagedRuntimeConfigError extends Error {}

// Express `trust proxy`: false (the socket peer is the client), a bounded hop
// count, or the exact addresses / ranges of the proxy in front
export type ManagedTrustProxy = false | number | string[];

export interface ManagedRuntimeConfig {
  host: string;
  port: number;
  uploadDirectory: string;
  trustProxy: ManagedTrustProxy;
}

// what the readiness check compares against: fixed once the process started
export interface ManagedRuntimeState {
  instanceId: string;
  storageNamespace: string;
}

type LeaseClient = Pick<Redis, 'set' | 'get' | 'eval'>;

function refuse(reason: string): never {
  throw new ManagedRuntimeConfigError(reason);
}

// The upload directory must be a real, private directory (no group or other
// access, so nothing but this process' user reads the stored bytes) that
// carries the operator's marker
export function assertPrivateStorageDirectory(directory: string) {
  if (!directory || !isAbsolute(directory)) {
    refuse('UPLOAD_DIRECTORY must be an absolute path');
  }

  let stats: Stats;
  try {
    stats = lstatSync(directory);
  } catch (err) {
    refuse('UPLOAD_DIRECTORY does not exist');
  }

  if (!stats.isDirectory()) {
    refuse('UPLOAD_DIRECTORY must be a directory, not a file or a symlink');
  }

  if (stats.mode & 0o077) {
    refuse('UPLOAD_DIRECTORY must not be accessible by group or others (chmod 700)');
  }

  try {
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (err) {
    refuse('UPLOAD_DIRECTORY is not readable and writable by this process');
  }

  let marker: Stats;
  try {
    marker = lstatSync(join(directory, MANAGED_STORAGE_MARKER));
  } catch (err) {
    refuse(
      `UPLOAD_DIRECTORY has no ${MANAGED_STORAGE_MARKER}: the persistent volume is not mounted or was not initialized`
    );
  }

  if (!marker.isFile()) {
    refuse(`${MANAGED_STORAGE_MARKER} must be a regular file`);
  }
}

function trustedProxyEntry(entry: string) {
  const [address, prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (!version || rest.length || address.includes('%')) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^\d{1,3}$/.test(prefix)) {
    return false;
  }
  const bits = Number(prefix);
  return (
    bits >= MIN_TRUSTED_PREFIX[version as 4 | 6] && bits <= (version === 4 ? 32 : 128)
  );
}

// POSTIZ_MANAGED_TRUST_PROXY. Unset: no proxy is trusted, the client is the
// socket peer and forwarding headers are ignored. A list trusts exactly those
// proxy addresses / ranges, so a caller that reaches the runtime directly is
// still keyed on its own address. A hop count trusts that many proxies
// whatever their address: only for a runtime nothing but its proxy can reach.
// `true`, 0, named ranges and ranges wider than /8 (IPv4) or /32 (IPv6) are
// refused
export function managedTrustProxy(raw: string | undefined): ManagedTrustProxy {
  const value = String(raw ?? '').trim();
  if (!value) {
    return false;
  }

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > MANAGED_RUNTIME_MAX_PROXY_HOPS) {
      refuse(
        `POSTIZ_MANAGED_TRUST_PROXY hop count must be from 1 to ${MANAGED_RUNTIME_MAX_PROXY_HOPS}; unset it to trust no proxy`
      );
    }
    return hops;
  }

  const entries = value.split(',').map((entry) => entry.trim());
  if (
    entries.length > MAX_TRUSTED_PROXIES ||
    !entries.every((entry) => trustedProxyEntry(entry))
  ) {
    refuse(
      `POSTIZ_MANAGED_TRUST_PROXY must be unset, a hop count from 1 to ${MANAGED_RUNTIME_MAX_PROXY_HOPS}, or up to ${MAX_TRUSTED_PROXIES} comma-separated proxy IP addresses or CIDR ranges (at least /${MIN_TRUSTED_PREFIX[4]} for IPv4, /${MIN_TRUSTED_PREFIX[6]} for IPv6)`
    );
  }

  return entries;
}

export function loadManagedRuntimeConfig(): ManagedRuntimeConfig {
  if (process.env.POSTIZ_MANAGED_MODE !== 'enabled') {
    refuse('POSTIZ_MANAGED_MODE must be "enabled": this runtime only serves the managed API');
  }

  if (process.env.MCP_ONLY) {
    refuse('MCP_ONLY must not be set: it unmounts the managed API');
  }

  // the allowlist checks every runtime of the extension runs
  try {
    assertManagedModeConfig();
  } catch (err) {
    refuse((err as Error).message);
  }

  if (!process.env.POSTIZ_MANAGED_CREDENTIALS) {
    refuse('POSTIZ_MANAGED_CREDENTIALS is not set');
  }

  // every entry used as written and at least one usable: a runtime nobody
  // can authenticate against must not report ready
  try {
    assertManagedCredentials();
  } catch (err) {
    refuse((err as Error).message);
  }

  if (!process.env.DATABASE_URL) {
    refuse('DATABASE_URL is not set');
  }

  // without it the shared ioRedis is an in-memory stand-in: no shared rate
  // limit, no token-attempt bound and no instance lease
  if (!process.env.REDIS_URL) {
    refuse('REDIS_URL is not set');
  }

  // R2 create-only writes and private reads are not qualified on hosted
  // infrastructure yet
  if (process.env.STORAGE_PROVIDER !== 'local') {
    refuse('STORAGE_PROVIDER must be exactly "local"');
  }

  // the prefix of every stored media path; it is never served by this runtime
  try {
    new URL(String(process.env.FRONTEND_URL));
  } catch (err) {
    refuse('FRONTEND_URL must be an absolute URL (the stored media path prefix)');
  }

  const uploadDirectory = String(process.env.UPLOAD_DIRECTORY || '');
  assertPrivateStorageDirectory(uploadDirectory);

  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    refuse('PORT must be an integer between 1 and 65535');
  }

  return {
    host: process.env.POSTIZ_MANAGED_RUNTIME_HOST || '127.0.0.1',
    port,
    uploadDirectory,
    trustProxy: managedTrustProxy(process.env.POSTIZ_MANAGED_TRUST_PROXY),
  };
}

// The namespace the reserved uploads are pinned to, read through the same
// storage the managed media service writes with. Another directory, or one
// mounted in its place, is another namespace
export async function managedStorageNamespace(uploadDirectory: string) {
  assertPrivateStorageDirectory(uploadDirectory);

  const storage = UploadFactory.createStorage();
  if (!storage.objectNamespace) {
    refuse('The configured storage has no private namespace');
  }

  return storage.objectNamespace();
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

// A second runtime on the same Redis refuses to start. This guards against an
// accidental second replica; it is a lease, not a fenced lock
export async function acquireManagedRuntimeLease(redis: LeaseClient, instanceId: string) {
  return !!(await redis.set(
    MANAGED_RUNTIME_LEASE_KEY,
    instanceId,
    'EX',
    MANAGED_RUNTIME_LEASE_SECONDS,
    'NX'
  ));
}

export async function holdsManagedRuntimeLease(redis: LeaseClient, instanceId: string) {
  return (await redis.get(MANAGED_RUNTIME_LEASE_KEY)) === instanceId;
}

// Compare and mutate in one Redis command: expiry between GET and EXPIRE/DEL must never renew or remove a successor's lease.
const RENEW_LEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_LEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export async function refreshManagedRuntimeLease(redis: LeaseClient, instanceId: string) {
  return (await redis.eval(RENEW_LEASE, 1, MANAGED_RUNTIME_LEASE_KEY, instanceId, MANAGED_RUNTIME_LEASE_SECONDS)) === 1;
}

export async function releaseManagedRuntimeLease(redis: LeaseClient, instanceId: string) {
  await redis.eval(RELEASE_LEASE, 1, MANAGED_RUNTIME_LEASE_KEY, instanceId);
}

// Retries the lease until it is free, the attempts are used up or `stopped`
// asks to give up (a signal during startup); false means not taken
export async function waitForManagedRuntimeLease(
  redis: LeaseClient,
  instanceId: string,
  stopped: () => boolean,
  retryMs = MANAGED_RUNTIME_LEASE_RETRY_MS,
  attempts = MANAGED_RUNTIME_LEASE_ATTEMPTS
) {
  for (let attempt = 1; !stopped(); attempt++) {
    if (
      await withTimeout(
        acquireManagedRuntimeLease(redis, instanceId),
        MANAGED_RUNTIME_CHECK_TIMEOUT_MS
      )
    ) {
      return true;
    }
    if (attempt >= attempts) {
      return false;
    }
    await new Promise((done) => setTimeout(done, retryMs));
  }

  return false;
}

// The managed models of the Prisma client this build was generated with
export function managedModelNames(): string[] {
  return (Prisma.dmmf?.datamodel.models ?? [])
    .map((model) => model.name)
    .filter((name) => name.startsWith('Managed'));
}

// Each managed model is read once with its full projection (no select), so a
// missing table or column refuses the start instead of failing a request.
// Read-only and through Prisma only. Indexes, constraints and column types are
// not covered: `managed-runtime-schema.mjs verify` is the structural check
export async function assertManagedRuntimeSchema(
  client: object,
  models = managedModelNames()
) {
  if (!models.length) {
    refuse('The Prisma client of this build has no managed model');
  }

  for (const model of models) {
    try {
      await (client as any)[model.charAt(0).toLowerCase() + model.slice(1)].findFirst();
    } catch (err) {
      refuse(
        `The database has no complete ${model} table of this build (run managed-runtime-schema.mjs verify)`
      );
    }
  }
}

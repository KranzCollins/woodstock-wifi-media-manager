process.env.TZ = 'UTC';

import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { managedRateLimit } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { ManagedRuntimeModule } from '@gitroom/backend/managed-runtime/managed-runtime.module';
import { ManagedLifecycleEnvironmentConfiguration } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.configuration';
import { ManagedLifecycleDispatcher } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.dispatcher';
import {
  assertManagedRuntimeSchema,
  loadManagedRuntimeConfig,
  MANAGED_RUNTIME_CHECK_TIMEOUT_MS,
  MANAGED_RUNTIME_LEASE_REFRESH_MS,
  MANAGED_RUNTIME_LEASE_SECONDS,
  MANAGED_RUNTIME_SCHEMA_TIMEOUT_MS,
  ManagedRuntimeConfigError,
  managedStorageNamespace,
  refreshManagedRuntimeLease,
  releaseManagedRuntimeLease,
  waitForManagedRuntimeLease,
  withTimeout,
} from '@gitroom/backend/managed-runtime/managed-runtime.config';

// The isolated W&W managed runtime (docs/managed-extension/deployment.md).
// Every precondition is checked before the port is opened, and a failed one
// exits with 1: unlike the backend's main.ts, a failed listen is not
// swallowed. Nothing here changes the schema.

const logger = new Logger('ManagedRuntime');

// below the 30 s stop grace period the deployment needs (Docker's default of
// 10 s kills the process before it releases the lease)
const STOP_DEADLINE_MS = 20000;

// only our own reasons are logged; a dependency's error can carry a host or
// a URL with credentials
function refuse(reason: string): never {
  logger.error(`Refusing to start: ${reason}`);
  process.exit(1);
}

// Set by SIGTERM / SIGINT. Startup gives up at its next step, and stop()
// waits for the step in flight, so a signal during startup never leaves a
// lease behind that it didn't release
let stopping = false;
let app: NestExpressApplication | undefined;
let instanceId: string | undefined;
let leaseHeld = false;
let refresh: NodeJS.Timeout | undefined;

async function start() {
  let config: ReturnType<typeof loadManagedRuntimeConfig>;
  try {
    config = loadManagedRuntimeConfig();
  } catch (err) {
    refuse(
      err instanceof ManagedRuntimeConfigError
        ? err.message
        : 'the configuration could not be read'
    );
  }

  // without a listener ioredis prints its error, with the Redis host and
  // port, as an unhandled 'error' event. Fixed text, once per outage
  let redisFailing = false;
  ioRedis.on('error', () => {
    if (!redisFailing) {
      redisFailing = true;
      logger.error('Redis connection error');
    }
  });
  ioRedis.on('ready', () => {
    redisFailing = false;
  });

  try {
    if ((await withTimeout(ioRedis.ping(), MANAGED_RUNTIME_CHECK_TIMEOUT_MS)) !== 'PONG') {
      throw new Error();
    }
  } catch (err) {
    refuse('Redis (REDIS_URL) did not answer');
  }

  let storageNamespace: string;
  try {
    storageNamespace = await managedStorageNamespace(config.uploadDirectory);
  } catch (err) {
    refuse(
      err instanceof ManagedRuntimeConfigError
        ? err.message
        : 'the upload directory could not be read'
    );
  }

  if (stopping) {
    return;
  }

  const id = randomUUID();
  instanceId = id;
  // a wiring error rejects (and exits 1 below) instead of aborting
  const nest = await NestFactory.create<NestExpressApplication>(
    ManagedRuntimeModule.register({ instanceId: id, storageNamespace }),
    { abortOnError: false }
  );
  app = nest;
  nest.disable('x-powered-by');
  // the address the token-attempt bound keys on (req.ip)
  nest.set('trust proxy', config.trustProxy);

  // PrismaService connects here and checks the durable enrollment against
  // POSTIZ_MANAGED_ORGANIZATIONS; a mismatch or a missing managed schema
  // exits inside PrismaService
  try {
    await nest.init();
  } catch (err) {
    refuse('the application could not be initialized (DATABASE_URL connection)');
  }

  try {
    await withTimeout(
      assertManagedRuntimeSchema(nest.get(PrismaService)),
      MANAGED_RUNTIME_SCHEMA_TIMEOUT_MS
    );
  } catch (err) {
    refuse(
      err instanceof ManagedRuntimeConfigError
        ? err.message
        : 'the managed schema could not be read in time'
    );
  }

  if (stopping) {
    return;
  }

  let acquired = false;
  try {
    acquired = await waitForManagedRuntimeLease(ioRedis, id, () => stopping);
  } catch (err) {
    // a SET that timed out may still have been applied; only our own lease
    // is ever released
    await withTimeout(
      releaseManagedRuntimeLease(ioRedis, id),
      MANAGED_RUNTIME_CHECK_TIMEOUT_MS
    ).catch(() => undefined);
    refuse('the single-instance lease could not be taken');
  }

  if (!acquired) {
    if (stopping) {
      return;
    }
    refuse('another managed runtime holds the single-instance lease on this Redis');
  }
  leaseHeld = true;

  // a lease that can't be renewed may already be another runtime's: stop
  // rather than run beside it. Renewal goes on while stop() closes the app
  const refreshPresence = async () => {
    const requestedAt = Date.now();
    let held: boolean;
    try {
      held = await withTimeout(
        refreshManagedRuntimeLease(ioRedis, id),
        MANAGED_RUNTIME_CHECK_TIMEOUT_MS
      );
    } catch (err) {
      held = false;
    }

    nest.get(ManagedLifecycleEnvironmentConfiguration).setRuntimePresenceUntil(held && !stopping
      ? new Date(requestedAt + MANAGED_RUNTIME_LEASE_SECONDS * 1000) : null);
    if (!held) {
      logger.error('Lost the single-instance lease or Redis, stopping');
      process.exit(1);
    }
  };
  await refreshPresence();
  refresh = setInterval(refreshPresence, MANAGED_RUNTIME_LEASE_REFRESH_MS);

  if (stopping) {
    return;
  }

  try {
    await nest.listen(config.port, config.host);
  } catch (err) {
    clearInterval(refresh);
    await withTimeout(
      releaseManagedRuntimeLease(ioRedis, id),
      MANAGED_RUNTIME_CHECK_TIMEOUT_MS
    ).catch(() => undefined);
    refuse(`port ${config.port} could not be opened`);
  }

  if (stopping) {
    return;
  }

  nest.get(ManagedLifecycleDispatcher).start();
  logger.log(
    `Managed runtime listening on ${config.host}:${config.port}, ${managedRateLimit()} requests / hour per organization`
  );
}

const startup = start().catch(() => refuse('unexpected startup failure'));

const stop = async (signal: string) => {
  if (stopping) {
    return;
  }
  stopping = true;
  app?.get(ManagedLifecycleEnvironmentConfiguration).setRuntimePresenceUntil(null);
  logger.log(`${signal} received, stopping`);
  setTimeout(() => process.exit(1), STOP_DEADLINE_MS).unref();

  // the startup step in flight finishes first, so whether a lease was taken
  // is known
  await startup;

  let code = 0;
  try {
    // in-flight requests finish while the lease is still being renewed
    await app?.close();
  } catch (err) {
    code = 1;
  }

  clearInterval(refresh);
  if (leaseHeld && instanceId) {
    try {
      await withTimeout(
        releaseManagedRuntimeLease(ioRedis, instanceId),
        MANAGED_RUNTIME_CHECK_TIMEOUT_MS
      );
    } catch (err) {
      code = 1;
    }
  }

  await withTimeout(ioRedis.quit(), MANAGED_RUNTIME_CHECK_TIMEOUT_MS).catch(
    () => undefined
  );
  process.exit(code);
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

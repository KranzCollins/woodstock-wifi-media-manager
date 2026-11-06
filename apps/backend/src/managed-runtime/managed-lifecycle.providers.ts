import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { ManagedRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.repository';
import { ManagedLifecycleRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.repository';
import { ManagedLifecycleService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.service';
import { ManagedLifecycleMediaRepository } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-repository';
import { ManagedLifecycleMediaStorage } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-storage';
import { ManagedMediaCapabilityService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.media-capability';
import { ManagedLifecycleDispatchAuthority } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.dispatch-authority';
import { ManagedLifecycleDispatcher } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.dispatcher';
import { ManagedLifecycleEnvironmentConfiguration, managedLifecycleMediaKeys, managedLifecycleMediaOrigin,
  parseManagedLifecycleConfiguration } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.lifecycle.configuration';
import { InstagramStandalonePublishAdapter, ManagedPublishAdapter } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.publish.provider';
import { SharedManagedRequestBudget, ManagedRequestBudget } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.request.budget';

// Dependency injection seams for isolated tests; no caller or HTTP setting
// can substitute an adapter, credential, clock or outbound transport.
export const MANAGED_LIFECYCLE_ENVIRONMENT = Symbol('managed lifecycle environment');
export const MANAGED_LIFECYCLE_CLOCK = Symbol('managed lifecycle clock');
export const MANAGED_LIFECYCLE_FETCH = Symbol('managed lifecycle fetch');
export const MANAGED_LIFECYCLE_BUDGET = Symbol('managed lifecycle shared budget');
export const MANAGED_LIFECYCLE_ADAPTERS = Symbol('managed lifecycle adapters');
type Environment = () => Readonly<Record<string, string | undefined>>;
type Clock = () => Date;

export const managedLifecycleProviders = [
  { provide: MANAGED_LIFECYCLE_ENVIRONMENT, useFactory: (): Environment => () => process.env },
  { provide: MANAGED_LIFECYCLE_CLOCK, useFactory: (): Clock => () => new Date() },
  { provide: MANAGED_LIFECYCLE_FETCH, useFactory: () => globalThis.fetch.bind(globalThis) },
  { provide: MANAGED_LIFECYCLE_BUDGET, useFactory: () => new SharedManagedRequestBudget(new ThrottlerStorageRedisService(ioRedis)) },
  { provide: ManagedLifecycleEnvironmentConfiguration, inject: [MANAGED_LIFECYCLE_ENVIRONMENT, MANAGED_LIFECYCLE_CLOCK],
    useFactory: (env: Environment, now: Clock) => new ManagedLifecycleEnvironmentConfiguration(env, undefined, () => now().getTime()) },
  { provide: MANAGED_LIFECYCLE_ADAPTERS, inject: [MANAGED_LIFECYCLE_ENVIRONMENT], useFactory: (env: Environment) => {
    const adapter = new InstagramStandalonePublishAdapter({ mediaOrigin: managedLifecycleMediaOrigin(env().POSTIZ_MANAGED_MEDIA_PUBLIC_ORIGIN) });
    return new Map([[adapter.identifier, adapter]]);
  } },
  { provide: ManagedLifecycleRepository, inject: [PrismaTransaction], useFactory: (transaction: PrismaTransaction) => new ManagedLifecycleRepository(transaction) },
  ManagedLifecycleMediaRepository,
  { provide: ManagedLifecycleMediaStorage, inject: [ManagedRepository],
    useFactory: (repository: ManagedRepository) => new ManagedLifecycleMediaStorage(repository, UploadFactory.createStorage()) },
  { provide: ManagedLifecycleService,
    inject: [ManagedLifecycleRepository, ManagedLifecycleMediaStorage, ManagedLifecycleEnvironmentConfiguration, MANAGED_LIFECYCLE_CLOCK, MANAGED_LIFECYCLE_ADAPTERS],
    useFactory: (repository: ManagedLifecycleRepository, storage: ManagedLifecycleMediaStorage, configuration: ManagedLifecycleEnvironmentConfiguration,
      now: Clock, adapters: ReadonlyMap<string, ManagedPublishAdapter>) => new ManagedLifecycleService(repository, storage, configuration, { now }, adapters) },
  { provide: ManagedLifecycleDispatchAuthority,
    inject: [ManagedLifecycleRepository, ManagedLifecycleMediaStorage, ManagedLifecycleEnvironmentConfiguration, MANAGED_LIFECYCLE_ADAPTERS, MANAGED_LIFECYCLE_CLOCK],
    useFactory: (repository: ManagedLifecycleRepository, storage: ManagedLifecycleMediaStorage, configuration: ManagedLifecycleEnvironmentConfiguration,
      adapters: ReadonlyMap<string, ManagedPublishAdapter>, now: Clock) => new ManagedLifecycleDispatchAuthority(repository, storage, configuration, adapters, now) },
  { provide: ManagedMediaCapabilityService,
    inject: [ManagedLifecycleMediaRepository, ManagedLifecycleMediaStorage, ManagedLifecycleDispatchAuthority,
      MANAGED_LIFECYCLE_BUDGET, MANAGED_LIFECYCLE_CLOCK, MANAGED_LIFECYCLE_ENVIRONMENT],
    useFactory: (store: ManagedLifecycleMediaRepository, storage: ManagedLifecycleMediaStorage, authority: ManagedLifecycleDispatchAuthority,
      budget: ManagedRequestBudget, now: Clock, env: Environment) => new ManagedMediaCapabilityService({ store, storage, authority, budget,
        clock: { now }, keys: managedLifecycleMediaKeys(env()) }) },
  { provide: ManagedLifecycleDispatcher,
    inject: [ManagedLifecycleRepository, ManagedLifecycleService, ManagedLifecycleDispatchAuthority, ManagedMediaCapabilityService,
      MANAGED_LIFECYCLE_BUDGET, MANAGED_LIFECYCLE_ADAPTERS, ManagedLifecycleEnvironmentConfiguration,
      MANAGED_LIFECYCLE_ENVIRONMENT, MANAGED_LIFECYCLE_CLOCK, MANAGED_LIFECYCLE_FETCH],
    useFactory: (repository: ManagedLifecycleRepository, service: ManagedLifecycleService, authority: ManagedLifecycleDispatchAuthority,
      media: ManagedMediaCapabilityService, budget: ManagedRequestBudget, adapters: ReadonlyMap<string, ManagedPublishAdapter>,
      configuration: ManagedLifecycleEnvironmentConfiguration, env: Environment, now: Clock, fetch: typeof globalThis.fetch) =>
      new ManagedLifecycleDispatcher({ repository, service, authority, media, budget, adapters, now, fetch,
        configuration: () => configuration.hasRuntimePresence() ? parseManagedLifecycleConfiguration(env()) : null }) },
];

import { isManagedModeEnabled, isManagedOrganization } from './managed.mode';
import { lifecyclePolicyRefusal, ManagedLifecyclePolicy } from './managed.lifecycle.contracts';
import type { ManagedLifecycleConfiguration, ManagedLifecycleConfiguredGates } from './managed.lifecycle.service';
import type { ManagedMediaCapabilityKeys } from './managed.lifecycle.media-capability';

// Operator configuration, never a caller-supplied policy. No setting enables
// itself and a malformed value closes the whole lifecycle configuration.
// Presence is set only by the isolated runtime after it owns its Redis lease;
// mounting the API in the upstream backend cannot make it a dispatcher.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;
const PROVIDERS = ['instagram-standalone'];
type Environment = Readonly<Record<string, string | undefined>>;
export type ManagedLifecycleOperatorConfig = Readonly<{
  organizations: readonly string[];
  providers: readonly string[];
  dispatcherEnabled: boolean;
  policy: ManagedLifecyclePolicy;
  mediaOrigin: string;
}>;

function list(raw: string | undefined, allowed?: readonly string[]): readonly string[] | null {
  if (!raw || raw.length > 4096) return null;
  const values = raw.split(',');
  if (!values.length || values.length > 64 || values.some(value => !ID.test(value)) ||
      new Set(values).size !== values.length || (allowed && values.some(value => !allowed.includes(value)))) return null;
  return Object.freeze(values);
}

export function managedLifecycleMediaOrigin(raw: string | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/' && (raw === url.origin || raw === url.origin + '/') ? url.origin : null;
  } catch { return null; }
}

// Returned only to private runtime composition, never configuration facts,
// capabilities, logs or projections. An invalid ring is never partly used.
export function managedLifecycleMediaKeys(env: Environment): ManagedMediaCapabilityKeys | null {
  const raw = env.POSTIZ_MANAGED_MEDIA_CAPABILITY_KEYS;
  if (!raw || raw.length > 4096) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join() !== 'activeKeyId,keys' || !KEY_ID.test(value.activeKeyId) ||
        !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 4) return null;
    const seen = new Set<string>();
    const keys: { id: string; secret: Buffer }[] = [];
    for (const key of value.keys) {
      if (!key || typeof key !== 'object' || Array.isArray(key) || Object.keys(key).sort().join() !== 'id,secretHex' ||
          typeof key.id !== 'string' || !KEY_ID.test(key.id) || seen.has(key.id) ||
          typeof key.secretHex !== 'string' || !/^[a-f0-9]{64,128}$/.test(key.secretHex) || key.secretHex.length % 2) return null;
      seen.add(key.id); keys.push({ id: key.id, secret: Buffer.from(key.secretHex, 'hex') });
    }
    return seen.has(value.activeKeyId) ? { activeKeyId: value.activeKeyId, keys } : null;
  } catch { return null; }
}

export function parseManagedLifecycleConfiguration(env: Environment): ManagedLifecycleOperatorConfig | null {
  const organizations = list(env.POSTIZ_MANAGED_LIFECYCLE_ORGANIZATIONS);
  const providers = list(env.POSTIZ_MANAGED_LIFECYCLE_PROVIDERS, PROVIDERS);
  const grantedAt = env.POSTIZ_MANAGED_LIFECYCLE_GRANTED_AT;
  const expiresAt = env.POSTIZ_MANAGED_LIFECYCLE_EXPIRES_AT;
  const mediaOrigin = managedLifecycleMediaOrigin(env.POSTIZ_MANAGED_MEDIA_PUBLIC_ORIGIN);
  if (!organizations || !providers || !grantedAt || !expiresAt || !INSTANT.test(grantedAt) || !INSTANT.test(expiresAt) ||
      !mediaOrigin || !managedLifecycleMediaKeys(env) ||
      !['enabled', 'disabled', undefined].includes(env.POSTIZ_MANAGED_DISPATCHER)) return null;
  const policy = { grantedAt: new Date(grantedAt), expiresAt: new Date(expiresAt) };
  if (!Number.isFinite(policy.grantedAt.getTime()) || !Number.isFinite(policy.expiresAt.getTime()) ||
      policy.grantedAt.toISOString() !== grantedAt || policy.expiresAt.toISOString() !== expiresAt ||
      lifecyclePolicyRefusal(policy, policy.grantedAt)) return null;
  return Object.freeze({ organizations, providers, policy, mediaOrigin,
    dispatcherEnabled: env.POSTIZ_MANAGED_DISPATCHER === 'enabled' });
}

export class ManagedLifecycleEnvironmentConfiguration implements ManagedLifecycleConfiguration {
  #presentUntil = 0;
  constructor(private readonly environment: () => Environment = () => process.env,
    private readonly enrolled: (organizationId: string) => boolean = organizationId =>
      isManagedModeEnabled() && isManagedOrganization(organizationId),
    private readonly now: () => number = Date.now) {}

  // The runtime supplies the conservative expiry of its successful Redis
  // lease request. A stalled renewal cannot leave an evergreen boolean on.
  setRuntimePresenceUntil(until: Date | null): void {
    const at = this.now(), end = until?.getTime() ?? 0;
    this.#presentUntil = Number.isFinite(at) && Number.isFinite(end) && end > at && end <= at + 30_000 ? end : 0;
  }

  hasRuntimePresence(): boolean { return this.now() < this.#presentUntil; }

  async gates(organizationId: string): Promise<ManagedLifecycleConfiguredGates | null> {
    const config = parseManagedLifecycleConfiguration(this.environment());
    if (!config || !this.enrolled(organizationId) || !config.organizations.includes(organizationId)) return null;
    const present = this.now() < this.#presentUntil;
    return { organizationEnabled: true, dispatcherAvailable: present && config.dispatcherEnabled,
      mediaDeliveryReady: present, policy: config.policy, providers: config.providers };
  }
}

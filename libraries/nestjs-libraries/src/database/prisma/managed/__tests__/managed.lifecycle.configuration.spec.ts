import { ManagedLifecycleEnvironmentConfiguration, managedLifecycleMediaKeys,
  parseManagedLifecycleConfiguration } from '../managed.lifecycle.configuration';

const configured = (): Record<string, string | undefined> => ({
  POSTIZ_MANAGED_LIFECYCLE_ORGANIZATIONS: 'isolated-test',
  POSTIZ_MANAGED_LIFECYCLE_PROVIDERS: 'instagram-standalone',
  POSTIZ_MANAGED_LIFECYCLE_GRANTED_AT: '2026-11-04T00:00:00.000Z',
  POSTIZ_MANAGED_LIFECYCLE_EXPIRES_AT: '2026-11-10T23:00:00.000Z',
  POSTIZ_MANAGED_MEDIA_PUBLIC_ORIGIN: 'https://media.ww.test',
  POSTIZ_MANAGED_MEDIA_CAPABILITY_KEYS: JSON.stringify({ activeKeyId: 'test', keys: [{ id: 'test', secretHex: 'ab'.repeat(32) }] }),
  POSTIZ_MANAGED_DISPATCHER: 'enabled',
});

describe('operator lifecycle configuration', () => {
  it('requires explicit bounded configuration and runtime ownership; clearing it revokes the gates', async () => {
    let env = configured();
    let now = Date.parse('2026-11-05T00:00:00.000Z');
    const config = new ManagedLifecycleEnvironmentConfiguration(() => env, id => id === 'isolated-test', () => now);
    expect(await config.gates('isolated-test')).toMatchObject({ dispatcherAvailable: false, mediaDeliveryReady: false });
    config.setRuntimePresenceUntil(new Date(now + 30_000));
    expect(await config.gates('isolated-test')).toMatchObject({ dispatcherAvailable: true, mediaDeliveryReady: true });
    expect(await config.gates('foreign')).toBeNull();
    now += 30_000;
    expect(await config.gates('isolated-test')).toMatchObject({ dispatcherAvailable: false, mediaDeliveryReady: false });
    config.setRuntimePresenceUntil(new Date(now + 30_001));
    expect(await config.gates('isolated-test')).toMatchObject({ dispatcherAvailable: false });
    config.setRuntimePresenceUntil(new Date(now + 30_000));
    expect(await config.gates('isolated-test')).toMatchObject({ dispatcherAvailable: true });
    config.setRuntimePresenceUntil(null);
    expect(await config.gates('isolated-test')).toMatchObject({ dispatcherAvailable: false });
    env = {};
    expect(await config.gates('isolated-test')).toBeNull();
  });

  it.each([
    ['POSTIZ_MANAGED_LIFECYCLE_ORGANIZATIONS', 'isolated-test,isolated-test'],
    ['POSTIZ_MANAGED_LIFECYCLE_ORGANIZATIONS', 'isolated-test, foreign'],
    ['POSTIZ_MANAGED_LIFECYCLE_PROVIDERS', 'instagram'],
    ['POSTIZ_MANAGED_LIFECYCLE_GRANTED_AT', '2026-11-01T00:00:00.000Z'],
    ['POSTIZ_MANAGED_LIFECYCLE_GRANTED_AT', '2026-11-04T00:00:00Z'],
    ['POSTIZ_MANAGED_LIFECYCLE_EXPIRES_AT', '2026-11-11T00:00:00.000Z'],
    ['POSTIZ_MANAGED_LIFECYCLE_EXPIRES_AT', '2026-11-04T00:00:00.000Z'],
    ['POSTIZ_MANAGED_MEDIA_PUBLIC_ORIGIN', 'http://media.ww.test'],
    ['POSTIZ_MANAGED_MEDIA_PUBLIC_ORIGIN', 'https://user:password@media.ww.test'],
    ['POSTIZ_MANAGED_MEDIA_PUBLIC_ORIGIN', 'https://media.ww.test/path'],
    ['POSTIZ_MANAGED_MEDIA_PUBLIC_ORIGIN', 'https://media.ww.test?token=x'],
    ['POSTIZ_MANAGED_DISPATCHER', 'true'],
  ])('refuses a malformed %s without partly using the other fields', (key, value) => {
    expect(parseManagedLifecycleConfiguration({ ...configured(), [key]: value })).toBeNull();
  });

  it('fails closed with no settings and no implicit dispatcher switch', () => {
    expect(parseManagedLifecycleConfiguration({})).toBeNull();
    expect(parseManagedLifecycleConfiguration({ ...configured(), POSTIZ_MANAGED_DISPATCHER: undefined }))
      .toMatchObject({ dispatcherEnabled: false });
  });

  it.each([
    { activeKeyId: 'missing', keys: [{ id: 'test', secretHex: 'ab'.repeat(32) }] },
    { activeKeyId: 'test', keys: [{ id: 'test', secretHex: 'ab' }] },
    { activeKeyId: 'test', keys: [{ id: 'test', secretHex: 'ab'.repeat(32), secret: 'extra' }] },
    { activeKeyId: 'test', keys: [1, 2].map(() => ({ id: 'test', secretHex: 'ab'.repeat(32) })) },
  ])('refuses a broken keyring as a whole', value => {
    expect(managedLifecycleMediaKeys({ POSTIZ_MANAGED_MEDIA_CAPABILITY_KEYS: JSON.stringify(value) })).toBeNull();
  });
});

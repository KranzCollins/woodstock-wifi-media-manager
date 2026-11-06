import { Logger } from '@nestjs/common';
import {
  assertManagedCredentials,
  assertManagedModeConfig,
  findManagedCredential,
  isManagedModeEnabled,
  isManagedOrganization,
  managedRateLimit,
  sha256Hex,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';

const ORG = 'a1111111-1111-4111-8111-111111111111';
const TOKEN = 'FAKE-managed-token-0123456789abcdef-0123456789';

const credential = (over: any = {}) => ({
  id: 'ww-local',
  organizationId: ORG,
  tokenSha256: sha256Hex(TOKEN),
  scopes: ['posts:read', 'posts:write'],
  ...over,
});

describe('managed mode configuration', () => {
  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
    delete process.env.POSTIZ_MANAGED_CREDENTIALS;
  });

  it('is disabled by default, even with an allowlist and credentials', () => {
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
    process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([credential()]);

    expect(isManagedModeEnabled()).toBe(false);
    expect(isManagedOrganization(ORG)).toBe(false);
    expect(findManagedCredential(TOKEN)).toBeUndefined();

    for (const value of ['true', '1', 'ENABLED', 'enabled ']) {
      process.env.POSTIZ_MANAGED_MODE = value;
      expect(isManagedModeEnabled()).toBe(false);
    }
  });

  it('matches organizations exactly', () => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ` ${ORG} , *, not valid! `;

    expect(isManagedOrganization(ORG)).toBe(true);
    expect(isManagedOrganization(ORG.slice(0, 10))).toBe(false);
    expect(isManagedOrganization(ORG.toUpperCase())).toBe(false);
    expect(isManagedOrganization('*')).toBe(false);
    expect(isManagedOrganization(undefined)).toBe(false);
    expect(isManagedOrganization(null)).toBe(false);
  });

  it('binds a token to its credential and organization', () => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
    process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([credential()]);

    expect(findManagedCredential(TOKEN)).toEqual(credential());
    expect(findManagedCredential(TOKEN + 'x')).toBeUndefined();
    expect(findManagedCredential(sha256Hex(TOKEN))).toBeUndefined();
    expect(findManagedCredential('short')).toBeUndefined();
    expect(findManagedCredential(undefined)).toBeUndefined();
  });

  it('ignores credentials for organizations off the allowlist, unknown scopes and ambiguous entries', () => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;

    process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([
      credential({ organizationId: '99999999-9999-4999-8999-999999999999' }),
    ]);
    expect(findManagedCredential(TOKEN)).toBeUndefined();

    process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([
      credential({ scopes: ['admin', 'billing:topup'] }),
    ]);
    expect(findManagedCredential(TOKEN)).toBeUndefined();

    process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([
      credential({ scopes: ['posts:read', 'admin'] }),
    ]);
    expect(findManagedCredential(TOKEN)?.scopes).toEqual(['posts:read']);

    process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([
      credential(),
      credential({ id: 'ww-copy' }),
    ]);
    expect(findManagedCredential(TOKEN)).toBeUndefined();
  });

  it('stops the process at boot instead of running with less enrollment than configured', () => {
    const boot = (env: Record<string, string>) => {
      Object.assign(process.env, env);
      try {
        assertManagedModeConfig();
        return 'started';
      } catch (err) {
        return 'stopped';
      } finally {
        delete process.env.POSTIZ_MANAGED_MODE;
        delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
      }
    };

    expect(boot({})).toBe('started');
    expect(boot({ POSTIZ_MANAGED_MODE: 'disabled', POSTIZ_MANAGED_ORGANIZATIONS: ORG })).toBe(
      'started'
    );
    expect(boot({ POSTIZ_MANAGED_MODE: 'enabled', POSTIZ_MANAGED_ORGANIZATIONS: ORG })).toBe(
      'started'
    );

    // a typo would silently leave this process unguarded
    expect(boot({ POSTIZ_MANAGED_MODE: 'true', POSTIZ_MANAGED_ORGANIZATIONS: ORG })).toBe(
      'stopped'
    );
    expect(boot({ POSTIZ_MANAGED_MODE: 'enabled' })).toBe('stopped');
    expect(boot({ POSTIZ_MANAGED_MODE: 'enabled', POSTIZ_MANAGED_ORGANIZATIONS: ' , ' })).toBe(
      'stopped'
    );
    expect(
      boot({ POSTIZ_MANAGED_MODE: 'enabled', POSTIZ_MANAGED_ORGANIZATIONS: `${ORG},*` })
    ).toBe('stopped');
  });

  it('caps the managed rate limit at 200 / hour; the environment can only lower it', () => {
    expect(managedRateLimit()).toBe(200);
    process.env.POSTIZ_MANAGED_RATE_LIMIT = '600';
    expect(managedRateLimit()).toBe(200);
    process.env.POSTIZ_MANAGED_RATE_LIMIT = '50';
    expect(managedRateLimit()).toBe(50);
    process.env.POSTIZ_MANAGED_RATE_LIMIT = 'abc';
    expect(managedRateLimit()).toBe(200);
    delete process.env.POSTIZ_MANAGED_RATE_LIMIT;
  });

  it('fails closed on malformed configuration', () => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;

    for (const raw of ['not json', '{"id":"x"}', '[{"id":"ww"}]', 'null']) {
      process.env.POSTIZ_MANAGED_CREDENTIALS = raw;
      expect(findManagedCredential(TOKEN)).toBeUndefined();
    }
  });

  it('logs every unused or partly used entry by position, never an id, digest or token', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      process.env.POSTIZ_MANAGED_MODE = 'enabled';
      process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
      process.env.POSTIZ_MANAGED_CREDENTIALS = JSON.stringify([
        credential({ id: `${TOKEN}!` }),
        credential({ tokenSha256: TOKEN }),
        credential({ token: TOKEN }),
      ]);

      // the lenient process still uses the entry that is only partly valid
      expect(findManagedCredential(TOKEN)?.id).toBe('ww-local');

      const logged = warn.mock.calls.map(([message]) => String(message)).join('\n');
      expect(logged).toContain('entry 1 has an invalid id');
      expect(logged).toContain('entry 2 has no tokenSha256');
      expect(logged).toContain('entry 3 has a field other than');
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(sha256Hex(TOKEN));
      expect(logged).not.toContain('ww-local');
    } finally {
      warn.mockRestore();
    }
  });

  it('strictly: refuses unless every entry is used as written and one authenticates', () => {
    const strict = (value: unknown) => {
      process.env.POSTIZ_MANAGED_CREDENTIALS =
        typeof value === 'string' ? value : JSON.stringify(value);
      try {
        assertManagedCredentials();
        return 'started';
      } catch (err) {
        expect((err as Error).message).not.toContain(TOKEN);
        expect((err as Error).message).not.toContain(sha256Hex(TOKEN));
        return (err as Error).message;
      }
    };

    process.env.POSTIZ_MANAGED_ORGANIZATIONS = ORG;
    expect(strict([credential()])).toContain('not "enabled"');

    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    expect(strict([credential()])).toBe('started');
    expect(strict([credential(), credential({ id: 'ww-other', tokenSha256: sha256Hex(`${TOKEN}-2`) })])).toBe('started');

    expect(strict([])).toContain('no usable credential');
    expect(strict('')).toContain('no usable credential');
    expect(strict('not json')).toContain('is not valid JSON');
    expect(strict({})).toContain('must be a JSON array');
    expect(strict([credential({ scopes: ['posts:read', 'admin'] })])).toContain('entry 1 has an unknown scope');
    expect(strict([credential({ scopes: [] })])).toContain('entry 1 has no known scope');
    expect(strict([credential(), null])).toContain('entry 2 is not an object');
    expect(strict([credential(), credential({ id: 'ww-copy' })])).toContain('entry 1 shares');
    expect(strict([credential({ organizationId: 'b2222222-2222-4222-8222-222222222222' })])).toContain(
      'entry 1 names an organization'
    );
  });
});

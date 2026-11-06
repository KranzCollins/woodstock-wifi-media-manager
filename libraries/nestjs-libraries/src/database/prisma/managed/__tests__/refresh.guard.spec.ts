jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/integrations/integration.service', () => ({
  IntegrationService: class {},
}));

import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';

const MANAGED = '11111111-1111-4111-8111-111111111111';
const UNMANAGED = '99999999-9999-4999-8999-999999999999';

describe('RefreshIntegrationService in a managed organization', () => {
  // FAKE provider whose refresh would be an external call
  const provider = {
    refreshToken: jest.fn(async () => ({
      accessToken: 'FAKE-new',
      refreshToken: 'FAKE-refresh',
      expiresIn: 100,
    })),
  };
  const integrationManager = { getSocialIntegration: jest.fn(() => provider) };
  const integrationService = {
    createOrUpdateIntegration: jest.fn(async () => undefined),
    refreshNeeded: jest.fn(),
  };
  const service = new RefreshIntegrationService(
    integrationManager as any,
    integrationService as any,
    {} as any
  );

  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = MANAGED;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
  });

  it('never calls the provider or rewrites the channel', async () => {
    expect(
      await service.refresh({ organizationId: MANAGED, providerIdentifier: 'x' } as any)
    ).toBe(false);
    expect(integrationManager.getSocialIntegration).not.toHaveBeenCalled();
    expect(provider.refreshToken).not.toHaveBeenCalled();
    expect(integrationService.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  it('refreshes an unmanaged organization as before', async () => {
    await service.refresh({
      organizationId: UNMANAGED,
      providerIdentifier: 'x',
      internalId: 'i',
      rootInternalId: 'i',
    } as any);
    expect(provider.refreshToken).toHaveBeenCalledTimes(1);
    expect(integrationService.createOrUpdateIntegration).toHaveBeenCalledTimes(1);
  });
});

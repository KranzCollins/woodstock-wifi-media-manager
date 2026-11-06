// the connection service loads ManagedService (for identityFingerprint),
// which pulls in the media helpers; no storage or sniffer is used here
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({}));
jest.mock(
  'file-type',
  () => ({ fileTypeStream: jest.fn(), fileTypeFromBuffer: jest.fn() }),
  { virtual: true }
);

import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ThrottlerManagedCredentialGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import {
  MANAGED_SCOPE_KEY,
  ManagedScopeGuard,
} from '@gitroom/backend/services/auth/managed.scope.guard';
import {
  MANAGED_CONNECTION_ROUTE_SCOPES,
  ManagedConnectionController,
} from '@gitroom/backend/managed-api/managed.connection.controller';

const handler = (name: string) => (ManagedConnectionController.prototype as any)[name];
const handlers = Object.getOwnPropertyNames(ManagedConnectionController.prototype).filter(
  (name) => name !== 'constructor'
);

// FAKE credentials, as ManagedAuthMiddleware would attach them
const AI = { id: 'ww-mcp', organizationId: 'org', scopes: ['channels:connect'] };
const RELAY = { id: 'ww-relay', organizationId: 'org', scopes: ['channels:connect-callback'] };
const TODAY = {
  id: 'ww-today',
  organizationId: 'org',
  scopes: ['channels:read', 'channels:qualify', 'posts:read', 'posts:write', 'media:write', 'media:upload'],
};

function allowed(name: string, credential: unknown) {
  const guard = new ManagedScopeGuard(new Reflector());
  try {
    return guard.canActivate({
      getHandler: () => handler(name),
      switchToHttp: () => ({ getRequest: () => ({ managedCredential: credential }) }),
    } as any);
  } catch (err: any) {
    return err.getResponse().code;
  }
}

describe('ManagedConnectionController', () => {
  it('mounts exactly these routes under /managed/v1/connections', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ManagedConnectionController)).toBe(
      '/managed/v1/connections'
    );
    expect(
      Object.fromEntries(
        handlers.map((name) => [
          name,
          [
            Reflect.getMetadata(METHOD_METADATA, handler(name)),
            Reflect.getMetadata(PATH_METADATA, handler(name)),
          ],
        ])
      )
    ).toEqual({
      createIntent: [RequestMethod.POST, '/intents'],
      getIntent: [RequestMethod.GET, '/intents/:intentId'],
      cancelIntent: [RequestMethod.POST, '/intents/:intentId/cancel'],
      retryIntent: [RequestMethod.POST, '/intents/:intentId/retry'],
      recoverIntent: [RequestMethod.POST, '/intents/:intentId/recover'],
      authorize: [RequestMethod.POST, '/intents/:intentId/authorization'],
      callback: [RequestMethod.POST, '/intents/:intentId/callback'],
    });
  });

  it('declares one scope per route through the existing guard metadata, and the same guards as the managed API', () => {
    for (const name of handlers) {
      expect([name, Reflect.getMetadata(MANAGED_SCOPE_KEY, handler(name))]).toEqual([
        name,
        (MANAGED_CONNECTION_ROUTE_SCOPES as any)[name],
      ]);
      expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler(name))).toBeUndefined();
    }
    expect(Reflect.getMetadata(GUARDS_METADATA, ManagedConnectionController)).toEqual([
      ThrottlerManagedCredentialGuard,
      ManagedScopeGuard,
    ]);
  });

  it('keeps the relay routes from the AI-facing credential and the intent routes from the relay', () => {
    for (const name of ['createIntent', 'getIntent', 'cancelIntent', 'retryIntent', 'recoverIntent']) {
      expect([name, allowed(name, AI), allowed(name, RELAY)]).toEqual([name, true, 'SCOPE_MISSING']);
    }
    for (const name of ['authorize', 'callback']) {
      expect([name, allowed(name, AI), allowed(name, RELAY)]).toEqual([name, 'SCOPE_MISSING', true]);
    }
  });

  it('opens no route to a credential holding only the scopes that exist today', () => {
    for (const name of handlers) {
      expect([name, allowed(name, TODAY)]).toEqual([name, 'SCOPE_MISSING']);
    }
  });

  it('marks the answers that carry a state or an outcome as not cacheable', () => {
    for (const name of ['authorize', 'callback']) {
      expect(Reflect.getMetadata(HEADERS_METADATA, handler(name))).toEqual([
        { name: 'Cache-Control', value: 'no-store' },
      ]);
    }
  });

  it('passes the organization and credential from the request, never from the body', async () => {
    const service = {
      createIntent: jest.fn(async () => 'created'),
      authorize: jest.fn(async () => 'authorized'),
      callback: jest.fn(async () => 'relayed'),
    };
    const controller = new ManagedConnectionController(service as any);
    const body = { operationKey: 'k'.repeat(8) } as any;

    await controller.createIntent(AI as any, body);
    expect(service.createIntent).toHaveBeenCalledWith('org', 'ww-mcp', body);

    await controller.authorize(RELAY as any, 'intent');
    expect(service.authorize).toHaveBeenCalledWith(RELAY, 'intent');

    await controller.callback(RELAY as any, 'intent', { state: 's' } as any);
    expect(service.callback).toHaveBeenCalledWith(RELAY, 'intent', { state: 's' });
  });
});

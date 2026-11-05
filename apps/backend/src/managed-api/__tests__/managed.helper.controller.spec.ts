// the helper service loads ManagedService (for identityFingerprint), which
// pulls in the media helpers; no storage or sniffer is used here
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({}));
jest.mock(
  'file-type',
  () => ({ fileTypeStream: jest.fn(), fileTypeFromBuffer: jest.fn() }),
  { virtual: true }
);

import { EventEmitter } from 'events';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ThrottlerManagedCredentialGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import {
  MANAGED_SCOPE_KEY,
  ManagedScopeGuard,
} from '@gitroom/backend/services/auth/managed.scope.guard';
import { ManagedHelperController } from '@gitroom/backend/managed-api/managed.helper.controller';

const handlers = Object.getOwnPropertyNames(ManagedHelperController.prototype).filter(
  (name) => name !== 'constructor'
);
const call = ManagedHelperController.prototype.call;

// FAKE credentials, as ManagedAuthMiddleware would attach them
const HELPER = { id: 'ww-helper', organizationId: 'org', scopes: ['helpers:read'] };
const TODAY = {
  id: 'ww-today',
  organizationId: 'org',
  scopes: ['channels:read', 'channels:qualify', 'channels:connect', 'posts:read', 'posts:write', 'media:write', 'media:upload'],
};

function allowed(credential: unknown) {
  const guard = new ManagedScopeGuard(new Reflector());
  try {
    return guard.canActivate({
      getHandler: () => call,
      switchToHttp: () => ({ getRequest: () => ({ managedCredential: credential }) }),
    } as any);
  } catch (err: any) {
    return err.getResponse().code;
  }
}

function fakeResponse(state: { destroyed?: boolean } = {}) {
  return Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false, ...state });
}

describe('ManagedHelperController', () => {
  it('mounts one POST route under /managed/v1/helpers', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ManagedHelperController)).toBe('/managed/v1/helpers');
    expect(handlers).toEqual(['call']);
    expect(Reflect.getMetadata(METHOD_METADATA, call)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, call)).toBe('/calls');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, call)).toBe(200);
    expect(Reflect.getMetadata(HEADERS_METADATA, call)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
  });

  it('uses the managed guards and shared throttle, and requires helpers:read', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ManagedHelperController)).toEqual([
      ThrottlerManagedCredentialGuard,
      ManagedScopeGuard,
    ]);
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, call)).toBeUndefined();
    expect(Reflect.getMetadata(MANAGED_SCOPE_KEY, call)).toBe('helpers:read');
    expect(allowed(HELPER)).toBe(true);
    expect(allowed(TODAY)).toBe('SCOPE_MISSING');
  });

  it('passes the credential from the request and a signal that ends when the client goes away', async () => {
    const service = { run: jest.fn(async () => 'result') };
    const controller = new ManagedHelperController(service as any);
    const body = { helper: 'tiktok-business.music-search.v1' } as any;
    const res = fakeResponse();

    expect(await controller.call(HELPER as any, body, res as any)).toBe('result');
    const signal = (service.run.mock.calls[0] as any[])[2] as AbortSignal;
    expect(service.run).toHaveBeenCalledWith(HELPER, body, signal);
    expect(signal.aborted).toBe(false);
    res.emit('close');
    expect(signal.aborted).toBe(true);

    await controller.call(HELPER as any, body, fakeResponse({ destroyed: true }) as any);
    expect(((service.run.mock.calls[1] as any[])[2] as AbortSignal).aborted).toBe(true);
  });
});

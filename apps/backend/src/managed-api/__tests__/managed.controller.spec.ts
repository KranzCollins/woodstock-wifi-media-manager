// the controller's collaborators touch storage and providers; only its route
// metadata and the removed route are used here
jest.mock('@gitroom/nestjs-libraries/database/prisma/managed/managed.service', () => ({
  ManagedService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/managed/managed.media.service', () => ({
  ManagedMediaService: class {},
}));

import { EventEmitter } from 'events';
import { GoneException, RequestMethod } from '@nestjs/common';
import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ManagedController } from '@gitroom/backend/managed-api/routes/v1/managed.controller';
import { MANAGED_SCOPE_KEY } from '@gitroom/backend/services/auth/managed.scope.guard';

const handlers = Object.getOwnPropertyNames(ManagedController.prototype).filter(
  (name) => name !== 'constructor'
);
const route = (name: string) => {
  const handler = (ManagedController.prototype as any)[name];
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler),
    method: Reflect.getMetadata(METHOD_METADATA, handler),
  };
};

describe('ManagedController uploads', () => {
  it('answers the removed capture upload with 410, without reading or storing anything', () => {
    // FAKE media service: any call would be a bypass of the reservations
    const media = { recordCapturedUpload: jest.fn(), receiveUploadContent: jest.fn() };
    const controller = new ManagedController({} as any, media as any);

    let refused: any;
    try {
      controller.uploadMedia();
    } catch (err) {
      refused = err;
    }

    expect(refused).toBeInstanceOf(GoneException);
    expect(refused.getResponse()).toEqual({
      code: 'ENDPOINT_REMOVED',
      msg: expect.stringContaining('/managed/v1/media/uploads'),
    });
    expect(route('uploadMedia')).toEqual({ path: '/media', method: RequestMethod.POST });
    expect(controller.uploadMedia.length).toBe(0);
    expect(media.recordCapturedUpload).not.toHaveBeenCalled();
    expect(media.receiveUploadContent).not.toHaveBeenCalled();
  });

  it('attaches no file or body interceptor to any managed route', () => {
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, ManagedController)).toBeUndefined();
    for (const name of handlers) {
      expect([
        name,
        Reflect.getMetadata(INTERCEPTORS_METADATA, (ManagedController.prototype as any)[name]),
      ]).toEqual([name, undefined]);
    }
  });

  it('keeps the reserved upload routes as the only managed upload path', () => {
    expect(route('reserveMediaUpload')).toEqual({
      path: '/media/uploads',
      method: RequestMethod.POST,
    });
    expect(route('mediaUploadStatus')).toEqual({
      path: '/media/uploads/:operationKey',
      method: RequestMethod.GET,
    });
    expect(route('mediaUploadContent')).toEqual({
      path: '/media/uploads/:operationKey/content',
      method: RequestMethod.PUT,
    });
    expect(route('recoverMediaUpload')).toEqual({
      path: '/media/uploads/:operationKey/recover',
      method: RequestMethod.POST,
    });

    // nothing else of the controller takes bytes
    const uploads = handlers.filter((name) => /^\/media(\/|$)/.test(route(name).path));
    expect(uploads.sort()).toEqual(
      [
        'mediaUploadContent',
        'mediaUploadStatus',
        'recoverMediaUpload',
        'reserveMediaUpload',
        'uploadMedia',
        'verifyMedia',
      ].sort()
    );
  });
});

describe('ManagedController operation status and capabilities', () => {
  const CREDENTIAL = {
    id: 'ww-test',
    organizationId: '11111111-1111-4111-8111-111111111111',
    tokenSha256: 'FAKE',
    scopes: ['posts:read'],
  } as any;

  // the shared 200 / hour budget of these routes is proven with the real
  // guard in managed.auth.middleware.spec.ts
  it('are reads that need posts:read', () => {
    expect(route('operationStatus')).toEqual({
      path: '/operations/:operationKey',
      method: RequestMethod.GET,
    });
    expect(route('capabilities')).toEqual({
      path: '/capabilities',
      method: RequestMethod.GET,
    });
    for (const name of ['operationStatus', 'capabilities']) {
      expect(
        Reflect.getMetadata(MANAGED_SCOPE_KEY, (ManagedController.prototype as any)[name])
      ).toBe('posts:read');
    }
  });

  it('asks the service only for the credential organization, never a write', async () => {
    // FAKE service: records what the controller asked for
    const service = {
      operationStatus: jest.fn(async () => ({ status: 'ABSENT' })),
      capabilities: jest.fn(() => ({ version: 'FAKE' })),
      createDraft: jest.fn(),
      editDraft: jest.fn(),
    };
    const controller = new ManagedController(service as any, {} as any);

    await controller.operationStatus(CREDENTIAL, 'ww:approval:1:create');
    expect(service.operationStatus).toHaveBeenCalledWith(
      CREDENTIAL.organizationId,
      'ww:approval:1:create'
    );
    expect(controller.capabilities()).toEqual({ version: 'FAKE' });
    expect(service.createDraft).not.toHaveBeenCalled();
    expect(service.editDraft).not.toHaveBeenCalled();
  });

  it('routes the current-media observation as a posts:read GET for one exact revision', async () => {
    expect(route('observeCurrentMedia')).toEqual({
      path: '/posts/:managedPostId/media-observation',
      method: RequestMethod.GET,
    });
    expect(
      Reflect.getMetadata(MANAGED_SCOPE_KEY, ManagedController.prototype.observeCurrentMedia)
    ).toBe('posts:read');

    // FAKE services: the observation is the service's; nothing else is asked
    const service = {
      observeCurrentMedia: jest.fn(async () => ({ status: 'FAKE' })),
      getPost: jest.fn(),
      editDraft: jest.fn(),
    };
    const media = { verifyStoredMedia: jest.fn() };
    const controller = new ManagedController(service as any, media as any);
    const postId = '33333333-3333-4333-8333-333333333333';

    // FAKE response: closing it (the client went away) aborts the reads
    const res = new EventEmitter();
    await controller.observeCurrentMedia(CREDENTIAL, postId, { revision: 3 }, res as any);
    expect(service.observeCurrentMedia).toHaveBeenCalledWith(
      CREDENTIAL.organizationId,
      postId,
      3,
      expect.any(AbortSignal)
    );
    const [[, , , cancel]] = service.observeCurrentMedia.mock.calls as any;
    expect(cancel.aborted).toBe(false);
    res.emit('close');
    expect(cancel.aborted).toBe(true);
    expect(service.getPost).not.toHaveBeenCalled();
    expect(service.editDraft).not.toHaveBeenCalled();
    expect(media.verifyStoredMedia).not.toHaveBeenCalled();
  });

  it.each([
    ['destroyed', { destroyed: true }],
    ['finished', { writableFinished: true }],
  ])('starts the observation already aborted for a %s response', async (_, state) => {
    const service = { observeCurrentMedia: jest.fn(async () => ({ status: 'FAKE' })) };
    const controller = new ManagedController(service as any, {} as any);

    // FAKE response whose close was emitted before the route ran
    const res = Object.assign(new EventEmitter(), state);
    await controller.observeCurrentMedia(
      CREDENTIAL,
      '33333333-3333-4333-8333-333333333333',
      { revision: 3 },
      res as any
    );
    const [[, , , cancel]] = service.observeCurrentMedia.mock.calls as any;
    expect(cancel.aborted).toBe(true);
  });
});

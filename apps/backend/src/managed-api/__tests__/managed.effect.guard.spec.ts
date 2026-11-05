// The controllers' collaborators touch storage, providers and third parties;
// only their route metadata and the refusal before them are used here
jest.mock('@gitroom/nestjs-libraries/database/prisma/media/media.service', () => ({
  MediaService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service', () => ({
  SubscriptionService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({
  streamUploadOptions: () => ({}),
}));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => mockStorage },
}));
jest.mock('@gitroom/nestjs-libraries/videos/video.interface', () => ({
  VideoAbstract: class {},
}));
jest.mock('@gitroom/nestjs-libraries/3rdparties/thirdparty.manager', () => ({
  ThirdPartyManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator', () => ({
  IsSafeWebhookUrl: () => () => undefined,
}));
jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: { fixedDecryption: (value: string) => value },
}));

// FAKE storage of the third-party controller
const mockStorage = { uploadSimple: jest.fn(async () => 'https://FAKE/x.png') };

import {
  Controller,
  MiddlewareConsumer,
  Module,
  NestModule,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  MANAGED_EFFECT_KEY,
  ManagedEffectGuard,
  RefuseManagedEffect,
} from '@gitroom/backend/services/auth/managed.effect.guard';
import { MediaController } from '@gitroom/backend/api/routes/media.controller';
import { MediaWidgetController } from '@gitroom/backend/api/routes/media.widget.controller';
import { ThirdPartyController } from '@gitroom/backend/api/routes/third-party.controller';

const MANAGED = '11111111-1111-4111-8111-111111111111';
const UNMANAGED = '99999999-9999-4999-8999-999999999999';

// FAKE multer engine: records that bytes reached "storage"
const mockEngine = {
  _handleFile: jest.fn((req: any, file: any, cb: any) => {
    file.stream.resume();
    file.stream.on('end', () => cb(null, { path: 'FAKE-stored' }));
  }),
  _removeFile: jest.fn((req: any, file: any, cb: any) => cb(null)),
};

@Controller('/fake-upload')
class FakeUploadController {
  @Post('/')
  @RefuseManagedEffect('uploading media')
  @UseInterceptors(FileInterceptor('file', { storage: mockEngine as any }))
  upload(@UploadedFile() file: any) {
    return { stored: file?.path || null };
  }
}

// FAKE auth middleware: the org the real ones set on req.org
@Module({ controllers: [FakeUploadController] })
class FakeUploadModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: any, res: any, next: () => void) => {
        req.org = { id: req.headers['x-fake-org'] };
        next();
      })
      .forRoutes(FakeUploadController);
  }
}

describe('ManagedEffectGuard', () => {
  beforeEach(() => {
    process.env.POSTIZ_MANAGED_MODE = 'enabled';
    process.env.POSTIZ_MANAGED_ORGANIZATIONS = MANAGED;
    mockEngine._handleFile.mockClear();
    mockStorage.uploadSimple.mockClear();
  });

  afterEach(() => {
    delete process.env.POSTIZ_MANAGED_MODE;
    delete process.env.POSTIZ_MANAGED_ORGANIZATIONS;
  });

  describe('runs before the multipart interceptor (real Nest + multer, loopback only)', () => {
    let app: any;
    let port: number;

    beforeAll(async () => {
      app = await NestFactory.create(FakeUploadModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      port = app.getHttpServer().address().port;
    });

    afterAll(async () => {
      await app.close();
    });

    const send = (org: string) => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('FAKE-UPLOAD-BYTES')]), 'a.png');
      return fetch(`http://127.0.0.1:${port}/fake-upload`, {
        method: 'POST',
        body: form,
        headers: { 'x-fake-org': org },
      });
    };

    it('refuses a managed organization before any byte reaches storage', async () => {
      const response = await send(MANAGED);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'MANAGED_EFFECT_REFUSED' });
      expect(mockEngine._handleFile).not.toHaveBeenCalled();
    });

    it('stores as before for an unmanaged organization and with the mode off', async () => {
      const response = await send(UNMANAGED);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ stored: 'FAKE-stored' });

      delete process.env.POSTIZ_MANAGED_MODE;
      expect((await send(MANAGED)).status).toBe(201);
      expect(mockEngine._handleFile).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    [MediaController, 'uploadServer'],
    [MediaController, 'uploadSimple'],
    [MediaController, 'uploadFile'],
    [MediaWidgetController, 'upload'],
  ])('%p.%s carries the guard', (type: any, handler: string) => {
    const method = type.prototype[handler];
    expect(Reflect.getMetadata(MANAGED_EFFECT_KEY, method)).toBe('uploading media');
    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toContain(ManagedEffectGuard);
  });

  describe('ThirdPartyController', () => {
    const controller = () => {
      const manager = {
        getIntegrationById: jest.fn(async () => ({ identifier: 'FAKE', apiKey: 'FAKE-key' })),
        getThirdPartyByName: jest.fn(() => ({
          instance: {
            sendData: jest.fn(async () => 'https://FAKE/generated.png'),
            importMedia: jest.fn(async () => [{ url: 'https://FAKE/a.png' }]),
            fakeFunction: jest.fn(async () => ({})),
          },
        })),
      };
      const media = { saveFile: jest.fn(async () => ({ id: 'FAKE-media' })) };
      return {
        manager,
        media,
        instance: new ThirdPartyController(manager as any, media as any),
      };
    };

    it('refuses submit, function and import before the third party or storage', async () => {
      const { manager, media, instance } = controller();
      const org = { id: MANAGED } as any;

      for (const call of [
        () => instance.generate(org, 'FAKE-id', {}),
        () => instance.callFunction(org, 'FAKE-id', 'fakeFunction', {}),
        () => instance.importMedia(org, 'FAKE-id', { items: [] } as any),
      ]) {
        await expect(call()).rejects.toMatchObject({
          response: { code: 'MANAGED_EFFECT_REFUSED' },
        });
      }

      expect(manager.getIntegrationById).not.toHaveBeenCalled();
      expect(manager.getThirdPartyByName).not.toHaveBeenCalled();
      expect(mockStorage.uploadSimple).not.toHaveBeenCalled();
      expect(media.saveFile).not.toHaveBeenCalled();
    });

    it('still reaches the third party for an unmanaged organization', async () => {
      const { manager, media, instance } = controller();
      await instance.generate({ id: UNMANAGED } as any, 'FAKE-id', {});

      expect(manager.getIntegrationById).toHaveBeenCalled();
      expect(mockStorage.uploadSimple).toHaveBeenCalledWith('https://FAKE/generated.png');
      expect(media.saveFile).toHaveBeenCalled();
    });
  });
});

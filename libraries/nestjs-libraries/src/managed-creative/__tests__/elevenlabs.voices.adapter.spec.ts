// The voice lookup of the creative worker. Every transport is a FAKE; nothing
// reaches ElevenLabs. What is checked: the request is the one
// ImagesSlides.loadVoices sends, there is nothing a caller can choose, one
// send per call, and only voice ids and names come back (no preview urls, no
// key, no provider message).
jest.mock('transloadit', () => ({ __esModule: true, default: class {} }));
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), { virtual: true });
jest.mock('subtitle', () => ({ stringifySync: jest.fn() }));
jest.mock('p-limit', () => ({ __esModule: true, default: () => (fn: () => unknown) => fn() }));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('@gitroom/nestjs-libraries/openai/openai.service', () => ({ OpenaiService: class {} }));
jest.mock('@gitroom/nestjs-libraries/openai/fal.service', () => ({ FalService: class {} }));

import { ImagesSlides } from '@gitroom/nestjs-libraries/videos/images-slides/images.slides';
import {
  ELEVENLABS_VOICES_URL,
  ElevenLabsVoicesAdapter,
} from '@gitroom/nestjs-libraries/managed-creative/providers/elevenlabs.voices.adapter';
import { ProviderRequest } from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

const KEY = 'FAKE-elevenlabs-key';

const VOICE = {
  voice_id: '21m00Tcm4TlvDq8ikWAM',
  name: 'Rachel',
  preview_url: 'https://storage.googleapis.com/SECRET-preview.mp3',
  category: 'premade',
  settings: { stability: 0.5 },
};

const json = (status: number, value: unknown) =>
  new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });

function fakeTransport(answer: (url: string, request: ProviderRequest) => Promise<Response>) {
  return jest.fn(answer);
}

const adapter = (transport: ReturnType<typeof fakeTransport>) =>
  new ElevenLabsVoicesAdapter(KEY, transport);

describe('ElevenLabsVoicesAdapter.listVoices', () => {
  it('sends the request of ImagesSlides.loadVoices, once', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: true, json: async () => ({ voices: [VOICE] }) } as any);
    process.env.ELEVENSLABS_API_KEY = KEY;
    const loaded = await new ImagesSlides({} as any, {} as any).loadVoices({});
    const [serviceUrl, serviceInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    fetchSpy.mockRestore();
    delete process.env.ELEVENSLABS_API_KEY;

    const transport = fakeTransport(async () => json(200, { voices: [VOICE] }));
    const result = await adapter(transport).listVoices();

    expect(result).toEqual({
      outcome: 'accepted',
      sent: true,
      receipt: { voices: [{ id: loaded.voices[0].id, label: loaded.voices[0].name }] },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe(serviceUrl);
    expect(url).toBe(ELEVENLABS_VOICES_URL);
    expect(request.method).toBe(serviceInit.method);
    expect(request.headers).toEqual(serviceInit.headers);
    expect(request.body).toBeUndefined();
    expect(request.redirect).toBe('error');
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|preview|FAKE-elevenlabs-key|https?:/);
  });

  it('has no way to choose another call', () => {
    expect(Object.getOwnPropertyNames(ElevenLabsVoicesAdapter.prototype).sort()).toEqual([
      'constructor',
      'headers',
      'listVoices',
    ]);
    expect(ElevenLabsVoicesAdapter.prototype.listVoices.length).toBe(1);
  });

  it('is not sent without a key or when aborted before', async () => {
    const transport = fakeTransport(async () => json(200, { voices: [VOICE] }));
    expect(await new ElevenLabsVoicesAdapter('', transport).listVoices()).toEqual({
      outcome: 'not_sent',
      sent: false,
      code: 'NOT_CONFIGURED',
    });

    const controller = new AbortController();
    controller.abort();
    expect(await adapter(transport).listVoices(controller.signal)).toEqual({
      outcome: 'not_sent',
      sent: false,
      code: 'ABORTED_BEFORE_SEND',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps only voices with a plain id and name', async () => {
    const transport = fakeTransport(async () =>
      json(200, {
        voices: [
          VOICE,
          { ...VOICE, voice_id: '../v1/text-to-speech' },
          { ...VOICE, voice_id: undefined },
          { ...VOICE, voice_id: 12 },
          { ...VOICE, voice_id: 'abc', name: 'Line\nbreak' },
          { ...VOICE, voice_id: 'abc', name: 'x'.repeat(101) },
          { ...VOICE, voice_id: 'abc', name: '   ' },
          null,
          { voice_id: 'pNInz6obpgDQGcFmaJgB', name: ' Adam ' },
        ],
      })
    );
    expect(await adapter(transport).listVoices()).toEqual({
      outcome: 'accepted',
      sent: true,
      receipt: {
        voices: [
          { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel' },
          { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam' },
        ],
      },
    });
  });

  it.each<[string, () => Response, string, string]>([
    ['2xx without voices', () => json(200, {}), 'unknown', 'VOICES_NO_RESULT'],
    ['2xx that is not JSON', () => json(200, '<html>SECRET'), 'unknown', 'VOICES_NO_RESULT'],
    ['more voices than asked for', () => json(200, { voices: Array(41).fill(VOICE) }), 'unknown', 'VOICES_NO_RESULT'],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://evil.test/SECRET' } }), 'unknown', 'VOICES_NO_RESULT'],
    ['a 500', () => json(500, { detail: 'SECRET' }), 'unknown', 'VOICES_NO_RESULT'],
    ['an answer that is too large', () => json(200, 'x'.repeat(2 * 1024 * 1024 + 1)), 'unknown', 'VOICES_ANSWER_TOO_LARGE'],
    ['a 401 with a detail', () => json(401, { detail: { status: 'quota_exceeded', message: 'SECRET' } }), 'rejected', 'VOICES_REFUSED'],
    ['a 401 with a text detail', () => json(401, { detail: 'SECRET ' + KEY }), 'rejected', 'VOICES_REFUSED'],
  ])('%s is %s and never sent again', async (_name, response, outcome, code) => {
    const transport = fakeTransport(async () => response());
    const result = await adapter(transport).listVoices();

    expect(result).toMatchObject({ outcome, sent: true, code });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|FAKE-elevenlabs-key|preview/);
  });

  it('a refusal passes on only a plain provider code', async () => {
    const plain = fakeTransport(async () =>
      json(401, { detail: { status: 'quota_exceeded', message: 'SECRET' } })
    );
    expect(await adapter(plain).listVoices()).toEqual({
      outcome: 'rejected',
      sent: true,
      code: 'VOICES_REFUSED',
      httpStatus: 401,
      providerCode: 'quota_exceeded',
    });

    const text = fakeTransport(async () => json(401, { detail: 'Invalid API key' }));
    expect(await adapter(text).listVoices()).toMatchObject({
      outcome: 'rejected',
      providerCode: undefined,
    });
  });

  it('a refused redirect, a lost connection or an abort after sending is unknown', async () => {
    // fetch with redirect: 'error' rejects instead of following
    const redirected = fakeTransport(async () => {
      throw new TypeError('fetch failed: unexpected redirect to https://evil.test/SECRET');
    });
    expect(await adapter(redirected).listVoices()).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'VOICES_CONNECTION_LOST',
    });

    const controller = new AbortController();
    const aborted = fakeTransport(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
          controller.abort();
        })
    );
    expect(await adapter(aborted).listVoices(controller.signal)).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'VOICES_ABORTED',
    });
    expect(redirected).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it('an answer that stops being read is unknown', async () => {
    const lost = fakeTransport(async () => ({
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error('SECRET socket closed');
          },
          cancel: async () => undefined,
        }),
      },
    }) as unknown as Response);
    expect(await adapter(lost).listVoices()).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'VOICES_ANSWER_LOST',
    });
  });
});

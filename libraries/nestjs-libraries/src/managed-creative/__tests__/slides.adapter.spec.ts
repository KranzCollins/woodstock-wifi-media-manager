// The image-text-slides stages of the creative worker. Every transport and the
// script writer are FAKES; only the Transloadit SDK is real, and only to sign
// (it never sends). Nothing reaches a provider and nothing is paid. What is
// checked: each stage is one request, the same one ImagesSlides sends, under a
// deadline, without retries; inputs out of bounds are never sent; only codes,
// handles and checked urls come back, never a key, a signed url or a message.
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn() }), { virtual: true });

import { createHmac } from 'crypto';
import { parseBuffer } from 'music-metadata';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import {
  SLIDES_MAX,
  SlidesAdapter,
  SlidesAssemblyInput,
} from '@gitroom/nestjs-libraries/managed-creative/providers/slides.adapter';
import {
  newAssemblyId,
  slidesAssemblySteps,
  slidesSrt,
} from '@gitroom/nestjs-libraries/managed-creative/slides-builders';
import { ProviderRequest } from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

const mockDuration = parseBuffer as unknown as jest.Mock;

const KEYS = {
  fal: 'FAKE-fal-key',
  eleven: 'FAKE-eleven-key',
  tlKey: 'FAKE-tl-key',
  tlSecret: 'FAKE-tl-secret',
};
const SECRETS = /FAKE-fal-key|FAKE-eleven-key|FAKE-tl-secret|SECRET|X-Amz|signature/;

const json = (status: number, value: unknown) =>
  new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });

type Answer = (url: string, request: ProviderRequest) => Promise<Response>;

const fakeTransport = (answer: Answer) => jest.fn(answer);

function adapter(
  transport: ReturnType<typeof fakeTransport> = fakeTransport(async () => json(500, {})),
  writer = { slidesFromTextOnce: jest.fn(async (): Promise<any[]> => []) },
  overrides: Partial<{ fal: string; eleven: string; tlKey: string }> = {}
) {
  return new SlidesAdapter({
    writer,
    falKey: overrides.fal ?? KEYS.fal,
    elevenLabsKey: overrides.eleven ?? KEYS.eleven,
    transloadit: { authKey: overrides.tlKey ?? KEYS.tlKey, authSecret: KEYS.tlSecret },
    transport,
    imageHosts: ['v3.fal.media'],
    videoHosts: ['tmp.transloadit.test'],
    scratchHosts: ['scratch.test'],
  });
}

const slide = (index: number) => ({ imagePrompt: `Image ${index}`, voiceText: `Voice ${index}` });

describe('SlidesAdapter', () => {
  it('has one method per stage and no way to choose another call', () => {
    expect(Object.getOwnPropertyNames(SlidesAdapter.prototype).sort()).toEqual([
      'assemble',
      'assemblyStatus',
      'constructor',
      'image',
      'script',
      'speech',
    ]);
  });

  it('keeps the keys out of anything that can be printed', () => {
    const printed = JSON.stringify(adapter());
    expect(printed).not.toMatch(SECRETS);
    expect(printed).not.toContain(KEYS.tlKey);
  });
});

describe('SlidesAdapter.script', () => {
  it('sends the prompt as confirmed, once, without retries, under a deadline', async () => {
    const writer = { slidesFromTextOnce: jest.fn(async (): Promise<any[]> => [slide(0), slide(1), slide(2)]) };
    const result = await adapter(undefined, writer).script({ prompt: 'A talk about cats' });

    expect(result).toEqual({
      outcome: 'accepted',
      sent: true,
      receipt: { slides: [slide(0), slide(1), slide(2)] },
    });
    expect(writer.slidesFromTextOnce).toHaveBeenCalledTimes(1);
    const [prompt, options] = writer.slidesFromTextOnce.mock.calls[0] as unknown as [string, any];
    expect(prompt).toBe('A talk about cats');
    expect(options.maxRetries).toBe(0);
    expect(options.timeout).toBe(10 * 60 * 1000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('is not sent with an empty or long prompt, or when aborted before', async () => {
    const writer = { slidesFromTextOnce: jest.fn(async (): Promise<any[]> => [slide(0)]) };
    const controller = new AbortController();
    controller.abort();

    expect(await adapter(undefined, writer).script({ prompt: '  ' })).toMatchObject({ outcome: 'not_sent', code: 'INPUT_INVALID' });
    expect(await adapter(undefined, writer).script({ prompt: 'x'.repeat(4001) })).toMatchObject({ outcome: 'not_sent' });
    expect(await adapter(undefined, writer).script({ prompt: 'ok' }, controller.signal)).toMatchObject({
      outcome: 'not_sent',
      code: 'ABORTED_BEFORE_SEND',
    });
    expect(writer.slidesFromTextOnce).not.toHaveBeenCalled();
  });

  it.each<[string, unknown[], string]>([
    ['no slides', [], 'SCRIPT_NO_SLIDES'],
    ['more slides than the stages allow', Array.from({ length: SLIDES_MAX + 1 }, (_, i) => slide(i)), 'SCRIPT_TOO_MANY_SLIDES'],
    ['a slide without voice', [{ imagePrompt: 'I', voiceText: '' }], 'SCRIPT_SLIDE_INVALID'],
    ['a voice text out of bounds', [{ imagePrompt: 'I', voiceText: 'v'.repeat(2001) }], 'SCRIPT_SLIDE_INVALID'],
  ])('%s is rejected output, sent once', async (_name, slides, code) => {
    const writer = { slidesFromTextOnce: jest.fn(async (): Promise<any[]> => slides) };
    expect(await adapter(undefined, writer).script({ prompt: 'ok' })).toEqual({ outcome: 'output_rejected', sent: true, code });
    expect(writer.slidesFromTextOnce).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Error, string, string]>([
    ['a timeout', new APIConnectionTimeoutError(), 'unknown', 'SCRIPT_TIMEOUT'],
    ['an abort', new APIUserAbortError(), 'unknown', 'SCRIPT_ABORTED'],
    ['a lost connection', new APIConnectionError({ message: 'SECRET' }), 'unknown', 'SCRIPT_CONNECTION_LOST'],
    ['a 500', APIError.generate(500, { error: { message: 'SECRET' } }, undefined, new Headers()), 'unknown', 'SCRIPT_NO_RECEIPT'],
    ['an unparsable answer', new Error('SECRET'), 'unknown', 'SCRIPT_NO_RECEIPT'],
    ['a 429', APIError.generate(429, { error: { code: 'rate_limit_exceeded' } }, undefined, new Headers()), 'rejected', 'SCRIPT_REFUSED'],
  ])('%s is %s and only a code comes back', async (_name, error, outcome, code) => {
    const writer = {
      slidesFromTextOnce: jest.fn(async (): Promise<any[]> => {
        throw error;
      }),
    };
    const result = await adapter(undefined, writer).script({ prompt: 'SECRET prompt' });
    expect(result).toMatchObject({ outcome, sent: true, code });
    expect(writer.slidesFromTextOnce).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(SECRETS);
  });
});

describe('SlidesAdapter.image', () => {
  const FAL_ANSWER = { images: [{ url: 'https://v3.fal.media/files/cat.jpeg' }], seed: 1 };

  it.each<['vertical' | 'horizontal', string]>([
    ['vertical', '9:16'],
    ['horizontal', '16:9'],
  ])('sends the FalService request of ImagesSlides once (%s)', async (output, ratio) => {
    const transport = fakeTransport(async () => json(200, FAL_ANSWER));
    const result = await adapter(transport).image({ imagePrompt: 'a cat', output });

    expect(result).toEqual({
      outcome: 'accepted',
      sent: true,
      receipt: { url: 'https://v3.fal.media/files/cat.jpeg', host: 'v3.fal.media' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe('https://fal.run/fal-ai/ideogram/v2');
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({ Authorization: `Key ${KEYS.fal}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(request.body!)).toEqual({
      prompt: 'a cat',
      aspect_ratio: ratio,
      resolution: '720p',
      num_images: 1,
      output_format: 'jpeg',
      expand_prompt: true,
    });
    expect(request.redirect).toBe('error');
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('is not sent without a key, with a bad option or when aborted before', async () => {
    const transport = fakeTransport(async () => json(200, FAL_ANSWER));
    const controller = new AbortController();
    controller.abort();

    expect(await adapter(transport, undefined, { fal: '' }).image({ imagePrompt: 'a', output: 'vertical' })).toMatchObject({
      outcome: 'not_sent',
      code: 'NOT_CONFIGURED',
    });
    expect(await adapter(transport).image({ imagePrompt: 'a', output: 'square' as any })).toMatchObject({
      outcome: 'not_sent',
      code: 'INPUT_INVALID',
    });
    expect(await adapter(transport).image({ imagePrompt: 'a', output: 'vertical' }, controller.signal)).toMatchObject({
      outcome: 'not_sent',
      code: 'ABORTED_BEFORE_SEND',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each<[string, () => Response, string, string]>([
    ['an image on another host', () => json(200, { images: [{ url: 'https://evil.test/SECRET.jpg' }] }), 'output_rejected', 'IMAGE_URL_REFUSED'],
    ['an http image', () => json(200, { images: [{ url: 'http://v3.fal.media/a.jpg' }] }), 'output_rejected', 'IMAGE_URL_REFUSED'],
    ['a video instead of an image', () => json(200, { video: { url: 'https://v3.fal.media/a.mp4' } }), 'output_rejected', 'IMAGE_MISSING'],
    ['2xx that is not JSON', () => json(200, '<html>SECRET'), 'unknown', 'IMAGE_NO_RESULT'],
    ['a 500', () => json(500, 'SECRET'), 'unknown', 'IMAGE_NO_RESULT'],
    ['a redirect answer', () => new Response(null, { status: 302, headers: { location: 'https://evil.test/SECRET' } }), 'unknown', 'IMAGE_NO_RESULT'],
    ['an answer that is too large', () => json(200, 'x'.repeat(256 * 1024 + 1)), 'unknown', 'IMAGE_ANSWER_TOO_LARGE'],
    ['a 422', () => json(422, { detail: [{ msg: 'SECRET' }] }), 'rejected', 'IMAGE_REFUSED'],
  ])('%s is %s and never sent again', async (_name, response, outcome, code) => {
    const transport = fakeTransport(async () => response());
    const result = await adapter(transport).image({ imagePrompt: 'a cat', output: 'vertical' });

    expect(result).toMatchObject({ outcome, sent: true, code });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(SECRETS);
  });

  it('a refused redirect or a lost connection is unknown', async () => {
    const transport = fakeTransport(async () => {
      throw new TypeError('fetch failed: redirect to https://evil.test/SECRET');
    });
    expect(await adapter(transport).image({ imagePrompt: 'a', output: 'vertical' })).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'IMAGE_CONNECTION_LOST',
    });
  });
});

describe('SlidesAdapter.speech', () => {
  beforeEach(() => mockDuration.mockReset());

  it('sends the text-to-speech request of ImagesSlides once and returns the audio and its length', async () => {
    mockDuration.mockResolvedValue({ format: { duration: 4.2 } });
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0xc3]);
    const transport = fakeTransport(async () => new Response(mp3, { status: 200 }));

    const result = await adapter(transport).speech({ voice: '21m00Tcm4TlvDq8ikWAM', voiceText: 'Hello' });

    expect(result).toMatchObject({ outcome: 'accepted', sent: true, receipt: { mimeType: 'audio/mpeg', seconds: 4.2 } });
    expect(Buffer.from((result as any).receipt.audio)).toEqual(Buffer.from(mp3));
    expect(mockDuration).toHaveBeenCalledWith(expect.anything(), 'audio/mpeg');
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128');
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({ 'Content-Type': 'application/json', 'xi-api-key': KEYS.eleven });
    expect(JSON.parse(request.body!)).toEqual({ text: 'Hello', model_id: 'eleven_multilingual_v2' });
    expect(request.redirect).toBe('error');
  });

  it('a voice id that is not a plain id, or no key, is never sent', async () => {
    const transport = fakeTransport(async () => new Response(new Uint8Array([1])));
    for (const voice of ['../v2/voices', 'a/b', '', 'x'.repeat(65)]) {
      expect(await adapter(transport).speech({ voice, voiceText: 'Hi' })).toMatchObject({ outcome: 'not_sent', code: 'INPUT_INVALID' });
    }
    expect(await adapter(transport, undefined, { eleven: '' }).speech({ voice: 'abc', voiceText: 'Hi' })).toMatchObject({
      outcome: 'not_sent',
      code: 'NOT_CONFIGURED',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each<[string, unknown, string]>([
    ['unreadable audio', new Error('SECRET'), 'SPEECH_AUDIO_INVALID'],
    ['audio without a length', { format: {} }, 'SPEECH_AUDIO_INVALID'],
    ['audio far too long', { format: { duration: 601 } }, 'SPEECH_AUDIO_INVALID'],
  ])('%s is rejected output', async (_name, metadata, code) => {
    if (metadata instanceof Error) mockDuration.mockRejectedValue(metadata);
    else mockDuration.mockResolvedValue(metadata);
    const transport = fakeTransport(async () => new Response(new Uint8Array([1, 2])));

    expect(await adapter(transport).speech({ voice: 'abc', voiceText: 'Hi' })).toEqual({ outcome: 'output_rejected', sent: true, code });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Response, object]>([
    ['a 401 with a detail', () => json(401, { detail: { status: 'quota_exceeded', message: 'SECRET' } }), { outcome: 'rejected', code: 'SPEECH_REFUSED', httpStatus: 401, providerCode: 'quota_exceeded' }],
    ['a 401 with a text detail', () => json(401, { detail: 'SECRET' }), { outcome: 'rejected', code: 'SPEECH_REFUSED', providerCode: undefined }],
    ['a 500', () => json(500, { detail: 'SECRET' }), { outcome: 'unknown', code: 'SPEECH_NO_RESULT' }],
    ['audio that is too large', () => new Response(new Uint8Array(10 * 1024 * 1024 + 1)), { outcome: 'unknown', code: 'SPEECH_ANSWER_TOO_LARGE' }],
  ])('%s', async (_name, response, expected) => {
    const transport = fakeTransport(async () => response());
    const result = await adapter(transport).speech({ voice: 'abc', voiceText: 'Hi' });

    expect(result).toMatchObject({ sent: true, ...expected });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(SECRETS);
  });

  it('an answer that stops being read, or an abort while reading, is unknown', async () => {
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
    expect(await adapter(lost).speech({ voice: 'abc', voiceText: 'Hi' })).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'SPEECH_ANSWER_LOST',
    });

    const controller = new AbortController();
    const hanging = fakeTransport(async () => {
      setTimeout(() => controller.abort(), 0);
      return {
        status: 200,
        body: {
          getReader: () => ({
            read: () => new Promise<never>(() => undefined),
            cancel: async () => undefined,
          }),
        },
      } as unknown as Response;
    });
    expect(await adapter(hanging).speech({ voice: 'abc', voiceText: 'Hi' }, controller.signal)).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'SPEECH_ANSWER_LOST',
    });
  });
});

describe('SlidesAdapter.assemble', () => {
  const scratch = (key: string) => `https://scratch.test/bucket/${key}?X-Amz-Signature=SECRET`;
  const input = (count = 2): SlidesAssemblyInput => ({
    operationId: 'op1',
    assemblyId: newAssemblyId(),
    slides: Array.from({ length: count }, (_, index) => ({
      voiceText: `Voice ${index}`,
      seconds: 2 + index,
      imageUrl: scratch(`ww-op1-slide-${index}.jpg`),
      audioUrl: scratch(`ww-op1-slide-${index}.mp3`),
    })),
  });

  const field = (body: string, name: string) =>
    new RegExp(`name="${name.replace('.', '\\.')}"[^\\r]*\\r\\n(?:Content-Type: [^\\r]+\\r\\n)?\\r\\n([\\s\\S]*?)\\r\\n--`).exec(body)?.[1];

  it('creates the assembly of ImagesSlides once, under the recorded id, signed like the SDK', async () => {
    const stage = input();
    const transport = fakeTransport(async () =>
      json(200, { ok: 'ASSEMBLY_EXECUTING', assembly_id: stage.assemblyId, assembly_ssl_url: 'https://api2.transloadit.com/a/SECRET' })
    );

    const result = await adapter(transport).assemble(stage);

    expect(result).toEqual({
      outcome: 'accepted',
      sent: true,
      receipt: { kind: 'transloadit', assemblyId: stage.assemblyId },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe(`https://api2.transloadit.com/assemblies/${stage.assemblyId}`);
    expect(request.method).toBe('POST');
    expect(request.redirect).toBe('error');
    expect(request.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);

    const body = request.body!;
    const params = JSON.parse(field(body, 'params')!);
    expect(params.steps).toEqual(
      slidesAssemblySteps(stage.slides.map((s) => ({ imageUrl: s.imageUrl, audioUrl: s.audioUrl, seconds: s.seconds })))
    );
    expect(params.auth.key).toBe(KEYS.tlKey);
    expect(Date.parse(params.auth.expires)).toBeGreaterThan(Date.now());
    expect(field(body, 'signature')).toBe(
      createHmac('sha1', KEYS.tlSecret).update(Buffer.from(field(body, 'params')!, 'utf-8')).digest('hex')
    );
    expect(field(body, 'subtitles.srt')).toBe(
      slidesSrt(stage.slides.map((s) => ({ text: s.voiceText, seconds: s.seconds })))
    );
    expect(body).not.toContain(KEYS.tlSecret);
    expect(JSON.stringify(result)).not.toMatch(SECRETS);
  });

  it('only imports the retained scratch copies of this operation', async () => {
    const transport = fakeTransport(async () => json(200, {}));
    const cases: SlidesAssemblyInput[] = [
      { ...input(1), slides: [{ ...input(1).slides[0], imageUrl: 'https://v3.fal.media/files/cat.jpeg' }] },
      { ...input(1), slides: [{ ...input(1).slides[0], audioUrl: scratch('ww-op2-slide-0.mp3') }] },
      { ...input(1), slides: [{ ...input(1).slides[0], imageUrl: 'https://evil.test/ww-op1-slide-0.jpg' }] },
      { ...input(1), slides: [{ ...input(1).slides[0], seconds: 0 }] },
      { ...input(1), assemblyId: '../bill' },
      { ...input(1), operationId: '../op' },
      input(0),
      input(SLIDES_MAX + 1),
    ];
    for (const stage of cases) {
      expect(await adapter(transport).assemble(stage)).toMatchObject({ outcome: 'not_sent', code: 'INPUT_INVALID' });
    }
    expect(await adapter(transport, undefined, { tlKey: '' }).assemble(input())).toMatchObject({
      outcome: 'not_sent',
      code: 'NOT_CONFIGURED',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each<[string, (id: string) => Response, object]>([
    ['an error in a 2xx answer', () => json(200, { error: 'IMPORT_FILE_ERROR', message: 'SECRET' }), { outcome: 'rejected', httpStatus: 200, providerCode: 'IMPORT_FILE_ERROR' }],
    ['a rate limit (the SDK would send it again)', () => json(413, { error: 'RATE_LIMIT_REACHED', info: { retryIn: 1 } }), { outcome: 'rejected', httpStatus: 413, providerCode: 'RATE_LIMIT_REACHED' }],
    ['another assembly id', () => json(200, { ok: 'ASSEMBLY_EXECUTING', assembly_id: 'f'.repeat(32) }), { outcome: 'unknown', code: 'ASSEMBLY_NO_RECEIPT' }],
    ['a 500', () => json(500, 'SECRET'), { outcome: 'unknown', code: 'ASSEMBLY_NO_RECEIPT' }],
  ])('%s is sent once', async (_name, response, expected) => {
    const stage = input();
    const transport = fakeTransport(async () => response(stage.assemblyId));
    const result = await adapter(transport).assemble(stage);

    expect(result).toMatchObject({ sent: true, ...expected });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(SECRETS);
  });

  it('a lost connection is unknown, the recorded id can still be read', async () => {
    const transport = fakeTransport(async () => {
      throw new TypeError('socket hang up SECRET');
    });
    expect(await adapter(transport).assemble(input())).toEqual({ outcome: 'unknown', sent: true, code: 'ASSEMBLY_CONNECTION_LOST' });
  });
});

describe('SlidesAdapter.assemblyStatus', () => {
  const handle = { kind: 'transloadit' as const, assemblyId: 'a'.repeat(32) };

  it('reads the assembly with a signed url and returns only the checked result url', async () => {
    const transport = fakeTransport(async () =>
      json(200, {
        ok: 'ASSEMBLY_COMPLETED',
        assembly_id: handle.assemblyId,
        params: '{"steps":{"image0":{"url":"https://scratch.test/x?X-Amz-Signature=SECRET"}}}',
        results: { subtitled: [{ url: 'https://tmp.transloadit.test/video.mp4' }] },
      })
    );

    const result = await adapter(transport).assemblyStatus(handle);

    expect(result).toEqual({
      status: 'completed',
      artifact: {
        artifactId: `transloadit-${handle.assemblyId}-0`,
        role: 'video',
        source: { kind: 'url', url: 'https://tmp.transloadit.test/video.mp4', host: 'tmp.transloadit.test' },
        declared: {},
      },
    });
    const [url, request] = transport.mock.calls[0];
    expect(url.startsWith(`https://api2.transloadit.com/assemblies/${handle.assemblyId}?signature=`)).toBe(true);
    const query = new URL(url).searchParams;
    expect(query.get('signature')).toBe(
      createHmac('sha1', KEYS.tlSecret).update(Buffer.from(query.get('params')!, 'utf-8')).digest('hex')
    );
    expect(request.method).toBe('GET');
    expect(request.redirect).toBe('error');
    expect(JSON.stringify(result)).not.toMatch(SECRETS);
  });

  it.each<[string, () => Response, object]>([
    ['executing', () => json(200, { ok: 'ASSEMBLY_EXECUTING' }), { status: 'pending' }],
    ['uploading', () => json(200, { ok: 'ASSEMBLY_UPLOADING' }), { status: 'pending' }],
    ['an error', () => json(200, { error: 'INVALID_FILE_META_DATA', message: 'SECRET' }), { status: 'failed', code: 'PROVIDER_FAILED', providerCode: 'INVALID_FILE_META_DATA' }],
    ['cancelled', () => json(200, { ok: 'ASSEMBLY_CANCELED' }), { status: 'failed', providerCode: 'ASSEMBLY_CANCELED' }],
    ['a result on another host', () => json(200, { ok: 'ASSEMBLY_COMPLETED', results: { subtitled: [{ url: 'https://evil.test/SECRET.mp4' }] } }), { status: 'failed', code: 'RESULT_URL_INVALID' }],
    ['no result', () => json(200, { ok: 'ASSEMBLY_COMPLETED', results: {} }), { status: 'failed', code: 'RESULT_URL_INVALID' }],
    ['a result on a port', () => json(200, { ok: 'ASSEMBLY_COMPLETED', results: { subtitled: [{ url: 'https://tmp.transloadit.test:8443/v.mp4' }] } }), { status: 'failed', code: 'RESULT_URL_INVALID' }],
    ['a result on an address', () => json(200, { ok: 'ASSEMBLY_COMPLETED', results: { subtitled: [{ url: 'https://169.254.169.254/v.mp4' }] } }), { status: 'failed', code: 'RESULT_URL_INVALID' }],
    // not found is only that: never read as "the create was not sent"
    ['a 404', () => json(404, { error: 'ASSEMBLY_NOT_FOUND', message: 'SECRET' }), { status: 'not_found', code: 'STATUS_NOT_FOUND' }],
    ['a 404 without a body', () => new Response(null, { status: 404 }), { status: 'not_found', code: 'STATUS_NOT_FOUND' }],
  ])('%s', async (_name, response, expected) => {
    const result = await adapter(fakeTransport(async () => response())).assemblyStatus(handle);
    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toMatch(SECRETS);
  });

  it('refuses a handle that is not a plain assembly id', async () => {
    const transport = fakeTransport(async () => json(200, {}));
    for (const forged of [
      { kind: 'transloadit', assemblyId: '../bill/2026-01' },
      { kind: 'evolink', assemblyId: handle.assemblyId },
      null,
    ]) {
      expect(await adapter(transport).assemblyStatus(forged as any)).toEqual({
        status: 'invalid',
        code: 'HANDLE_INVALID',
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

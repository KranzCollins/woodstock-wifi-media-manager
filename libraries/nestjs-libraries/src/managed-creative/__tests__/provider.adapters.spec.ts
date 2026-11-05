// The stateless provider adapters of the creative worker. Every transport and
// generator is a FAKE; nothing reaches Evolink or OpenAI and nothing is paid.
// What is checked: one send per submit, sent vs not sent vs unknown, refusals,
// bounded answers, and that no key or provider message comes back out.
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import { VERSION } from 'openai/version';
import { Seedance } from '@gitroom/nestjs-libraries/videos/seedance/seedance';
import { EvolinkSeedanceAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/evolink.seedance.adapter';
import { OpenaiImageAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/openai.image.adapter';
import {
  ProviderRequest,
  readBounded,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';
import {
  ImageGenerateStage,
  SeedanceSubmitStage,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';

const KEY = 'FAKE-evolink-key';
const RESULT_HOSTS = ['cdn.fake.test'];

const STAGE: SeedanceSubmitStage = {
  stage: 'video.submit',
  provider: 'evolink',
  model: 'seedance-2.0-fast-reference-to-video',
  prompt: 'a cat',
  output: 'horizontal',
  imageUrls: ['https://FAKE/a.png'],
};

const json = (status: number, value: unknown) =>
  new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });

function fakeTransport(answer: (url: string, request: ProviderRequest) => Promise<Response>) {
  return jest.fn(answer);
}

describe('EvolinkSeedanceAdapter.submit', () => {
  it('sends the body Seedance sends, once, with the key only in the header', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue({ json: async () => ({ id: 'task-1' }) } as any);
    process.env.EVOLINK_API_KEY = KEY;
    await new Seedance().submit('horizontal', {
      prompt: 'a cat',
      images: [{ id: 'media-1', path: 'https://FAKE/a.png' }],
    });
    const seedanceBody = fetchSpy.mock.calls[0][1].body;
    fetchSpy.mockRestore();
    delete process.env.EVOLINK_API_KEY;

    const transport = fakeTransport(async () => json(200, { id: 'task-1' }));
    const result = await new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, transport).submit(STAGE);

    expect(result).toEqual({
      outcome: 'accepted',
      sent: true,
      receipt: { kind: 'evolink', taskId: 'task-1' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe('https://api.evolink.ai/v1/videos/generations');
    expect(request.body).toBe(seedanceBody);
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it.each<[string, Response, string, string]>([
    ['2xx without an id', json(200, {}), 'unknown', 'SUBMIT_NO_RECEIPT'],
    ['2xx that is not JSON', json(200, '<html>'), 'unknown', 'SUBMIT_NO_RECEIPT'],
    ['an id that is not a task id', json(200, { id: '../tasks/x' }), 'unknown', 'SUBMIT_RECEIPT_INVALID'],
    ['a 5xx with an error', json(500, { error: { code: 'E' } }), 'unknown', 'SUBMIT_NO_RECEIPT'],
    ['a gateway page', json(502, '<html>bad gateway</html>'), 'unknown', 'SUBMIT_NO_RECEIPT'],
    ['an answer too large to read', json(200, 'x'.repeat(70 * 1024)), 'unknown', 'SUBMIT_ANSWER_TOO_LARGE'],
    ['a 400 with an error', json(400, { error: { code: 'invalid_prompt', message: 'SECRET prompt' } }), 'rejected', 'SUBMIT_REFUSED'],
    ['a 429 with an error', json(429, { error: { code: 'rate_limited' } }), 'rejected', 'SUBMIT_REFUSED'],
    ['a 400 without an error', json(400, 'nope'), 'unknown', 'SUBMIT_NO_RECEIPT'],
  ])('%s is %s and never sent again', async (_name, response, outcome, code) => {
    const transport = fakeTransport(async () => response);
    const result = await new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, transport).submit(STAGE);

    expect(result).toMatchObject({ outcome, sent: true, code });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|FAKE-evolink-key/);
  });

  it('a refusal passes on only a plain provider code', async () => {
    const transport = fakeTransport(async () =>
      json(400, { error: { code: 'bad code with https://x', message: 'm' } })
    );
    const result = await new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, transport).submit(STAGE);
    expect(result).toEqual({
      outcome: 'rejected',
      sent: true,
      code: 'SUBMIT_REFUSED',
      httpStatus: 400,
      providerCode: undefined,
    });
  });

  it('a lost connection or an abort after sending is unknown', async () => {
    const lost = fakeTransport(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, lost).submit(STAGE)).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'SUBMIT_CONNECTION_LOST',
    });

    const controller = new AbortController();
    const aborted = fakeTransport(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
          controller.abort();
        })
    );
    expect(await new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, aborted).submit(STAGE, controller.signal)).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'SUBMIT_ABORTED',
    });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it('is not sent when aborted before, or when the model does not match the images', async () => {
    const transport = fakeTransport(async () => json(200, { id: 'task-1' }));
    const adapter = new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, transport);
    const controller = new AbortController();
    controller.abort();

    expect(await adapter.submit(STAGE, controller.signal)).toEqual({
      outcome: 'not_sent',
      sent: false,
      code: 'ABORTED_BEFORE_SEND',
    });
    expect(
      await adapter.submit({ ...STAGE, model: 'seedance-2.0-fast-text-to-video' })
    ).toEqual({ outcome: 'not_sent', sent: false, code: 'MODEL_MISMATCH' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('EvolinkSeedanceAdapter.status', () => {
  const handle = { kind: 'evolink' as const, taskId: 'task-1' };

  it.each<[Response, Record<string, unknown>]>([
    [json(200, { status: 'pending' }), { status: 'pending' }],
    [json(200, { status: 'processing' }), { status: 'pending' }],
    [json(200, { status: 'completed', results: [] }), { status: 'failed', code: 'RESULT_MISSING' }],
    [json(200, { status: 'completed', results: ['http://FAKE/v.mp4'] }), { status: 'failed', code: 'RESULT_URL_INVALID' }],
    [json(200, { status: 'failed', error: { code: 'content_blocked', message: 'SECRET' } }), { status: 'failed', code: 'PROVIDER_FAILED', providerCode: 'content_blocked' }],
    [json(200, { status: 'cancelled' }), { status: 'failed', code: 'PROVIDER_FAILED' }],
    [json(500, 'oops'), { status: 'unreadable', code: 'STATUS_UNREADABLE' }],
    [json(200, 'not json'), { status: 'unreadable', code: 'STATUS_UNREADABLE' }],
    // only that the task was not found: not that it was never sent or billed
    [json(404, { error: { code: 'task_not_found', message: 'SECRET' } }), { status: 'not_found', code: 'STATUS_NOT_FOUND' }],
    [json(404, 'not json'), { status: 'not_found', code: 'STATUS_NOT_FOUND' }],
  ])('maps %#', async (response, expected) => {
    const transport = fakeTransport(async () => response);
    const result = await new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, transport).status(handle);

    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(transport.mock.calls[0][0]).toBe('https://api.evolink.ai/v1/tasks/task-1');
    expect(transport.mock.calls[0][1].method).toBe('GET');
  });

  it('a completed task gives a url artifact for W&W ingest', async () => {
    const transport = fakeTransport(async () =>
      json(200, { status: 'completed', results: ['https://cdn.FAKE.test/v.mp4?sig=1'] })
    );
    expect(await new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, transport).status(handle)).toEqual({
      status: 'completed',
      artifact: {
        artifactId: 'evolink-task-1-0',
        role: 'video',
        source: { kind: 'url', url: 'https://cdn.fake.test/v.mp4?sig=1', host: 'cdn.fake.test' },
        declared: {},
      },
    });
  });

  it.each([
    'https://evil.test/SECRET.mp4',
    'https://cdn.fake.test.evil.test/v.mp4',
    'https://cdn.fake.test:8443/v.mp4',
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1/v.mp4',
    'https://2130706433/v.mp4',
    'https://[::1]/v.mp4',
    'https://localhost/v.mp4',
    'https://storage.internal/v.mp4',
    'http://cdn.fake.test/v.mp4',
  ])('a result url that is not on a configured public host is refused (%s)', async (resultUrl) => {
    const transport = fakeTransport(async () => json(200, { status: 'completed', results: [resultUrl] }));
    const result = await new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, transport).status(handle);

    expect(result).toEqual({ status: 'failed', code: 'RESULT_URL_INVALID' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('an address or a local name is refused even when it is configured', async () => {
    for (const host of ['127.0.0.1', 'localhost', 'storage.internal', 'storage']) {
      const transport = fakeTransport(async () =>
        json(200, { status: 'completed', results: [`https://${host}/v.mp4`] })
      );
      expect(await new EvolinkSeedanceAdapter(KEY, [host], transport).status(handle)).toEqual({
        status: 'failed',
        code: 'RESULT_URL_INVALID',
      });
    }
  });

  it('a lost read is unreadable, and a forged handle is never requested', async () => {
    const lost = fakeTransport(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, lost).status(handle)).toEqual({
      status: 'unreadable',
      code: 'STATUS_CONNECTION_LOST',
    });

    const transport = fakeTransport(async () => json(200, { status: 'pending' }));
    const adapter = new EvolinkSeedanceAdapter(KEY, RESULT_HOSTS, transport);
    for (const forged of [
      { kind: 'evolink', taskId: '../../x' },
      { kind: 'runpod', taskId: 'task-1' },
      null,
      undefined,
    ]) {
      expect(await adapter.status(forged as any)).toEqual({ status: 'invalid', code: 'HANDLE_INVALID' });
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('readBounded', () => {
  it('reads up to the bound and refuses past it', async () => {
    expect(await readBounded(new Response('abc'), 3)).toEqual({ ok: true, text: 'abc' });
    expect(await readBounded(new Response('abcd'), 3)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('OpenaiImageAdapter', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('FAKE-png-body'),
  ]).toString('base64');
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]).toString('base64');

  const stage = (orientation: 'square' | 'vertical'): ImageGenerateStage => ({
    stage: 'image.generate',
    provider: 'openai',
    model: 'chatgpt-image-latest',
    prompt: 'a cat',
    orientation,
  });

  it('the installed SDK retries by default and sends no idempotency key', () => {
    // why the managed caller always passes maxRetries: 0
    expect(VERSION).toBe('6.27.0');
    const client = new OpenAI({ apiKey: 'FAKE-openai-key' });
    expect(client.maxRetries).toBe(2);
    expect((client as any).idempotencyHeader).toBeUndefined();
  });

  it('calls once, without retries or prompt rewrite, under a deadline', async () => {
    const generator = { generateImage: jest.fn(async () => PNG) };
    const result = await new OpenaiImageAdapter(generator).generate(stage('vertical'), 'artifact-1');

    expect(generator.generateImage).toHaveBeenCalledTimes(1);
    const [prompt, isVertical, options] = (generator.generateImage.mock.calls[0] as unknown) as [
      string,
      boolean,
      { maxRetries: number; timeout: number; signal: AbortSignal }
    ];
    expect(prompt).toBe('a cat');
    expect(isVertical).toBe(true);
    expect(options.maxRetries).toBe(0);
    expect(options.timeout).toBe(5 * 60 * 1000);
    expect(options.signal).toBeInstanceOf(AbortSignal);

    expect(result).toEqual({
      outcome: 'accepted',
      sent: true,
      receipt: {
        artifact: {
          artifactId: 'artifact-1',
          role: 'image',
          source: { kind: 'inline_base64', mimeType: 'image/png', data: PNG },
          declared: { byteLength: 21 },
        },
      },
    });
  });

  it.each<[string, Error, string, string]>([
    ['a timeout', new APIConnectionTimeoutError(), 'unknown', 'IMAGE_TIMEOUT'],
    ['an abort', new APIUserAbortError(), 'unknown', 'IMAGE_ABORTED'],
    ['a lost connection', new APIConnectionError({ message: 'SECRET' }), 'unknown', 'IMAGE_CONNECTION_LOST'],
    ['a 500', APIError.generate(500, { error: { message: 'SECRET' } }, undefined, new Headers()), 'unknown', 'IMAGE_NO_RECEIPT'],
    ['a 409', APIError.generate(409, { error: { message: 'SECRET' } }, undefined, new Headers()), 'unknown', 'IMAGE_NO_RECEIPT'],
    ['an unknown error', new Error('SECRET'), 'unknown', 'IMAGE_NO_RECEIPT'],
    ['a 400', APIError.generate(400, { error: { code: 'content_policy_violation', message: 'SECRET' } }, undefined, new Headers()), 'rejected', 'IMAGE_REFUSED'],
    ['a 429', APIError.generate(429, { error: { code: 'rate_limit_exceeded' } }, undefined, new Headers()), 'rejected', 'IMAGE_REFUSED'],
  ])('%s is %s, sent, and only a code comes back', async (_name, error, outcome, code) => {
    const generator = {
      generateImage: jest.fn(async (): Promise<string> => {
        throw error;
      }),
    };
    const result = await new OpenaiImageAdapter(generator).generate(stage('square'), 'a');

    expect(result).toMatchObject({ outcome, sent: true, code });
    expect(generator.generateImage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('a refusal keeps the status and a plain provider code', async () => {
    const generator = {
      generateImage: jest.fn(async (): Promise<string> => {
        throw APIError.generate(400, { error: { code: 'content_policy_violation' } }, undefined, new Headers());
      }),
    };
    expect(await new OpenaiImageAdapter(generator).generate(stage('square'), 'a')).toEqual({
      outcome: 'rejected',
      sent: true,
      code: 'IMAGE_REFUSED',
      httpStatus: 400,
      providerCode: 'content_policy_violation',
    });
  });

  it.each<[string | undefined, string]>([
    [undefined, 'IMAGE_MISSING'],
    [JPEG, 'IMAGE_NOT_PNG'],
    ['not base64!', 'IMAGE_NOT_PNG'],
  ])('an answer that is not a PNG (%#) is output_rejected', async (b64, code) => {
    const generator = { generateImage: jest.fn(async () => b64) };
    expect(await new OpenaiImageAdapter(generator).generate(stage('square'), 'a')).toEqual({
      outcome: 'output_rejected',
      sent: true,
      code,
    });
  });

  it('is not sent when aborted before', async () => {
    const generator = { generateImage: jest.fn(async () => PNG) };
    const controller = new AbortController();
    controller.abort();
    expect(
      await new OpenaiImageAdapter(generator).generate(stage('square'), 'a', controller.signal)
    ).toEqual({ outcome: 'not_sent', sent: false, code: 'ABORTED_BEFORE_SEND' });
    expect(generator.generateImage).not.toHaveBeenCalled();
  });
});

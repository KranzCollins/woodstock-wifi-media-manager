// The Deepgram adapter of the creative worker. Every transport is a FAKE;
// nothing reaches Deepgram and nothing is paid. What is checked: the request
// is the one DeepgramService sends, only retained scratch audio is sent, one
// send per call, sent vs not sent vs unknown, and that no key, signed url or
// provider message comes back out.
import {
  DeepgramService,
  deepgramTranscript,
} from '@gitroom/nestjs-libraries/deepgram/deepgram.service';
import {
  DeepgramAdapter,
  DeepgramTranscribeInput,
} from '@gitroom/nestjs-libraries/managed-creative/providers/deepgram.adapter';
import { ProviderRequest } from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

const KEY = 'FAKE-deepgram-key';
const HOSTS = ['scratch.fake.test'];
const scratch = (key: string) =>
  `https://scratch.fake.test/bucket/${key}?X-Amz-Signature=SECRETSIG`;

const TRANSCRIBE: DeepgramTranscribeInput = {
  step: 'transcribe',
  operationId: 'op1',
  url: scratch('ww-op1-audio.ogg'),
};

const CAPTION: DeepgramTranscribeInput = {
  step: 'clip_caption',
  operationId: 'op1',
  clip: 4,
  url: scratch('ww-op1-clip-4-source.mp4'),
};

const RESULTS = {
  channels: [
    {
      detected_language: 'nl',
      alternatives: [{ words: [{ word: 'hoi', punctuated_word: 'Hoi.', start: 0.1, end: 0.4 }] }],
    },
  ],
  utterances: [{ start: 0.1, end: 0.4, transcript: 'Hoi.' }],
};

const json = (status: number, value: unknown) =>
  new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });

function fakeTransport(answer: (url: string, request: ProviderRequest) => Promise<Response>) {
  return jest.fn(answer);
}

const adapter = (transport: ReturnType<typeof fakeTransport>) =>
  new DeepgramAdapter(KEY, HOSTS, transport);

describe('DeepgramAdapter.transcribe', () => {
  it.each<[string, DeepgramTranscribeInput]>([
    ['the audio of the video', TRANSCRIBE],
    ['the window of a clip', CAPTION],
  ])('sends %s as DeepgramService does, once', async (_name, input) => {
    const fetchSpy = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: true, json: async () => ({ results: RESULTS }) } as any);
    process.env.DEEPGRAM_API_KEY = KEY;
    await new DeepgramService().transcribeUrl(input.url);
    const [serviceUrl, serviceInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    fetchSpy.mockRestore();
    delete process.env.DEEPGRAM_API_KEY;

    const transport = fakeTransport(async () => json(200, { results: RESULTS }));
    const result = await adapter(transport).transcribe(input);

    expect(result).toEqual({
      outcome: 'accepted',
      sent: true,
      receipt: deepgramTranscript(RESULTS),
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe(serviceUrl);
    expect(request.body).toBe(serviceInit.body);
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${KEY}` },
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRETSIG|FAKE-deepgram-key/);
  });

  it.each<[string, DeepgramTranscribeInput, string]>([
    ['an untrusted url', { ...TRANSCRIBE, url: 'https://evil.test/ww-op1-audio.ogg' }, 'SCRATCH_URL_REFUSED'],
    ['a plain http url', { ...TRANSCRIBE, url: 'http://scratch.fake.test/b/ww-op1-audio.ogg' }, 'SCRATCH_URL_REFUSED'],
    ['the audio of another operation', { ...TRANSCRIBE, url: scratch('ww-op2-audio.ogg') }, 'SCRATCH_URL_REFUSED'],
    ['the window of another clip', { ...CAPTION, url: scratch('ww-op1-clip-3-source.mp4') }, 'SCRATCH_URL_REFUSED'],
    ['a rendered clip, not its source', { ...CAPTION, url: scratch('ww-op1-clip-4.mp4') }, 'SCRATCH_URL_REFUSED'],
    ['a clip index out of range', { ...CAPTION, clip: 10 }, 'INPUT_INVALID'],
    ['an operation id that is a path', { ...TRANSCRIBE, operationId: '../x' }, 'INPUT_INVALID'],
    ['an unknown step', { ...TRANSCRIBE, step: 'listen' } as any, 'INPUT_INVALID'],
  ])('%s is not sent', async (_name, input, code) => {
    const transport = fakeTransport(async () => json(200, { results: RESULTS }));
    expect(await adapter(transport).transcribe(input)).toEqual({
      outcome: 'not_sent',
      sent: false,
      code,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('is not sent without a key or when aborted before', async () => {
    const transport = fakeTransport(async () => json(200, { results: RESULTS }));
    expect(await new DeepgramAdapter('', HOSTS, transport).transcribe(TRANSCRIBE)).toEqual({
      outcome: 'not_sent',
      sent: false,
      code: 'NOT_CONFIGURED',
    });

    const controller = new AbortController();
    controller.abort();
    expect(await adapter(transport).transcribe(TRANSCRIBE, controller.signal)).toEqual({
      outcome: 'not_sent',
      sent: false,
      code: 'ABORTED_BEFORE_SEND',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each<[string, Response, string, string]>([
    ['2xx without results', json(200, {}), 'unknown', 'TRANSCRIBE_NO_RESULT'],
    ['2xx that is not JSON', json(200, '<html>'), 'unknown', 'TRANSCRIBE_NO_RESULT'],
    ['a 500', json(500, { err_code: 'E', err_msg: 'SECRET' }), 'unknown', 'TRANSCRIBE_NO_RESULT'],
    ['a 400 without an error', json(400, 'SECRET'), 'unknown', 'TRANSCRIBE_NO_RESULT'],
    ['a 400 with an error', json(400, { err_code: 'Bad Request', err_msg: 'SECRET ' + scratch('x') }), 'rejected', 'TRANSCRIBE_REFUSED'],
    ['a 401 with an error', json(401, { err_code: 'INVALID_AUTH', err_msg: 'SECRET' }), 'rejected', 'TRANSCRIBE_REFUSED'],
  ])('%s is %s and never sent again', async (_name, response, outcome, code) => {
    const transport = fakeTransport(async () => response);
    const result = await adapter(transport).transcribe(TRANSCRIBE);

    expect(result).toMatchObject({ outcome, sent: true, code });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|FAKE-deepgram-key/);
  });

  it.each([
    { ...RESULTS, utterances: {} },
    { ...RESULTS, utterances: [null] },
    { ...RESULTS, utterances: [{ start: -1, end: 2, transcript: 'secret' }] },
    { ...RESULTS, utterances: [{ start: 2, end: 1, transcript: 'secret' }] },
    { ...RESULTS, utterances: [{ start: 0, end: 10801, transcript: 'secret' }] },
    { ...RESULTS, utterances: [{ start: 0, end: 1, transcript: { secret: true } }] },
    { ...RESULTS, channels: [{ alternatives: [{ words: {} }] }] },
    { ...RESULTS, channels: [{ alternatives: [{ words: [null] }] }] },
    { ...RESULTS, channels: [{ ...RESULTS.channels[0], detected_language: 'https://secret.invalid' }] },
    { ...RESULTS, utterances: [{ start: 0, end: 1, transcript: 'x'.repeat(20001) }] },
  ])('malformed provider content stays a billed unknown without an exception or retry', async (results) => {
    const transport = fakeTransport(async () => json(200, { results }));
    await expect(adapter(transport).transcribe(TRANSCRIBE)).resolves.toEqual({
      outcome: 'unknown', sent: true, code: 'TRANSCRIBE_NO_RESULT',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('accepts silence with empty arrays and a bounded projected receipt', async () => {
    const transport = fakeTransport(async () => json(200, { results: {
      channels: [{ alternatives: [{ words: [] }], ignored: 'SECRET' }], utterances: [], ignored: 'SECRET',
    } }));
    expect(await adapter(transport).transcribe(TRANSCRIBE)).toEqual({ outcome: 'accepted', sent: true,
      receipt: { version: 1, language: 'en', origin: 'transcribed', word_level: true, segments: [], words: [] } });
  });

  it('a refusal passes on only a plain provider code', async () => {
    const plain = fakeTransport(async () => json(401, { err_code: 'INVALID_AUTH' }));
    expect(await adapter(plain).transcribe(TRANSCRIBE)).toEqual({
      outcome: 'rejected',
      sent: true,
      code: 'TRANSCRIBE_REFUSED',
      httpStatus: 401,
      providerCode: 'INVALID_AUTH',
    });

    const spaced = fakeTransport(async () => json(400, { err_code: 'Bad Request' }));
    expect(await adapter(spaced).transcribe(TRANSCRIBE)).toMatchObject({
      outcome: 'rejected',
      providerCode: undefined,
    });
  });

  it('a lost connection or an abort after sending is unknown', async () => {
    const lost = fakeTransport(async () => {
      throw new TypeError('fetch failed ' + scratch('x'));
    });
    expect(await adapter(lost).transcribe(TRANSCRIBE)).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'TRANSCRIBE_CONNECTION_LOST',
    });

    const controller = new AbortController();
    const aborted = fakeTransport(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
          controller.abort();
        })
    );
    expect(await adapter(aborted).transcribe(TRANSCRIBE, controller.signal)).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'TRANSCRIBE_ABORTED',
    });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(1);
  });
});

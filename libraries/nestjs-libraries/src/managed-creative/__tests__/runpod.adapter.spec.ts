// The RunPod adapter of the creative worker. Every transport is a FAKE;
// nothing reaches RunPod and nothing is paid. What is checked: the jobs are
// the ones RunPodMediaProcessor sends, one send per submit, sent vs not sent
// vs unknown, refused sources and scratch urls, and that no key, signed url or
// provider message comes back out.
import { RunPodMediaProcessor } from '@gitroom/nestjs-libraries/upload/runpod.media.processor';
import {
  analyseOutcome,
  buildAnalyseJob,
  buildClipFetchJob,
  buildClipRenderJob,
  clipFetchOutcome,
  clipRenderOutcome,
} from '@gitroom/nestjs-libraries/managed-creative/clipping-builders';
import {
  RunPodAdapter,
  RunPodClipOutput,
  RunPodIngestOutput,
  RunPodSubmitInput,
} from '@gitroom/nestjs-libraries/managed-creative/providers/runpod.adapter';
import { ProviderRequest } from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

const KEY = 'FAKE-runpod-key';
const ENDPOINTS = { ingest: 'fake-ingest', clipper: 'fake-clipper' };
const HOSTS = ['scratch.fake.test'];
const scratch = (key: string) =>
  `https://scratch.fake.test/bucket/${key}?X-Amz-Signature=SECRETSIG`;

const ANALYSE: RunPodSubmitInput = {
  step: 'analyse',
  operationId: 'op1',
  url: 'https://www.youtube.com/watch?v=FAKE',
  audioOnly: false,
  transcriptUploadUrl: scratch('ww-op1-transcript.json'),
  audioUploadUrl: scratch('ww-op1-audio.ogg'),
  maxDurationSeconds: 600,
};

const FETCH: RunPodSubmitInput = {
  step: 'clip_fetch',
  operationId: 'op1',
  clip: 2,
  url: 'https://youtu.be/FAKE',
  fit: 'crop',
  start: 30.4,
  end: 61.2,
  durationSeconds: 62,
  videoUploadUrl: scratch('ww-op1-clip-2-source.mp4'),
};

const RENDER: RunPodSubmitInput = {
  step: 'clip_render',
  operationId: 'op1',
  clip: 2,
  sourceUrl: scratch('ww-op1-clip-2-source.mp4'),
  start: 30.4,
  end: 61.2,
  trimStart: 28,
  outputUploadUrl: scratch('ww-op1-clip-2.mp4'),
  thumbnailUploadUrl: scratch('ww-op1-clip-2.jpg'),
  fit: 'blur',
  words: [{ text: 'hi', start: 2.4, end: 2.8 }],
};

const json = (status: number, value: unknown) =>
  new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });

function fakeTransport(answer: (url: string, request: ProviderRequest) => Promise<Response>) {
  return jest.fn(answer);
}

const adapter = (transport: ReturnType<typeof fakeTransport>) =>
  new RunPodAdapter(KEY, ENDPOINTS, HOSTS, transport);

async function processorBody(endpointId: string, job: unknown) {
  const fetchSpy = jest
    .spyOn(global, 'fetch' as any)
    .mockResolvedValue({ ok: true, json: async () => ({ id: 'job-1' }) } as any);
  await new RunPodMediaProcessor<any, any>(KEY, endpointId).submit(job);
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  fetchSpy.mockRestore();
  return { url, body: init.body };
}

describe('RunPodAdapter.submit', () => {
  it.each<[string, RunPodSubmitInput, 'ingest' | 'clipper', unknown]>([
    [
      'analyse',
      ANALYSE,
      'ingest',
      buildAnalyseJob({ ...(ANALYSE as any), reference: 'ww-op1' }),
    ],
    [
      'clip_fetch',
      FETCH,
      'ingest',
      buildClipFetchJob({ ...(FETCH as any), reference: 'ww-op1-clip-2' }),
    ],
    [
      'clip_render',
      RENDER,
      'clipper',
      buildClipRenderJob({ ...(RENDER as any), reference: 'ww-op1-clip-2' }),
    ],
  ])('%s sends the job RunPodMediaProcessor sends, once', async (_name, input, endpoint, job) => {
    const expected = await processorBody(ENDPOINTS[endpoint], job);
    const transport = fakeTransport(async () => json(200, { id: 'job-1', status: 'IN_QUEUE' }));
    const result = await adapter(transport).submit(input);

    expect(result).toEqual({
      outcome: 'accepted',
      sent: true,
      receipt: { kind: 'runpod', endpoint, jobId: 'job-1' },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe(expected.url);
    expect(url).toBe(`https://api.runpod.ai/v2/${ENDPOINTS[endpoint]}/run`);
    expect(request.body).toBe(expected.body);
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRETSIG|FAKE-runpod-key/);
  });

  it('keeps the fit: a crop fetches the taller rendition and renders cropped', async () => {
    const transport = fakeTransport(async () => json(200, { id: 'job-1' }));
    await adapter(transport).submit(FETCH);
    await adapter(transport).submit({ ...RENDER, fit: 'crop' } as RunPodSubmitInput);

    expect(JSON.parse(transport.mock.calls[0][1].body!).input.source.max_height).toBe(1080);
    expect(JSON.parse(transport.mock.calls[1][1].body!).input.frame.fit).toBe('crop');
  });

  it.each<[string, Record<string, unknown>, RunPodSubmitInput, string]>([
    ['a source that is not YouTube', { url: 'https://evil.test/v' }, ANALYSE, 'SOURCE_REFUSED'],
    ['a plain http source', { url: 'http://youtube.com/watch?v=x' }, FETCH, 'SOURCE_REFUSED'],
    ['an upload url on another host', { audioUploadUrl: 'https://evil.test/ww-op1-audio.ogg' }, ANALYSE, 'SCRATCH_URL_REFUSED'],
    ['an upload url of another operation', { audioUploadUrl: scratch('ww-op2-audio.ogg') }, ANALYSE, 'SCRATCH_URL_REFUSED'],
    ['a missing transcript url', { transcriptUploadUrl: undefined }, ANALYSE, 'SCRATCH_URL_REFUSED'],
    ['a transcript url on an audio only job', { audioOnly: true }, ANALYSE, 'SCRATCH_URL_REFUSED'],
    ['a fetch into another clip', { videoUploadUrl: scratch('ww-op1-clip-3-source.mp4') }, FETCH, 'SCRATCH_URL_REFUSED'],
    ['a render of another source', { sourceUrl: scratch('ww-op1-clip-1-source.mp4') }, RENDER, 'SCRATCH_URL_REFUSED'],
    ['a longer source than allowed', { maxDurationSeconds: 180 * 60 + 1 }, ANALYSE, 'INPUT_INVALID'],
    ['a clip too long', { end: 130.5 }, FETCH, 'INPUT_INVALID'],
    ['a clip too short', { end: 35 }, RENDER, 'INPUT_INVALID'],
    ['no fit', { fit: undefined }, FETCH, 'INPUT_INVALID'],
    ['a clip index out of range', { clip: 10 }, RENDER, 'INPUT_INVALID'],
    ['a trim after the start', { trimStart: 31 }, RENDER, 'INPUT_INVALID'],
    ['words that are not words', { words: [{ text: 1 }] }, RENDER, 'INPUT_INVALID'],
    ['an operation id that is a path', { operationId: '../x' }, ANALYSE, 'INPUT_INVALID'],
    ['an unknown step', { step: 'normalize' }, ANALYSE, 'INPUT_INVALID'],
  ])('%s is not sent', async (_name, change, base, code) => {
    const transport = fakeTransport(async () => json(200, { id: 'job-1' }));
    const result = await adapter(transport).submit({ ...base, ...change } as RunPodSubmitInput);

    expect(result).toEqual({ outcome: 'not_sent', sent: false, code });
    expect(transport).not.toHaveBeenCalled();
  });

  it('is not sent without a configured endpoint or when aborted before', async () => {
    const transport = fakeTransport(async () => json(200, { id: 'job-1' }));
    expect(
      await new RunPodAdapter(KEY, { ingest: 'fake-ingest', clipper: '' }, HOSTS, transport).submit(RENDER)
    ).toEqual({ outcome: 'not_sent', sent: false, code: 'NOT_CONFIGURED' });
    expect(
      await new RunPodAdapter(KEY, { ingest: 'evil.test/x', clipper: 'c' }, HOSTS, transport).submit(ANALYSE)
    ).toEqual({ outcome: 'not_sent', sent: false, code: 'NOT_CONFIGURED' });

    const controller = new AbortController();
    controller.abort();
    expect(await adapter(transport).submit(ANALYSE, controller.signal)).toEqual({
      outcome: 'not_sent',
      sent: false,
      code: 'ABORTED_BEFORE_SEND',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each<[string, Response, string, string]>([
    ['2xx without an id', json(200, {}), 'unknown', 'SUBMIT_NO_RECEIPT'],
    ['2xx that is not JSON', json(200, '<html>'), 'unknown', 'SUBMIT_NO_RECEIPT'],
    ['an id that is not a job id', json(200, { id: '../status/x' }), 'unknown', 'SUBMIT_RECEIPT_INVALID'],
    ['a 500', json(500, { error: 'SECRET ' + scratch('x') }), 'unknown', 'SUBMIT_NO_RECEIPT'],
    ['a gateway page', json(502, '<html>bad gateway</html>'), 'unknown', 'SUBMIT_NO_RECEIPT'],
    ['an answer too large to read', json(200, 'x'.repeat(300 * 1024)), 'unknown', 'SUBMIT_ANSWER_TOO_LARGE'],
    ['a 401', json(401, 'SECRET'), 'rejected', 'SUBMIT_REFUSED'],
    ['a 429', json(429, { error: 'SECRET' }), 'rejected', 'SUBMIT_REFUSED'],
  ])('%s is %s and never sent again', async (_name, response, outcome, code) => {
    const transport = fakeTransport(async () => response);
    const result = await adapter(transport).submit(ANALYSE);

    expect(result).toMatchObject({ outcome, sent: true, code });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|FAKE-runpod-key/);
  });

  it('a lost connection or an abort after sending is unknown', async () => {
    const lost = fakeTransport(async () => {
      throw new TypeError('fetch failed ' + scratch('x'));
    });
    expect(await adapter(lost).submit(ANALYSE)).toEqual({
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
    expect(await adapter(aborted).submit(ANALYSE, controller.signal)).toEqual({
      outcome: 'unknown',
      sent: true,
      code: 'SUBMIT_ABORTED',
    });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(1);
  });
});

describe('RunPodAdapter.status', () => {
  const handle = { kind: 'runpod' as const, endpoint: 'clipper' as const, jobId: 'job-1' };

  it.each<[Response, Record<string, unknown>]>([
    [json(200, { id: 'job-1', status: 'IN_QUEUE' }), { status: 'pending' }],
    [json(200, { id: 'job-1', status: 'IN_PROGRESS' }), { status: 'pending' }],
    [json(200, { status: 'COMPLETED', output: { status: 'completed', clips: [] } }), { status: 'completed', result: { status: 'completed', clips: [] } }],
    [json(200, { status: 'FAILED', error: 'SECRET ' + scratch('x') }), { status: 'failed', error: 'RUNPOD_FAILED' }],
    [json(200, { status: 'TIMED_OUT' }), { status: 'failed', error: 'RUNPOD_TIMED_OUT' }],
    [json(500, 'oops'), { status: 'unreadable', code: 'STATUS_UNREADABLE' }],
    [json(200, 'not json'), { status: 'unreadable', code: 'STATUS_UNREADABLE' }],
    // only that RunPod does not know the job (now): never "not sent" or a refund
    [json(404, { error: 'SECRET ' + scratch('x') }), { status: 'not_found', code: 'STATUS_NOT_FOUND' }],
    [json(404, 'not json'), { status: 'not_found', code: 'STATUS_NOT_FOUND' }],
  ])('maps %#', async (response, expected) => {
    const transport = fakeTransport(async () => response);
    const result = await adapter(transport).status(handle);

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
    expect(transport.mock.calls[0][0]).toBe('https://api.runpod.ai/v2/fake-clipper/status/job-1');
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('a lost read is unreadable, and a forged handle is never requested', async () => {
    const lost = fakeTransport(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await adapter(lost).status(handle)).toEqual({
      status: 'unreadable',
      code: 'STATUS_CONNECTION_LOST',
    });

    const transport = fakeTransport(async () => json(200, { status: 'IN_QUEUE' }));
    expect(await adapter(transport).status({ ...handle, jobId: '../../x' })).toEqual({
      status: 'invalid',
      code: 'HANDLE_INVALID',
    });
    expect(
      await adapter(transport).status({ ...handle, endpoint: 'normalize' as any })
    ).toEqual({ status: 'invalid', code: 'HANDLE_INVALID' });
    for (const forged of [{ ...handle, kind: 'evolink' }, null, undefined]) {
      expect(await adapter(transport).status(forged as any)).toEqual({ status: 'invalid', code: 'HANDLE_INVALID' });
    }
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('RunPodAdapter.status output', () => {
  const ingest = { kind: 'runpod' as const, endpoint: 'ingest' as const, jobId: 'job-1' };
  const clipper = { kind: 'runpod' as const, endpoint: 'clipper' as const, jobId: 'job-1' };
  const completed = (output: unknown) => async () => json(200, { status: 'COMPLETED', output });
  const LEAKY_FAILURE = {
    code: 'SOURCE_UNAVAILABLE',
    message: 'SECRET could not read ' + scratch('ww-op1-audio.ogg'),
    retryable: false,
    stderr_tail: 'SECRET ffmpeg ' + scratch('ww-op1-audio.ogg'),
  };

  it('a finished analyse keeps only what the clipping outcomes read', async () => {
    const result = await adapter(
      fakeTransport(
        completed({
          version: 1,
          reference: 'ww-op1',
          status: 'completed',
          source: {
            title: 'A talk',
            description: 'SECRET description ' + scratch('x'),
            uploader: 'SECRET uploader',
            thumbnail_url: 'https://evil.test/SECRET.jpg',
            duration_seconds: 600,
            trim: null,
          },
          video: null,
          audio: { bytes: 1024, duration_seconds: 600 },
          transcript: { language: 'en', origin: 'auto_generated', word_level: true, segments: 3, words: 9 },
          failure: null,
        })
      )
    ).status(ingest);

    expect(result).toEqual({
      status: 'completed',
      result: {
        status: 'completed',
        source: { title: 'A talk', duration_seconds: 600 },
        audio: { bytes: 1024 },
        transcript: { origin: 'auto_generated' },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|X-Amz|evil\.test/);
    expect(
      analyseOutcome((result as { status: 'completed'; result: RunPodIngestOutput }))
    ).toEqual({ state: 'done', durationSeconds: 600, title: 'A talk', thumbnailUrl: undefined, transcribe: false });
  });

  it('a failure keeps only an allowed code and whether it is retryable', async () => {
    const failed = await adapter(
      fakeTransport(completed({ status: 'failed', failure: LEAKY_FAILURE }))
    ).status(ingest);
    expect(failed).toEqual({
      status: 'completed',
      result: { status: 'failed', failure: { code: 'SOURCE_UNAVAILABLE', retryable: false } },
    });
    expect(JSON.stringify(failed)).not.toMatch(/SECRET|X-Amz/);

    const other = await adapter(
      fakeTransport(completed({ status: 'failed', failure: { ...LEAKY_FAILURE, code: 'SECRET_' + scratch('x') } }))
    ).status(ingest);
    expect(other).toEqual({
      status: 'completed',
      result: { status: 'failed', failure: { code: 'PROCESSOR_FAILED', retryable: false } },
    });
    expect(JSON.stringify(other)).not.toMatch(/SECRET|X-Amz/);

    const tooLong = await adapter(
      fakeTransport(
        completed({
          status: 'failed',
          source: { duration_seconds: 4 * 60 * 60 },
          failure: { ...LEAKY_FAILURE, code: 'DURATION_TOO_LONG' },
        })
      )
    ).status(ingest);
    expect(analyseOutcome(tooLong as { status: 'completed'; result: RunPodIngestOutput })).toEqual({
      state: 'too_long',
      durationSeconds: 4 * 60 * 60,
    });
  });

  it('a finished fetch and render keep the window start, the clip state and a thumbnail', async () => {
    const fetched = await adapter(
      fakeTransport(completed({ status: 'completed', video: { bytes: 1 }, source: { trim: { start_seconds: 28, end_seconds: 64 } } }))
    ).status(ingest);
    expect(clipFetchOutcome(fetched as { status: 'completed'; result: RunPodIngestOutput }, 30.4)).toEqual({
      state: 'done',
      trimStart: 28,
    });

    const rendered = await adapter(
      fakeTransport(
        completed({
          version: 1,
          reference: 'ww-op1-clip-2',
          status: 'partial',
          clips: [{ reference: 'ww-op1-clip-2', status: 'failed', output: null, thumbnail: null, failure: LEAKY_FAILURE }],
          failure: null,
        })
      )
    ).status(clipper);
    expect(rendered).toEqual({
      status: 'completed',
      result: {
        status: 'partial',
        clips: [{ status: 'failed', failure: { code: 'SOURCE_UNAVAILABLE', retryable: false } }],
      },
    });
    const outcome = clipRenderOutcome(rendered as { status: 'completed'; result: RunPodClipOutput });
    expect(outcome).toMatchObject({ state: 'failed', failure: { code: 'SOURCE_UNAVAILABLE' } });
    // the "result" of a failed outcome is the projection, never the raw output
    expect(JSON.stringify(outcome)).not.toMatch(/SECRET|X-Amz/);

    const done = await adapter(
      fakeTransport(completed({ status: 'completed', clips: [{ status: 'completed', output: { bytes: 9 }, thumbnail: { bytes: 3 } }] }))
    ).status(clipper);
    expect(clipRenderOutcome(done as { status: 'completed'; result: RunPodClipOutput })).toEqual({
      state: 'done',
      thumbnail: true,
    });
  });

  it.each<[string, 'ingest' | 'clipper', unknown]>([
    ['no output', 'ingest', undefined],
    ['an output that is not an object', 'ingest', 'SECRET'],
    ['an unknown status', 'ingest', { status: 'done' }],
    ['a failure without retryable', 'ingest', { status: 'failed', failure: { code: 'X', message: 'SECRET' } }],
    ['a retryable that is a string', 'ingest', { status: 'failed', failure: { code: 'X', retryable: 'true' } }],
    ['a duration that is a string', 'ingest', { status: 'completed', source: { duration_seconds: '600' }, audio: { bytes: 1 } }],
    ['a negative duration', 'ingest', { status: 'completed', source: { duration_seconds: -1 }, audio: { bytes: 1 } }],
    ['a trim that is a string', 'ingest', { status: 'completed', video: { bytes: 1 }, source: { trim: { start_seconds: '28' } } }],
    ['a title that is not text', 'ingest', { status: 'completed', source: { title: { SECRET: 1 }, duration_seconds: 5 }, audio: { bytes: 1 } }],
    ['a title far too long', 'ingest', { status: 'completed', source: { title: 'x'.repeat(301), duration_seconds: 5 }, audio: { bytes: 1 } }],
    ['bytes that are not a count', 'ingest', { status: 'completed', source: { duration_seconds: 5 }, audio: { bytes: 'SECRET' } }],
    ['a source that is a list', 'ingest', { status: 'completed', source: [], audio: { bytes: 1 } }],
    ['an unknown caption origin', 'ingest', { status: 'completed', source: { duration_seconds: 5 }, transcript: { origin: 'SECRET' } }],
    ['clips that are not a list', 'clipper', { status: 'completed', clips: { 0: { status: 'completed' } } }],
    ['more than the one clip', 'clipper', { status: 'completed', clips: [{ status: 'completed' }, { status: 'completed' }] }],
    ['a clip with an unknown status', 'clipper', { status: 'completed', clips: [{ status: 'SECRET' }] }],
    ['a clip that is null', 'clipper', { status: 'completed', clips: [null] }],
    ['a thumbnail without bytes', 'clipper', { status: 'completed', clips: [{ status: 'completed', thumbnail: { url: scratch('x') } }] }],
  ])('%s is a finished job with a refused output, nothing of it read', async (_name, endpoint, output) => {
    const transport = fakeTransport(completed(output));
    const result = await adapter(transport).status(endpoint === 'ingest' ? ingest : clipper);

    expect(result).toEqual({ status: 'output_rejected', code: 'OUTPUT_INVALID' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

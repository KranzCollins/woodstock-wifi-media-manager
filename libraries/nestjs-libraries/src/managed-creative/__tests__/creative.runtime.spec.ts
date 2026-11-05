// The owned creative runtime with the real adapters over FAKE providers and a
// FAKE scratch bucket; nothing is sent or paid. What is checked: refusals
// happen before any provider request, one send per call, every url a
// provider gets is a signed scratch url of the job's own keys, nothing a
// caller gets back carries a url or a signature, and the scratch protocol is
// read strictly.
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn(async () => ({ format: { duration: 2 } })) }), {
  virtual: true,
});
jest.mock('transloadit', () => ({
  __esModule: true,
  default: class {
    calcSignature(params: unknown) {
      return { signature: 'FAKE-SIGNATURE', params: JSON.stringify(params) };
    }
  },
}));
jest.mock('@gitroom/nestjs-libraries/openai/openai.service', () => ({ OpenaiService: class {} }));

import { createHash } from 'crypto';
import {
  CreativeCallContext,
  CreativeDispatch,
  CreativeObject,
  CreativePollOutcome,
  CreativePriorCall,
  ManagedCreativeRuntime,
  managedCreativeRuntimeFromEnv,
  parseClippingTranscript,
  sniffCreativeMedia,
} from '@gitroom/nestjs-libraries/managed-creative/creative.runtime';
import {
  creativeScratchConfig,
  creativeScratchKeys,
} from '@gitroom/nestjs-libraries/managed-creative/creative.scratch';
import { CreativeHandle, managedScratchKeys } from '@gitroom/nestjs-libraries/managed-creative/contracts';
import { CreativeJobInput } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.contracts';
import {
  FakeProviders,
  FakeScratch,
  JPEG_BYTES,
  MP4_BYTES,
  PNG_BYTES,
  SCRATCH_HOST,
  SECRET,
  SEGMENTS,
  WORDS,
  captionFile,
  fakeOpenai,
  fakeRuntime,
} from '@gitroom/nestjs-libraries/managed-creative/__tests__/fakes/creative.runtime.fakes';

const OP = 'a'.repeat(32);
const IMAGE: CreativeJobInput = {
  kind: 'image',
  provider: 'openai',
  model: 'chatgpt-image-latest',
  orientation: 'vertical',
  prompt: 'A FAKE lighthouse',
};
const CLIPPING: CreativeJobInput = {
  kind: 'clipping',
  sourceUrl: 'https://www.youtube.com/watch?v=FAKE0000001',
  fit: 'crop',
  clips: 2,
  maxSourceMinutes: 10,
  clipSeconds: { min: 10, max: 90 },
};

function setup() {
  const scratch = new FakeScratch();
  const providers = new FakeProviders(scratch);
  const openai = fakeOpenai();
  return { scratch, providers, openai, runtime: fakeRuntime(providers, scratch, openai) };
}

function ctx(input: CreativeJobInput, stage: CreativeCallContext['stage'], extra: Partial<CreativeCallContext> = {}): CreativeCallContext {
  return { operationId: OP, input, stage, item: 0, attempt: 1, assemblyId: null, calls: [], objects: [], ...extra };
}

const analysed = (transcript: 'auto' | 'none' | 'untrusted', attempt = 1): CreativePriorCall => ({
  stage: 'clip.analyse',
  item: 0,
  attempt,
  status: 'ACCEPTED',
  intermediate: null,
  pollStatus: 'COMPLETED',
  pollResult: { durationSeconds: 61, transcript },
  pollIntermediate: { title: 'FAKE talk', sourceSeconds: 60.5 },
});

// YouTube's own captions, as RunPod reports an analysis that wrote them
const AUTO_ANALYSIS = {
  status: 'completed',
  source: { title: 'FAKE talk', duration_seconds: 60.2 },
  transcript: { origin: 'auto_generated' },
};
// the same captions, timed by whole lines only
const lineTimed = (origin = 'auto_generated') => captionFile(origin, { word_level: false });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const transcriptObject = (key: string, bytes: Buffer): CreativeObject => ({
  role: 'transcript',
  slot: 0,
  storageKey: key,
  sha256: sha(bytes),
  byteLength: bytes.length,
  contentType: 'application/json',
  assetId: null,
  assetVersion: null,
});

const pollAnalyse = (runtime: ManagedCreativeRuntime, handle: CreativeHandle, attempt = 1) =>
  runtime.poll({ operationId: OP, input: CLIPPING, stage: 'clip.analyse', item: 0, attempt, handle, calls: [] });

// The row W&W keeps of a call, from what the runtime answered
const settledSend = (stage: CreativeCallContext['stage'], dispatch: CreativeDispatch, item = 0): CreativePriorCall => ({
  stage,
  item,
  attempt: 1,
  status: 'COMPLETED',
  intermediate: dispatch.intermediate ?? null,
  pollStatus: null,
  pollResult: null,
  pollIntermediate: null,
});
const settledPoll = (stage: CreativeCallContext['stage'], outcome: CreativePollOutcome, item = 0, attempt = 1): CreativePriorCall => {
  if (!('answer' in outcome) || outcome.answer.status !== 'completed') throw new Error('not completed');
  return {
    stage,
    item,
    attempt,
    status: 'ACCEPTED',
    intermediate: null,
    pollStatus: 'COMPLETED',
    pollResult: outcome.answer.result,
    pollIntermediate: outcome.intermediate ?? null,
  };
};

async function sent(runtime: ManagedCreativeRuntime, context: CreativeCallContext) {
  const prepared = await runtime.prepare(context);
  if (!prepared.ok) throw new Error(`not prepared: ${prepared.code}`);
  return prepared.send();
}

describe('parseClippingTranscript', () => {
  it('reads exactly the ClippingTranscript shape', () => {
    expect(parseClippingTranscript(JSON.parse(captionFile().toString()))).toEqual({
      version: 1,
      language: 'en',
      origin: 'auto_generated',
      word_level: true,
      segments: SEGMENTS,
      words: WORDS,
    });
  });

  it('accepts the complete Deepgram segment limit without relaxing the total character cap', () => {
    const transcript = { ...JSON.parse(captionFile('transcribed').toString()), segments: [{ start: 0, end: 10, text: 'a'.repeat(2500) }] };
    expect(parseClippingTranscript(transcript)?.segments[0].text).toHaveLength(2500);
    expect(parseClippingTranscript({ ...transcript, segments: [{ start: 0, end: 10, text: 'a'.repeat(20_001) }] })).toBeNull();
    expect(parseClippingTranscript({ ...transcript, segments: Array.from({ length: 41 }, () => ({ start: 0, end: 10, text: 'a'.repeat(20_000) })) })).toBeNull();
  });

  it.each([
    ['an extra key', { extra: 'x' }],
    ['another version', { version: 2 }],
    ['a language that is not a tag', { language: 'en; drop' }],
    ['an unknown origin', { origin: 'translated' }],
    ['a time past the bound', { segments: [{ start: 0, end: 99999, text: 'x' }] }],
    ['an inverted time', { segments: [{ start: 5, end: 1, text: 'x' }] }],
    ['control characters', { words: [{ start: 0, end: 1, text: 'a\u0007' }] }],
    ['an entry with an extra key', { words: [{ start: 0, end: 1, text: 'a', url: 'https://x.test' }] }],
  ])('refuses %s', (_name, change) => {
    expect(parseClippingTranscript({ ...JSON.parse(captionFile().toString()), ...change })).toBeNull();
  });
});

describe('sniffCreativeMedia', () => {
  it('names the type from the signature only', () => {
    expect(sniffCreativeMedia(PNG_BYTES)).toBe('image/png');
    expect(sniffCreativeMedia(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffCreativeMedia(MP4_BYTES)).toBe('video/mp4');
    expect(sniffCreativeMedia(Buffer.from('<html>'))).toBeNull();
  });
});

describe('prepare', () => {
  it('refuses every call without a scratch bucket, before any request', async () => {
    const { providers, openai, scratch } = setup();
    const runtime = fakeRuntime(providers, scratch, openai, { scratch: null });

    expect(await runtime.prepare(ctx(IMAGE, 'image.generate'))).toEqual({ ok: false, code: 'SCRATCH_NOT_CONFIGURED' });
    expect(openai.generateImage).not.toHaveBeenCalled();
    expect(providers.requests).toHaveLength(0);
  });

  it('refuses an unconfigured provider and a stage of another kind', async () => {
    const { providers, openai, scratch } = setup();
    const runtime = fakeRuntime(providers, scratch, openai, { image: null });

    expect(await runtime.prepare(ctx(IMAGE, 'image.generate'))).toEqual({ ok: false, code: 'IMAGE_NOT_CONFIGURED' });
    expect(await runtime.prepare(ctx(IMAGE, 'clip.analyse'))).toEqual({ ok: false, code: 'STAGE_KIND_MISMATCH' });
    expect(providers.requests).toHaveLength(0);
  });

  it('makes one image request and retains the PNG under the job key', async () => {
    const { runtime, openai, scratch } = setup();
    const prepared = await runtime.prepare(ctx(IMAGE, 'image.generate'));
    if (!prepared.ok) throw new Error('not prepared');

    const dispatch = await prepared.send();

    expect(openai.generateImage).toHaveBeenCalledTimes(1);
    expect(openai.generateImage.mock.calls[0][2]).toMatchObject({ maxRetries: 0 });
    expect(dispatch.answer).toEqual({ outcome: 'completed', result: null });
    expect(scratch.files.get(creativeScratchKeys(OP).image)).toEqual(PNG_BYTES);
    expect(dispatch.objects).toEqual([
      expect.objectContaining({ role: 'artifact', slot: 1, storageKey: creativeScratchKeys(OP).image, contentType: 'image/png' }),
    ]);
  });

  it('answers unknown, never completed, when the paid image can not be retained', async () => {
    const { runtime, scratch } = setup();
    scratch.files.set(creativeScratchKeys(OP).image, Buffer.from('other bytes'));
    const prepared = await runtime.prepare(ctx(IMAGE, 'image.generate'));
    if (!prepared.ok) throw new Error('not prepared');

    expect((await prepared.send()).answer).toEqual({ outcome: 'unknown', code: 'OUTPUT_NOT_RETAINED' });
    expect(scratch.files.get(creativeScratchKeys(OP).image)).toEqual(Buffer.from('other bytes'));
  });

  it('asks the audio-only analysis only after untrusted captions, with no transcript upload', async () => {
    const { runtime, providers } = setup();
    expect(await runtime.prepare(ctx(CLIPPING, 'clip.analyse', { attempt: 2 }))).toEqual({
      ok: false,
      code: 'ANALYSE_RETRY_NOT_DUE',
    });

    const prepared = await runtime.prepare(ctx(CLIPPING, 'clip.analyse', { attempt: 2, calls: [analysed('untrusted')] }));
    if (!prepared.ok) throw new Error('not prepared');
    providers.outputs.push({ status: 'completed' });
    const dispatch = await prepared.send();

    expect(dispatch.answer).toEqual({ outcome: 'accepted', handle: { kind: 'runpod', jobId: 'rp-1' } });
    expect(dispatch.handle).toEqual({ kind: 'runpod', endpoint: 'ingest', jobId: 'rp-1' });
    const job = providers.posts()[0].body.input;
    expect(job.transcript).toBeUndefined();
    expect(job.audio.unless_transcript).toBe(false);
    expect(new URL(job.audio.url).hostname).toBe(SCRATCH_HOST);
    expect(job.audio.url).toContain(managedScratchKeys(OP).audio);
  });

  it('reads the caption file strictly before the selection and refuses a tampered one unsent', async () => {
    const { runtime, scratch, openai } = setup();
    scratch.files.set(managedScratchKeys(OP).transcript, captionFile('auto_generated', { note: 'extra' }));

    expect(await runtime.prepare(ctx(CLIPPING, 'clip.pick', { calls: [analysed('auto')] }))).toEqual({
      ok: false,
      code: 'TRANSCRIPT_INVALID',
    });
    expect(openai.pickClips).not.toHaveBeenCalled();
  });

  it('keeps only clips inside the asked range and pins the caption file it read', async () => {
    const { runtime, scratch, openai } = setup();
    scratch.files.set(managedScratchKeys(OP).transcript, captionFile());
    const input = { ...CLIPPING, clipSeconds: { min: 10, max: 28 } } as CreativeJobInput;

    const prepared = await runtime.prepare(ctx(input, 'clip.pick', { input, calls: [analysed('auto')] }));
    if (!prepared.ok) throw new Error('not prepared');
    const dispatch = await prepared.send();

    expect(openai.pickClips).toHaveBeenCalledTimes(1);
    expect(openai.pickClips.mock.calls[0][0]).toBe('FAKE talk');
    expect(dispatch.answer).toEqual({ outcome: 'completed', result: { clips: 1 } });
    expect(dispatch.intermediate).toEqual({ clips: [{ title: 'Clip A', content: 'Post A', start: 0, end: 25 }] });
    expect(dispatch.objects).toEqual([
      expect.objectContaining({ role: 'transcript', slot: 0, storageKey: managedScratchKeys(OP).transcript }),
    ]);
  });
});

describe('poll', () => {
  it('reads a RunPod handle only on the endpoint its stage was sent to', async () => {
    const { runtime, providers } = setup();
    const outcome = await runtime.poll({
      operationId: OP,
      input: CLIPPING,
      stage: 'clip.render',
      item: 1,
      attempt: 1,
      handle: { kind: 'runpod', endpoint: 'ingest', jobId: 'rp-1' },
      calls: [],
    });

    expect(outcome).toEqual({ invalid: true });
    expect(providers.requests).toHaveLength(0);
  });

  it('turns untrusted captions into the frozen untrusted result with whole seconds', async () => {
    const { runtime, providers } = setup();
    providers.runpodJobs.set('rp-9', {
      status: 'completed',
      source: { title: 'FAKE talk', duration_seconds: 60.2 },
      transcript: { origin: 'uploader_provided' },
    });

    const outcome = await runtime.poll({
      operationId: OP,
      input: CLIPPING,
      stage: 'clip.analyse',
      item: 0,
      attempt: 1,
      handle: { kind: 'runpod', endpoint: 'ingest', jobId: 'rp-9' },
      calls: [],
    });

    expect(outcome).toEqual({
      answer: { status: 'completed', result: { durationSeconds: 61, transcript: 'untrusted' } },
      final: true,
      intermediate: { title: 'FAKE talk', sourceSeconds: 60.2 },
    });
  });

  it('fails an analysis longer than the job allows instead of reporting it', async () => {
    const { runtime, providers } = setup();
    providers.runpodJobs.set('rp-9', {
      status: 'completed',
      source: { duration_seconds: 601 },
      audio: { bytes: 1 },
    });

    const outcome = await runtime.poll({
      operationId: OP,
      input: CLIPPING,
      stage: 'clip.analyse',
      item: 0,
      attempt: 1,
      handle: { kind: 'runpod', endpoint: 'ingest', jobId: 'rp-9' },
      calls: [],
    });

    expect(outcome).toEqual({ answer: { status: 'failed', code: 'DURATION_TOO_LONG' }, final: true });
  });

  it('retains a finished video before reporting it and returns no url', async () => {
    const { runtime, scratch } = setup();
    const outcome = await runtime.poll({
      operationId: OP,
      input: { kind: 'video.seedance', provider: 'evolink', model: 'seedance-2.0-fast-text-to-video', output: 'vertical', prompt: 'x', sourceAssets: [] },
      stage: 'video.submit',
      item: 0,
      attempt: 1,
      handle: { kind: 'evolink', taskId: 'task-1' },
      calls: [],
    });

    expect(outcome).toMatchObject({ answer: { status: 'completed', result: null }, final: true });
    expect(scratch.files.get(creativeScratchKeys(OP).video)).toEqual(MP4_BYTES);
    expect(JSON.stringify(outcome)).not.toContain('https://');
  });

  it('keeps polling when the finished video could not be fetched', async () => {
    const { scratch, providers, openai } = setup();
    const runtime = fakeRuntime(providers, scratch, openai, { resultHosts: { evolink: [], fal: [], transloadit: [] } });

    const outcome = await runtime.poll({
      operationId: OP,
      input: { kind: 'video.seedance', provider: 'evolink', model: 'seedance-2.0-fast-text-to-video', output: 'vertical', prompt: 'x', sourceAssets: [] },
      stage: 'video.submit',
      item: 0,
      attempt: 1,
      handle: { kind: 'evolink', taskId: 'task-1' },
      calls: [],
    });

    expect(outcome).toEqual({ answer: { status: 'running' }, final: false });
  });
});

describe('clipping captions', () => {
  const RP: CreativeHandle = { kind: 'runpod', endpoint: 'ingest', jobId: 'rp-9' };

  it('reports word-timed automatic captions as auto and pins the exact file it read', async () => {
    const { runtime, providers, scratch } = setup();
    const file = captionFile();
    scratch.files.set(managedScratchKeys(OP).transcript, file);
    providers.runpodJobs.set('rp-9', AUTO_ANALYSIS);

    expect(await pollAnalyse(runtime, RP)).toEqual({
      answer: { status: 'completed', result: { durationSeconds: 61, transcript: 'auto' } },
      final: true,
      intermediate: { title: 'FAKE talk', sourceSeconds: 60.2 },
      objects: [transcriptObject(managedScratchKeys(OP).transcript, file)],
    });
    expect(providers.posts()).toHaveLength(0);
  });

  it.each([
    ['line-timed', lineTimed()],
    ['not JSON', Buffer.from('{"version":1,')],
    ['not UTF-8', Buffer.from([0xff, 0xfe, 0x7b])],
    ['an extra key', captionFile('auto_generated', { note: 'x' })],
    ['of another origin than RunPod reported', captionFile('uploader_provided')],
    ['absent', null],
  ])('reports automatic captions that are %s as untrusted, pinning nothing and sending nothing', async (_name, file) => {
    const { runtime, providers, scratch } = setup();
    if (file) scratch.files.set(managedScratchKeys(OP).transcript, file);
    providers.runpodJobs.set('rp-9', AUTO_ANALYSIS);

    expect(await pollAnalyse(runtime, RP)).toEqual({
      answer: { status: 'completed', result: { durationSeconds: 61, transcript: 'untrusted' } },
      final: true,
      intermediate: { title: 'FAKE talk', sourceSeconds: 60.2 },
    });
    expect(providers.posts()).toHaveLength(0);
  });

  it('keeps polling while the caption file can not be read, then reads it', async () => {
    const { runtime, providers, scratch } = setup();
    scratch.files.set(managedScratchKeys(OP).transcript, captionFile());
    providers.runpodJobs.set('rp-9', AUTO_ANALYSIS);
    const read = jest.spyOn(scratch, 'read');

    read.mockResolvedValueOnce({ ok: false, reason: 'read_failed' });
    expect(await pollAnalyse(runtime, RP)).toEqual({ answer: { status: 'running' }, final: false });
    read.mockRejectedValueOnce(new Error('FAKE storage down'));
    expect(await pollAnalyse(runtime, RP)).toEqual({ answer: { status: 'running' }, final: false });

    expect(await pollAnalyse(runtime, RP)).toMatchObject({
      answer: { status: 'completed', result: { transcript: 'auto' } },
      objects: [expect.objectContaining({ role: 'transcript', slot: 0 })],
    });
  });

  it('checks the source bound before reading any caption file', async () => {
    const { runtime, providers, scratch } = setup();
    scratch.files.set(managedScratchKeys(OP).transcript, captionFile());
    const read = jest.spyOn(scratch, 'read');

    providers.runpodJobs.set('rp-9', { ...AUTO_ANALYSIS, source: { duration_seconds: 600.5 } });
    expect(await pollAnalyse(runtime, RP)).toEqual({ answer: { status: 'failed', code: 'DURATION_TOO_LONG' }, final: true });
    providers.runpodJobs.set('rp-9', { ...AUTO_ANALYSIS, source: { duration_seconds: 600 } });
    expect(await pollAnalyse(runtime, RP)).toMatchObject({ answer: { result: { durationSeconds: 600, transcript: 'auto' } } });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('goes from line-timed captions through the audio-only analysis and Deepgram to a clip with burned-in words', async () => {
    const { runtime, providers, scratch, openai } = setup();
    providers.transcriptFile = lineTimed();

    providers.outputs.push(AUTO_ANALYSIS);
    const first = await sent(runtime, ctx(CLIPPING, 'clip.analyse'));
    const untrusted = await pollAnalyse(runtime, first.handle!);
    expect(untrusted).toMatchObject({ answer: { result: { transcript: 'untrusted' } } });
    const calls = [settledPoll('clip.analyse', untrusted)];

    // the line-timed captions never reach a selection
    expect(await runtime.prepare(ctx(CLIPPING, 'clip.pick', { calls }))).toEqual({ ok: false, code: 'TRANSCRIPT_NOT_RETAINED' });

    providers.outputs.push({ status: 'completed', source: { title: 'FAKE talk', duration_seconds: 60.2 }, audio: { bytes: 10 } });
    const second = await sent(runtime, ctx(CLIPPING, 'clip.analyse', { attempt: 2, calls }));
    expect(providers.posts('fake-ingest')[1].body.input.transcript).toBeUndefined();
    const audio = await pollAnalyse(runtime, second.handle!, 2);
    expect(audio).toMatchObject({ answer: { result: { transcript: 'none' } } });
    calls.push(settledPoll('clip.analyse', audio, 0, 2));

    const transcribed = await sent(runtime, ctx(CLIPPING, 'clip.transcribe', { calls }));
    expect(transcribed.answer).toEqual({ outcome: 'completed', result: null });
    const objects = transcribed.objects!;
    expect(objects).toEqual([expect.objectContaining({ role: 'transcript', slot: 0, storageKey: creativeScratchKeys(OP).transcribed })]);
    calls.push(settledSend('clip.transcribe', transcribed));

    const picked = await sent(runtime, ctx(CLIPPING, 'clip.pick', { calls, objects }));
    expect(picked.answer).toEqual({ outcome: 'completed', result: { clips: 2 } });
    expect(openai.pickClips).toHaveBeenCalledTimes(1);
    calls.push(settledSend('clip.pick', picked));

    providers.outputs.push({ status: 'completed', source: { trim: { start_seconds: 0 } }, video: { bytes: 10 } });
    const fetch = await sent(runtime, ctx(CLIPPING, 'clip.fetch', { item: 1, calls, objects }));
    const fetched = await runtime.poll({ operationId: OP, input: CLIPPING, stage: 'clip.fetch', item: 1, attempt: 1, handle: fetch.handle!, calls });
    calls.push(settledPoll('clip.fetch', fetched, 1));

    providers.outputs.push({ status: 'completed', clips: [{ status: 'completed', thumbnail: { bytes: 5 } }] });
    const render = await sent(runtime, ctx(CLIPPING, 'clip.render', { item: 1, calls, objects }));
    expect(render.intermediate).toEqual({ captions: 'words' });
    expect(providers.posts('fake-clipper')[0].body.input.captions).toEqual({
      words: [
        { text: 'Line', start: 0, end: 1 },
        { text: 'Line', start: 12, end: 13 },
      ],
    });

    // two analyses, one fetch, one whole-source transcription, no per-clip one
    expect(providers.posts('fake-ingest')).toHaveLength(3);
    expect(providers.posts('deepgram')).toHaveLength(1);
    expect(scratch.files.has(managedScratchKeys(OP).transcript)).toBe(true);
  });

  describe('a transcript pinned before captions were checked at the analysis', () => {
    const fetchedClip = (start: number, end: number): CreativePriorCall[] => [
      settledSend('clip.pick', { answer: { outcome: 'completed', result: { clips: 1 } }, intermediate: { clips: [{ title: 'A', content: 'B', start, end }] } }),
      {
        stage: 'clip.fetch',
        item: 1,
        attempt: 1,
        status: 'ACCEPTED',
        intermediate: null,
        pollStatus: 'COMPLETED',
        pollResult: null,
        pollIntermediate: { trimStart: Math.max(0, start - 2) },
      },
    ];

    function pinned(scratch: FakeScratch, file: Buffer) {
      scratch.files.set(managedScratchKeys(OP).transcript, file);
      return [transcriptObject(managedScratchKeys(OP).transcript, file)];
    }

    it('refuses the selection and the render of a line-timed one, unsent, instead of rendering without captions', async () => {
      const { runtime, providers, scratch, openai } = setup();
      const objects = pinned(scratch, lineTimed());

      expect(await runtime.prepare(ctx(CLIPPING, 'clip.pick', { calls: [analysed('auto')], objects }))).toEqual({
        ok: false,
        code: 'CAPTION_TIMING_UNAVAILABLE',
      });
      expect(
        await runtime.prepare(ctx(CLIPPING, 'clip.render', { item: 1, calls: [analysed('auto'), ...fetchedClip(0, 25)], objects }))
      ).toEqual({ ok: false, code: 'CAPTION_TIMING_UNAVAILABLE' });
      expect(openai.pickClips).not.toHaveBeenCalled();
      expect(providers.requests).toHaveLength(0);
    });

    it('renders a span nobody speaks in of a word-timed one, recorded as silent', async () => {
      const { runtime, providers, scratch } = setup();
      const objects = pinned(scratch, captionFile('auto_generated', { words: [{ start: 0, end: 1, text: 'Hi' }] }));

      providers.outputs.push({ status: 'completed', clips: [{ status: 'completed' }] });
      const render = await sent(runtime, ctx(CLIPPING, 'clip.render', { item: 1, calls: [analysed('auto'), ...fetchedClip(30, 45)], objects }));

      expect(render.answer).toMatchObject({ outcome: 'accepted' });
      expect(render.intermediate).toEqual({ captions: 'silent' });
      expect(providers.posts('fake-clipper')[0].body.input.captions).toBeUndefined();
    });
  });
});

describe('readArtifact', () => {
  it('reads a pinned object only while its bytes are unchanged', async () => {
    const { runtime, scratch } = setup();
    const key = creativeScratchKeys(OP).image;
    scratch.files.set(key, PNG_BYTES);
    const object = {
      role: 'artifact' as const,
      slot: 1,
      storageKey: key,
      sha256: createHash('sha256').update(PNG_BYTES).digest('hex'),
      byteLength: PNG_BYTES.length,
      contentType: 'image/png',
      assetId: null,
      assetVersion: null,
    };

    const read = await runtime.readArtifact({ operationId: OP, kind: 'image', item: 0, calls: [], objects: [object] });
    expect(read).toMatchObject({ kind: 'bytes', contentType: 'image/png', sha256: object.sha256 });

    scratch.files.set(key, Buffer.concat([PNG_BYTES, Buffer.from('x')]));
    expect(await runtime.readArtifact({ operationId: OP, kind: 'image', item: 0, calls: [], objects: [object] })).toEqual({
      kind: 'missing',
      code: 'ARTIFACT_OBJECT_CHANGED',
    });
  });
});

describe('managedCreativeRuntimeFromEnv', () => {
  it('builds nothing that can send without its configuration', async () => {
    const runtime = managedCreativeRuntimeFromEnv({}, async () => {
      throw new Error('no request may be made');
    });

    expect(await runtime.prepare(ctx(IMAGE, 'image.generate'))).toEqual({ ok: false, code: 'SCRATCH_NOT_CONFIGURED' });
    expect(await runtime.voices()).toBeNull();
  });

  it('refuses a scratch configuration that is incomplete or not an R2 account id', () => {
    const env = {
      POSTIZ_MANAGED_CREATIVE_SCRATCH_ACCOUNT_ID: 'f'.repeat(32),
      POSTIZ_MANAGED_CREATIVE_SCRATCH_ACCESS_KEY: 'FAKE',
      POSTIZ_MANAGED_CREATIVE_SCRATCH_SECRET_ACCESS_KEY: 'FAKE',
      POSTIZ_MANAGED_CREATIVE_SCRATCH_BUCKET: 'ww-creative-scratch',
    };
    expect(creativeScratchConfig(env)).toMatchObject({ bucket: 'ww-creative-scratch', region: 'auto' });
    expect(creativeScratchConfig({ ...env, POSTIZ_MANAGED_CREATIVE_SCRATCH_ACCOUNT_ID: 'acct.evil.test' })).toBeNull();
    expect(creativeScratchConfig({ ...env, POSTIZ_MANAGED_CREATIVE_SCRATCH_BUCKET: '' })).toBeNull();
  });

  it('never lets a signed url or key reach an answer', async () => {
    const { runtime, providers } = setup();
    providers.outputs.push({ status: 'completed' });
    const prepared = await runtime.prepare(ctx(CLIPPING, 'clip.analyse'));
    if (!prepared.ok) throw new Error('not prepared');
    const dispatch = await prepared.send();

    expect(JSON.stringify(dispatch)).not.toContain(SECRET);
    expect(JSON.stringify(dispatch)).not.toContain('FAKE-runpod-key');
  });
});

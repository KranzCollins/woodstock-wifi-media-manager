// The stage contract W&W stores in its durable queue: closed providers,
// models and stages, the managed clipping policy without defaults, and only a
// recorded provider handle is resumed after a restart.
import {
  parseCreativeHandle,
  parseCreativeStage,
  parseManagedClippingRequest,
  resultUrl,
  resumeOutcome,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';

const ASSEMBLY_ID = 'a'.repeat(32);

const IMAGE = {
  stage: 'image.generate',
  provider: 'openai',
  model: 'chatgpt-image-latest',
  prompt: 'a cat',
  orientation: 'square',
};

const VIDEO = {
  stage: 'video.submit',
  provider: 'evolink',
  model: 'seedance-2.0-fast-text-to-video',
  prompt: 'a cat',
  output: 'vertical',
  imageUrls: [] as string[],
};

describe('parseCreativeStage', () => {
  it('accepts the closed stages as they are', () => {
    expect(parseCreativeStage(IMAGE)).toEqual({ ok: true, value: IMAGE });
    expect(parseCreativeStage(VIDEO)).toEqual({ ok: true, value: VIDEO });
    const reference = {
      ...VIDEO,
      model: 'seedance-2.0-fast-reference-to-video',
      imageUrls: ['https://FAKE/a.png'],
    };
    expect(parseCreativeStage(reference)).toEqual({ ok: true, value: reference });
    const status = {
      stage: 'video.status',
      provider: 'evolink',
      handle: { kind: 'evolink', taskId: 'task-1' },
    };
    expect(parseCreativeStage(status)).toEqual({ ok: true, value: status });
  });

  it.each<[string, unknown, string]>([
    ['an unknown stage', { ...IMAGE, stage: 'tool.call' }, 'STAGE_UNKNOWN'],
    ['not an object', 'image.generate', 'STAGE_INVALID'],
    ['another image model', { ...IMAGE, model: 'dall-e-3' }, 'STAGE_PROVIDER_REFUSED'],
    ['another provider', { ...IMAGE, provider: 'fal' }, 'STAGE_PROVIDER_REFUSED'],
    ['a prompt rewrite flag', { ...IMAGE, promptRewrite: true }, 'STAGE_UNKNOWN_FIELD'],
    ['a function name', { ...VIDEO, functionName: 'loadVoices' }, 'STAGE_UNKNOWN_FIELD'],
    ['an empty prompt', { ...IMAGE, prompt: '  ' }, 'STAGE_PROMPT_INVALID'],
    ['a prompt over 4000', { ...IMAGE, prompt: 'x'.repeat(4001) }, 'STAGE_PROMPT_INVALID'],
    ['an orientation', { ...IMAGE, orientation: 'landscape' }, 'STAGE_OPTION_INVALID'],
    ['a video output', { ...VIDEO, output: 'square' }, 'STAGE_OPTION_INVALID'],
    ['four images', { ...VIDEO, imageUrls: ['1', '2', '3', '4'].map((p) => `https://FAKE/${p}`) }, 'STAGE_IMAGES_INVALID'],
    ['an http image', { ...VIDEO, imageUrls: ['http://FAKE/a.png'] }, 'STAGE_IMAGES_INVALID'],
    ['an image with credentials', { ...VIDEO, imageUrls: ['https://u:p@FAKE/a.png'] }, 'STAGE_IMAGES_INVALID'],
    ['a model that does not match the images', { ...VIDEO, imageUrls: ['https://FAKE/a.png'] }, 'STAGE_MODEL_MISMATCH'],
    ['a forged task id', { stage: 'video.status', provider: 'evolink', handle: { kind: 'evolink', taskId: '../x' } }, 'STAGE_HANDLE_INVALID'],
    ['an in-process handle to poll', { stage: 'video.status', provider: 'evolink', handle: { kind: 'in_process', taskId: 'x' } }, 'STAGE_HANDLE_INVALID'],
  ])('refuses %s', (_name, input, code) => {
    expect(parseCreativeStage(input)).toEqual({ ok: false, code });
  });
});

describe('parseCreativeStage: slides and clipping', () => {
  const SOURCE = 'https://www.youtube.com/watch?v=FAKE';
  const STAGES = {
    script: { stage: 'slides.script', provider: 'openai', prompt: 'a story' },
    image: { stage: 'slides.image', provider: 'fal', model: 'ideogram/v2', imagePrompt: 'a cat', output: 'vertical' },
    speech: { stage: 'slides.speech', provider: 'elevenlabs', model: 'eleven_multilingual_v2', voice: '21m00Tcm4TlvDq8ikWAM', voiceText: 'Hello' },
    assemble: {
      stage: 'slides.assemble',
      provider: 'transloadit',
      operationId: 'op1',
      assemblyId: ASSEMBLY_ID,
      slides: [{ voiceText: 'Hello', seconds: 4.2 }],
    },
    slidesStatus: { stage: 'slides.status', provider: 'transloadit', handle: { kind: 'transloadit', assemblyId: ASSEMBLY_ID } },
    analyse: { stage: 'clipping.analyse', provider: 'runpod', operationId: 'op1', url: SOURCE, audioOnly: false, maxDurationSeconds: 600 },
    transcribe: { stage: 'clipping.transcribe', provider: 'deepgram', operationId: 'op1' },
    pick: { stage: 'clipping.pick', provider: 'openai', operationId: 'op1', title: 'A talk', clips: 3 },
    fetch: {
      stage: 'clipping.clip_fetch',
      provider: 'runpod',
      operationId: 'op1',
      clip: 2,
      url: SOURCE,
      fit: 'crop',
      start: 30.4,
      end: 61.2,
      durationSeconds: 600,
    },
    caption: { stage: 'clipping.clip_caption', provider: 'deepgram', operationId: 'op1', clip: 2 },
    render: {
      stage: 'clipping.clip_render',
      provider: 'runpod',
      operationId: 'op1',
      clip: 2,
      fit: 'blur',
      start: 30.4,
      end: 61.2,
      trimStart: 28,
      words: [{ text: 'hi', start: 2.4, end: 2.8 }],
    },
    clippingStatus: { stage: 'clipping.status', provider: 'runpod', handle: { kind: 'runpod', endpoint: 'clipper', jobId: 'job-1' } },
  };

  it.each(Object.entries(STAGES))('accepts %s as it is', (_name, stage) => {
    expect(parseCreativeStage(stage)).toEqual({ ok: true, value: stage });
  });

  it.each<[string, unknown, string]>([
    ['a script for another provider', { ...STAGES.script, provider: 'anthropic' }, 'STAGE_PROVIDER_REFUSED'],
    ['an empty script prompt', { ...STAGES.script, prompt: ' ' }, 'STAGE_PROMPT_INVALID'],
    ['another image model', { ...STAGES.image, model: 'flux/dev' }, 'STAGE_PROVIDER_REFUSED'],
    ['a square slide', { ...STAGES.image, output: 'square' }, 'STAGE_OPTION_INVALID'],
    ['another speech model', { ...STAGES.speech, model: 'eleven_v3' }, 'STAGE_PROVIDER_REFUSED'],
    ['a voice id that is a path', { ...STAGES.speech, voice: '../v2/voices' }, 'STAGE_OPTION_INVALID'],
    ['a voice text over 2000', { ...STAGES.speech, voiceText: 'x'.repeat(2001) }, 'STAGE_PROMPT_INVALID'],
    ['a url chosen by the stage', { ...STAGES.assemble, slides: [{ voiceText: 'Hi', seconds: 1, imageUrl: 'https://evil.test/x' }] }, 'STAGE_SLIDES_INVALID'],
    ['six slides', { ...STAGES.assemble, slides: Array(6).fill({ voiceText: 'Hi', seconds: 1 }) }, 'STAGE_SLIDES_INVALID'],
    ['no slides', { ...STAGES.assemble, slides: [] }, 'STAGE_SLIDES_INVALID'],
    ['a voice of 0 seconds', { ...STAGES.assemble, slides: [{ voiceText: 'Hi', seconds: 0 }] }, 'STAGE_SLIDES_INVALID'],
    ['an assembly id that is not one', { ...STAGES.assemble, assemblyId: '../bill' }, 'STAGE_OPTION_INVALID'],
    ['an operation id that is a path', { ...STAGES.assemble, operationId: '../x' }, 'STAGE_OPTION_INVALID'],
    ['steps chosen by the stage', { ...STAGES.assemble, steps: {} }, 'STAGE_UNKNOWN_FIELD'],
    ['an evolink handle on slides', { ...STAGES.slidesStatus, handle: { kind: 'evolink', taskId: 'task-1' } }, 'STAGE_HANDLE_INVALID'],
    ['a source that is not YouTube', { ...STAGES.analyse, url: 'https://evil.test/v' }, 'STAGE_SOURCE_REFUSED'],
    ['a source longer than allowed', { ...STAGES.analyse, maxDurationSeconds: 180 * 60 + 1 }, 'STAGE_OPTION_INVALID'],
    ['an upload url chosen by the stage', { ...STAGES.analyse, audioUploadUrl: 'https://evil.test/x' }, 'STAGE_UNKNOWN_FIELD'],
    ['a transcription url chosen by the stage', { ...STAGES.transcribe, url: 'https://evil.test/x' }, 'STAGE_UNKNOWN_FIELD'],
    ['a transcript chosen by the stage', { ...STAGES.pick, transcript: { segments: [] } }, 'STAGE_UNKNOWN_FIELD'],
    ['eleven clips', { ...STAGES.pick, clips: 11 }, 'STAGE_OPTION_INVALID'],
    ['a title over 300', { ...STAGES.pick, title: 'x'.repeat(301) }, 'STAGE_OPTION_INVALID'],
    ['no fit', { ...STAGES.fetch, fit: undefined }, 'STAGE_OPTION_INVALID'],
    ['a clip too long', { ...STAGES.fetch, end: 130.5 }, 'STAGE_OPTION_INVALID'],
    ['a fetch of another site', { ...STAGES.fetch, url: 'https://vimeo.com/1' }, 'STAGE_SOURCE_REFUSED'],
    ['a clip index out of range', { ...STAGES.caption, clip: 10 }, 'STAGE_OPTION_INVALID'],
    ['a trim after the start', { ...STAGES.render, trimStart: 31 }, 'STAGE_OPTION_INVALID'],
    ['words that are not words', { ...STAGES.render, words: [{ text: 1 }] }, 'STAGE_OPTION_INVALID'],
    ['too many words', { ...STAGES.render, words: Array(2001).fill({ text: 'a', start: 1, end: 2 }) }, 'STAGE_OPTION_INVALID'],
    ['a source url on a render', { ...STAGES.render, sourceUrl: 'https://evil.test/x' }, 'STAGE_UNKNOWN_FIELD'],
    ['a render on Deepgram', { ...STAGES.render, provider: 'deepgram' }, 'STAGE_PROVIDER_REFUSED'],
    ['a transloadit handle on clipping', { ...STAGES.clippingStatus, handle: { kind: 'transloadit', assemblyId: ASSEMBLY_ID } }, 'STAGE_HANDLE_INVALID'],
    ['another RunPod endpoint', { ...STAGES.clippingStatus, handle: { kind: 'runpod', endpoint: 'normalize', jobId: 'job-1' } }, 'STAGE_HANDLE_INVALID'],
  ])('refuses %s', (_name, input, code) => {
    expect(parseCreativeStage(input)).toEqual({ ok: false, code });
  });
});

describe('parseManagedClippingRequest', () => {
  const REQUEST = { url: 'https://www.youtube.com/watch?v=FAKE', fit: 'crop', clips: 3 };

  it('accepts an explicit request', () => {
    expect(parseManagedClippingRequest(REQUEST)).toEqual({ ok: true, value: REQUEST });
  });

  it.each<[string, unknown, string]>([
    ['channels to draft on', { ...REQUEST, integrations: ['FAKE-channel'] }, 'CLIPPING_FIELDS_INVALID'],
    ['no fit (no blur default)', { url: REQUEST.url, clips: 3 }, 'CLIPPING_FIT_REQUIRED'],
    ['no clip count (no 5 default)', { url: REQUEST.url, fit: 'blur' }, 'CLIPPING_COUNT_INVALID'],
    ['0 clips', { ...REQUEST, clips: 0 }, 'CLIPPING_COUNT_INVALID'],
    ['11 clips', { ...REQUEST, clips: 11 }, 'CLIPPING_COUNT_INVALID'],
    ['another fit', { ...REQUEST, fit: 'contain' }, 'CLIPPING_FIT_REQUIRED'],
    ['another site', { ...REQUEST, url: 'https://vimeo.com/1' }, 'CLIPPING_SOURCE_REFUSED'],
    ['a look-alike host', { ...REQUEST, url: 'https://notyoutube.com/x' }, 'CLIPPING_SOURCE_REFUSED'],
    ['http', { ...REQUEST, url: 'http://youtube.com/watch?v=FAKE' }, 'CLIPPING_SOURCE_REFUSED'],
  ])('refuses %s', (_name, input, code) => {
    expect(parseManagedClippingRequest(input)).toEqual({ ok: false, code });
  });
});

describe('resumeOutcome', () => {
  it.each([
    { kind: 'evolink', taskId: 'task-1' },
    { kind: 'runpod', endpoint: 'ingest', jobId: 'job-1' },
    { kind: 'runpod', endpoint: 'clipper', jobId: 'job-1' },
    { kind: 'transloadit', assemblyId: ASSEMBLY_ID },
  ])('a provider handle is polled after a restart (%o)', (handle) => {
    expect(resumeOutcome(handle)).toBe('poll');
  });

  it.each<[string, unknown]>([
    ['an in-process job (there is none any more)', { kind: 'in_process', instanceId: 'worker-2', jobId: 'job-1' }],
    ['a forged task id', { kind: 'evolink', taskId: '../x' }],
    ['another RunPod endpoint', { kind: 'runpod', endpoint: 'normalize', jobId: 'job-1' }],
    ['an assembly id that is not one', { kind: 'transloadit', assemblyId: 'A'.repeat(32) }],
    ['a handle with an extra field', { kind: 'evolink', taskId: 'task-1', url: 'https://FAKE' }],
    ['a handle of another kind', { kind: 'transloadit', taskId: 'task-1' }],
    ['no handle', null],
  ])('%s is unknown, never resumed', (_name, handle) => {
    expect(resumeOutcome(handle)).toBe('outcome_unknown');
    expect(parseCreativeHandle(handle)).toEqual({ ok: false, code: 'HANDLE_INVALID' });
  });
});

describe('resultUrl', () => {
  const HOSTS = ['cdn.fake.test'];

  it('accepts https on exactly a configured host', () => {
    expect(resultUrl('https://cdn.fake.test/v.mp4?sig=1', HOSTS)?.hostname).toBe('cdn.fake.test');
    expect(resultUrl('https://CDN.fake.test/v.mp4', HOSTS)?.hostname).toBe('cdn.fake.test');
  });

  it.each([
    'http://cdn.fake.test/v.mp4',
    'https://cdn.fake.test:444/v.mp4',
    'https://a.cdn.fake.test/v.mp4',
    'https://u:p@cdn.fake.test/v.mp4',
    'https://169.254.169.254/v.mp4',
    'https://0x7f000001/v.mp4',
    'https://[::1]/v.mp4',
    'not a url',
  ])('refuses %s', (url) => {
    expect(resultUrl(url, HOSTS)).toBeNull();
  });

  it('refuses an address or a local name even when it is configured', () => {
    for (const host of ['10.0.0.1', 'localhost', 'api.localhost', 'storage.local', 'db.internal', 'minio']) {
      expect(resultUrl(`https://${host}/v.mp4`, [host])).toBeNull();
    }
  });
});

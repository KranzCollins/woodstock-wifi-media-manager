import {
  ClipFit,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
} from '@gitroom/nestjs-libraries/managed-creative/clipping-builders';
import {
  SLIDES_IMAGE_MODEL,
  SLIDES_SPEECH_MODEL,
  isAssemblyId,
} from '@gitroom/nestjs-libraries/managed-creative/slides-builders';
import { ClippingWord } from '@gitroom/nestjs-libraries/upload/clipping.processor.interface';
import { seedanceGenerationBody } from '@gitroom/nestjs-libraries/videos/seedance/seedance';

// Stage contract between the W&W durable operation queue and the creative
// worker (docs/managed-extension/creative-jobs-implementation.md). Every
// provider, model and stage is a closed choice: there is no generic "call this
// tool" stage. W&W keeps the queue, the confirmation and the budget; the
// worker attempts each billable submit at most once and reports what it knows.

export const CREATIVE_STAGE_VERSION = 'ww.creative-stage.v1';

export const IMAGE_MODEL = 'chatgpt-image-latest';
export const SEEDANCE_MODELS = [
  'seedance-2.0-fast-text-to-video',
  'seedance-2.0-fast-reference-to-video',
] as const;

export const IMAGE_PROMPT_MAX = 4000;
export const VIDEO_PROMPT_MAX = 4000;
export const SEEDANCE_IMAGES_MAX = 3;
export const URL_MAX = 2048;
export const MANAGED_CLIPS = { min: 1, max: 10 } as const;
// Same bound as MAX_SOURCE_MINUTES of ClippingService: no analyse job asks for
// a longer video, whatever the balance
export const MANAGED_SOURCE_MAX_SECONDS = 180 * 60;
export const CLIPPING_SOURCE_HOST = /(^|\.)(youtube\.com|youtu\.be)$/i;
// The title of the source, written into the clip selection instructions
export const CLIPPING_TITLE_MAX = 300;
// A clip of MAX_CLIP_SECONDS has far fewer spoken words
export const CLIP_WORDS_MAX = 2000;
const WORD_TEXT_MAX = 1000;
// The model is told "between 3-5 slides maximum"; every slide is two more paid
// requests, so more than that is never accepted
export const SLIDES_MAX = 5;
export const VOICE_TEXT_MAX = 2000;
// One voice of VOICE_TEXT_MAX is far shorter
export const SLIDE_SPEECH_MAX_SECONDS = 600;
const VOICE_ID = /^[A-Za-z0-9]{1,64}$/;

export type ImageOrientation = 'square' | 'vertical';
export type VideoOutput = 'vertical' | 'horizontal';
export type SeedanceModel = (typeof SEEDANCE_MODELS)[number];

// The prompt is sent as confirmed: the managed flow never rewrites it
// (generatePromptForPicture is not part of this contract)
export interface ImageGenerateStage {
  stage: 'image.generate';
  provider: 'openai';
  model: typeof IMAGE_MODEL;
  prompt: string;
  orientation: ImageOrientation;
}

// The model follows from the images exactly like Seedance picks it, and is
// part of what the human confirms
export interface SeedanceSubmitStage {
  stage: 'video.submit';
  provider: 'evolink';
  model: SeedanceModel;
  prompt: string;
  output: VideoOutput;
  imageUrls: string[];
}

export interface SeedanceStatusStage {
  stage: 'video.status';
  provider: 'evolink';
  handle: EvolinkHandle;
}

// image-text-slides, one stage per request of ImagesSlides. The voice texts
// and lengths of the assembly are the receipts of the script and speech
// stages; the scratch urls are signed by the worker for the operation id and
// the slide index, never named by a stage
export interface SlidesScriptStage {
  stage: 'slides.script';
  provider: 'openai';
  prompt: string;
}

export interface SlidesImageStage {
  stage: 'slides.image';
  provider: 'fal';
  model: typeof SLIDES_IMAGE_MODEL;
  imagePrompt: string;
  output: VideoOutput;
}

export interface SlidesSpeechStage {
  stage: 'slides.speech';
  provider: 'elevenlabs';
  model: typeof SLIDES_SPEECH_MODEL;
  voice: string;
  voiceText: string;
}

export interface SlidesAssembleStage {
  stage: 'slides.assemble';
  provider: 'transloadit';
  operationId: string;
  // made with newAssemblyId and recorded by W&W before the stage runs
  assemblyId: string;
  slides: { voiceText: string; seconds: number }[];
}

export interface SlidesStatusStage {
  stage: 'slides.status';
  provider: 'transloadit';
  handle: TransloaditHandle;
}

// Clipping, one stage per job of ClippingService. Times, fit, words and title
// come from the receipts of the earlier stages (analyse, transcribe, pick,
// fetch); the transcript the selection reads is the one the worker retained,
// and every scratch url is signed by the worker, never named by a stage
export interface ClippingAnalyseStage {
  stage: 'clipping.analyse';
  provider: 'runpod';
  operationId: string;
  url: string;
  audioOnly: boolean;
  maxDurationSeconds: number;
}

export interface ClippingTranscribeStage {
  stage: 'clipping.transcribe';
  provider: 'deepgram';
  operationId: string;
}

export interface ClippingPickStage {
  stage: 'clipping.pick';
  provider: 'openai';
  operationId: string;
  title: string;
  clips: number;
}

export interface ClippingClipFetchStage {
  stage: 'clipping.clip_fetch';
  provider: 'runpod';
  operationId: string;
  clip: number;
  url: string;
  fit: ClipFit;
  start: number;
  end: number;
  durationSeconds?: number | null;
}

export interface ClippingClipCaptionStage {
  stage: 'clipping.clip_caption';
  provider: 'deepgram';
  operationId: string;
  clip: number;
}

export interface ClippingClipRenderStage {
  stage: 'clipping.clip_render';
  provider: 'runpod';
  operationId: string;
  clip: number;
  fit: ClipFit;
  start: number;
  end: number;
  trimStart: number;
  words: ClippingWord[];
}

export interface ClippingStatusStage {
  stage: 'clipping.status';
  provider: 'runpod';
  handle: RunPodHandle;
}

export type CreativeStage =
  | ImageGenerateStage
  | SeedanceSubmitStage
  | SeedanceStatusStage
  | SlidesScriptStage
  | SlidesImageStage
  | SlidesSpeechStage
  | SlidesAssembleStage
  | SlidesStatusStage
  | ClippingAnalyseStage
  | ClippingTranscribeStage
  | ClippingPickStage
  | ClippingClipFetchStage
  | ClippingClipCaptionStage
  | ClippingClipRenderStage
  | ClippingStatusStage;

export interface EvolinkHandle {
  kind: 'evolink';
  taskId: string;
}

// The two RunPod endpoints of the media service; the endpoint ids themselves
// are configuration, never part of a stage
export type RunPodEndpoint = 'ingest' | 'clipper';

export interface RunPodHandle {
  kind: 'runpod';
  endpoint: RunPodEndpoint;
  jobId: string;
}

// The assembly id W&W made and recorded before the assembly was sent
export interface TransloaditHandle {
  kind: 'transloadit';
  assemblyId: string;
}

// Every handle can be polled by any worker process. A stage without a handle
// is one request whose answer is its result (an image, a script, a voice, a
// transcript, a selection): there is nothing to poll, and one that was
// interrupted is settled by W&W as unknown, never sent again by itself
export type CreativeHandle = EvolinkHandle | RunPodHandle | TransloaditHandle;

// What a status read reports for a handle that is not one (forged, from
// another kind, or for an endpoint that is not configured): never requested
export type InvalidHandle = { status: 'invalid'; code: 'HANDLE_INVALID' };

// What a status read reports when the provider answers 404 for a handle. The
// job may have expired, may never have been created, or the provider may not
// know it yet: none of that is inferred here. It is not "not sent", not a
// refund and not a retry; W&W bounds how long it polls and then settles it
export type HandleNotFound = { status: 'not_found'; code: 'STATUS_NOT_FOUND' };

// "sent" is false only when the request never left the process. Anything sent
// may have been billed: W&W never releases or refunds a reservation for it and
// never sends it again by itself. "unknown" has no provider receipt at all
export type SubmitOutcome<Receipt> =
  | { outcome: 'not_sent'; sent: false; code: string }
  | { outcome: 'accepted'; sent: true; receipt: Receipt }
  | {
      outcome: 'rejected';
      sent: true;
      code: string;
      httpStatus: number;
      providerCode?: string;
    }
  | { outcome: 'unknown'; sent: true; code: string };

// What W&W ingest receives. Everything in "declared" is untrusted, the bytes
// are checked by W&W before they are uploaded as DRAFT media
export interface CreativeArtifact {
  artifactId: string;
  role: 'image' | 'video' | 'clip' | 'clip_thumbnail';
  source:
    | { kind: 'inline_base64'; mimeType: 'image/png'; data: string }
    | { kind: 'url'; url: string; host: string };
  declared: { byteLength?: number; title?: string; content?: string };
}

export type StageValidation<T> =
  | { ok: true; value: T }
  | { ok: false; code: string };

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isProviderTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID.test(value);
}

// A provider error code is passed on only when it is a short plain token;
// provider messages never are (they can echo prompts or urls)
export function safeProviderCode(value: unknown): string | undefined {
  // A well-formed string can still be an echoed credential. Only our fixed diagnostic vocabulary may leave the boundary.
  const allowed = new Set(['invalid_prompt', 'rate_limited', 'rate_limit_exceeded', 'content_blocked',
    'content_policy_violation', 'INVALID_AUTH', 'quota_exceeded', 'invalid_api_key', 'insufficient_quota',
    'IMPORT_FILE_ERROR', 'RATE_LIMIT_REACHED', 'INVALID_FILE_META_DATA', 'ASSEMBLY_CANCELED']);
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

export function httpsUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value.length || value.length > URL_MAX) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url
      : null;
  } catch (err) {
    return null;
  }
}

const ADDRESS_HOST = /^(\d+\.\d+\.\d+\.\d+|\[.*\])$/;
const LOCAL_HOST = /(^|\.)(localhost|local|internal)$/;

// A provider result url that W&W ingest will fetch: https on the default port,
// on exactly one of the configured hosts, and never an address or a local
// name even when one is configured by mistake
export function resultUrl(value: unknown, hosts: readonly string[]): URL | null {
  const url = httpsUrl(value);
  if (!url) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  return !url.port &&
    host.includes('.') &&
    !ADDRESS_HOST.test(host) &&
    !LOCAL_HOST.test(host) &&
    hosts.includes(host)
    ? url
    : null;
}

export const seconds = (value: unknown, max: number): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max;

export const isClipFit = (value: unknown): value is ClipFit =>
  value === 'blur' || value === 'crop';

export const isClippingSource = (value: unknown) => {
  const url = httpsUrl(value);
  return !!url && CLIPPING_SOURCE_HOST.test(url.hostname);
};

export const isClipWindow = (start: unknown, end: unknown) =>
  seconds(start, MANAGED_SOURCE_MAX_SECONDS) &&
  seconds(end, MANAGED_SOURCE_MAX_SECONDS) &&
  end - start >= MIN_CLIP_SECONDS &&
  end - start <= MAX_CLIP_SECONDS;

export const isClipWords = (value: unknown): value is ClippingWord[] =>
  Array.isArray(value) &&
  value.length <= CLIP_WORDS_MAX &&
  value.every(
    (word) =>
      typeof word?.text === 'string' &&
      word.text.length <= WORD_TEXT_MAX &&
      seconds(word.start, MANAGED_SOURCE_MAX_SECONDS) &&
      seconds(word.end, MANAGED_SOURCE_MAX_SECONDS)
  );

export const isVoiceId = (value: unknown): value is string =>
  typeof value === 'string' && VOICE_ID.test(value);

export const isSlideSeconds = (value: unknown): value is number =>
  seconds(value, SLIDE_SPEECH_MAX_SECONDS) && value > 0;

// The exact body Seedance sends for this stage (managed images have no
// library id, only the url Evolink reads)
export function seedanceBodyFor(
  stage: Pick<SeedanceSubmitStage, 'prompt' | 'output' | 'imageUrls'>
) {
  return seedanceGenerationBody(stage.output, {
    prompt: stage.prompt,
    images: stage.imageUrls.map((path) => ({ id: '', path })),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const prompt = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

// The fields and the provider of a stage, the same way for every stage
const stageFields = (
  input: Record<string, unknown>,
  provider: string,
  fields: string[]
): StageValidation<never> | null => {
  if (!onlyKeys(input, ['stage', 'provider', ...fields])) {
    return { ok: false, code: 'STAGE_UNKNOWN_FIELD' };
  }
  return input.provider === provider
    ? null
    : { ok: false, code: 'STAGE_PROVIDER_REFUSED' };
};

// A status stage polls exactly one kind of handle, on its own provider
const statusStage = <T extends CreativeStage>(
  input: Record<string, unknown>,
  provider: string,
  kind: CreativeHandle['kind']
): StageValidation<T> => {
  if (!onlyKeys(input, ['stage', 'provider', 'handle'])) {
    return { ok: false, code: 'STAGE_UNKNOWN_FIELD' };
  }
  const handle = parseCreativeHandle(input.handle);
  if (input.provider !== provider || !handle.ok || handle.value.kind !== kind) {
    return { ok: false, code: 'STAGE_HANDLE_INVALID' };
  }
  return { ok: true, value: input as unknown as T };
};

// A handle read back from the W&W ledger. Unknown kinds or keys are refused
export function parseCreativeHandle(
  input: unknown
): StageValidation<CreativeHandle> {
  if (isRecord(input)) {
    if (
      input.kind === 'evolink' &&
      onlyKeys(input, ['kind', 'taskId']) &&
      isProviderTaskId(input.taskId)
    ) {
      return { ok: true, value: input as unknown as EvolinkHandle };
    }

    if (
      input.kind === 'runpod' &&
      onlyKeys(input, ['kind', 'endpoint', 'jobId']) &&
      (input.endpoint === 'ingest' || input.endpoint === 'clipper') &&
      isProviderTaskId(input.jobId)
    ) {
      return { ok: true, value: input as unknown as RunPodHandle };
    }

    if (
      input.kind === 'transloadit' &&
      onlyKeys(input, ['kind', 'assemblyId']) &&
      isAssemblyId(input.assemblyId)
    ) {
      return { ok: true, value: input as unknown as TransloaditHandle };
    }
  }

  return { ok: false, code: 'HANDLE_INVALID' };
}

// A stage read back from the W&W queue. Unknown keys, stages, providers or
// models are refused, never ignored
export function parseCreativeStage(
  input: unknown
): StageValidation<CreativeStage> {
  if (!isRecord(input)) {
    return { ok: false, code: 'STAGE_INVALID' };
  }

  switch (input.stage) {
    case 'image.generate':
      if (
        !onlyKeys(input, ['stage', 'provider', 'model', 'prompt', 'orientation'])
      ) {
        return { ok: false, code: 'STAGE_UNKNOWN_FIELD' };
      }
      if (input.provider !== 'openai' || input.model !== IMAGE_MODEL) {
        return { ok: false, code: 'STAGE_PROVIDER_REFUSED' };
      }
      if (!prompt(input.prompt, IMAGE_PROMPT_MAX)) {
        return { ok: false, code: 'STAGE_PROMPT_INVALID' };
      }
      if (input.orientation !== 'square' && input.orientation !== 'vertical') {
        return { ok: false, code: 'STAGE_OPTION_INVALID' };
      }
      return { ok: true, value: input as unknown as ImageGenerateStage };

    case 'video.submit': {
      if (
        !onlyKeys(input, [
          'stage',
          'provider',
          'model',
          'prompt',
          'output',
          'imageUrls',
        ])
      ) {
        return { ok: false, code: 'STAGE_UNKNOWN_FIELD' };
      }
      if (input.provider !== 'evolink') {
        return { ok: false, code: 'STAGE_PROVIDER_REFUSED' };
      }
      if (!prompt(input.prompt, VIDEO_PROMPT_MAX)) {
        return { ok: false, code: 'STAGE_PROMPT_INVALID' };
      }
      if (input.output !== 'vertical' && input.output !== 'horizontal') {
        return { ok: false, code: 'STAGE_OPTION_INVALID' };
      }
      const imageUrls = input.imageUrls;
      if (
        !Array.isArray(imageUrls) ||
        imageUrls.length > SEEDANCE_IMAGES_MAX ||
        !imageUrls.every((url) => !!httpsUrl(url))
      ) {
        return { ok: false, code: 'STAGE_IMAGES_INVALID' };
      }
      if (
        input.model !==
        seedanceBodyFor({
          prompt: input.prompt as string,
          output: input.output as VideoOutput,
          imageUrls: imageUrls as string[],
        }).model
      ) {
        return { ok: false, code: 'STAGE_MODEL_MISMATCH' };
      }
      return { ok: true, value: input as unknown as SeedanceSubmitStage };
    }

    case 'video.status':
      return statusStage<SeedanceStatusStage>(input, 'evolink', 'evolink');

    case 'slides.script':
      return (
        stageFields(input, 'openai', ['prompt']) ||
        (prompt(input.prompt, VIDEO_PROMPT_MAX)
          ? { ok: true, value: input as unknown as SlidesScriptStage }
          : { ok: false, code: 'STAGE_PROMPT_INVALID' })
      );

    case 'slides.image':
      return (
        stageFields(input, 'fal', ['model', 'imagePrompt', 'output']) ||
        (input.model !== SLIDES_IMAGE_MODEL
          ? { ok: false, code: 'STAGE_PROVIDER_REFUSED' }
          : !prompt(input.imagePrompt, IMAGE_PROMPT_MAX)
          ? { ok: false, code: 'STAGE_PROMPT_INVALID' }
          : input.output !== 'vertical' && input.output !== 'horizontal'
          ? { ok: false, code: 'STAGE_OPTION_INVALID' }
          : { ok: true, value: input as unknown as SlidesImageStage })
      );

    case 'slides.speech':
      return (
        stageFields(input, 'elevenlabs', ['model', 'voice', 'voiceText']) ||
        (input.model !== SLIDES_SPEECH_MODEL
          ? { ok: false, code: 'STAGE_PROVIDER_REFUSED' }
          : !isVoiceId(input.voice)
          ? { ok: false, code: 'STAGE_OPTION_INVALID' }
          : !prompt(input.voiceText, VOICE_TEXT_MAX)
          ? { ok: false, code: 'STAGE_PROMPT_INVALID' }
          : { ok: true, value: input as unknown as SlidesSpeechStage })
      );

    case 'slides.assemble': {
      const refused = stageFields(input, 'transloadit', [
        'operationId',
        'assemblyId',
        'slides',
      ]);
      if (refused) {
        return refused;
      }
      if (!isManagedOperationId(input.operationId) || !isAssemblyId(input.assemblyId)) {
        return { ok: false, code: 'STAGE_OPTION_INVALID' };
      }
      const slides = input.slides;
      if (
        !Array.isArray(slides) ||
        !slides.length ||
        slides.length > SLIDES_MAX ||
        !slides.every(
          (slide) =>
            isRecord(slide) &&
            onlyKeys(slide, ['voiceText', 'seconds']) &&
            prompt(slide.voiceText, VOICE_TEXT_MAX) &&
            isSlideSeconds(slide.seconds)
        )
      ) {
        return { ok: false, code: 'STAGE_SLIDES_INVALID' };
      }
      return { ok: true, value: input as unknown as SlidesAssembleStage };
    }

    case 'slides.status':
      return statusStage<SlidesStatusStage>(input, 'transloadit', 'transloadit');

    case 'clipping.analyse':
      return (
        stageFields(input, 'runpod', [
          'operationId',
          'url',
          'audioOnly',
          'maxDurationSeconds',
        ]) ||
        (!isManagedOperationId(input.operationId) ||
        typeof input.audioOnly !== 'boolean' ||
        !Number.isInteger(input.maxDurationSeconds) ||
        !seconds(input.maxDurationSeconds, MANAGED_SOURCE_MAX_SECONDS) ||
        input.maxDurationSeconds < 1
          ? { ok: false, code: 'STAGE_OPTION_INVALID' }
          : !isClippingSource(input.url)
          ? { ok: false, code: 'STAGE_SOURCE_REFUSED' }
          : { ok: true, value: input as unknown as ClippingAnalyseStage })
      );

    case 'clipping.transcribe':
      return (
        stageFields(input, 'deepgram', ['operationId']) ||
        (isManagedOperationId(input.operationId)
          ? { ok: true, value: input as unknown as ClippingTranscribeStage }
          : { ok: false, code: 'STAGE_OPTION_INVALID' })
      );

    case 'clipping.pick':
      return (
        stageFields(input, 'openai', ['operationId', 'title', 'clips']) ||
        (isManagedOperationId(input.operationId) &&
        typeof input.title === 'string' &&
        input.title.length <= CLIPPING_TITLE_MAX &&
        Number.isInteger(input.clips) &&
        (input.clips as number) >= MANAGED_CLIPS.min &&
        (input.clips as number) <= MANAGED_CLIPS.max
          ? { ok: true, value: input as unknown as ClippingPickStage }
          : { ok: false, code: 'STAGE_OPTION_INVALID' })
      );

    case 'clipping.clip_fetch':
      return (
        stageFields(input, 'runpod', [
          'operationId',
          'clip',
          'url',
          'fit',
          'start',
          'end',
          'durationSeconds',
        ]) ||
        (!isManagedOperationId(input.operationId) ||
        !isManagedClipIndex(input.clip) ||
        !isClipFit(input.fit) ||
        !isClipWindow(input.start, input.end) ||
        (input.durationSeconds != null &&
          !seconds(input.durationSeconds, MANAGED_SOURCE_MAX_SECONDS))
          ? { ok: false, code: 'STAGE_OPTION_INVALID' }
          : !isClippingSource(input.url)
          ? { ok: false, code: 'STAGE_SOURCE_REFUSED' }
          : { ok: true, value: input as unknown as ClippingClipFetchStage })
      );

    case 'clipping.clip_caption':
      return (
        stageFields(input, 'deepgram', ['operationId', 'clip']) ||
        (isManagedOperationId(input.operationId) && isManagedClipIndex(input.clip)
          ? { ok: true, value: input as unknown as ClippingClipCaptionStage }
          : { ok: false, code: 'STAGE_OPTION_INVALID' })
      );

    case 'clipping.clip_render':
      return (
        stageFields(input, 'runpod', [
          'operationId',
          'clip',
          'fit',
          'start',
          'end',
          'trimStart',
          'words',
        ]) ||
        (isManagedOperationId(input.operationId) &&
        isManagedClipIndex(input.clip) &&
        isClipFit(input.fit) &&
        isClipWindow(input.start, input.end) &&
        seconds(input.trimStart, input.start as number) &&
        isClipWords(input.words)
          ? { ok: true, value: input as unknown as ClippingClipRenderStage }
          : { ok: false, code: 'STAGE_OPTION_INVALID' })
      );

    case 'clipping.status':
      return statusStage<ClippingStatusStage>(input, 'runpod', 'runpod');

    default:
      return { ok: false, code: 'STAGE_UNKNOWN' };
  }
}

// After a restart only a recorded provider handle can be polled again. A
// stage without one (see CreativeHandle) or a handle that does not parse is
// never resumed or started again: the operation stops as unknown
export function resumeOutcome(handle: unknown): 'poll' | 'outcome_unknown' {
  return parseCreativeHandle(handle).ok ? 'poll' : 'outcome_unknown';
}

// Managed clipping is explicit: the fit and the number of clips are always
// chosen (no blur / 5 default), and there are no channels, so no drafts are
// made by the clipping itself. Results only reach Postiz through W&W ingest
export interface ManagedClippingRequest {
  url: string;
  fit: ClipFit;
  clips: number;
}

export function parseManagedClippingRequest(
  input: unknown
): StageValidation<ManagedClippingRequest> {
  if (!isRecord(input) || !onlyKeys(input, ['url', 'fit', 'clips'])) {
    return { ok: false, code: 'CLIPPING_FIELDS_INVALID' };
  }

  const url = httpsUrl(input.url);
  if (!url || !CLIPPING_SOURCE_HOST.test(url.hostname)) {
    return { ok: false, code: 'CLIPPING_SOURCE_REFUSED' };
  }

  if (input.fit !== 'blur' && input.fit !== 'crop') {
    return { ok: false, code: 'CLIPPING_FIT_REQUIRED' };
  }

  if (
    !Number.isInteger(input.clips) ||
    (input.clips as number) < MANAGED_CLIPS.min ||
    (input.clips as number) > MANAGED_CLIPS.max
  ) {
    return { ok: false, code: 'CLIPPING_COUNT_INVALID' };
  }

  return {
    ok: true,
    value: { url: input.url as string, fit: input.fit, clips: input.clips as number },
  };
}

// Every scratch file of a managed operation is named after the W&W operation
// id, in the shape ClippingService names its own (keys()/clipKeys()). Nothing
// in a stage chooses a path: the worker signs these keys and the adapters
// refuse any other
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isManagedOperationId(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_ID.test(value);
}

// "clip" is the index of the clip, below MANAGED_CLIPS.max
export type ManagedScratchStep =
  | { step: 'analyse' }
  | { step: 'transcribe' }
  | { step: 'clip_fetch'; clip: number }
  | { step: 'clip_render'; clip: number };

export function managedScratchKeys(operationId: string) {
  const clip = (index: number) => ({
    reference: `ww-${operationId}-clip-${index}`,
    source: `ww-${operationId}-clip-${index}-source.mp4`,
    output: `ww-${operationId}-clip-${index}.mp4`,
    thumbnail: `ww-${operationId}-clip-${index}.jpg`,
  });

  return {
    reference: `ww-${operationId}`,
    transcript: `ww-${operationId}-transcript.json`,
    audio: `ww-${operationId}-audio.ogg`,
    clip,
  };
}

export const isManagedClipIndex = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= 0 &&
  (value as number) < MANAGED_CLIPS.max;

// A signed scratch url: https, on one of the configured storage hosts, and its
// last path part is exactly the expected key. The url itself is a credential
// and is never returned, logged or put in an error
export function isScratchUrl(
  value: unknown,
  key: string,
  hosts: readonly string[]
): boolean {
  const url = httpsUrl(value);
  if (!url || !hosts.includes(url.hostname.toLowerCase())) {
    return false;
  }

  try {
    return decodeURIComponent(url.pathname.split('/').pop() || '') === key;
  } catch (err) {
    return false;
  }
}

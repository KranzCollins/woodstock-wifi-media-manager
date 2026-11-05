import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import {
  ClippingTranscript,
  ClippingWord,
} from '@gitroom/nestjs-libraries/upload/clipping.processor.interface';
import { MediaProcessorStatus } from '@gitroom/nestjs-libraries/upload/media.processor.interface';
import {
  CreativeHandle,
  IMAGE_MODEL,
  MANAGED_SOURCE_MAX_SECONDS,
  RunPodHandle,
  managedScratchKeys,
  resultUrl,
  seconds,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';
import {
  SelectedClip,
  analyseOutcome,
  clipCaptionWords,
  clipFetchOutcome,
  clipRenderOutcome,
} from '@gitroom/nestjs-libraries/managed-creative/clipping-builders';
import { slideScratchKeys } from '@gitroom/nestjs-libraries/managed-creative/slides-builders';
import {
  ProviderTransport,
  deadline,
  fetchTransport,
  readBoundedBytes,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';
import { OpenaiImageAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/openai.image.adapter';
import {
  EvolinkSeedanceAdapter,
  SeedanceStatusResult,
} from '@gitroom/nestjs-libraries/managed-creative/providers/evolink.seedance.adapter';
import {
  AssemblyStatusResult,
  SlideScript,
  SlidesAdapter,
} from '@gitroom/nestjs-libraries/managed-creative/providers/slides.adapter';
import {
  RunPodAdapter,
  RunPodClipOutput,
  RunPodIngestOutput,
} from '@gitroom/nestjs-libraries/managed-creative/providers/runpod.adapter';
import { DeepgramAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/deepgram.adapter';
import { OpenaiClipsAdapter } from '@gitroom/nestjs-libraries/managed-creative/providers/openai.clips.adapter';
import {
  ElevenLabsVoicesAdapter,
  ManagedVoice,
} from '@gitroom/nestjs-libraries/managed-creative/providers/elevenlabs.voices.adapter';
import {
  CreativeScratch,
  R2CreativeScratch,
  ScratchRead,
  creativeScratchConfig,
  creativeScratchKeys,
} from '@gitroom/nestjs-libraries/managed-creative/creative.scratch';
import {
  CREATIVE_ARTIFACT_MAX_BYTES,
  CreativeAnalyseResult,
  CreativeCallAnswer,
  CreativeCallStatus,
  CreativeInputOf,
  CreativeJobInput,
  CreativeKind,
  CreativePollAnswer,
  CreativePollStatus,
  CreativeRefusal,
  CreativeStageName,
  creativeCode,
  sha256Of,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.contracts';

// The owned creative runtime (docs/managed-extension/creative-runtime.md):
// the composition of the closed provider adapters and the private scratch
// bucket, one W&W stage at a time. No Prisma: the service hands in what
// earlier calls of the job left (their private intermediates and the pinned
// scratch objects) and persists what comes back.
//
// prepare() does every local step a call needs (preconditions, configuration,
// reading retained inputs, signing scratch urls) and refuses before anything
// is recorded or sent; its send() makes exactly one billable provider request
// and then retains what it answered. Polls and artifact reads never create
// provider work. Every url a provider gets is one signed here for a fixed key
// of the job's operation; a provider's own result url is only fetched from
// the configured result hosts, and never stored or returned.

export type CreativeObjectRole =
  | 'artifact'
  | 'slide_image'
  | 'slide_audio'
  | 'transcript'
  | 'source';

// A retained scratch object, pinned by its digest. Read back by key only
export interface CreativeObject {
  role: CreativeObjectRole;
  slot: number;
  storageKey: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  assetId: string | null;
  assetVersion: number | null;
}

// What an earlier call of the same job left, from its call row
export interface CreativePriorCall {
  stage: CreativeStageName;
  item: number;
  attempt: number;
  status: CreativeCallStatus;
  intermediate: Record<string, unknown> | null;
  pollStatus: CreativePollStatus | null;
  pollResult: CreativeAnalyseResult | null;
  pollIntermediate: Record<string, unknown> | null;
}

export interface CreativeCallContext {
  // the 32-hex scratch namespace of the job's binding, never W&W's job id
  operationId: string;
  input: CreativeJobInput;
  stage: CreativeStageName;
  item: number;
  attempt: number;
  // slides.assemble only: the id W&W committed before the call
  assemblyId: string | null;
  calls: CreativePriorCall[];
  objects: CreativeObject[];
}

export interface CreativeDispatch {
  answer: CreativeCallAnswer;
  // the owned handle of an accepted call, kept on its row
  handle?: CreativeHandle;
  intermediate?: Record<string, unknown>;
  objects?: CreativeObject[];
}

export type CreativePrepared =
  | { ok: false; code: string }
  | {
      ok: true;
      // known before sending (an assembly id): recorded with DISPATCHING
      handle?: CreativeHandle;
      send: () => Promise<CreativeDispatch>;
    };

export interface CreativePollContext {
  operationId: string;
  input: CreativeJobInput;
  stage: CreativeStageName;
  item: number;
  attempt: number;
  handle: CreativeHandle;
  calls: CreativePriorCall[];
}

export type CreativePollOutcome =
  | { invalid: true }
  | {
      invalid?: false;
      answer: CreativePollAnswer;
      // completed / failed are kept on the call row and answered again as is
      final: boolean;
      intermediate?: Record<string, unknown>;
      objects?: CreativeObject[];
    };

export interface CreativeArtifactContext {
  operationId: string;
  kind: CreativeKind;
  item: number;
  calls: CreativePriorCall[];
  objects: CreativeObject[];
}

export type CreativeArtifactRead =
  | {
      kind: 'bytes';
      bytes: Buffer;
      contentType: CreativeMediaType;
      sha256: string;
      // a clip RunPod wrote is pinned by the first read of it
      pin?: CreativeObject;
    }
  | { kind: 'missing'; code: string };

export interface CreativeRuntimeDeps {
  scratch: CreativeScratch | null;
  image: OpenaiImageAdapter | null;
  seedance: EvolinkSeedanceAdapter | null;
  slides: SlidesAdapter | null;
  runpod: RunPodAdapter | null;
  deepgram: DeepgramAdapter | null;
  clips: OpenaiClipsAdapter | null;
  voices: ElevenLabsVoicesAdapter | null;
  transport: ProviderTransport;
  // where a provider's result may be fetched from (resultUrl)
  resultHosts: {
    evolink: readonly string[];
    fal: readonly string[];
    transloadit: readonly string[];
  };
}

// The transcript of 180 minutes of speech stays well below this (as Deepgram)
const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;
// One provider result read: a 20 MiB video on a slow link
const RESULT_FETCH_MS = 2 * 60 * 1000;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type CreativeMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'video/mp4';

export const CREATIVE_MEDIA_EXTENSIONS: Record<CreativeMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

// The type the bytes themselves say, from their signature only. W&W ingest
// checks them again before anything becomes DRAFT media
export function sniffCreativeMedia(bytes: Buffer): CreativeMediaType | null {
  if (bytes.length >= PNG.length && bytes.subarray(0, PNG.length).equals(PNG)) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    return 'video/mp4';
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const hasKeys = (value: Record<string, unknown>, keys: string) =>
  Object.keys(value).sort().join(',') === keys;

// The transcript file a clip selection and its captions read: the shape
// ClippingService stores (ClippingTranscript), checked strictly. A file with
// any other key, an out-of-range time or control text is not read at all
export function parseClippingTranscript(
  value: unknown
): ClippingTranscript | null {
  if (
    !isRecord(value) ||
    !hasKeys(value, 'language,origin,segments,version,word_level,words') ||
    value.version !== 1 ||
    typeof value.language !== 'string' ||
    !LANGUAGE.test(value.language) ||
    !['auto_generated', 'uploader_provided', 'transcribed'].includes(
      value.origin as string
    ) ||
    typeof value.word_level !== 'boolean' ||
    !Array.isArray(value.segments) ||
    value.segments.length > 20000 ||
    !Array.isArray(value.words) ||
    value.words.length > 100000
  ) {
    return null;
  }

  let characters = 0;
  const entries = (list: unknown[], max: number) => {
    const output: ClippingWord[] = [];
    for (const entry of list) {
      if (!isRecord(entry) || !hasKeys(entry, 'end,start,text')) {
        return null;
      }
      const { start, end, text } = entry;
      if (
        !seconds(start, MANAGED_SOURCE_MAX_SECONDS) ||
        !seconds(end, MANAGED_SOURCE_MAX_SECONDS) ||
        end < start ||
        typeof text !== 'string' ||
        text.length > max ||
        CONTROL.test(text)
      ) {
        return null;
      }
      characters += text.length;
      if (characters > 800000) {
        return null;
      }
      output.push({ start, end, text });
    }
    return output;
  };

  const segments = entries(value.segments, 20_000);
  const words = entries(value.words, 1000);
  if (!segments || !words) {
    return null;
  }

  return {
    version: 1,
    language: value.language,
    origin: value.origin as ClippingTranscript['origin'],
    word_level: value.word_level,
    segments,
    words,
  };
}

// The bytes of a transcript file, read as strictly as the file itself
function transcriptOf(bytes: Buffer): ClippingTranscript | null {
  try {
    return parseClippingTranscript(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
  } catch (err) {
    return null;
  }
}

const refused = (code: string): CreativePrepared => ({ ok: false, code });

const unknown = (code: string): CreativeDispatch => ({
  answer: { outcome: 'unknown', code },
});

// An adapter outcome that is not a success, as W&W's refusal. An output the
// runtime cannot use is the provider's definitive answer: rejected (held)
function refusalOf(result: { outcome: string; code?: string }): CreativeRefusal {
  const outcome =
    result.outcome === 'not_sent'
      ? 'not_sent'
      : result.outcome === 'unknown'
      ? 'unknown'
      : 'rejected';
  return {
    outcome,
    code: creativeCode(
      result.code,
      outcome === 'not_sent'
        ? 'PROVIDER_NOT_SENT'
        : outcome === 'unknown'
        ? 'PROVIDER_OUTCOME_UNKNOWN'
        : 'PROVIDER_REJECTED'
    ),
  };
}

const RUNNING: CreativePollOutcome = { answer: { status: 'running' }, final: false };
const NOT_FOUND: CreativePollOutcome = { answer: { status: 'not_found' }, final: false };
const failed = (code: string): CreativePollOutcome => ({
  answer: { status: 'failed', code },
  final: true,
});
const completedNull = (
  extra: Pick<Extract<CreativePollOutcome, { answer: unknown }>, 'intermediate' | 'objects'> = {}
): CreativePollOutcome => ({
  answer: { status: 'completed', result: null },
  final: true,
  ...extra,
});

// ---- what earlier calls left ------------------------------------------------

const completedCall = (calls: CreativePriorCall[], stage: CreativeStageName, item?: number) =>
  calls.find(
    (call) =>
      call.stage === stage &&
      (item === undefined || call.item === item) &&
      call.status === 'COMPLETED'
  );

const polledCall = (calls: CreativePriorCall[], stage: CreativeStageName, item: number) =>
  calls.find(
    (call) =>
      call.stage === stage && call.item === item && call.pollStatus === 'COMPLETED'
  );

// the analysis the job goes on with: the audio-only one when it ran
function latestAnalyse(calls: CreativePriorCall[]) {
  return calls
    .filter((call) => call.stage === 'clip.analyse' && call.pollStatus === 'COMPLETED' && call.pollResult)
    .sort((a, b) => b.attempt - a.attempt)[0];
}

function scriptOf(calls: CreativePriorCall[]): SlideScript[] | null {
  const slides = completedCall(calls, 'slides.script')?.intermediate?.slides;
  return Array.isArray(slides) &&
    slides.every(
      (slide) =>
        isRecord(slide) &&
        typeof slide.imagePrompt === 'string' &&
        typeof slide.voiceText === 'string'
    )
    ? (slides as SlideScript[])
    : null;
}

function picksOf(calls: CreativePriorCall[]): SelectedClip[] | null {
  const clips = completedCall(calls, 'clip.pick')?.intermediate?.clips;
  return Array.isArray(clips) &&
    clips.every(
      (clip) =>
        isRecord(clip) &&
        typeof clip.start === 'number' &&
        typeof clip.end === 'number'
    )
    ? (clips as SelectedClip[])
    : null;
}

const objectOf = (objects: CreativeObject[], role: CreativeObjectRole, slot: number) =>
  objects.find((object) => object.role === role && object.slot === slot);

// The caption file RunPod wrote, pinned by the digest of the bytes read
const transcriptPin = (key: string, bytes: Buffer): CreativeObject => ({
  role: 'transcript',
  slot: 0,
  storageKey: key,
  sha256: sha256Of(bytes),
  byteLength: bytes.length,
  contentType: 'application/json',
  assetId: null,
  assetVersion: null,
});

// ---- the runtime ------------------------------------------------------------

export class ManagedCreativeRuntime {
  constructor(private _deps: CreativeRuntimeDeps) {}

  // Stores bytes under a fixed key, create-only. An object already there is
  // only adopted when it is exactly these bytes
  private async retain(
    scratch: CreativeScratch,
    target: { role: CreativeObjectRole; slot: number; key: string; contentType: string },
    bytes: Buffer
  ): Promise<CreativeObject | null> {
    const sha256 = sha256Of(bytes);
    try {
      if ((await scratch.create(target.key, bytes, target.contentType)) === 'exists') {
        const existing = await scratch.read(target.key, bytes.length);
        if (!existing.ok || sha256Of(existing.bytes) !== sha256) {
          return null;
        }
      }
    } catch (err) {
      return null;
    }

    return {
      role: target.role,
      slot: target.slot,
      storageKey: target.key,
      sha256,
      byteLength: bytes.length,
      contentType: target.contentType,
      assetId: null,
      assetVersion: null,
    };
  }

  // A pinned object, only when its bytes are still the ones recorded
  private async readPinned(
    scratch: CreativeScratch,
    object: CreativeObject,
    maxBytes: number
  ): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: string }> {
    const read = await scratch.read(object.storageKey, maxBytes);
    if (read.ok === false) {
      return {
        ok: false,
        code:
          read.reason === 'absent'
            ? 'OBJECT_ABSENT'
            : read.reason === 'too_large'
            ? 'OBJECT_TOO_LARGE'
            : 'OBJECT_READ_FAILED',
      };
    }
    if (sha256Of(read.bytes) !== object.sha256) {
      return { ok: false, code: 'OBJECT_CHANGED' };
    }
    return { ok: true, bytes: read.bytes };
  }

  // A provider's finished output, from one of its configured result hosts
  // only. Not a provider request: nothing is created or billed by it
  private async fetchResult(
    url: string,
    hosts: readonly string[]
  ): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: 'too_large' | 'failed' }> {
    const checked = resultUrl(url, hosts);
    if (!checked) {
      return { ok: false, reason: 'failed' };
    }

    const signal = deadline(RESULT_FETCH_MS);
    try {
      const response = await this._deps.transport(checked.toString(), {
        method: 'GET',
        headers: {},
        signal,
        redirect: 'error',
      });
      if (response.status !== 200) {
        return { ok: false, reason: 'failed' };
      }
      const read = await readBoundedBytes(response, CREATIVE_ARTIFACT_MAX_BYTES, signal);
      return read.ok === true
        ? { ok: true, bytes: read.bytes }
        : { ok: false, reason: read.reason === 'too_large' ? 'too_large' : 'failed' };
    } catch (err) {
      return { ok: false, reason: 'failed' };
    }
  }

  private async sign(
    work: () => Promise<string>
  ): Promise<string | null> {
    try {
      return await work();
    } catch (err) {
      return null;
    }
  }

  // The transcript the clip selection and the captions read: the one the
  // job pinned, or at the selection the captions file the analysis wrote
  private async transcript(
    ctx: Pick<CreativeCallContext, 'operationId' | 'calls' | 'objects'>,
    scratch: CreativeScratch
  ): Promise<
    | { ok: true; transcript: ClippingTranscript; pin?: CreativeObject }
    | { ok: false; code: string }
  > {
    const analyse = latestAnalyse(ctx.calls);
    if (!analyse?.pollResult) {
      return { ok: false, code: 'ANALYSE_NOT_COMPLETED' };
    }
    const origin = analyse.pollResult.transcript === 'auto' ? 'auto_generated' : 'transcribed';

    const pinned = objectOf(ctx.objects, 'transcript', 0);
    let bytes: Buffer;
    let pin: CreativeObject | undefined;
    if (pinned) {
      const read = await this.readPinned(scratch, pinned, TRANSCRIPT_MAX_BYTES);
      if (read.ok === false) {
        return { ok: false, code: `TRANSCRIPT_${read.code}` };
      }
      bytes = read.bytes;
    } else {
      if (analyse.pollResult.transcript !== 'auto') {
        return { ok: false, code: 'TRANSCRIPT_NOT_RETAINED' };
      }
      const key = managedScratchKeys(ctx.operationId).transcript;
      const read = await scratch.read(key, TRANSCRIPT_MAX_BYTES);
      if (read.ok === false) {
        return { ok: false, code: 'TRANSCRIPT_UNREADABLE' };
      }
      bytes = read.bytes;
      pin = transcriptPin(key, bytes);
    }

    const transcript = transcriptOf(bytes);
    if (!transcript || transcript.origin !== origin) {
      return { ok: false, code: 'TRANSCRIPT_INVALID' };
    }

    return { ok: true, transcript, pin };
  }

  // The caption file an analysis says it wrote, pinned when it is YouTube's
  // own word-timed captions. null when it is anything else (absent, too
  // large, not the strict shape, another origin, line-timed); 'unreadable'
  // when the bucket could not be read, so the next poll reads it again
  private async automaticCaptions(
    operationId: string,
    scratch: CreativeScratch
  ): Promise<CreativeObject | null | 'unreadable'> {
    const key = managedScratchKeys(operationId).transcript;
    let read: ScratchRead;
    try {
      read = await scratch.read(key, TRANSCRIPT_MAX_BYTES);
    } catch (err) {
      return 'unreadable';
    }
    if (read.ok === false) {
      return read.reason === 'read_failed' ? 'unreadable' : null;
    }

    const transcript = transcriptOf(read.bytes);
    return transcript?.origin === 'auto_generated' && transcript.word_level
      ? transcriptPin(key, read.bytes)
      : null;
  }

  // ---- one billable call ----------------------------------------------------

  async prepare(ctx: CreativeCallContext): Promise<CreativePrepared> {
    const scratch = this._deps.scratch;
    if (!scratch) {
      return refused('SCRATCH_NOT_CONFIGURED');
    }
    if (!/^[a-f0-9]{32}$/.test(ctx.operationId)) {
      return refused('OPERATION_INVALID');
    }

    const input = ctx.input;
    switch (ctx.stage) {
      case 'image.generate':
        return input.kind === 'image' ? this.image(ctx, input, scratch) : refused('STAGE_KIND_MISMATCH');
      case 'video.submit':
        return input.kind === 'video.seedance' ? this.videoSubmit(ctx, input, scratch) : refused('STAGE_KIND_MISMATCH');
      case 'slides.script':
      case 'slides.image':
      case 'slides.speech':
      case 'slides.assemble':
        return input.kind === 'video.image_text_slides' ? this.slides(ctx, input, scratch) : refused('STAGE_KIND_MISMATCH');
      case 'clip.analyse':
      case 'clip.transcribe':
      case 'clip.pick':
      case 'clip.fetch':
      case 'clip.render':
        return input.kind === 'clipping' ? this.clipping(ctx, input, scratch) : refused('STAGE_KIND_MISMATCH');
      default:
        return refused('STAGE_NOT_CALLABLE');
    }
  }

  private image(
    ctx: CreativeCallContext,
    input: CreativeInputOf<'image'>,
    scratch: CreativeScratch
  ): CreativePrepared {
    const adapter = this._deps.image;
    if (!adapter) {
      return refused('IMAGE_NOT_CONFIGURED');
    }

    return {
      ok: true,
      send: async () => {
        const result = await adapter.generate(
          {
            stage: 'image.generate',
            provider: 'openai',
            model: IMAGE_MODEL,
            prompt: input.prompt,
            orientation: input.orientation,
          },
          `image-${ctx.operationId}`
        );
        if (result.outcome !== 'accepted') {
          return { answer: refusalOf(result) };
        }
        const source = result.receipt.artifact.source;
        if (source.kind !== 'inline_base64') {
          return unknown('OUTPUT_NOT_RETAINED');
        }

        const object = await this.retain(
          scratch,
          { role: 'artifact', slot: 1, key: creativeScratchKeys(ctx.operationId).image, contentType: 'image/png' },
          Buffer.from(source.data, 'base64')
        );
        return object
          ? { answer: { outcome: 'completed', result: null }, objects: [object] }
          : unknown('OUTPUT_NOT_RETAINED');
      },
    };
  }

  // The reference images are the source bytes W&W transferred for this job
  // (exact asset, version and digest), signed from their scratch keys
  private async videoSubmit(
    ctx: CreativeCallContext,
    input: CreativeInputOf<'video.seedance'>,
    scratch: CreativeScratch
  ): Promise<CreativePrepared> {
    const adapter = this._deps.seedance;
    if (!adapter) {
      return refused('VIDEO_NOT_CONFIGURED');
    }

    const imageUrls: string[] = [];
    for (const [index, asset] of input.sourceAssets.entries()) {
      const object = objectOf(ctx.objects, 'source', index + 1);
      if (
        !object ||
        object.assetId !== asset.assetId ||
        object.assetVersion !== asset.version ||
        object.sha256 !== asset.sha256
      ) {
        return refused('SOURCE_NOT_RETAINED');
      }
      const url = await this.sign(() => scratch.signDownload(object.storageKey));
      if (!url) {
        return refused('SCRATCH_SIGN_FAILED');
      }
      imageUrls.push(url);
    }

    return {
      ok: true,
      send: async () => {
        const result = await adapter.submit({
          stage: 'video.submit',
          provider: 'evolink',
          model: input.model,
          prompt: input.prompt,
          output: input.output,
          imageUrls,
        });
        if (result.outcome !== 'accepted') {
          return { answer: refusalOf(result) };
        }
        return {
          answer: { outcome: 'accepted', handle: { kind: 'evolink', taskId: result.receipt.taskId } },
          handle: result.receipt,
        };
      },
    };
  }

  private async slides(
    ctx: CreativeCallContext,
    input: CreativeInputOf<'video.image_text_slides'>,
    scratch: CreativeScratch
  ): Promise<CreativePrepared> {
    const adapter = this._deps.slides;
    if (!adapter) {
      return refused('SLIDES_NOT_CONFIGURED');
    }

    if (ctx.stage === 'slides.script') {
      return {
        ok: true,
        send: async () => {
          const result = await adapter.script({ prompt: input.prompt });
          if (result.outcome !== 'accepted') {
            return { answer: refusalOf(result) };
          }
          const slides = result.receipt.slides;
          return {
            answer: { outcome: 'completed', result: { slides: slides.length } },
            intermediate: { slides },
          };
        },
      };
    }

    const script = scriptOf(ctx.calls);
    if (!script) {
      return refused('SLIDES_NOT_SCRIPTED');
    }

    if (ctx.stage === 'slides.image' || ctx.stage === 'slides.speech') {
      const slide = script[ctx.item - 1];
      if (!slide) {
        return refused('SLIDE_NOT_SCRIPTED');
      }
      const keys = slideScratchKeys(ctx.operationId, ctx.item - 1);

      if (ctx.stage === 'slides.image') {
        return {
          ok: true,
          send: async () => {
            const result = await adapter.image({ imagePrompt: slide.imagePrompt, output: input.output });
            if (result.outcome !== 'accepted') {
              return { answer: refusalOf(result) };
            }
            // fal.run answers with a url on its CDN: the image is retained
            // now, the assembly only ever imports the scratch copy
            const fetched = await this.fetchResult(result.receipt.url, this._deps.resultHosts.fal);
            const type = fetched.ok ? sniffCreativeMedia(fetched.bytes) : null;
            const object =
              fetched.ok && type && type !== 'video/mp4'
                ? await this.retain(scratch, { role: 'slide_image', slot: ctx.item, key: keys.image, contentType: type }, fetched.bytes)
                : null;
            return object
              ? { answer: { outcome: 'completed', result: null }, objects: [object] }
              : unknown('OUTPUT_NOT_RETAINED');
          },
        };
      }

      return {
        ok: true,
        send: async () => {
          const result = await adapter.speech({ voice: input.voiceId, voiceText: slide.voiceText });
          if (result.outcome !== 'accepted') {
            return { answer: refusalOf(result) };
          }
          const object = await this.retain(
            scratch,
            { role: 'slide_audio', slot: ctx.item, key: keys.audio, contentType: 'audio/mpeg' },
            result.receipt.audio
          );
          return object
            ? {
                answer: { outcome: 'completed', result: null },
                intermediate: { seconds: result.receipt.seconds },
                objects: [object],
              }
            : unknown('OUTPUT_NOT_RETAINED');
        },
      };
    }

    // slides.assemble: every slide's retained image and voice, by their keys
    if (!ctx.assemblyId) {
      return refused('ASSEMBLY_ID_INVALID');
    }
    const slides: { voiceText: string; seconds: number; imageUrl: string; audioUrl: string }[] = [];
    for (const [index, slide] of script.entries()) {
      const image = objectOf(ctx.objects, 'slide_image', index + 1);
      const audio = objectOf(ctx.objects, 'slide_audio', index + 1);
      const spoken = completedCall(ctx.calls, 'slides.speech', index + 1)?.intermediate?.seconds;
      if (!image || !audio || typeof spoken !== 'number') {
        return refused('SLIDE_NOT_RETAINED');
      }
      const imageUrl = await this.sign(() => scratch.signDownload(image.storageKey));
      const audioUrl = await this.sign(() => scratch.signDownload(audio.storageKey));
      if (!imageUrl || !audioUrl) {
        return refused('SCRATCH_SIGN_FAILED');
      }
      slides.push({ voiceText: slide.voiceText, seconds: spoken, imageUrl, audioUrl });
    }

    const assemblyId = ctx.assemblyId;
    return {
      ok: true,
      handle: { kind: 'transloadit', assemblyId },
      send: async () => {
        const result = await adapter.assemble({ operationId: ctx.operationId, assemblyId, slides });
        if (result.outcome !== 'accepted') {
          return { answer: refusalOf(result) };
        }
        return { answer: { outcome: 'accepted' }, handle: result.receipt };
      },
    };
  }

  private async clipping(
    ctx: CreativeCallContext,
    input: CreativeInputOf<'clipping'>,
    scratch: CreativeScratch
  ): Promise<CreativePrepared> {
    const keys = managedScratchKeys(ctx.operationId);
    const runpod = this._deps.runpod;

    // a submit whose handle is followed by a poll
    const submitted = (submit: () => ReturnType<RunPodAdapter['submit']>, intermediate?: Record<string, unknown>) =>
      async (): Promise<CreativeDispatch> => {
        const result = await submit();
        if (result.outcome !== 'accepted') {
          return { answer: refusalOf(result) };
        }
        return {
          answer: { outcome: 'accepted', handle: { kind: 'runpod', jobId: result.receipt.jobId } },
          handle: result.receipt,
          intermediate,
        };
      };

    switch (ctx.stage) {
      case 'clip.analyse': {
        if (!runpod) {
          return refused('CLIPPING_NOT_CONFIGURED');
        }
        // the second analysis only follows captions that can't be trusted,
        // and asks for the audio alone (ClippingService.submitAnalyse)
        const audioOnly = ctx.attempt === 2;
        if (
          audioOnly &&
          ctx.calls.find((call) => call.stage === 'clip.analyse' && call.attempt === 1)?.pollResult
            ?.transcript !== 'untrusted'
        ) {
          return refused('ANALYSE_RETRY_NOT_DUE');
        }
        const audioUploadUrl = await this.sign(() => scratch.signUpload(keys.audio, 'audio/ogg'));
        const transcriptUploadUrl = audioOnly
          ? undefined
          : await this.sign(() => scratch.signUpload(keys.transcript, 'application/json'));
        if (!audioUploadUrl || transcriptUploadUrl === null) {
          return refused('SCRATCH_SIGN_FAILED');
        }
        return {
          ok: true,
          send: submitted(() =>
            runpod.submit({
              step: 'analyse',
              operationId: ctx.operationId,
              url: input.sourceUrl,
              audioOnly,
              transcriptUploadUrl,
              audioUploadUrl,
              maxDurationSeconds: input.maxSourceMinutes * 60,
            })
          ),
        };
      }

      case 'clip.transcribe': {
        const deepgram = this._deps.deepgram;
        if (!deepgram) {
          return refused('CLIPPING_NOT_CONFIGURED');
        }
        if (latestAnalyse(ctx.calls)?.pollResult?.transcript !== 'none') {
          return refused('TRANSCRIBE_NOT_DUE');
        }
        const url = await this.sign(() => scratch.signDownload(keys.audio));
        if (!url) {
          return refused('SCRATCH_SIGN_FAILED');
        }
        return {
          ok: true,
          send: async () => {
            const result = await deepgram.transcribe({ step: 'transcribe', operationId: ctx.operationId, url });
            if (result.outcome !== 'accepted') {
              return { answer: refusalOf(result) };
            }
            const object = await this.retain(
              scratch,
              {
                role: 'transcript',
                slot: 0,
                key: creativeScratchKeys(ctx.operationId).transcribed,
                contentType: 'application/json',
              },
              Buffer.from(JSON.stringify(result.receipt))
            );
            return object
              ? { answer: { outcome: 'completed', result: null }, objects: [object] }
              : unknown('OUTPUT_NOT_RETAINED');
          },
        };
      }

      case 'clip.pick': {
        const clips = this._deps.clips;
        if (!clips) {
          return refused('CLIPPING_NOT_CONFIGURED');
        }
        const read = await this.transcript(ctx, scratch);
        if (read.ok === false) {
          return refused(read.code);
        }
        // a selection whose clips could never get their captions is not paid for
        if (!read.transcript.word_level) {
          return refused('CAPTION_TIMING_UNAVAILABLE');
        }
        const title = latestAnalyse(ctx.calls)?.pollIntermediate?.title;
        return {
          ok: true,
          send: async () => {
            const result = await clips.select({
              title: typeof title === 'string' ? title : '',
              transcript: read.transcript,
              clips: input.clips,
            });
            if (result.outcome !== 'accepted') {
              return { answer: refusalOf(result), objects: read.pin ? [read.pin] : undefined };
            }
            // the selection rules of ClippingService, then the clip range
            // the person asked for
            const kept = result.receipt.clips.filter(
              (clip) =>
                clip.end - clip.start >= input.clipSeconds.min &&
                clip.end - clip.start <= input.clipSeconds.max
            );
            return {
              answer: { outcome: 'completed', result: { clips: kept.length } },
              intermediate: { clips: kept },
              objects: read.pin ? [read.pin] : undefined,
            };
          },
        };
      }

      case 'clip.fetch': {
        if (!runpod) {
          return refused('CLIPPING_NOT_CONFIGURED');
        }
        const clip = picksOf(ctx.calls)?.[ctx.item - 1];
        if (!clip) {
          return refused('CLIP_NOT_PICKED');
        }
        const sourceSeconds = latestAnalyse(ctx.calls)?.pollIntermediate?.sourceSeconds;
        const videoUploadUrl = await this.sign(() =>
          scratch.signUpload(keys.clip(ctx.item - 1).source, 'video/mp4')
        );
        if (!videoUploadUrl) {
          return refused('SCRATCH_SIGN_FAILED');
        }
        return {
          ok: true,
          send: submitted(() =>
            runpod.submit({
              step: 'clip_fetch',
              operationId: ctx.operationId,
              clip: ctx.item - 1,
              url: input.sourceUrl,
              fit: input.fit,
              start: clip.start,
              end: clip.end,
              durationSeconds: typeof sourceSeconds === 'number' ? sourceSeconds : null,
              videoUploadUrl,
            })
          ),
        };
      }

      case 'clip.render': {
        if (!runpod) {
          return refused('CLIPPING_NOT_CONFIGURED');
        }
        const clip = picksOf(ctx.calls)?.[ctx.item - 1];
        const trimStart = polledCall(ctx.calls, 'clip.fetch', ctx.item)?.pollIntermediate?.trimStart;
        if (!clip || typeof trimStart !== 'number') {
          return refused('CLIP_NOT_FETCHED');
        }
        const read = await this.transcript(ctx, scratch);
        if (read.ok === false) {
          return refused(read.code);
        }
        // Captions only come from word-timed transcripts. Line-timed ones
        // would need a Deepgram call per clip, which no W&W stage pays for,
        // so the analysis never lets one through; a clip is never silently
        // rendered without them. No words inside a word-timed transcript is a
        // span nobody speaks in, rendered as it is
        const words = clipCaptionWords(read.transcript, clip.start, clip.end, trimStart);
        if (!words) {
          return refused('CAPTION_TIMING_UNAVAILABLE');
        }
        const clipKeys = keys.clip(ctx.item - 1);
        const sourceUrl = await this.sign(() => scratch.signDownload(clipKeys.source));
        const outputUploadUrl = await this.sign(() => scratch.signUpload(clipKeys.output, 'video/mp4'));
        const thumbnailUploadUrl = await this.sign(() => scratch.signUpload(clipKeys.thumbnail, 'image/jpeg'));
        if (!sourceUrl || !outputUploadUrl || !thumbnailUploadUrl) {
          return refused('SCRATCH_SIGN_FAILED');
        }
        return {
          ok: true,
          send: submitted(
            () =>
              runpod.submit({
                step: 'clip_render',
                operationId: ctx.operationId,
                clip: ctx.item - 1,
                sourceUrl,
                start: clip.start,
                end: clip.end,
                trimStart,
                outputUploadUrl,
                thumbnailUploadUrl,
                fit: input.fit,
                words,
              }),
            { captions: words.length ? 'words' : 'silent' }
          ),
        };
      }

      default:
        return refused('STAGE_NOT_CALLABLE');
    }
  }

  // ---- reads of an accepted handle --------------------------------------------

  async poll(ctx: CreativePollContext): Promise<CreativePollOutcome> {
    const scratch = this._deps.scratch;
    const handle = ctx.handle;

    if (handle.kind === 'evolink') {
      if (!this._deps.seedance || !scratch) {
        return RUNNING;
      }
      return this.urlResult(
        await this._deps.seedance.status(handle),
        this._deps.resultHosts.evolink,
        creativeScratchKeys(ctx.operationId).video,
        scratch
      );
    }

    if (handle.kind === 'transloadit') {
      if (!this._deps.slides || !scratch) {
        return RUNNING;
      }
      return this.urlResult(
        await this._deps.slides.assemblyStatus(handle),
        this._deps.resultHosts.transloadit,
        creativeScratchKeys(ctx.operationId).slides,
        scratch
      );
    }

    // the endpoint is the one recorded when the job was accepted
    const endpoint = ctx.stage === 'clip.render' ? 'clipper' : 'ingest';
    if (handle.endpoint !== endpoint) {
      return { invalid: true };
    }
    if (!this._deps.runpod) {
      return RUNNING;
    }
    const status = await this._deps.runpod.status(handle as RunPodHandle);
    switch (status.status) {
      case 'invalid':
        return { invalid: true };
      case 'not_found':
        return NOT_FOUND;
      case 'unreadable':
        return RUNNING;
      case 'output_rejected':
        return failed('OUTPUT_INVALID');
    }

    if (ctx.stage === 'clip.analyse' && ctx.input.kind === 'clipping') {
      // the caption file is read before the analysis is reported
      if (!scratch) {
        return RUNNING;
      }
      return this.analysed(ctx, ctx.input, status as MediaProcessorStatus<RunPodIngestOutput>, scratch);
    }

    if (ctx.stage === 'clip.fetch') {
      const clip = picksOf(ctx.calls)?.[ctx.item - 1];
      if (!clip) {
        return failed('CLIP_NOT_PICKED');
      }
      const outcome = clipFetchOutcome<RunPodIngestOutput>(
        status as MediaProcessorStatus<RunPodIngestOutput>,
        clip.start
      );
      switch (outcome.state) {
        case 'pending':
          return RUNNING;
        case 'done':
          return completedNull({ intermediate: { trimStart: outcome.trimStart } });
        case 'retry':
          // recorded as failed; W&W never sends a call again
          return failed('CLIP_FETCH_RETRYABLE');
        default:
          return failed(creativeCode(outcome.failure?.code, 'CLIP_FETCH_FAILED'));
      }
    }

    if (ctx.stage === 'clip.render') {
      const outcome = clipRenderOutcome<RunPodClipOutput>(
        status as MediaProcessorStatus<RunPodClipOutput>
      );
      switch (outcome.state) {
        case 'pending':
          return RUNNING;
        case 'done':
          return completedNull({ intermediate: { thumbnail: outcome.thumbnail } });
        case 'retry':
          return failed('CLIP_RENDER_RETRYABLE');
        default:
          return failed(creativeCode(outcome.failure?.code, 'CLIP_RENDER_FAILED'));
      }
    }

    return { invalid: true };
  }

  // The analysis as W&W freezes it: whole seconds within the job's bound,
  // and where the captions stand (auto: usable; none: transcribe the audio;
  // untrusted: analyse again for the audio alone)
  private async analysed(
    ctx: CreativePollContext,
    input: CreativeInputOf<'clipping'>,
    status: MediaProcessorStatus<RunPodIngestOutput>,
    scratch: CreativeScratch
  ): Promise<CreativePollOutcome> {
    const max = input.maxSourceMinutes * 60;
    const durationOf = (raw: number | null | undefined) => {
      const durationSeconds = Math.ceil(raw || 0);
      return durationSeconds >= 1 && durationSeconds <= max ? durationSeconds : null;
    };
    const finished = (raw: number | null | undefined, transcript: CreativeAnalyseResult['transcript'], title?: string | null, objects?: CreativeObject[]): CreativePollOutcome => {
      const durationSeconds = durationOf(raw);
      if (!durationSeconds) {
        return failed('DURATION_TOO_LONG');
      }
      return {
        answer: { status: 'completed', result: { durationSeconds, transcript } },
        final: true,
        intermediate: { title: title || '', sourceSeconds: raw },
        ...(objects ? { objects } : {}),
      };
    };

    const outcome = analyseOutcome<RunPodIngestOutput>(status);
    switch (outcome.state) {
      case 'pending':
        return RUNNING;
      case 'done': {
        if (ctx.attempt === 2 && !outcome.transcribe) {
          return failed('ANALYSE_OUTPUT_UNEXPECTED');
        }
        // the bound first: nothing is read for a source that is refused
        if (!durationOf(outcome.durationSeconds)) {
          return failed('DURATION_TOO_LONG');
        }
        if (outcome.transcribe) {
          return finished(outcome.durationSeconds, 'none', outcome.title);
        }
        // Burned-in captions need words, and only Deepgram on the audio is
        // paid for by a W&W stage: captions that are not word-timed are
        // untrusted, so the audio-only analysis and the transcription follow
        const captions = await this.automaticCaptions(ctx.operationId, scratch);
        if (captions === 'unreadable') {
          return RUNNING;
        }
        return captions
          ? finished(outcome.durationSeconds, 'auto', outcome.title, [captions])
          : finished(outcome.durationSeconds, 'untrusted', outcome.title);
      }
      case 'captions_untrusted':
        return ctx.attempt === 1
          ? finished(
              status.status === 'completed' ? status.result.source?.duration_seconds : null,
              'untrusted',
              status.status === 'completed' ? status.result.source?.title : null
            )
          : failed('ANALYSE_OUTPUT_UNEXPECTED');
      case 'retry':
        return failed('ANALYSE_RETRYABLE');
      case 'too_long':
        return failed('DURATION_TOO_LONG');
      case 'failed':
        return failed(creativeCode(outcome.failure?.code, 'ANALYSE_FAILED'));
      case 'empty':
        return failed('ANALYSE_EMPTY');
      default:
        return failed('ANALYSE_OUTPUT_UNEXPECTED');
    }
  }

  // A finished video behind a provider url is retained before it is
  // reported completed. A read that fails is tried again by the next poll; a
  // result that can never be retained is completed with its artifact missing
  private async urlResult(
    status: SeedanceStatusResult | AssemblyStatusResult,
    hosts: readonly string[],
    key: string,
    scratch: CreativeScratch
  ): Promise<CreativePollOutcome> {
    switch (status.status) {
      case 'pending':
      case 'unreadable':
        return RUNNING;
      case 'not_found':
        return NOT_FOUND;
      case 'invalid':
        return { invalid: true };
      case 'failed':
        return failed(creativeCode(status.code, 'PROVIDER_FAILED'));
    }

    const source = status.artifact.source;
    if (source.kind !== 'url') {
      return completedNull({ intermediate: { artifactMissing: 'ARTIFACT_SOURCE_INVALID' } });
    }
    const fetched = await this.fetchResult(source.url, hosts);
    if (fetched.ok === false) {
      return fetched.reason === 'too_large'
        ? completedNull({ intermediate: { artifactMissing: 'ARTIFACT_TOO_LARGE' } })
        : RUNNING;
    }
    if (sniffCreativeMedia(fetched.bytes) !== 'video/mp4') {
      return completedNull({ intermediate: { artifactMissing: 'ARTIFACT_TYPE_INVALID' } });
    }
    const object = await this.retain(
      scratch,
      { role: 'artifact', slot: 1, key, contentType: 'video/mp4' },
      fetched.bytes
    );
    return object ? completedNull({ objects: [object] }) : RUNNING;
  }

  // ---- the finished output --------------------------------------------------

  async readArtifact(ctx: CreativeArtifactContext): Promise<CreativeArtifactRead> {
    const scratch = this._deps.scratch;
    if (!scratch) {
      return { kind: 'missing', code: 'SCRATCH_NOT_CONFIGURED' };
    }
    const allowed: CreativeMediaType[] = ctx.kind === 'image' ? ['image/png', 'image/jpeg'] : ['video/mp4'];
    const slot = ctx.kind === 'clipping' ? ctx.item : 1;
    const pinned = objectOf(ctx.objects, 'artifact', slot);

    let bytes: Buffer;
    let pin: CreativeObject | undefined;
    if (pinned) {
      const read = await this.readPinned(scratch, pinned, CREATIVE_ARTIFACT_MAX_BYTES);
      if (read.ok === false) {
        return { kind: 'missing', code: `ARTIFACT_${read.code}` };
      }
      bytes = read.bytes;
    } else if (ctx.kind === 'clipping') {
      // RunPod wrote the clip into its key; its first read pins it
      if (!polledCall(ctx.calls, 'clip.render', ctx.item)) {
        return { kind: 'missing', code: 'CLIP_NOT_RENDERED' };
      }
      const key = managedScratchKeys(ctx.operationId).clip(ctx.item - 1).output;
      const read = await scratch.read(key, CREATIVE_ARTIFACT_MAX_BYTES);
      if (read.ok === false) {
        return {
          kind: 'missing',
          code:
            read.reason === 'too_large'
              ? 'ARTIFACT_TOO_LARGE'
              : read.reason === 'absent'
              ? 'ARTIFACT_ABSENT'
              : 'ARTIFACT_READ_FAILED',
        };
      }
      bytes = read.bytes;
      pin = {
        role: 'artifact',
        slot,
        storageKey: key,
        sha256: sha256Of(bytes),
        byteLength: bytes.length,
        contentType: 'video/mp4',
        assetId: null,
        assetVersion: null,
      };
    } else {
      const final = ctx.calls.find(
        (call) =>
          (call.stage === 'video.submit' || call.stage === 'slides.assemble') &&
          call.pollStatus === 'COMPLETED'
      );
      return {
        kind: 'missing',
        code: creativeCode(final?.pollIntermediate?.artifactMissing, 'ARTIFACT_NOT_RETAINED'),
      };
    }

    const contentType = sniffCreativeMedia(bytes);
    if (!contentType || !allowed.includes(contentType)) {
      return { kind: 'missing', code: 'ARTIFACT_TYPE_INVALID' };
    }
    return { kind: 'bytes', bytes, contentType, sha256: sha256Of(bytes), pin };
  }

  // ---- W&W source bytes and the voice list ------------------------------------

  // One Seedance reference image W&W transferred, verified by the caller
  async retainSource(
    operationId: string,
    slot: number,
    asset: { assetId: string; version: number },
    bytes: Buffer,
    contentType: CreativeMediaType
  ): Promise<CreativeObject | null> {
    const scratch = this._deps.scratch;
    if (!scratch || !/^[a-f0-9]{32}$/.test(operationId)) {
      return null;
    }
    const object = await this.retain(
      scratch,
      {
        role: 'source',
        slot,
        key: creativeScratchKeys(operationId).source(slot, CREATIVE_MEDIA_EXTENSIONS[contentType]),
        contentType,
      },
      bytes
    );
    return object ? { ...object, assetId: asset.assetId, assetVersion: asset.version } : null;
  }

  // ImagesSlides.loadVoices: ids and names only. A read, never billed work
  async voices(): Promise<ManagedVoice[] | null> {
    if (!this._deps.voices) {
      return null;
    }
    const result = await this._deps.voices.listVoices();
    return result.outcome === 'accepted' ? result.receipt.voices : null;
  }
}

// ---- configuration ------------------------------------------------------------

function hosts(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => HOST.test(entry));
}

// The closed set of adapters, each built directly with its own key and only
// when everything it needs is configured; a missing piece leaves it null, so
// its calls are refused before anything is recorded or sent. Nothing here
// goes through IntegrationManager, VideoManager or MediaService
export function managedCreativeRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  transport: ProviderTransport = fetchTransport
): ManagedCreativeRuntime {
  const scratchConfig = creativeScratchConfig(env);
  const scratch = scratchConfig ? new R2CreativeScratch(scratchConfig) : null;
  const resultHosts = {
    evolink: hosts(env.POSTIZ_MANAGED_CREATIVE_EVOLINK_RESULT_HOSTS),
    fal: hosts(env.POSTIZ_MANAGED_CREATIVE_FAL_RESULT_HOSTS),
    transloadit: hosts(env.POSTIZ_MANAGED_CREATIVE_TRANSLOADIT_RESULT_HOSTS),
  };
  // OpenaiService reads OPENAI_API_KEY itself; without one it would send a
  // placeholder key, so it is not used at all
  const openai = env.OPENAI_API_KEY ? new OpenaiService() : null;
  const slidesConfigured =
    !!openai &&
    !!scratch &&
    !!env.FAL_KEY &&
    !!env.ELEVENSLABS_API_KEY &&
    !!env.TRANSLOADIT_AUTH &&
    !!env.TRANSLOADIT_SECRET &&
    resultHosts.fal.length > 0 &&
    resultHosts.transloadit.length > 0;

  return new ManagedCreativeRuntime({
    scratch,
    image: openai ? new OpenaiImageAdapter(openai) : null,
    seedance:
      env.EVOLINK_API_KEY && resultHosts.evolink.length
        ? new EvolinkSeedanceAdapter(env.EVOLINK_API_KEY, resultHosts.evolink, transport)
        : null,
    slides: slidesConfigured
      ? new SlidesAdapter({
          writer: openai!,
          falKey: env.FAL_KEY!,
          elevenLabsKey: env.ELEVENSLABS_API_KEY!,
          transloadit: { authKey: env.TRANSLOADIT_AUTH!, authSecret: env.TRANSLOADIT_SECRET! },
          transport,
          imageHosts: resultHosts.fal,
          videoHosts: resultHosts.transloadit,
          scratchHosts: scratch!.hosts,
        })
      : null,
    runpod:
      scratch &&
      env.RUNPOD_API_KEY &&
      env.RUNPOD_INGEST_ENDPOINT_ID &&
      env.RUNPOD_CLIPPER_ENDPOINT_ID
        ? new RunPodAdapter(
            env.RUNPOD_API_KEY,
            { ingest: env.RUNPOD_INGEST_ENDPOINT_ID, clipper: env.RUNPOD_CLIPPER_ENDPOINT_ID },
            scratch.hosts,
            transport
          )
        : null,
    deepgram:
      scratch && env.DEEPGRAM_API_KEY
        ? new DeepgramAdapter(env.DEEPGRAM_API_KEY, scratch.hosts, transport)
        : null,
    clips: openai ? new OpenaiClipsAdapter(openai) : null,
    voices: env.ELEVENSLABS_API_KEY
      ? new ElevenLabsVoicesAdapter(env.ELEVENSLABS_API_KEY, transport)
      : null,
    transport,
    resultHosts,
  });
}

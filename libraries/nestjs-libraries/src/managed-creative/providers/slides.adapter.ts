import { randomUUID } from 'crypto';
import Transloadit from 'transloadit';
import { parseBuffer } from 'music-metadata';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import {
  FAL_RUN_URL,
  FAL_TIMEOUT_MS,
  falImageBody,
} from '@gitroom/nestjs-libraries/openai/fal.service';
import {
  CreativeArtifact,
  HandleNotFound,
  IMAGE_PROMPT_MAX,
  InvalidHandle,
  SLIDES_MAX,
  SubmitOutcome,
  TransloaditHandle,
  VIDEO_PROMPT_MAX,
  VOICE_TEXT_MAX,
  VideoOutput,
  isManagedOperationId,
  isScratchUrl,
  isSlideSeconds,
  isVoiceId,
  resultUrl,
  safeProviderCode,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';
import {
  ELEVENLABS_SPEECH_TIMEOUT_MS,
  SLIDES_IMAGE_MODEL,
  TRANSLOADIT_ENDPOINT,
  elevenLabsSpeechBody,
  elevenLabsSpeechUrl,
  isAssemblyId,
  slideScratchKeys,
  slidesAssemblySteps,
  slidesSrt,
} from '@gitroom/nestjs-libraries/managed-creative/slides-builders';
import {
  ProviderResponse,
  ProviderTransport,
  deadline,
  parseJson,
  readBounded,
  readBoundedBytes,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

// defined with the other handles and limits in contracts
export { SLIDES_MAX, VOICE_TEXT_MAX };
export type { TransloaditHandle };

// image-text-slides as separate stages: the script, one image per slide, one
// voice per slide, the assembly, and the read of the assembly. Every method is
// one request; W&W authorizes and records each before calling it, and decides
// what comes next. ImagesSlides.process keeps running all of it in one go.
// There is no transcription: the subtitles are the script's own voice texts,
// timed by the length of each voice (read here from the bytes, not billed)

// OpenaiService.slidesFromTextOnce, so the request stays the one ImagesSlides
// sends (generateSlidesFromText is that request with three tries)
export interface SlidesWriter {
  slidesFromTextOnce(
    text: string,
    requestOptions?: {
      maxRetries?: number;
      timeout?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ imagePrompt?: unknown; voiceText?: unknown }[]>;
}

export interface SlidesAdapterConfig {
  writer: SlidesWriter;
  falKey: string;
  elevenLabsKey: string;
  transloadit: { authKey: string; authSecret: string };
  transport: ProviderTransport;
  // where a Fal image and a finished video may be; only W&W ingest fetches them
  imageHosts: readonly string[];
  videoHosts: readonly string[];
  // the signed scratch storage the assembly imports from (see isScratchUrl)
  scratchHosts: readonly string[];
}

export interface SlideScript {
  imagePrompt: string;
  voiceText: string;
}

// the OpenAI client timeout, now also over reading the answer
const SCRIPT_DEADLINE_MS = 10 * 60 * 1000;
// the SDK's own request timeout; the assembly runs on after its answer
const ASSEMBLY_TIMEOUT_MS = 60000;
const FAL_ANSWER_MAX_BYTES = 256 * 1024;
// 128 kbps for 10 minutes; one slide of VOICE_TEXT_MAX is far shorter
const SPEECH_MAX_BYTES = 10 * 1024 * 1024;
const ERROR_ANSWER_MAX_BYTES = 64 * 1024;
const ASSEMBLY_ANSWER_MAX_BYTES = 2 * 1024 * 1024;
const ASSEMBLY_RUNNING = [
  'ASSEMBLY_UPLOADING',
  'ASSEMBLY_EXECUTING',
  'ASSEMBLY_REPLAYING',
];
// Answers that say the request was refused as it was sent. Whether a refused
// request costs anything is not known from the source, so it stays "sent"
const OPENAI_REFUSED = [400, 401, 403, 404, 422, 429];
const FAL_REFUSED = [400, 401, 403, 404, 422, 429];
// ElevenLabs reports quota and permission problems as 401, see elevenLabsError
const ELEVENLABS_REFUSED = [400, 401, 403, 422, 429];
// 413 is Transloadit's RATE_LIMIT_REACHED, which its SDK would send again
const TRANSLOADIT_REFUSED = [400, 401, 403, 404, 413, 422, 429];

// answered, but nothing in it can be used; it may have been billed
type OutputRejected = { outcome: 'output_rejected'; sent: true; code: string };

export type SlidesScriptResult =
  | SubmitOutcome<{ slides: SlideScript[] }>
  | OutputRejected;

// The url is the provider's, untrusted and server only: W&W retains the bytes
// under slideScratchKeys(..).image before the assembly, nothing else uses it
export type SlideImageResult =
  | SubmitOutcome<{ url: string; host: string }>
  | OutputRejected;

// The bytes are retained by W&W under slideScratchKeys(..).audio
export type SlideSpeechResult =
  | SubmitOutcome<{ audio: Buffer; mimeType: 'audio/mpeg'; seconds: number }>
  | OutputRejected;

export type AssemblyStatusResult =
  | { status: 'pending' }
  | { status: 'completed'; artifact: CreativeArtifact }
  | { status: 'failed'; code: string; providerCode?: string }
  // also an assembly whose create request never arrived: see HandleNotFound
  | HandleNotFound
  // nothing was learned (timeout, unreadable answer)
  | { status: 'unreadable'; code: string }
  | InvalidHandle;

export interface SlidesAssemblyInput {
  operationId: string;
  // made with newAssemblyId and recorded by W&W before this call
  assemblyId: string;
  slides: {
    voiceText: string;
    seconds: number;
    imageUrl: string;
    audioUrl: string;
  }[];
}

const notSent = (code: string) =>
  ({ outcome: 'not_sent', sent: false, code } as const);

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export class SlidesAdapter {
  private _writer: SlidesWriter;
  private _transport: ProviderTransport;
  private _imageHosts: readonly string[];
  private _videoHosts: readonly string[];
  private _scratchHosts: readonly string[];
  // The keys and the Transloadit secret only live in these closures
  private _configured: () => {
    fal: boolean;
    elevenLabs: boolean;
    transloadit: boolean;
  };
  private _falHeaders: () => Record<string, string>;
  private _elevenLabsHeaders: () => Record<string, string>;
  private _sign: (params: Record<string, unknown>) => {
    signature: string;
    params: string;
  };

  constructor(config: SlidesAdapterConfig) {
    const { falKey, elevenLabsKey } = config;
    const { authKey, authSecret } = config.transloadit;
    // only used to sign: the SDK makes the signature with its expiry, the
    // requests themselves go through the transport. No retries if it ever sends
    const transloadit =
      authKey && authSecret
        ? new Transloadit({ authKey, authSecret, maxRetries: 0 })
        : undefined;

    this._writer = config.writer;
    this._transport = config.transport;
    this._imageHosts = config.imageHosts;
    this._videoHosts = config.videoHosts;
    this._scratchHosts = config.scratchHosts;
    this._configured = () => ({
      fal: !!falKey,
      elevenLabs: !!elevenLabsKey,
      transloadit: !!transloadit,
    });
    this._falHeaders = () => ({
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json',
    });
    this._elevenLabsHeaders = () => ({
      'Content-Type': 'application/json',
      'xi-api-key': elevenLabsKey,
    });
    this._sign = (params) => transloadit!.calcSignature(params);
  }

  // The prompt is sent as confirmed. No SDK retries and none of the three
  // tries of generateSlidesFromText: one request
  async script(
    input: { prompt: string },
    signal?: AbortSignal
  ): Promise<SlidesScriptResult> {
    if (!text(input?.prompt, VIDEO_PROMPT_MAX)) {
      return notSent('INPUT_INVALID');
    }

    if (signal?.aborted) {
      return notSent('ABORTED_BEFORE_SEND');
    }

    let slides: Awaited<ReturnType<SlidesWriter['slidesFromTextOnce']>>;
    try {
      slides = await this._writer.slidesFromTextOnce(input.prompt, {
        maxRetries: 0,
        timeout: SCRIPT_DEADLINE_MS,
        signal: deadline(SCRIPT_DEADLINE_MS, signal),
      });
    } catch (err) {
      return scriptFailure(err);
    }

    if (!Array.isArray(slides) || !slides.length) {
      return { outcome: 'output_rejected', sent: true, code: 'SCRIPT_NO_SLIDES' };
    }

    if (slides.length > SLIDES_MAX) {
      return {
        outcome: 'output_rejected',
        sent: true,
        code: 'SCRIPT_TOO_MANY_SLIDES',
      };
    }

    if (
      !slides.every(
        (slide) =>
          text(slide?.imagePrompt, IMAGE_PROMPT_MAX) &&
          text(slide?.voiceText, VOICE_TEXT_MAX)
      )
    ) {
      return {
        outcome: 'output_rejected',
        sent: true,
        code: 'SCRIPT_SLIDE_INVALID',
      };
    }

    return {
      outcome: 'accepted',
      sent: true,
      receipt: {
        slides: slides.map((slide) => ({
          imagePrompt: slide.imagePrompt as string,
          voiceText: slide.voiceText as string,
        })),
      },
    };
  }

  // FalService.generateImageFromText with the model of ImagesSlides. fal.run
  // answers with the image itself, no id: an answer that is lost is unknown
  async image(
    input: { imagePrompt: string; output: VideoOutput },
    signal?: AbortSignal
  ): Promise<SlideImageResult> {
    if (
      !text(input?.imagePrompt, IMAGE_PROMPT_MAX) ||
      (input.output !== 'vertical' && input.output !== 'horizontal')
    ) {
      return notSent('INPUT_INVALID');
    }

    if (!this._configured().fal) {
      return notSent('NOT_CONFIGURED');
    }

    if (signal?.aborted) {
      return notSent('ABORTED_BEFORE_SEND');
    }

    const requestSignal = deadline(FAL_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(FAL_RUN_URL + SLIDES_IMAGE_MODEL, {
        method: 'POST',
        headers: this._falHeaders(),
        body: JSON.stringify(
          falImageBody(input.imagePrompt, input.output === 'vertical')
        ),
        signal: requestSignal,
        redirect: 'error',
      });
    } catch (err) {
      return {
        outcome: 'unknown',
        sent: true,
        code: requestSignal.aborted ? 'IMAGE_ABORTED' : 'IMAGE_CONNECTION_LOST',
      };
    }

    const read = await readBounded(response, FAL_ANSWER_MAX_BYTES, requestSignal);
    if (read.ok === false) {
      return {
        outcome: 'unknown',
        sent: true,
        code:
          read.reason === 'too_large'
            ? 'IMAGE_ANSWER_TOO_LARGE'
            : 'IMAGE_ANSWER_LOST',
      };
    }

    const value = parseJson(read.text) as any;
    if (response.status >= 200 && response.status < 300) {
      if (value === undefined) {
        return { outcome: 'unknown', sent: true, code: 'IMAGE_NO_RESULT' };
      }

      // FalService passes a video on; a slide is only ever an image
      if (value?.video || !Array.isArray(value?.images)) {
        return { outcome: 'output_rejected', sent: true, code: 'IMAGE_MISSING' };
      }

      const url = resultUrl(value.images[0]?.url, this._imageHosts);
      if (!url) {
        return {
          outcome: 'output_rejected',
          sent: true,
          code: 'IMAGE_URL_REFUSED',
        };
      }

      return {
        outcome: 'accepted',
        sent: true,
        receipt: { url: url.toString(), host: url.hostname },
      };
    }

    // Fal's error body is free text, nothing of it is passed on
    if (FAL_REFUSED.includes(response.status)) {
      return {
        outcome: 'rejected',
        sent: true,
        code: 'IMAGE_REFUSED',
        httpStatus: response.status,
      };
    }

    return { outcome: 'unknown', sent: true, code: 'IMAGE_NO_RESULT' };
  }

  // The text-to-speech request of ImagesSlides for one slide
  async speech(
    input: { voice: string; voiceText: string },
    signal?: AbortSignal
  ): Promise<SlideSpeechResult> {
    if (!isVoiceId(input?.voice) || !text(input.voiceText, VOICE_TEXT_MAX)) {
      return notSent('INPUT_INVALID');
    }

    if (!this._configured().elevenLabs) {
      return notSent('NOT_CONFIGURED');
    }

    if (signal?.aborted) {
      return notSent('ABORTED_BEFORE_SEND');
    }

    const requestSignal = deadline(ELEVENLABS_SPEECH_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(elevenLabsSpeechUrl(input.voice), {
        method: 'POST',
        headers: this._elevenLabsHeaders(),
        body: JSON.stringify(elevenLabsSpeechBody(input.voiceText)),
        signal: requestSignal,
        redirect: 'error',
      });
    } catch (err) {
      return {
        outcome: 'unknown',
        sent: true,
        code: requestSignal.aborted ? 'SPEECH_ABORTED' : 'SPEECH_CONNECTION_LOST',
      };
    }

    if (response.status < 200 || response.status >= 300) {
      const read = await readBounded(
        response,
        ERROR_ANSWER_MAX_BYTES,
        requestSignal
      );
      const value = read.ok ? (parseJson(read.text) as any) : undefined;
      // only the plain status of the detail; its message is the provider's text
      if (read.ok && ELEVENLABS_REFUSED.includes(response.status)) {
        return {
          outcome: 'rejected',
          sent: true,
          code: 'SPEECH_REFUSED',
          httpStatus: response.status,
          providerCode: safeProviderCode(value?.detail?.status),
        };
      }

      return { outcome: 'unknown', sent: true, code: 'SPEECH_NO_RESULT' };
    }

    const read = await readBoundedBytes(response, SPEECH_MAX_BYTES, requestSignal);
    if (read.ok === false) {
      return {
        outcome: 'unknown',
        sent: true,
        code:
          read.reason === 'too_large'
            ? 'SPEECH_ANSWER_TOO_LARGE'
            : 'SPEECH_ANSWER_LOST',
      };
    }

    // getAudioDuration of ImagesSlides
    let seconds: number | undefined;
    try {
      seconds = (await parseBuffer(read.bytes, 'audio/mpeg')).format.duration;
    } catch (err) {
      seconds = undefined;
    }

    if (!isSlideSeconds(seconds)) {
      return {
        outcome: 'output_rejected',
        sent: true,
        code: 'SPEECH_AUDIO_INVALID',
      };
    }

    return {
      outcome: 'accepted',
      sent: true,
      receipt: { audio: read.bytes, mimeType: 'audio/mpeg', seconds },
    };
  }

  // The assembly of ImagesSlides without waitForCompletion: created under the
  // id W&W recorded, then read with assemblyStatus. It only imports the
  // retained scratch copies of this operation, never a provider url
  async assemble(
    input: SlidesAssemblyInput,
    signal?: AbortSignal
  ): Promise<SubmitOutcome<TransloaditHandle>> {
    const slides = input?.slides;
    if (
      !isManagedOperationId(input?.operationId) ||
      !isAssemblyId(input.assemblyId) ||
      !Array.isArray(slides) ||
      !slides.length ||
      slides.length > SLIDES_MAX ||
      !slides.every(
        (slide, index) =>
          text(slide?.voiceText, VOICE_TEXT_MAX) &&
          isSlideSeconds(slide.seconds) &&
          isScratchUrl(
            slide.imageUrl,
            slideScratchKeys(input.operationId, index).image,
            this._scratchHosts
          ) &&
          isScratchUrl(
            slide.audioUrl,
            slideScratchKeys(input.operationId, index).audio,
            this._scratchHosts
          )
      )
    ) {
      return notSent('INPUT_INVALID');
    }

    if (!this._configured().transloadit) {
      return notSent('NOT_CONFIGURED');
    }

    // nothing has been sent yet, so a failure here is not_sent; the error
    // itself is not passed on (it can hold the signed scratch urls)
    let srt: string;
    let signed: { signature: string; params: string };
    try {
      srt = slidesSrt(
        slides.map((slide) => ({ text: slide.voiceText, seconds: slide.seconds }))
      );
      signed = this._sign({
        steps: slidesAssemblySteps(
          slides.map((slide) => ({
            imageUrl: slide.imageUrl,
            audioUrl: slide.audioUrl,
            seconds: slide.seconds,
          }))
        ),
      });
    } catch (err) {
      return notSent('INPUT_INVALID');
    }
    const { signature, params } = signed;

    // The form the SDK sends: params, signature, then the upload by its name
    const boundary = `----ww${randomUUID().replace(/-/g, '')}`;
    if ([srt, params].some((part) => part.includes(boundary))) {
      return notSent('INPUT_INVALID');
    }
    const body = [
      `--${boundary}\r\nContent-Disposition: form-data; name="params"\r\n\r\n${params}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="signature"\r\n\r\n${signature}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="subtitles.srt"; filename="subtitles.srt"\r\nContent-Type: application/x-subrip\r\n\r\n${srt}\r\n`,
      `--${boundary}--\r\n`,
    ].join('');

    if (signal?.aborted) {
      return notSent('ABORTED_BEFORE_SEND');
    }

    const requestSignal = deadline(ASSEMBLY_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(
        `${TRANSLOADIT_ENDPOINT}/assemblies/${input.assemblyId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body,
          signal: requestSignal,
          redirect: 'error',
        }
      );
    } catch (err) {
      return {
        outcome: 'unknown',
        sent: true,
        code: requestSignal.aborted
          ? 'ASSEMBLY_ABORTED'
          : 'ASSEMBLY_CONNECTION_LOST',
      };
    }

    const read = await readBounded(
      response,
      ASSEMBLY_ANSWER_MAX_BYTES,
      requestSignal
    );
    if (read.ok === false) {
      return {
        outcome: 'unknown',
        sent: true,
        code:
          read.reason === 'too_large'
            ? 'ASSEMBLY_ANSWER_TOO_LARGE'
            : 'ASSEMBLY_ANSWER_LOST',
      };
    }

    const value = parseJson(read.text) as any;
    const ok = response.status >= 200 && response.status < 300;
    // checkResult of the SDK: an error in a 2xx answer is a refusal too
    if (
      typeof value?.error === 'string' &&
      (ok || TRANSLOADIT_REFUSED.includes(response.status))
    ) {
      return {
        outcome: 'rejected',
        sent: true,
        code: 'ASSEMBLY_REFUSED',
        httpStatus: response.status,
        providerCode: safeProviderCode(value.error),
      };
    }

    if (ok && value?.assembly_id === input.assemblyId) {
      return {
        outcome: 'accepted',
        sent: true,
        receipt: { kind: 'transloadit', assemblyId: input.assemblyId },
      };
    }

    return { outcome: 'unknown', sent: true, code: 'ASSEMBLY_NO_RECEIPT' };
  }

  // A read (getAssembly of the SDK): safe to repeat, also for an assembly whose
  // create answer was lost. The signed url is a credential, never returned
  async assemblyStatus(
    handle: TransloaditHandle,
    signal?: AbortSignal
  ): Promise<AssemblyStatusResult> {
    if (handle?.kind !== 'transloadit' || !isAssemblyId(handle?.assemblyId)) {
      return { status: 'invalid', code: 'HANDLE_INVALID' };
    }

    if (!this._configured().transloadit) {
      return { status: 'unreadable', code: 'NOT_CONFIGURED' };
    }

    let signed: { signature: string; params: string };
    try {
      signed = this._sign({});
    } catch (err) {
      return { status: 'unreadable', code: 'STATUS_NOT_SIGNED' };
    }
    const { signature, params } = signed;
    const requestSignal = deadline(ASSEMBLY_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(
        `${TRANSLOADIT_ENDPOINT}/assemblies/${
          handle.assemblyId
        }?signature=${signature}&params=${encodeURIComponent(params)}`,
        {
          method: 'GET',
          headers: {},
          signal: requestSignal,
          redirect: 'error',
        }
      );
    } catch (err) {
      return { status: 'unreadable', code: 'STATUS_CONNECTION_LOST' };
    }

    const read = await readBounded(
      response,
      ASSEMBLY_ANSWER_MAX_BYTES,
      requestSignal
    );
    // ASSEMBLY_NOT_FOUND or not, whatever the body says; nothing is inferred
    // from it, see HandleNotFound
    if (response.status === 404) {
      return { status: 'not_found', code: 'STATUS_NOT_FOUND' };
    }

    const data = read.ok ? (parseJson(read.text) as any) : undefined;
    if (
      !read.ok ||
      response.status < 200 ||
      response.status >= 300 ||
      data === undefined
    ) {
      return { status: 'unreadable', code: 'STATUS_UNREADABLE' };
    }

    if (typeof data?.error === 'string') {
      return {
        status: 'failed',
        code: 'PROVIDER_FAILED',
        providerCode: safeProviderCode(data.error),
      };
    }

    if (ASSEMBLY_RUNNING.includes(data?.ok)) {
      return { status: 'pending' };
    }

    if (data?.ok !== 'ASSEMBLY_COMPLETED') {
      return {
        status: 'failed',
        code: 'PROVIDER_FAILED',
        providerCode: safeProviderCode(data?.ok),
      };
    }

    // the result is fetched by W&W ingest, never by the worker
    const url = resultUrl(data?.results?.subtitled?.[0]?.url, this._videoHosts);
    if (!url) {
      return { status: 'failed', code: 'RESULT_URL_INVALID' };
    }

    return {
      status: 'completed',
      artifact: {
        artifactId: `transloadit-${handle.assemblyId}-0`,
        role: 'video',
        source: { kind: 'url', url: url.toString(), host: url.hostname },
        declared: {},
      },
    };
  }
}

// Nothing of the error is passed on but a code: its message can carry the
// prompt, and its headers are the provider's
function scriptFailure(err: unknown): SlidesScriptResult {
  if (err instanceof APIConnectionTimeoutError) {
    return { outcome: 'unknown', sent: true, code: 'SCRIPT_TIMEOUT' };
  }

  if (err instanceof APIUserAbortError) {
    return { outcome: 'unknown', sent: true, code: 'SCRIPT_ABORTED' };
  }

  if (err instanceof APIConnectionError) {
    return { outcome: 'unknown', sent: true, code: 'SCRIPT_CONNECTION_LOST' };
  }

  if (
    err instanceof APIError &&
    typeof err.status === 'number' &&
    OPENAI_REFUSED.includes(err.status)
  ) {
    return {
      outcome: 'rejected',
      sent: true,
      code: 'SCRIPT_REFUSED',
      httpStatus: err.status,
      providerCode: safeProviderCode(err.code),
    };
  }

  // also a finish on length or content filter: the answer was made and is lost
  return { outcome: 'unknown', sent: true, code: 'SCRIPT_NO_RECEIPT' };
}

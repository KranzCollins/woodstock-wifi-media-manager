import {
  RUNPOD_API_URL,
  RUNPOD_TIMEOUT_MS,
  runPodJobStatus,
  runPodRunBody,
} from '@gitroom/nestjs-libraries/upload/runpod.media.processor';
import { ClippingWord } from '@gitroom/nestjs-libraries/upload/clipping.processor.interface';
import { MediaProcessorStatus } from '@gitroom/nestjs-libraries/upload/media.processor.interface';
import {
  ClipFit,
  buildAnalyseJob,
  buildClipFetchJob,
  buildClipRenderJob,
} from '@gitroom/nestjs-libraries/managed-creative/clipping-builders';
import {
  CLIPPING_TITLE_MAX,
  HandleNotFound,
  InvalidHandle,
  MANAGED_SOURCE_MAX_SECONDS,
  RunPodEndpoint,
  RunPodHandle,
  SubmitOutcome,
  isClipFit,
  isClipWindow,
  isClipWords,
  isClippingSource,
  isManagedClipIndex,
  isManagedOperationId,
  isProviderTaskId,
  isScratchUrl,
  managedScratchKeys,
  seconds,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';
import {
  ProviderResponse,
  ProviderTransport,
  deadline,
  parseJson,
  readBounded,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

// An answer of /run or /status is a small JSON; a clip job carries at most the
// words of one clip
const RUNPOD_ANSWER_MAX_BYTES = 256 * 1024;
const RUNPOD_BODY_MAX_BYTES = 256 * 1024;
// RunPod sends no error body this source reads, so only the status says the
// job was refused before it was queued. Whether that costs anything is not
// known, so it stays "sent"
const REFUSED_STATUSES = [400, 401, 403, 404, 413, 429];
const ENDPOINT_ID = /^[A-Za-z0-9-]{1,64}$/;

// What the worker asks for. Every url is one the worker signed itself for the
// keys of the operation; the job is always built by the clipping builders, so
// the jobs are the ones ClippingService submits
export type RunPodSubmitInput =
  | {
      step: 'analyse';
      operationId: string;
      url: string;
      audioOnly: boolean;
      transcriptUploadUrl?: string;
      audioUploadUrl: string;
      maxDurationSeconds: number;
    }
  | {
      step: 'clip_fetch';
      operationId: string;
      clip: number;
      url: string;
      fit: ClipFit;
      start: number;
      end: number;
      durationSeconds?: number | null;
      videoUploadUrl: string;
    }
  | {
      step: 'clip_render';
      operationId: string;
      clip: number;
      sourceUrl: string;
      start: number;
      end: number;
      trimStart: number;
      outputUploadUrl: string;
      thumbnailUploadUrl: string;
      fit: ClipFit;
      words: ClippingWord[];
    };

// The failure codes of the media service that the clipping outcomes and
// ClippingService tell apart; any other code is passed on as PROCESSOR_FAILED
const FAILURE_CODES = [
  'DURATION_TOO_LONG',
  'SOURCE_UNAVAILABLE',
  'UNSUPPORTED_INPUT',
] as const;
// A source refused as DURATION_TOO_LONG reports its real length, which can be
// far over MANAGED_SOURCE_MAX_SECONDS
const REPORTED_SECONDS_MAX = 7 * 24 * 60 * 60;

// What the managed path gets of a finished job: only the fields the clipping
// outcomes read (analyseOutcome, clipFetchOutcome, clipRenderOutcome), each
// checked. No failure message, stderr, description, uploader or thumbnail url:
// those are free provider text that can quote the signed scratch urls
export interface RunPodFailure {
  code: (typeof FAILURE_CODES)[number] | 'PROCESSOR_FAILED';
  retryable: boolean;
}

export interface RunPodIngestOutput {
  status: 'completed' | 'failed';
  source?: {
    title?: string;
    duration_seconds?: number;
    trim?: { start_seconds: number };
  };
  video?: { bytes: number };
  audio?: { bytes: number };
  transcript?: { origin: 'auto_generated' | 'uploader_provided' };
  failure?: RunPodFailure;
}

export interface RunPodClipOutput {
  status: 'completed' | 'partial' | 'failed';
  clips?: {
    status: 'completed' | 'failed';
    thumbnail?: { bytes: number };
    failure?: RunPodFailure;
  }[];
  failure?: RunPodFailure;
}

export type RunPodOutput<E extends RunPodEndpoint = RunPodEndpoint> =
  E extends 'ingest' ? RunPodIngestOutput : RunPodClipOutput;

export type RunPodStatusResult<E extends RunPodEndpoint = RunPodEndpoint> =
  | MediaProcessorStatus<RunPodOutput<E>>
  // RunPod says the job completed but its output is not the contract: it ran
  // and may have been billed. Final, never polled or sent again by itself
  | { status: 'output_rejected'; code: 'OUTPUT_INVALID' }
  | HandleNotFound
  // nothing was learned (timeout, unreadable answer): polled again later
  | { status: 'unreadable'; code: string }
  // a forged handle or a missing endpoint: never requested, never polled again
  | InvalidHandle;

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// the transport may drop keys whose value is null, so null is missing too
const absent = (value: unknown): value is null | undefined =>
  value === undefined || value === null;

const optional = (value: unknown, valid: (value: any) => boolean) =>
  absent(value) || valid(value);

const isFailure = (value: unknown) =>
  isRecord(value) &&
  typeof value.code === 'string' &&
  typeof value.retryable === 'boolean';

const isBytes = (value: unknown) =>
  isRecord(value) && Number.isSafeInteger(value.bytes) && value.bytes >= 0;

const failureOf = (value: any): RunPodFailure | undefined =>
  absent(value)
    ? undefined
    : {
        code: FAILURE_CODES.includes(value.code) ? value.code : 'PROCESSOR_FAILED',
        retryable: value.retryable,
      };

const bytesOf = (value: any) =>
  absent(value) ? undefined : { bytes: value.bytes as number };

// null when anything present is not what IngestResult says: the whole output
// is refused, never partly read
function ingestOutput(value: unknown): RunPodIngestOutput | null {
  if (
    !isRecord(value) ||
    (value.status !== 'completed' && value.status !== 'failed') ||
    !optional(value.failure, isFailure) ||
    !optional(value.video, isBytes) ||
    !optional(value.audio, isBytes) ||
    !optional(
      value.transcript,
      (transcript) =>
        isRecord(transcript) &&
        (transcript.origin === 'auto_generated' ||
          transcript.origin === 'uploader_provided')
    ) ||
    !optional(value.source, isRecord)
  ) {
    return null;
  }

  const source = value.source || {};
  if (
    !optional(
      source.title,
      (title) => typeof title === 'string' && title.length <= CLIPPING_TITLE_MAX
    ) ||
    !optional(source.duration_seconds, (duration) =>
      seconds(duration, REPORTED_SECONDS_MAX)
    ) ||
    !optional(
      source.trim,
      (trim) =>
        isRecord(trim) && seconds(trim.start_seconds, MANAGED_SOURCE_MAX_SECONDS)
    )
  ) {
    return null;
  }

  return {
    status: value.status,
    source: absent(value.source)
      ? undefined
      : {
          title: source.title ?? undefined,
          duration_seconds: source.duration_seconds ?? undefined,
          trim: absent(source.trim)
            ? undefined
            : { start_seconds: source.trim.start_seconds },
        },
    video: bytesOf(value.video),
    audio: bytesOf(value.audio),
    transcript: absent(value.transcript)
      ? undefined
      : { origin: value.transcript.origin },
    failure: failureOf(value.failure),
  };
}

// A managed clip job renders exactly one clip
function clipOutput(value: unknown): RunPodClipOutput | null {
  if (
    !isRecord(value) ||
    !['completed', 'partial', 'failed'].includes(value.status) ||
    !optional(value.failure, isFailure) ||
    !optional(
      value.clips,
      (clips) =>
        Array.isArray(clips) &&
        clips.length <= 1 &&
        clips.every(
          (clip) =>
            isRecord(clip) &&
            (clip.status === 'completed' || clip.status === 'failed') &&
            optional(clip.thumbnail, isBytes) &&
            optional(clip.failure, isFailure)
        )
    )
  ) {
    return null;
  }

  return {
    status: value.status,
    clips: absent(value.clips)
      ? undefined
      : value.clips.map((clip: Record<string, any>) => ({
          status: clip.status,
          thumbnail: bytesOf(clip.thumbnail),
          failure: failureOf(clip.failure),
        })),
    failure: failureOf(value.failure),
  };
}

// RunPod's own requests of RunPodMediaProcessor, without the polling loop:
// one submit, one status read. The endpoint ids, the key and the scratch hosts
// are configuration; a stage only names "ingest" or "clipper"
export class RunPodAdapter {
  constructor(
    private _apiKey: string,
    private _endpoints: Record<RunPodEndpoint, string>,
    private _scratchHosts: readonly string[],
    private _transport: ProviderTransport
  ) {}

  private headers() {
    return {
      Authorization: `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private baseUrl(endpoint: RunPodEndpoint) {
    const id = this._endpoints[endpoint];
    return ENDPOINT_ID.test(id || '') ? `${RUNPOD_API_URL}${id}` : null;
  }

  // The job of the step, or the code it is refused with. Every scratch url
  // must be the signed url of exactly the key of this operation and clip
  private job(input: RunPodSubmitInput) {
    if (!isManagedOperationId(input?.operationId)) {
      return { code: 'INPUT_INVALID' };
    }

    const keys = managedScratchKeys(input.operationId);
    const scratch = (url: unknown, key: string) =>
      isScratchUrl(url, key, this._scratchHosts);

    switch (input.step) {
      case 'analyse':
        if (
          typeof input.audioOnly !== 'boolean' ||
          !Number.isInteger(input.maxDurationSeconds) ||
          input.maxDurationSeconds < 1 ||
          input.maxDurationSeconds > MANAGED_SOURCE_MAX_SECONDS
        ) {
          return { code: 'INPUT_INVALID' };
        }
        if (!isClippingSource(input.url)) {
          return { code: 'SOURCE_REFUSED' };
        }
        if (
          !scratch(input.audioUploadUrl, keys.audio) ||
          (input.audioOnly
            ? input.transcriptUploadUrl !== undefined
            : !scratch(input.transcriptUploadUrl, keys.transcript))
        ) {
          return { code: 'SCRATCH_URL_REFUSED' };
        }
        return {
          endpoint: 'ingest' as const,
          job: buildAnalyseJob({
            reference: keys.reference,
            url: input.url,
            audioOnly: input.audioOnly,
            transcriptUploadUrl: input.transcriptUploadUrl,
            audioUploadUrl: input.audioUploadUrl,
            maxDurationSeconds: input.maxDurationSeconds,
          }),
        };

      case 'clip_fetch':
        if (
          !isManagedClipIndex(input.clip) ||
          !isClipFit(input.fit) ||
          !isClipWindow(input.start, input.end) ||
          (input.durationSeconds != null &&
            !seconds(input.durationSeconds, MANAGED_SOURCE_MAX_SECONDS))
        ) {
          return { code: 'INPUT_INVALID' };
        }
        if (!isClippingSource(input.url)) {
          return { code: 'SOURCE_REFUSED' };
        }
        if (!scratch(input.videoUploadUrl, keys.clip(input.clip).source)) {
          return { code: 'SCRATCH_URL_REFUSED' };
        }
        return {
          endpoint: 'ingest' as const,
          job: buildClipFetchJob({
            reference: keys.clip(input.clip).reference,
            url: input.url,
            fit: input.fit,
            start: input.start,
            end: input.end,
            durationSeconds: input.durationSeconds,
            videoUploadUrl: input.videoUploadUrl,
          }),
        };

      case 'clip_render': {
        if (
          !isManagedClipIndex(input.clip) ||
          !isClipFit(input.fit) ||
          !isClipWindow(input.start, input.end) ||
          !seconds(input.trimStart, input.start) ||
          !isClipWords(input.words)
        ) {
          return { code: 'INPUT_INVALID' };
        }
        const clip = keys.clip(input.clip);
        if (
          !scratch(input.sourceUrl, clip.source) ||
          !scratch(input.outputUploadUrl, clip.output) ||
          !scratch(input.thumbnailUploadUrl, clip.thumbnail)
        ) {
          return { code: 'SCRATCH_URL_REFUSED' };
        }
        return {
          endpoint: 'clipper' as const,
          job: buildClipRenderJob({
            reference: clip.reference,
            sourceUrl: input.sourceUrl,
            start: input.start,
            end: input.end,
            trimStart: input.trimStart,
            outputUploadUrl: input.outputUploadUrl,
            thumbnailUploadUrl: input.thumbnailUploadUrl,
            fit: input.fit,
            words: input.words,
          }),
        };
      }

      default:
        return { code: 'INPUT_INVALID' };
    }
  }

  // Sent at most once. RunPod has no idempotency key and no cancel this source
  // uses, so without a job id in the answer the job may exist: unknown, and
  // never sent again
  async submit(
    input: RunPodSubmitInput,
    signal?: AbortSignal
  ): Promise<SubmitOutcome<RunPodHandle>> {
    const built = this.job(input);
    if (!('job' in built)) {
      return { outcome: 'not_sent', sent: false, code: built.code };
    }

    const baseUrl = this.baseUrl(built.endpoint);
    if (!baseUrl || !this._apiKey) {
      return { outcome: 'not_sent', sent: false, code: 'NOT_CONFIGURED' };
    }

    const body = JSON.stringify(runPodRunBody(built.job));
    if (Buffer.byteLength(body) > RUNPOD_BODY_MAX_BYTES) {
      return { outcome: 'not_sent', sent: false, code: 'INPUT_TOO_LARGE' };
    }

    if (signal?.aborted) {
      return { outcome: 'not_sent', sent: false, code: 'ABORTED_BEFORE_SEND' };
    }

    const requestSignal = deadline(RUNPOD_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(`${baseUrl}/run`, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal: requestSignal,
        redirect: 'error',
      });
    } catch (err) {
      return {
        outcome: 'unknown',
        sent: true,
        // the deadline or the caller ended it; either way it may have arrived
        code: requestSignal.aborted ? 'SUBMIT_ABORTED' : 'SUBMIT_CONNECTION_LOST',
      };
    }

    const read = await readBounded(response, RUNPOD_ANSWER_MAX_BYTES, requestSignal);
    if (read.ok === false) {
      return {
        outcome: 'unknown',
        sent: true,
        code:
          read.reason === 'too_large'
            ? 'SUBMIT_ANSWER_TOO_LARGE'
            : 'SUBMIT_ANSWER_LOST',
      };
    }

    if (response.status >= 200 && response.status < 300) {
      const value = parseJson(read.text) as any;
      if (isProviderTaskId(value?.id)) {
        return {
          outcome: 'accepted',
          sent: true,
          receipt: { kind: 'runpod', endpoint: built.endpoint, jobId: value.id },
        };
      }

      return {
        outcome: 'unknown',
        sent: true,
        code: value?.id ? 'SUBMIT_RECEIPT_INVALID' : 'SUBMIT_NO_RECEIPT',
      };
    }

    if (REFUSED_STATUSES.includes(response.status)) {
      return {
        outcome: 'rejected',
        sent: true,
        code: 'SUBMIT_REFUSED',
        httpStatus: response.status,
      };
    }

    return { outcome: 'unknown', sent: true, code: 'SUBMIT_NO_RECEIPT' };
  }

  // A read: safe to repeat, W&W polls it and bounds how often. A finished job
  // is the projection of its output (RunPodIngestOutput for "ingest",
  // RunPodClipOutput for "clipper") that the clipping outcomes read; a
  // RunPod-level failure carries only its status
  async status<E extends RunPodEndpoint>(
    handle: RunPodHandle & { endpoint: E },
    signal?: AbortSignal
  ): Promise<RunPodStatusResult<E>> {
    const baseUrl =
      handle?.kind === 'runpod' &&
      (handle.endpoint === 'ingest' || handle.endpoint === 'clipper')
        ? this.baseUrl(handle.endpoint)
        : null;
    if (!isProviderTaskId(handle?.jobId) || !baseUrl) {
      return { status: 'invalid', code: 'HANDLE_INVALID' };
    }

    const requestSignal = deadline(RUNPOD_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(`${baseUrl}/status/${handle.jobId}`, {
        method: 'GET',
        headers: this.headers(),
        signal: requestSignal,
        redirect: 'error',
      });
    } catch (err) {
      return { status: 'unreadable', code: 'STATUS_CONNECTION_LOST' };
    }

    const read = await readBounded(response, RUNPOD_ANSWER_MAX_BYTES, requestSignal);
    // whatever the body says; nothing is inferred from it, see HandleNotFound
    if (response.status === 404) {
      return { status: 'not_found', code: 'STATUS_NOT_FOUND' };
    }

    const data = read.ok ? (parseJson(read.text) as any) : undefined;
    if (
      !read.ok ||
      response.status < 200 ||
      response.status >= 300 ||
      !data ||
      typeof data !== 'object'
    ) {
      return { status: 'unreadable', code: 'STATUS_UNREADABLE' };
    }

    const job = runPodJobStatus<unknown>(data);
    if (job.status === 'pending') {
      return job;
    }

    if (job.status === 'failed') {
      // RunPod's error text can echo the job and its signed urls
      return { status: 'failed', error: `RUNPOD_${data.status}` };
    }

    const output =
      handle.endpoint === 'ingest'
        ? ingestOutput(job.result)
        : clipOutput(job.result);
    if (!output) {
      return { status: 'output_rejected', code: 'OUTPUT_INVALID' };
    }

    return { status: 'completed', result: output as RunPodOutput<E> };
  }
}

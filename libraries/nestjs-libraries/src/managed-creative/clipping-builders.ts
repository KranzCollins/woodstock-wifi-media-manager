import {
  ClipJob,
  ClipResult,
  ClippingTranscript,
  ClippingWord,
  IngestJob,
  IngestResult,
  ProcessorFailure,
} from '@gitroom/nestjs-libraries/upload/clipping.processor.interface';
import { MediaProcessorStatus } from '@gitroom/nestjs-libraries/upload/media.processor.interface';

// The jobs and the reading of their answers, without storage, database or
// billing: ClippingService and the W&W creative worker submit the same jobs.
// Signed urls are made by the caller, in the order it always made them.

// Oxylabs only cuts on whole seconds, so the window is fetched a little wider
// and the clip job makes the exact cut inside it
export const WINDOW_PADDING = 2;
export const MIN_CLIP_SECONDS = 10;
export const MAX_CLIP_SECONDS = 90;
export const CLIP_FRAME = { width: 1080, height: 1920 } as const;

export type ClipFit = 'blur' | 'crop';

export interface SelectedClip {
  title: string;
  content: string;
  start: number;
  end: number;
}

// What the outcomes below read of an answer. IngestResult and ClipResult are
// these (ClippingService passes them as they came); the managed RunPod adapter
// passes a projection that holds nothing else, so whatever an outcome hands
// back as "result" or "failure" is only ever what the caller passed in
export interface FailureReading {
  code: string;
  retryable: boolean;
}

export interface IngestReading {
  status: 'completed' | 'failed';
  source?: {
    title?: string | null;
    thumbnail_url?: string | null;
    duration_seconds?: number | null;
    trim?: { start_seconds: number } | null;
  } | null;
  video?: { bytes: number } | null;
  audio?: { bytes: number } | null;
  transcript?: { origin: 'auto_generated' | 'uploader_provided' } | null;
  failure?: FailureReading | null;
}

export interface ClipReading {
  status: 'completed' | 'partial' | 'failed';
  clips?: {
    status: 'completed' | 'failed';
    thumbnail?: { bytes: number } | null;
    failure?: FailureReading | null;
  }[];
  failure?: FailureReading | null;
}

// One job for the whole video: the captions when the video has them, the audio
// only when it does not
export function buildAnalyseJob(params: {
  reference: string;
  url: string;
  audioOnly: boolean;
  transcriptUploadUrl?: string;
  audioUploadUrl: string;
  maxDurationSeconds: number;
}): IngestJob {
  return {
    version: 1,
    type: 'ingest',
    reference: params.reference,
    source: { url: params.url, via: 'oxylabs' },
    ...(params.audioOnly
      ? {}
      : {
          transcript: {
            url: params.transcriptUploadUrl!,
            languages: ['en'],
          },
        }),
    audio: {
      url: params.audioUploadUrl,
      unless_transcript: !params.audioOnly,
    },
    limits: { max_duration_seconds: params.maxDurationSeconds },
  };
}

export type AnalyseOutcome<R extends IngestReading = IngestResult> =
  | { state: 'pending' }
  | { state: 'retry' }
  // only YouTube's own captions are in the spoken language, see ClippingService
  | { state: 'captions_untrusted' }
  | { state: 'too_long'; durationSeconds: number }
  | { state: 'failed'; failure?: R['failure'] }
  | { state: 'unexpected'; result?: R }
  | { state: 'empty' }
  | {
      state: 'done';
      durationSeconds: number;
      title?: string | null;
      thumbnailUrl?: string | null;
      transcribe: boolean;
    };

export function analyseOutcome<R extends IngestReading = IngestResult>(
  job: MediaProcessorStatus<R>
): AnalyseOutcome<R> {
  if (job.status === 'pending') {
    return { state: 'pending' };
  }

  if (job.status === 'failed') {
    return { state: 'retry' };
  }

  const { result } = job;
  if (result?.status === 'failed') {
    if (result.failure?.retryable) {
      return { state: 'retry' };
    }

    if (result.failure?.code === 'DURATION_TOO_LONG') {
      return {
        state: 'too_long',
        durationSeconds: result.source?.duration_seconds || 0,
      };
    }

    return { state: 'failed', failure: result.failure };
  }

  const duration = result?.source?.duration_seconds;
  if (result?.status !== 'completed' || !duration) {
    return { state: 'unexpected', result };
  }

  if (!result.transcript && !result.audio) {
    return { state: 'empty' };
  }

  if (result.transcript && result.transcript.origin !== 'auto_generated') {
    return { state: 'captions_untrusted' };
  }

  return {
    state: 'done',
    durationSeconds: duration,
    title: result.source?.title,
    thumbnailUrl: result.source?.thumbnail_url,
    transcribe: !result.transcript,
  };
}

// The model answers with line numbers. A clip that runs over ends on the last
// line that still fits instead of being lost; out of bounds, too short and
// overlapping clips are dropped, the best first
export function selectClips(
  segments: ClippingTranscript['segments'],
  picked: { from?: number; to?: number; title?: string; content?: string }[],
  maxClips: number
): SelectedClip[] {
  return picked
    .filter(
      (clip): clip is { from: number; to: number; title: string; content: string } =>
        typeof clip.title === 'string' && typeof clip.content === 'string' &&
        Number.isInteger(clip.from) &&
        Number.isInteger(clip.to) &&
        clip.from >= 0 &&
        clip.to < segments.length &&
        clip.from <= clip.to
    )
    .map((clip) => {
      let to = clip.to;
      while (
        to > clip.from &&
        segments[to].end - segments[clip.from].start > MAX_CLIP_SECONDS
      ) {
        to--;
      }

      return {
        title: clip.title,
        content: clip.content,
        start: segments[clip.from].start,
        end: segments[to].end,
      };
    })
    .filter(
      (clip) =>
        clip.end - clip.start >= MIN_CLIP_SECONDS &&
        clip.end - clip.start <= MAX_CLIP_SECONDS
    )
    .reduce(
      (all, clip) =>
        all.some((p) => clip.start < p.end && p.start < clip.end)
          ? all
          : [...all, clip],
      [] as SelectedClip[]
    )
    .slice(0, maxClips);
}

// Only the window of the clip is downloaded, never the whole video. A crop
// keeps about a third of the width, so it needs the taller rendition to stay
// sharp; the whole picture scaled down does not
export function buildClipFetchJob(params: {
  reference: string;
  url: string;
  fit: ClipFit;
  start: number;
  end: number;
  durationSeconds?: number | null;
  videoUploadUrl: string;
}): IngestJob {
  const end = Math.ceil(params.end) + WINDOW_PADDING;
  return {
    version: 1,
    type: 'ingest',
    reference: params.reference,
    source: {
      url: params.url,
      via: 'oxylabs',
      max_height: params.fit === 'crop' ? 1080 : 720,
      start_seconds: Math.max(0, Math.floor(params.start) - WINDOW_PADDING),
      end_seconds: params.durationSeconds
        ? Math.min(params.durationSeconds, end)
        : end,
    },
    video: { url: params.videoUploadUrl },
  };
}

// "result" is the answer as the caller passed it, only for the log of an
// unexpected one
export type ClipJobOutcome<F = ProcessorFailure | null> =
  | { state: 'pending' }
  | { state: 'retry' }
  | { state: 'failed'; failure?: F; result?: unknown };

// every time of the fetched file is relative to the start of the window
export function clipFetchOutcome<R extends IngestReading = IngestResult>(
  job: MediaProcessorStatus<R>,
  clipStart: number
): ClipJobOutcome<R['failure']> | { state: 'done'; trimStart: number } {
  if (job.status === 'pending') {
    return { state: 'pending' };
  }

  if (job.status === 'failed') {
    return { state: 'retry' };
  }

  const { result } = job;
  if (result?.status === 'failed' && result.failure?.retryable) {
    return { state: 'retry' };
  }

  if (result?.status !== 'completed' || !result.video) {
    return { state: 'failed', failure: result?.failure, result };
  }

  return {
    state: 'done',
    trimStart:
      result.source?.trim?.start_seconds ??
      Math.max(0, Math.floor(clipStart) - WINDOW_PADDING),
  };
}

// The words of the captions on the timeline of the fetched window, or null
// when the captions only time whole lines and the window must be transcribed
export function clipCaptionWords(
  transcript: ClippingTranscript,
  start: number,
  end: number,
  trimStart: number
): ClippingWord[] | null {
  if (!transcript.word_level) {
    return null;
  }

  return transcript.words
    .filter((word) => word.end > start && word.start < end)
    .map((word) => ({
      text: word.text,
      start: Math.max(0, word.start - trimStart),
      end: Math.max(0, word.end - trimStart),
    }));
}

// Without face tracking a centre crop can cut the speaker out, the whole
// picture over a blurred copy of itself never does
export function buildClipRenderJob(params: {
  reference: string;
  sourceUrl: string;
  start: number;
  end: number;
  trimStart: number;
  outputUploadUrl: string;
  thumbnailUploadUrl: string;
  fit: ClipFit;
  words: ClippingWord[];
}): ClipJob {
  return {
    version: 1,
    type: 'clip',
    reference: params.reference,
    source: { url: params.sourceUrl },
    clips: [
      {
        reference: params.reference,
        start_seconds: Math.max(0, params.start - params.trimStart),
        end_seconds: params.end - params.trimStart,
        output: { url: params.outputUploadUrl },
        thumbnail: {
          url: params.thumbnailUploadUrl,
          timestamp_seconds: 0,
        },
      },
    ],
    frame: {
      width: CLIP_FRAME.width,
      height: CLIP_FRAME.height,
      fit: params.fit,
    },
    ...(params.words.length ? { captions: { words: params.words } } : {}),
  };
}

export function clipRenderOutcome<R extends ClipReading = ClipResult>(
  job: MediaProcessorStatus<R>
): ClipJobOutcome<R['failure']> | { state: 'done'; thumbnail: boolean } {
  if (job.status === 'pending') {
    return { state: 'pending' };
  }

  if (job.status === 'failed') {
    return { state: 'retry' };
  }

  const rendered = job.result?.clips?.[0];
  // a clip and its job carry the same failure type
  const failure = (rendered?.failure || job.result?.failure) as R['failure'];
  if (rendered?.status !== 'completed' && failure?.retryable) {
    return { state: 'retry' };
  }

  if (rendered?.status !== 'completed') {
    return { state: 'failed', failure, result: job.result };
  }

  return { state: 'done', thumbnail: !!rendered.thumbnail };
}

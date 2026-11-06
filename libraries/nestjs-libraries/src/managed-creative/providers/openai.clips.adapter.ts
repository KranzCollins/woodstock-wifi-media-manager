import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import { ClippingTranscript } from '@gitroom/nestjs-libraries/upload/clipping.processor.interface';
import {
  SelectedClip,
  selectClips,
} from '@gitroom/nestjs-libraries/managed-creative/clipping-builders';
import {
  CLIPPING_TITLE_MAX,
  MANAGED_CLIPS,
  MANAGED_SOURCE_MAX_SECONDS,
  SubmitOutcome,
  safeProviderCode,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';
import { deadline } from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

// OpenaiService.pickClips, so the request stays the one ClippingService sends
export interface ClipPicker {
  pickClips(
    title: string,
    language: string,
    segments: ClippingTranscript['segments'],
    maxClips: number,
    requestOptions?: {
      maxRetries?: number;
      timeout?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ from?: number; to?: number; title?: string; content?: string }[]>;
}

// Same bound as the call of ClippingService, but for the reading of the answer
// as well (the SDK timeout alone ends when the headers arrive)
const PICK_DEADLINE_MS = 8 * 60 * 1000;
// A source of MANAGED_SOURCE_MAX_SECONDS of speech stays well below these
const SEGMENTS_MAX = 20000;
const SEGMENT_TEXT_MAX = 2000;
const TRANSCRIPT_TEXT_MAX = 400000;
// The language is written into the instructions, so it is a language tag only
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
// The model is asked for at most MANAGED_CLIPS.max clips; an answer far beyond
// that is not read at all
const PICKED_MAX = 50;
const CLIP_TITLE_MAX = 200;
const CLIP_CONTENT_MAX = 3000;
// HTTP answers that say the request was refused as it was sent. 408, 409 and
// 5xx can come after the answer was made, so they stay unknown
const REFUSED_STATUSES = [400, 401, 403, 404, 422, 429];

// The transcript the worker retained itself (from the analyse or transcribe
// step), never one from a stage
export interface ClipSelectionInput {
  title: string;
  transcript: Pick<ClippingTranscript, 'language' | 'segments'>;
  clips: number;
}

export type ClipSelectionResult =
  | SubmitOutcome<{ clips: SelectedClip[] }>
  // the model answered but nothing in it can be used; it may have been billed
  | { outcome: 'output_rejected'; sent: true; code: string };

const validSegment = (segment: unknown) => {
  const { start, end, text } = (segment || {}) as Record<string, unknown>;
  return (
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    start <= end &&
    end <= MANAGED_SOURCE_MAX_SECONDS &&
    typeof text === 'string' &&
    text.length <= SEGMENT_TEXT_MAX
  );
};

function validInput(input: ClipSelectionInput) {
  const segments = input?.transcript?.segments;
  return (
    typeof input?.title === 'string' &&
    input.title.length <= CLIPPING_TITLE_MAX &&
    typeof input.transcript?.language === 'string' &&
    LANGUAGE.test(input.transcript.language) &&
    Number.isInteger(input.clips) &&
    input.clips >= MANAGED_CLIPS.min &&
    input.clips <= MANAGED_CLIPS.max &&
    Array.isArray(segments) &&
    segments.length > 0 &&
    segments.length <= SEGMENTS_MAX &&
    segments.every(validSegment) &&
    segments.reduce((all, segment) => all + segment.text.length, 0) <=
      TRANSCRIPT_TEXT_MAX
  );
}

// One selection, one request: no SDK retries. What the model picked is not
// trusted, it goes through selectClips exactly like ClippingService's answer
export class OpenaiClipsAdapter {
  constructor(private _picker: ClipPicker) {}

  async select(
    input: ClipSelectionInput,
    signal?: AbortSignal
  ): Promise<ClipSelectionResult> {
    if (!validInput(input)) {
      return { outcome: 'not_sent', sent: false, code: 'INPUT_INVALID' };
    }

    if (signal?.aborted) {
      return { outcome: 'not_sent', sent: false, code: 'ABORTED_BEFORE_SEND' };
    }

    let picked: Awaited<ReturnType<ClipPicker['pickClips']>> | undefined;
    try {
      picked = await this._picker.pickClips(
        input.title,
        input.transcript.language,
        input.transcript.segments,
        input.clips,
        {
          maxRetries: 0,
          timeout: PICK_DEADLINE_MS,
          signal: deadline(PICK_DEADLINE_MS, signal),
        }
      );
    } catch (err) {
      return clipsFailure(err);
    }

    if (!Array.isArray(picked)) {
      return { outcome: 'output_rejected', sent: true, code: 'CLIPS_MISSING' };
    }

    if (picked.length > PICKED_MAX) {
      return { outcome: 'output_rejected', sent: true, code: 'CLIPS_TOO_MANY' };
    }

    const clips = selectClips(
      input.transcript.segments,
      picked.filter(
        (clip) =>
          !!clip &&
          typeof clip === 'object' &&
          (typeof clip.title !== 'string' || clip.title.length <= CLIP_TITLE_MAX) &&
          (typeof clip.content !== 'string' ||
            clip.content.length <= CLIP_CONTENT_MAX)
      ),
      input.clips
    );

    if (!clips.length) {
      return { outcome: 'output_rejected', sent: true, code: 'CLIPS_NONE_USABLE' };
    }

    return { outcome: 'accepted', sent: true, receipt: { clips } };
  }
}

// Nothing of the error is passed on but a code: its message can carry the
// transcript, and its headers are the provider's
function clipsFailure(err: unknown): ClipSelectionResult {
  if (err instanceof APIConnectionTimeoutError) {
    return { outcome: 'unknown', sent: true, code: 'CLIPS_TIMEOUT' };
  }

  if (err instanceof APIUserAbortError) {
    return { outcome: 'unknown', sent: true, code: 'CLIPS_ABORTED' };
  }

  if (err instanceof APIConnectionError) {
    return { outcome: 'unknown', sent: true, code: 'CLIPS_CONNECTION_LOST' };
  }

  if (
    err instanceof APIError &&
    typeof err.status === 'number' &&
    REFUSED_STATUSES.includes(err.status)
  ) {
    return {
      outcome: 'rejected',
      sent: true,
      code: 'CLIPS_REFUSED',
      httpStatus: err.status,
      providerCode: safeProviderCode(err.code),
    };
  }

  // also a finish on length or content filter: the answer was made and is lost
  return { outcome: 'unknown', sent: true, code: 'CLIPS_NO_RECEIPT' };
}

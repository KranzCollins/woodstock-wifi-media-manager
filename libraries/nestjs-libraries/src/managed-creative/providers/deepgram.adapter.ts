import {
  DEEPGRAM_LISTEN_URL,
  DEEPGRAM_TIMEOUT_MS,
} from '@gitroom/nestjs-libraries/deepgram/deepgram.service';
import { ClippingTranscript } from '@gitroom/nestjs-libraries/upload/clipping.processor.interface';
import {
  SubmitOutcome,
  MANAGED_SOURCE_MAX_SECONDS,
  isManagedClipIndex,
  isManagedOperationId,
  isScratchUrl,
  managedScratchKeys,
  safeProviderCode,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';
import {
  ProviderResponse,
  ProviderTransport,
  deadline,
  parseJson,
  readBounded,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

// The words of a source of MANAGED_SOURCE_MAX_SECONDS, with utterances and
// paragraphs, stay well below this
const DEEPGRAM_ANSWER_MAX_BYTES = 32 * 1024 * 1024;
// Build a bounded transcript from untrusted provider JSON. Never let malformed
// arrays or values reach downstream clip selection or escape as raw exceptions.
function transcriptFromResult(value: unknown): ClippingTranscript | null {
  const record = (entry: unknown): entry is Record<string, unknown> =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry);
  if (!record(value) || !Array.isArray(value.channels) || value.channels.length !== 1
    || !record(value.channels[0]) || !Array.isArray(value.utterances)
    || value.utterances.length > 20_000) return null;
  const channel = value.channels[0];
  if (!Array.isArray(channel.alternatives) || channel.alternatives.length !== 1
    || !record(channel.alternatives[0]) || !Array.isArray(channel.alternatives[0].words)
    || channel.alternatives[0].words.length > 100_000) return null;
  const language = channel.detected_language ?? 'en';
  if (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/u.test(language)) return null;
  let characters = 0;
  function project(entries: unknown[], segment: boolean) {
    const output: Array<{ start: number; end: number; text: string }> = [];
    let lastStart = -1;
    for (const entry of entries) {
      if (!record(entry)) return null;
      const { start, end } = entry;
      const text = segment ? entry.transcript : (entry.punctuated_word ?? entry.word);
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
        || start < 0 || start < lastStart || end < start || end > MANAGED_SOURCE_MAX_SECONDS
        || typeof text !== 'string' || text.length > (segment ? 20_000 : 1_000)
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null;
      characters += text.length;
      if (characters > 800_000) return null;
      output.push({ start, end, text }); lastStart = start;
    }
    return output;
  }
  const segments = project(value.utterances, true);
  const words = project(channel.alternatives[0].words, false);
  if (segments === null || words === null) return null;
  return { version: 1, language, origin: 'transcribed', word_level: true, segments, words };
}

// Answers that say the request was refused as it was sent. Whether a refused
// request costs anything is not known from the source, so it stays "sent"
const REFUSED_STATUSES = [400, 401, 402, 403, 413, 415, 422, 429];

// Only audio the worker retained itself is transcribed: the audio of the
// whole video, or the fetched window of one clip. "url" is the url the worker
// signed for that key on its scratch storage, never one from a stage
export type DeepgramTranscribeInput =
  | { step: 'transcribe'; operationId: string; url: string }
  | { step: 'clip_caption'; operationId: string; clip: number; url: string };

// DeepgramService.transcribeUrl's request, sent once. The answer comes back on
// the same request, so the receipt is the transcript itself
export class DeepgramAdapter {
  constructor(
    private _apiKey: string,
    private _scratchHosts: readonly string[],
    private _transport: ProviderTransport
  ) {}

  private headers() {
    return {
      Authorization: `Token ${this._apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private scratchKey(input: DeepgramTranscribeInput) {
    if (!isManagedOperationId(input?.operationId)) {
      return null;
    }

    const keys = managedScratchKeys(input.operationId);
    switch (input.step) {
      case 'transcribe':
        return keys.audio;
      case 'clip_caption':
        return isManagedClipIndex(input.clip)
          ? keys.clip(input.clip).source
          : null;
      default:
        return null;
    }
  }

  async transcribe(
    input: DeepgramTranscribeInput,
    signal?: AbortSignal
  ): Promise<SubmitOutcome<ClippingTranscript>> {
    const key = this.scratchKey(input);
    if (!key) {
      return { outcome: 'not_sent', sent: false, code: 'INPUT_INVALID' };
    }

    // Deepgram fetches the url itself: anything but our own scratch key is
    // refused before it leaves the process
    if (!isScratchUrl(input.url, key, this._scratchHosts)) {
      return { outcome: 'not_sent', sent: false, code: 'SCRATCH_URL_REFUSED' };
    }

    if (!this._apiKey) {
      return { outcome: 'not_sent', sent: false, code: 'NOT_CONFIGURED' };
    }

    if (signal?.aborted) {
      return { outcome: 'not_sent', sent: false, code: 'ABORTED_BEFORE_SEND' };
    }

    const requestSignal = deadline(DEEPGRAM_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(DEEPGRAM_LISTEN_URL, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ url: input.url }),
        signal: requestSignal,
        redirect: 'error',
      });
    } catch (err) {
      return {
        outcome: 'unknown',
        sent: true,
        code: requestSignal.aborted
          ? 'TRANSCRIBE_ABORTED'
          : 'TRANSCRIBE_CONNECTION_LOST',
      };
    }

    const read = await readBounded(response, DEEPGRAM_ANSWER_MAX_BYTES, requestSignal);
    if (read.ok === false) {
      return {
        outcome: 'unknown',
        sent: true,
        code:
          read.reason === 'too_large'
            ? 'TRANSCRIBE_ANSWER_TOO_LARGE'
            : 'TRANSCRIBE_ANSWER_LOST',
      };
    }

    const value = parseJson(read.text) as any;
    if (response.status >= 200 && response.status < 300) {
      // the audio may have been billed even without a readable transcript
      const transcript = transcriptFromResult(value?.results);
      if (transcript === null) {
        return { outcome: 'unknown', sent: true, code: 'TRANSCRIBE_NO_RESULT' };
      }

      return {
        outcome: 'accepted',
        sent: true,
        receipt: transcript,
      };
    }

    // only the plain error code; err_msg can echo the url
    if (REFUSED_STATUSES.includes(response.status) && value?.err_code) {
      return {
        outcome: 'rejected',
        sent: true,
        code: 'TRANSCRIBE_REFUSED',
        httpStatus: response.status,
        providerCode: safeProviderCode(value.err_code),
      };
    }

    return { outcome: 'unknown', sent: true, code: 'TRANSCRIBE_NO_RESULT' };
  }
}

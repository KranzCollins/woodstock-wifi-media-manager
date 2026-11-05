import {
  SubmitOutcome,
  safeProviderCode,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';
import {
  ProviderResponse,
  ProviderTransport,
  deadline,
  parseJson,
  readBounded,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

// The request of ImagesSlides.loadVoices. It is the only ElevenLabs call this
// adapter makes: there is no function name, method or url a caller can choose
export const ELEVENLABS_VOICES_URL =
  'https://api.elevenlabs.io/v2/voices?page_size=40&category=premade';
const VOICES_TIMEOUT_MS = 30000;
const VOICES_MAX = 40;
// 40 premade voices with their settings and samples stay well below this
const VOICES_ANSWER_MAX_BYTES = 2 * 1024 * 1024;
const VOICE_ID = /^[A-Za-z0-9]{1,64}$/;
const VOICE_LABEL = /^[^\u0000-\u001f\u007f]{1,100}$/;
// ElevenLabs reports quota and permission problems as 401, see elevenLabsError
const REFUSED_STATUSES = [400, 401, 403, 422, 429];

export interface ManagedVoice {
  id: string;
  label: string;
}

// Only ids and names leave the adapter. preview_url and the other fields are
// provider urls and settings that W&W has no use for
export class ElevenLabsVoicesAdapter {
  constructor(
    private _apiKey: string,
    private _transport: ProviderTransport
  ) {}

  private headers() {
    return {
      'Content-Type': 'application/json',
      'xi-api-key': this._apiKey,
    };
  }

  async listVoices(
    signal?: AbortSignal
  ): Promise<SubmitOutcome<{ voices: ManagedVoice[] }>> {
    if (!this._apiKey) {
      return { outcome: 'not_sent', sent: false, code: 'NOT_CONFIGURED' };
    }

    if (signal?.aborted) {
      return { outcome: 'not_sent', sent: false, code: 'ABORTED_BEFORE_SEND' };
    }

    const requestSignal = deadline(VOICES_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(ELEVENLABS_VOICES_URL, {
        method: 'GET',
        headers: this.headers(),
        signal: requestSignal,
        redirect: 'error',
      });
    } catch (err) {
      return {
        outcome: 'unknown',
        sent: true,
        code: requestSignal.aborted ? 'VOICES_ABORTED' : 'VOICES_CONNECTION_LOST',
      };
    }

    const read = await readBounded(response, VOICES_ANSWER_MAX_BYTES, requestSignal);
    if (read.ok === false) {
      return {
        outcome: 'unknown',
        sent: true,
        code:
          read.reason === 'too_large'
            ? 'VOICES_ANSWER_TOO_LARGE'
            : 'VOICES_ANSWER_LOST',
      };
    }

    const value = parseJson(read.text) as any;
    if (response.status >= 200 && response.status < 300) {
      if (!Array.isArray(value?.voices) || value.voices.length > VOICES_MAX) {
        return { outcome: 'unknown', sent: true, code: 'VOICES_NO_RESULT' };
      }

      return {
        outcome: 'accepted',
        sent: true,
        receipt: {
          voices: value.voices
            .filter(
              (voice: any) =>
                typeof voice?.voice_id === 'string' &&
                VOICE_ID.test(voice.voice_id) &&
                typeof voice.name === 'string' &&
                VOICE_LABEL.test(voice.name.trim())
            )
            .map((voice: any) => ({
              id: voice.voice_id,
              label: voice.name.trim(),
            })),
        },
      };
    }

    // only the plain status of the detail; its message is the provider's text
    if (REFUSED_STATUSES.includes(response.status)) {
      return {
        outcome: 'rejected',
        sent: true,
        code: 'VOICES_REFUSED',
        httpStatus: response.status,
        providerCode: safeProviderCode(value?.detail?.status),
      };
    }

    return { outcome: 'unknown', sent: true, code: 'VOICES_NO_RESULT' };
  }
}

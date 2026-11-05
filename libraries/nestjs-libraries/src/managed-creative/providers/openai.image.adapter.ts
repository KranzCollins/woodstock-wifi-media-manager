import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import {
  CreativeArtifact,
  ImageGenerateStage,
  SubmitOutcome,
  safeProviderCode,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';
import { deadline } from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

// OpenaiService.generateImage, so the request stays the one Postiz sends
export interface ImageGenerator {
  generateImage(
    prompt: string,
    isVertical?: boolean,
    requestOptions?: {
      maxRetries?: number;
      timeout?: number;
      signal?: AbortSignal;
    }
  ): Promise<string | undefined>;
}

// Bounds the whole call, the reading of the answer included (the SDK timeout
// alone ends when the headers arrive)
const IMAGE_DEADLINE_MS = 5 * 60 * 1000;
// Same bound as a managed upload: a bigger image could never reach Postiz
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// HTTP answers that say the request was refused as it was sent. 408, 409 and
// 5xx can come after the image was made, so they stay unknown
const REFUSED_STATUSES = [400, 401, 403, 404, 422, 429];

export type ImageResult =
  | SubmitOutcome<{ artifact: CreativeArtifact }>
  // the provider answered but the bytes can't be used; it may have been billed
  | { outcome: 'output_rejected'; sent: true; code: string };

// One image, one request: no SDK retries, no prompt rewrite. The PNG is not
// trusted here, W&W ingest checks it before it becomes DRAFT media
export class OpenaiImageAdapter {
  constructor(private _generator: ImageGenerator) {}

  async generate(
    stage: ImageGenerateStage,
    artifactId: string,
    signal?: AbortSignal
  ): Promise<ImageResult> {
    if (signal?.aborted) {
      return { outcome: 'not_sent', sent: false, code: 'ABORTED_BEFORE_SEND' };
    }

    let b64: string | undefined;
    try {
      b64 = await this._generator.generateImage(
        stage.prompt,
        stage.orientation === 'vertical',
        {
          maxRetries: 0,
          timeout: IMAGE_DEADLINE_MS,
          signal: deadline(IMAGE_DEADLINE_MS, signal),
        }
      );
    } catch (err) {
      return imageFailure(err);
    }

    if (typeof b64 !== 'string' || !b64.length) {
      return { outcome: 'output_rejected', sent: true, code: 'IMAGE_MISSING' };
    }

    if (b64.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4) {
      return { outcome: 'output_rejected', sent: true, code: 'IMAGE_TOO_LARGE' };
    }

    const bytes = BASE64.test(b64) ? Buffer.from(b64, 'base64') : null;
    if (
      !bytes ||
      bytes.length < PNG_SIGNATURE.length ||
      !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      return { outcome: 'output_rejected', sent: true, code: 'IMAGE_NOT_PNG' };
    }

    return {
      outcome: 'accepted',
      sent: true,
      receipt: {
        artifact: {
          artifactId,
          role: 'image',
          source: { kind: 'inline_base64', mimeType: 'image/png', data: b64 },
          declared: { byteLength: bytes.length },
        },
      },
    };
  }
}

// Nothing of the error is passed on but a code: its message can carry the
// prompt, and its headers are the provider's
function imageFailure(err: unknown): ImageResult {
  if (err instanceof APIConnectionTimeoutError) {
    return { outcome: 'unknown', sent: true, code: 'IMAGE_TIMEOUT' };
  }

  if (err instanceof APIUserAbortError) {
    return { outcome: 'unknown', sent: true, code: 'IMAGE_ABORTED' };
  }

  if (err instanceof APIConnectionError) {
    return { outcome: 'unknown', sent: true, code: 'IMAGE_CONNECTION_LOST' };
  }

  if (
    err instanceof APIError &&
    typeof err.status === 'number' &&
    REFUSED_STATUSES.includes(err.status)
  ) {
    return {
      outcome: 'rejected',
      sent: true,
      code: 'IMAGE_REFUSED',
      httpStatus: err.status,
      providerCode: safeProviderCode(err.code),
    };
  }

  return { outcome: 'unknown', sent: true, code: 'IMAGE_NO_RECEIPT' };
}

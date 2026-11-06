import {
  EVOLINK_GENERATIONS_URL,
  EVOLINK_TASKS_URL,
  seedanceTaskStatus,
} from '@gitroom/nestjs-libraries/videos/seedance/seedance';
import {
  CreativeArtifact,
  EvolinkHandle,
  HandleNotFound,
  InvalidHandle,
  SeedanceSubmitStage,
  SubmitOutcome,
  isProviderTaskId,
  resultUrl,
  safeProviderCode,
  seedanceBodyFor,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';
import {
  ProviderResponse,
  ProviderTransport,
  deadline,
  parseJson,
  readBounded,
} from '@gitroom/nestjs-libraries/managed-creative/providers/provider.transport';

// Same 30 s as Seedance; an answer of a submit or a task is a small JSON
const EVOLINK_TIMEOUT_MS = 30000;
const EVOLINK_ANSWER_MAX_BYTES = 64 * 1024;
// Answers that say the request was refused as it was sent. Whether a refused
// request costs anything is not known from the source, so it stays "sent"
const REFUSED_STATUSES = [400, 401, 402, 403, 404, 413, 415, 422, 429];

export type SeedanceStatusResult =
  | { status: 'pending' }
  | { status: 'completed'; artifact: CreativeArtifact }
  | { status: 'failed'; code: string; providerCode?: string }
  | HandleNotFound
  // nothing was learned (timeout, unreadable answer): polled again later
  | { status: 'unreadable'; code: string }
  | InvalidHandle;

// Seedance's own requests, without the polling loop: one submit, one task
// read. Stateless; W&W keeps the handle and decides when to poll. The result
// hosts are configuration: where a finished video may be, since only W&W
// ingest fetches it
export class EvolinkSeedanceAdapter {
  constructor(
    private _apiKey: string,
    private _resultHosts: readonly string[],
    private _transport: ProviderTransport
  ) {}

  private headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this._apiKey}`,
    };
  }

  // Sent at most once. Without an id in the answer nobody can tell whether the
  // task exists, so the caller records it as unknown and never sends it again
  async submit(
    stage: SeedanceSubmitStage,
    signal?: AbortSignal
  ): Promise<SubmitOutcome<EvolinkHandle>> {
    const body = seedanceBodyFor(stage);
    if (body.model !== stage.model) {
      return { outcome: 'not_sent', sent: false, code: 'MODEL_MISMATCH' };
    }

    if (signal?.aborted) {
      return { outcome: 'not_sent', sent: false, code: 'ABORTED_BEFORE_SEND' };
    }

    const requestSignal = deadline(EVOLINK_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(EVOLINK_GENERATIONS_URL, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
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

    const read = await readBounded(response, EVOLINK_ANSWER_MAX_BYTES, requestSignal);
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

    const value = parseJson(read.text) as any;
    if (response.status >= 200 && response.status < 300) {
      if (isProviderTaskId(value?.id)) {
        return {
          outcome: 'accepted',
          sent: true,
          receipt: { kind: 'evolink', taskId: value.id },
        };
      }

      return {
        outcome: 'unknown',
        sent: true,
        code: value?.id ? 'SUBMIT_RECEIPT_INVALID' : 'SUBMIT_NO_RECEIPT',
      };
    }

    if (REFUSED_STATUSES.includes(response.status) && value?.error) {
      return {
        outcome: 'rejected',
        sent: true,
        code: 'SUBMIT_REFUSED',
        httpStatus: response.status,
        providerCode: safeProviderCode(value.error.code),
      };
    }

    return { outcome: 'unknown', sent: true, code: 'SUBMIT_NO_RECEIPT' };
  }

  // A read: safe to repeat, W&W polls it with backoff (10 s, 180 polls at most)
  async status(
    handle: EvolinkHandle,
    signal?: AbortSignal
  ): Promise<SeedanceStatusResult> {
    if (handle?.kind !== 'evolink' || !isProviderTaskId(handle?.taskId)) {
      return { status: 'invalid', code: 'HANDLE_INVALID' };
    }

    const requestSignal = deadline(EVOLINK_TIMEOUT_MS, signal);
    let response: ProviderResponse;
    try {
      response = await this._transport(EVOLINK_TASKS_URL + handle.taskId, {
        method: 'GET',
        headers: this.headers(),
        signal: requestSignal,
        redirect: 'error',
      });
    } catch (err) {
      return { status: 'unreadable', code: 'STATUS_CONNECTION_LOST' };
    }

    const read = await readBounded(response, EVOLINK_ANSWER_MAX_BYTES, requestSignal);
    // whatever the body says; nothing is inferred from it, see HandleNotFound
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

    const task = seedanceTaskStatus(data);
    if (task.status === 'pending') {
      return task;
    }

    if (task.status === 'failed') {
      return {
        status: 'failed',
        code:
          data?.status === 'completed' ? 'RESULT_MISSING' : 'PROVIDER_FAILED',
        providerCode: safeProviderCode(data?.error?.code),
      };
    }

    // the result is fetched by W&W ingest, never by the worker
    const url = resultUrl(task.url, this._resultHosts);
    if (!url) {
      return { status: 'failed', code: 'RESULT_URL_INVALID' };
    }

    return {
      status: 'completed',
      artifact: {
        artifactId: `evolink-${handle.taskId}-0`,
        role: 'video',
        source: { kind: 'url', url: url.toString(), host: url.hostname },
        declared: {},
      },
    };
  }
}

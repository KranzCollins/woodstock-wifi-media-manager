import { Inject, Injectable } from '@nestjs/common';
import { Readable } from 'stream';
import { ManagedCredential } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import { CreativeHandle } from '@gitroom/nestjs-libraries/managed-creative/contracts';
import { readStreamBounded } from '@gitroom/nestjs-libraries/managed-creative/creative.scratch';
import {
  CreativeArtifactRead,
  CreativeDispatch,
  CreativeObject,
  CreativePollOutcome,
  CreativePrepared,
  CreativePriorCall,
  ManagedCreativeRuntime,
  managedCreativeRuntimeFromEnv,
  sniffCreativeMedia,
} from '@gitroom/nestjs-libraries/managed-creative/creative.runtime';
import {
  CREATIVE_FINAL_STAGE,
  CREATIVE_SOURCE_MAX_BYTES,
  CreativeAnalyseResult,
  CreativeCallAnswer,
  CreativeCallStatus,
  CreativeJobInput,
  CreativeKind,
  CreativePollAnswer,
  CreativeStageName,
  ManagedCreativeException,
  accessException,
  callKeyOf,
  canonicalJson,
  creativeHandleKey,
  creativeStageRefusal,
  managedCreativeAccessRefusal,
  managedCreativeKindEnabled,
  notSent,
  parseCreativeJobInput,
  parseCreativeWwHandle,
  sha256Of,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.contracts';
import {
  CreativeCallRow,
  CreativeJobRow,
  ManagedCreativeRepository,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.repository';
import {
  ManagedCreativeArtifactDto,
  ManagedCreativeCallDto,
  ManagedCreativeJobDto,
  ManagedCreativePollDto,
} from '@gitroom/nestjs-libraries/dtos/managed/managed.creative.dto';

// The owned creative runtime (docs/managed-extension/creative-runtime.md):
// W&W's CreativeProviderRuntime over HTTP. Per call, in this order and never
// otherwise: refuse what can never be sent; bind the job to the
// organization; prepare every local input; create the call row as
// DISPATCHING (the one gate: a second request, a duplicate or a restarted
// process finds the row and never sends); make the one provider request;
// settle the row with exactly the answer returned. A row left DISPATCHING
// answers unknown forever. Every refusal before the gate is itself recorded,
// so a replay can't later turn a not_sent into a send.

export const MANAGED_CREATIVE_RUNTIME = 'MANAGED_CREATIVE_RUNTIME';

export const managedCreativeProviders = [
  {
    provide: MANAGED_CREATIVE_RUNTIME,
    useFactory: (): ManagedCreativeRuntime => managedCreativeRuntimeFromEnv(),
  },
];

const STATUS_OF: Record<CreativeCallAnswer['outcome'], CreativeCallStatus> = {
  not_sent: 'NOT_SENT',
  completed: 'COMPLETED',
  accepted: 'ACCEPTED',
  rejected: 'REJECTED',
  unknown: 'UNKNOWN',
  failed: 'FAILED',
};

const json = (value: unknown) =>
  value === undefined || value === null ? null : JSON.stringify(value);

function parsed<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    return null;
  }
}

export interface CreativeSourceReceipt {
  jobId: string;
  assetId: string;
  version: number;
  sha256: string;
  byteLength: number;
  contentType: string;
}

@Injectable()
export class ManagedCreativeService {
  // tests move the clock
  now = () => new Date();

  constructor(
    private _repository: ManagedCreativeRepository,
    @Inject(MANAGED_CREATIVE_RUNTIME)
    private _runtime: ManagedCreativeRuntime
  ) {}

  private access(credential: ManagedCredential) {
    const code = managedCreativeAccessRefusal(credential, process.env, this.now());
    if (code) {
      throw accessException(code);
    }
  }

  private operationId(job: CreativeJobRow) {
    return job.id.replace(/-/g, '');
  }

  private storedInput(job: CreativeJobRow): CreativeJobInput {
    const input = parseCreativeJobInput(parsed(job.input));
    // a stored input that no longer parses is never acted on
    if (!input || input.kind !== job.kind) {
      throw new ManagedCreativeException(
        'CREATIVE_JOB_BINDING_MISMATCH',
        'The bound input of this job can not be read'
      );
    }
    return input;
  }

  // The job's binding, created by the first request that names it. null
  // when the job id is bound to another W&W scope or another input
  private async bound(
    credential: ManagedCredential,
    jobId: string,
    tenantId: string,
    workspaceId: string,
    input: CreativeJobInput
  ): Promise<CreativeJobRow | null> {
    const organizationId = credential.organizationId;
    const canonical = canonicalJson(input);
    const inputSha256 = sha256Of(canonical);
    const job =
      (await this._repository.getJob(organizationId, jobId)) ??
      (await this._repository.createJob(organizationId, {
        jobId,
        tenantId,
        workspaceId,
        kind: input.kind,
        inputSha256,
        input: canonical,
        credentialId: credential.id,
      })) ??
      (await this._repository.getJob(organizationId, jobId));

    return job &&
      job.tenantId === tenantId &&
      job.workspaceId === workspaceId &&
      job.kind === input.kind &&
      job.inputSha256 === inputSha256
      ? job
      : null;
  }

  private async state(organizationId: string, job: CreativeJobRow) {
    const [calls, objects] = await Promise.all([
      this._repository.listCalls(organizationId, job.id),
      this._repository.listObjects(organizationId, job.id),
    ]);

    return {
      calls: calls.map(
        (call): CreativePriorCall => ({
          stage: call.stage as CreativeStageName,
          item: call.item,
          attempt: call.attempt,
          status: call.status,
          intermediate: parsed(call.intermediate),
          pollStatus: call.pollStatus,
          pollResult:
            call.pollStatus === 'COMPLETED'
              ? parsed<{ result?: CreativeAnalyseResult | null }>(call.pollAnswer)
                  ?.result ?? null
              : null,
          pollIntermediate: parsed(call.pollIntermediate),
        })
      ),
      objects: objects as CreativeObject[],
    };
  }

  async bindJob(
    credential: ManagedCredential,
    jobId: string,
    body: ManagedCreativeJobDto
  ) {
    this.access(credential);
    const input = parseCreativeJobInput(body.input);
    if (!input) {
      throw new ManagedCreativeException(
        'CREATIVE_INPUT_INVALID',
        'input is not a closed ww.creative-job.v1 input'
      );
    }
    if (!managedCreativeKindEnabled(input.kind)) {
      throw accessException('CREATIVE_KIND_NOT_ENABLED');
    }

    const job = await this.bound(credential, jobId, body.tenantId, body.workspaceId, input);
    if (!job) {
      throw new ManagedCreativeException(
        'CREATIVE_JOB_BINDING_MISMATCH',
        'This job id is bound to another scope or input'
      );
    }

    return { jobId, kind: job.kind, inputSha256: job.inputSha256 };
  }

  // ---- one billable call --------------------------------------------------------

  private replay(row: CreativeCallRow, requestHash: string): CreativeCallAnswer {
    if (row.requestHash !== requestHash) {
      throw new ManagedCreativeException(
        'CREATIVE_CALL_KEY_CONFLICT',
        'This call key was recorded for another request'
      );
    }

    // its sender died or is still waiting: nothing proves it was not sent
    if (row.status === 'DISPATCHING') {
      return { outcome: 'unknown', code: 'CALL_OUTCOME_UNRECORDED' };
    }

    return (
      parsed<CreativeCallAnswer>(row.answer) ?? {
        outcome: 'unknown',
        code: 'CALL_OUTCOME_UNRECORDED',
      }
    );
  }

  // A refusal is recorded like any answer: a replay must answer it again,
  // never send what was refused
  private async refuse(
    credential: ManagedCredential,
    body: ManagedCreativeCallDto,
    requestHash: string,
    jobRowId: string | null,
    code: string
  ): Promise<CreativeCallAnswer> {
    const answer = notSent(code);
    const row = await this._repository.createCall(credential.organizationId, {
      jobRowId,
      callKey: body.callKey,
      requestHash,
      stage: body.stage,
      item: body.item,
      attempt: body.attempt,
      status: 'NOT_SENT',
      code,
      handleKey: null,
      handle: null,
      answer: JSON.stringify(answer),
      credentialId: credential.id,
    });
    return row ? answer : this.replayAfterRace(credential, body.callKey, requestHash);
  }

  private async replayAfterRace(
    credential: ManagedCredential,
    callKey: string,
    requestHash: string
  ) {
    const row = await this._repository.getCall(credential.organizationId, callKey);
    return row
      ? this.replay(row, requestHash)
      : ({ outcome: 'unknown', code: 'CALL_OUTCOME_UNRECORDED' } as const);
  }

  async call(
    credential: ManagedCredential,
    body: ManagedCreativeCallDto
  ): Promise<CreativeCallAnswer> {
    // a credential of another principal records nothing at all
    const access = managedCreativeAccessRefusal(credential, process.env, this.now());
    if (access === 'CREATIVE_CREDENTIAL_NOT_DEDICATED') {
      throw accessException(access);
    }
    if (body.callKey !== callKeyOf(body.jobId, body.stage, body.item, body.attempt)) {
      throw new ManagedCreativeException(
        'CREATIVE_INPUT_INVALID',
        'callKey must be <jobId>:<stage>:<item>:<attempt>'
      );
    }

    const organizationId = credential.organizationId;
    const input = parseCreativeJobInput(body.input);
    const requestHash = sha256Of(
      canonicalJson({
        jobId: body.jobId,
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
        input: input ?? body.input,
        stage: body.stage,
        item: body.item,
        attempt: body.attempt,
        assemblyId: body.assemblyId ?? null,
      })
    );

    const prior = await this._repository.getCall(organizationId, body.callKey);
    if (prior) {
      return this.replay(prior, requestHash);
    }

    const refusal =
      access ??
      (!input
        ? 'CREATIVE_INPUT_INVALID'
        : !managedCreativeKindEnabled(input.kind)
        ? 'CREATIVE_KIND_NOT_ENABLED'
        : creativeStageRefusal(input.kind, body.stage, body.item, body.attempt) ??
          ((body.stage === 'slides.assemble') !== !!body.assemblyId
            ? 'ASSEMBLY_ID_INVALID'
            : null));
    if (refusal || !input) {
      return this.refuse(credential, body, requestHash, null, refusal || 'CREATIVE_INPUT_INVALID');
    }

    const job = await this.bound(credential, body.jobId, body.tenantId, body.workspaceId, input);
    if (!job) {
      return this.refuse(credential, body, requestHash, null, 'JOB_BINDING_MISMATCH');
    }

    const { calls, objects } = await this.state(organizationId, job);
    let prepared: CreativePrepared;
    try {
      prepared = await this._runtime.prepare({
        operationId: this.operationId(job),
        input,
        stage: body.stage,
        item: body.item,
        attempt: body.attempt,
        assemblyId: body.assemblyId ?? null,
        calls,
        objects,
      });
    } catch (err) {
      // nothing is sent before the gate below
      prepared = { ok: false, code: 'PREPARE_FAILED' };
    }
    if (prepared.ok === false) {
      return this.refuse(credential, body, requestHash, job.id, prepared.code);
    }

    // The gate. The handle of an assembly is known now and recorded with it,
    // so the assembly can be read whatever happens to the answer
    const row = await this._repository.createCall(organizationId, {
      jobRowId: job.id,
      callKey: body.callKey,
      requestHash,
      stage: body.stage,
      item: body.item,
      attempt: body.attempt,
      status: 'DISPATCHING',
      code: null,
      handleKey: prepared.handle ? creativeHandleKey(prepared.handle) : null,
      handle: json(prepared.handle),
      answer: null,
      credentialId: credential.id,
    });
    if (!row) {
      return this.replayAfterRace(credential, body.callKey, requestHash);
    }

    let dispatch: CreativeDispatch;
    try {
      dispatch = await prepared.send();
    } catch (err) {
      // a thrown request may have arrived; its error is not passed on
      dispatch = { answer: { outcome: 'unknown', code: 'PROVIDER_REPLY_LOST' } };
    }

    const handle: CreativeHandle | undefined = dispatch.handle ?? prepared.handle;
    let settled = false;
    try {
      settled = await this._repository.settleCall(
        organizationId,
        job.id,
        row.id,
        {
          status: STATUS_OF[dispatch.answer.outcome],
          code: 'code' in dispatch.answer ? dispatch.answer.code : null,
          handleKey: handle ? creativeHandleKey(handle) : null,
          handle: json(handle),
          answer: JSON.stringify(dispatch.answer),
          intermediate: json(dispatch.intermediate),
        },
        dispatch.objects ?? []
      );
    } catch (err) {
      settled = false;
    }

    // what was not recorded is not answered: the row stays DISPATCHING and
    // every replay is unknown, so this answer must be too
    return settled
      ? dispatch.answer
      : { outcome: 'unknown', code: 'CALL_NOT_RECORDED' };
  }

  // ---- reads of an owned handle ---------------------------------------------------

  async poll(
    credential: ManagedCredential,
    body: ManagedCreativePollDto
  ): Promise<CreativePollAnswer> {
    this.access(credential);
    const organizationId = credential.organizationId;
    const wwHandle = parseCreativeWwHandle(body.handle);
    if (!wwHandle) {
      throw new ManagedCreativeException('CREATIVE_HANDLE_INVALID', 'handle is not an evolink, runpod or transloadit handle');
    }

    // only a handle one of this organization's own calls recorded is read;
    // anything else is never sent to a provider
    const row = await this._repository.getCallByHandle(organizationId, creativeHandleKey(wwHandle));
    const handle = parsed<CreativeHandle>(row?.handle ?? null);
    const job = row?.jobRowId ? await this._repository.getJobByRow(organizationId, row.jobRowId) : null;
    if (!row || !handle || !job) {
      throw new ManagedCreativeException('CREATIVE_HANDLE_NOT_OWNED', 'No call of this organization recorded this handle');
    }
    if (
      wwHandle.kind === 'runpod' &&
      (body.call?.stage !== row.stage || body.call?.item !== row.item || body.call?.attempt !== row.attempt)
    ) {
      throw new ManagedCreativeException('CREATIVE_HANDLE_INVALID', 'call does not name the call this handle belongs to');
    }

    const stored = parsed<CreativePollAnswer>(row.pollAnswer);
    if (row.pollStatus && stored) {
      return stored;
    }

    const { calls } = await this.state(organizationId, job);
    let outcome: CreativePollOutcome;
    try {
      outcome = await this._runtime.poll({
        operationId: this.operationId(job),
        input: this.storedInput(job),
        stage: row.stage as CreativeStageName,
        item: row.item,
        attempt: row.attempt,
        handle,
        calls,
      });
    } catch (err) {
      // nothing was learned; the next poll reads again
      return { status: 'running' };
    }

    if (!('answer' in outcome)) {
      throw new ManagedCreativeException('CREATIVE_HANDLE_INVALID', 'This handle can not be read');
    }

    if (outcome.final && (outcome.answer.status === 'completed' || outcome.answer.status === 'failed')) {
      const saved = await this._repository.settlePoll(
        organizationId,
        job.id,
        row.id,
        {
          pollStatus: outcome.answer.status === 'completed' ? 'COMPLETED' : 'FAILED',
          pollAnswer: JSON.stringify(outcome.answer),
          pollIntermediate: json(outcome.intermediate),
        },
        outcome.objects ?? []
      );
      if (!saved) {
        // another poll recorded it first: that one is the answer
        const again = await this._repository.getCall(organizationId, row.callKey);
        return parsed<CreativePollAnswer>(again?.pollAnswer ?? null) ?? { status: 'running' };
      }
    }

    return outcome.answer;
  }

  // ---- the finished output ---------------------------------------------------------

  async readArtifact(
    credential: ManagedCredential,
    body: ManagedCreativeArtifactDto
  ): Promise<CreativeArtifactRead> {
    this.access(credential);
    const organizationId = credential.organizationId;
    const job = await this._repository.getJob(organizationId, body.jobId);
    if (!job) {
      throw new ManagedCreativeException('CREATIVE_JOB_NOT_FOUND', 'No job of this organization has this id');
    }

    const kind = job.kind as CreativeKind;
    if (
      body.stage !== CREATIVE_FINAL_STAGE[kind] ||
      (kind === 'clipping' ? body.item < 1 : body.item !== 0)
    ) {
      return { kind: 'missing', code: 'ARTIFACT_SOURCE_INVALID' };
    }
    if (body.handle) {
      const wwHandle = parseCreativeWwHandle(body.handle);
      const owner = wwHandle
        ? await this._repository.getCallByHandle(organizationId, creativeHandleKey(wwHandle))
        : null;
      if (!owner || owner.jobRowId !== job.id) {
        return { kind: 'missing', code: 'ARTIFACT_SOURCE_INVALID' };
      }
    }

    const { calls, objects } = await this.state(organizationId, job);
    let read: CreativeArtifactRead;
    try {
      read = await this._runtime.readArtifact({
        operationId: this.operationId(job),
        kind,
        item: body.item,
        calls,
        objects,
      });
    } catch (err) {
      return { kind: 'missing', code: 'ARTIFACT_READ_FAILED' };
    }

    if (read.kind === 'bytes' && read.pin) {
      const kept = await this._repository.pinObject(organizationId, job.id, read.pin);
      if (kept.sha256 !== read.pin.sha256) {
        return { kind: 'missing', code: 'ARTIFACT_OBJECT_CHANGED' };
      }
    }

    return read;
  }

  // ---- W&W source bytes (Seedance reference images) ---------------------------------

  // The exact bytes of one declared source asset version, transferred by W&W
  // for this job and verified against the digest frozen in its input. A
  // source already retained is answered without reading the body again
  async putSource(
    credential: ManagedCredential,
    jobId: string,
    assetId: string,
    version: number,
    body: Readable,
    contentType: string | undefined,
    contentLength: string | undefined,
    declaredSha256: string | undefined
  ): Promise<CreativeSourceReceipt> {
    this.access(credential);
    if (String(contentType || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
      throw new ManagedCreativeException('CREATIVE_SOURCE_INVALID', 'The content must be sent as application/octet-stream');
    }
    const declared = /^\d{1,9}$/.test(String(contentLength)) ? Number(contentLength) : NaN;
    if (!(declared > 0 && declared <= CREATIVE_SOURCE_MAX_BYTES)) {
      throw new ManagedCreativeException('CREATIVE_SOURCE_INVALID', `Content-Length must be from 1 to ${CREATIVE_SOURCE_MAX_BYTES}`);
    }

    const organizationId = credential.organizationId;
    const job = await this._repository.getJob(organizationId, jobId);
    if (!job) {
      throw new ManagedCreativeException('CREATIVE_JOB_NOT_FOUND', 'Bind the job with PUT /managed/v1/creative/jobs/:jobId first');
    }
    const input = this.storedInput(job);
    if (!managedCreativeKindEnabled(input.kind)) {
      throw accessException('CREATIVE_KIND_NOT_ENABLED');
    }
    const index =
      input.kind === 'video.seedance'
        ? input.sourceAssets.findIndex((asset) => asset.assetId === assetId && asset.version === version)
        : -1;
    if (input.kind !== 'video.seedance' || index < 0 || input.sourceAssets[index].sha256 !== declaredSha256) {
      throw new ManagedCreativeException('CREATIVE_SOURCE_NOT_DECLARED', 'This asset version and digest are not a source of this job');
    }

    const slot = index + 1;
    const receipt = (object: { sha256: string; byteLength: number; contentType: string }) => ({
      jobId,
      assetId,
      version,
      sha256: object.sha256,
      byteLength: object.byteLength,
      contentType: object.contentType,
    });
    const existing = (await this._repository.listObjects(organizationId, job.id)).find(
      (object) => object.role === 'source' && object.slot === slot
    );
    if (existing) {
      body.resume();
      return receipt(existing);
    }

    const read = await readStreamBounded(body, CREATIVE_SOURCE_MAX_BYTES);
    if (read.ok === false || read.bytes.length !== declared) {
      throw new ManagedCreativeException('CREATIVE_SOURCE_INVALID', 'The body could not be read to its declared length');
    }
    if (sha256Of(read.bytes) !== declaredSha256) {
      throw new ManagedCreativeException('CREATIVE_SOURCE_DIGEST_MISMATCH', 'The bytes do not have the declared sha256');
    }
    const type = sniffCreativeMedia(read.bytes);
    if (type !== 'image/png' && type !== 'image/jpeg' && type !== 'image/webp') {
      throw new ManagedCreativeException('CREATIVE_SOURCE_INVALID', 'A source must be a PNG, JPEG or WebP image');
    }

    const object = await this._runtime.retainSource(
      this.operationId(job),
      slot,
      { assetId, version },
      read.bytes,
      type
    );
    if (!object) {
      throw new ManagedCreativeException('CREATIVE_SOURCE_NOT_RETAINED', 'The source could not be retained; nothing was recorded');
    }
    const kept = await this._repository.pinObject(organizationId, job.id, object);
    if (kept.sha256 !== object.sha256) {
      throw new ManagedCreativeException('CREATIVE_SOURCE_NOT_RETAINED', 'Another source is recorded for this slot');
    }

    return receipt(kept);
  }

  // ---- the voice list --------------------------------------------------------------

  async voices(credential: ManagedCredential) {
    this.access(credential);
    if (!managedCreativeKindEnabled('video.image_text_slides')) {
      throw accessException('CREATIVE_KIND_NOT_ENABLED');
    }

    let voices: Awaited<ReturnType<ManagedCreativeRuntime['voices']>> = null;
    try {
      voices = await this._runtime.voices();
    } catch (err) {
      voices = null;
    }
    if (!voices) {
      throw new ManagedCreativeException('CREATIVE_VOICES_UNAVAILABLE', 'The voice list gave no usable answer; nothing was retried');
    }

    return { voices };
  }
}

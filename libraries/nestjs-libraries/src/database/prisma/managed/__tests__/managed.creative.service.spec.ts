// The owned creative runtime end to end: the service, the real runtime and
// the real adapters, over FAKE providers, a FAKE scratch bucket and an
// in-memory repository with the schema's unique keys. Nothing is sent or
// paid. What is checked: a call is sent at most once per call key whatever
// HTTP does (replays, concurrent duplicates, a lost record, a dead sender),
// refusals are recorded and never turn into a send, jobs and handles are
// bound to the organization, and every kind runs its stages through.
jest.mock('music-metadata', () => ({ parseBuffer: jest.fn(async () => ({ format: { duration: 2 } })) }), {
  virtual: true,
});
jest.mock('transloadit', () => ({
  __esModule: true,
  default: class {
    calcSignature(params: unknown) {
      return { signature: 'FAKE-SIGNATURE', params: JSON.stringify(params) };
    }
  },
}));
jest.mock('@gitroom/nestjs-libraries/openai/openai.service', () => ({ OpenaiService: class {} }));

import 'reflect-metadata';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ManagedCreativeService } from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.service';
import {
  CreativeCallRow,
  CreativeCallCreate,
  CreativeCallSettle,
  CreativeJobRow,
  CreativeObjectRow,
  CreativePollSettle,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.repository';
import {
  CreativeJobInput,
  MANAGED_CREATIVE_VERSION,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.creative.contracts';
import { ManagedCreativeCallDto } from '@gitroom/nestjs-libraries/dtos/managed/managed.creative.dto';
import { managedScratchKeys } from '@gitroom/nestjs-libraries/managed-creative/contracts';
import {
  FakeProviders,
  FakeScratch,
  MP4_BYTES,
  PNG_BYTES,
  SCRATCH_HOST,
  SECRET,
  captionFile,
  fakeOpenai,
  fakeRuntime,
} from '@gitroom/nestjs-libraries/managed-creative/__tests__/fakes/creative.runtime.fakes';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const NOW = new Date('2026-11-06T12:00:00.000Z');
const TENANT = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const credential = (organizationId = ORG, scopes = ['creative:run']) =>
  ({ id: `ww-creative-${organizationId}`, organizationId, tokenSha256: 'x', scopes } as any);

const ENV = {
  POSTIZ_MANAGED_MODE: 'enabled',
  POSTIZ_MANAGED_ORGANIZATIONS: `${ORG},${OTHER_ORG}`,
  POSTIZ_MANAGED_CREATIVE_ORGANIZATIONS: `${ORG},${OTHER_ORG}`,
  POSTIZ_MANAGED_CREATIVE_KINDS: 'image,video.seedance,video.image_text_slides,clipping',
  POSTIZ_MANAGED_CREATIVE_EXPIRES_AT: '2026-11-10T23:00:00.000Z',
};
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterEach(() => {
  for (const key of Object.keys(ENV)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const clone = <T>(value: T): T => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));
const taken = () => new (Prisma as any).PrismaClientKnownRequestError('Unique constraint failed', 'P2002');

// The repository's contract over memory, with the schema's unique keys:
// (organizationId, jobId), (organizationId, callKey), (organizationId,
// handleKey) and (jobRowId, role, slot)
class FakeCreativeRepository {
  jobs: CreativeJobRow[] = [];
  calls: CreativeCallRow[] = [];
  objects: (CreativeObjectRow & { organizationId: string; jobRowId: string })[] = [];
  failSettle = false;

  async getJob(organizationId: string, jobId: string) {
    return clone(this.jobs.find((job) => job.organizationId === organizationId && job.jobId === jobId) ?? null);
  }
  async getJobByRow(organizationId: string, id: string) {
    return clone(this.jobs.find((job) => job.organizationId === organizationId && job.id === id) ?? null);
  }
  async createJob(organizationId: string, data: Omit<CreativeJobRow, 'id' | 'organizationId'>) {
    if (this.jobs.some((job) => job.organizationId === organizationId && job.jobId === data.jobId)) return null;
    const row = { ...data, id: randomUUID(), organizationId };
    this.jobs.push(row);
    return clone(row);
  }
  async getCall(organizationId: string, callKey: string) {
    return clone(this.calls.find((call) => call.organizationId === organizationId && call.callKey === callKey) ?? null);
  }
  async getCallByHandle(organizationId: string, handleKey: string) {
    return clone(this.calls.find((call) => call.organizationId === organizationId && call.handleKey === handleKey) ?? null);
  }
  private handleTaken(organizationId: string, handleKey: string | null, id?: string) {
    return !!handleKey && this.calls.some((call) => call.organizationId === organizationId && call.handleKey === handleKey && call.id !== id);
  }
  async createCall(organizationId: string, data: CreativeCallCreate) {
    if (
      this.calls.some((call) => call.organizationId === organizationId && call.callKey === data.callKey) ||
      this.handleTaken(organizationId, data.handleKey)
    ) {
      return null;
    }
    const { credentialId, ...rest } = data;
    const row: CreativeCallRow = {
      ...rest,
      id: randomUUID(),
      organizationId,
      intermediate: null,
      pollStatus: null,
      pollAnswer: null,
      pollIntermediate: null,
    };
    this.calls.push(row);
    return clone(row);
  }
  private addObjects(organizationId: string, jobRowId: string, objects: CreativeObjectRow[]) {
    for (const object of objects) {
      if (!this.objects.some((o) => o.jobRowId === jobRowId && o.role === object.role && o.slot === object.slot)) {
        this.objects.push({ ...clone(object), organizationId, jobRowId });
      }
    }
  }
  async settleCall(organizationId: string, jobRowId: string, id: string, data: CreativeCallSettle, objects: CreativeObjectRow[]) {
    if (this.failSettle) throw new Error('FAKE database unavailable');
    const row = this.calls.find((call) => call.id === id && call.organizationId === organizationId && call.status === 'DISPATCHING');
    if (!row) return false;
    if (this.handleTaken(organizationId, data.handleKey, id)) throw taken();
    Object.assign(row, data);
    this.addObjects(organizationId, jobRowId, objects);
    return true;
  }
  async settlePoll(organizationId: string, jobRowId: string, id: string, data: CreativePollSettle, objects: CreativeObjectRow[]) {
    const row = this.calls.find((call) => call.id === id && call.organizationId === organizationId && call.pollStatus === null);
    if (!row) return false;
    Object.assign(row, data);
    this.addObjects(organizationId, jobRowId, objects);
    return true;
  }
  async listCalls(organizationId: string, jobRowId: string) {
    return clone(this.calls.filter((call) => call.organizationId === organizationId && call.jobRowId === jobRowId));
  }
  async listObjects(organizationId: string, jobRowId: string) {
    return clone(
      this.objects
        .filter((object) => object.organizationId === organizationId && object.jobRowId === jobRowId)
        .map(({ organizationId: _o, jobRowId: _j, ...object }) => object)
    );
  }
  async pinObject(organizationId: string, jobRowId: string, object: CreativeObjectRow) {
    this.addObjects(organizationId, jobRowId, [object]);
    const { organizationId: _o, jobRowId: _j, ...kept } = this.objects.find(
      (o) => o.jobRowId === jobRowId && o.role === object.role && o.slot === object.slot
    )!;
    return clone(kept);
  }
}

function setup() {
  const repository = new FakeCreativeRepository();
  const scratch = new FakeScratch();
  const providers = new FakeProviders(scratch);
  const openai = fakeOpenai();
  const service = new ManagedCreativeService(repository as any, fakeRuntime(providers, scratch, openai));
  service.now = () => NOW;
  return { repository, scratch, providers, openai, service };
}

const IMAGE: CreativeJobInput = {
  kind: 'image',
  provider: 'openai',
  model: 'chatgpt-image-latest',
  orientation: 'square',
  prompt: 'A FAKE lighthouse at dusk',
};
const SLIDES: CreativeJobInput = {
  kind: 'video.image_text_slides',
  output: 'vertical',
  voiceId: 'Voice0001',
  prompt: 'Two FAKE animals say hello',
};
const CLIPPING: CreativeJobInput = {
  kind: 'clipping',
  sourceUrl: 'https://www.youtube.com/watch?v=FAKE0000001',
  fit: 'blur',
  clips: 2,
  maxSourceMinutes: 10,
  clipSeconds: { min: 10, max: 90 },
};
const SOURCE = Buffer.concat([PNG_BYTES, Buffer.from('FAKE-SOURCE')]);
const SOURCE_SHA = createHash('sha256').update(SOURCE).digest('hex');
const ASSET = '44444444-4444-4444-8444-444444444444';
const seedance = (sources = 1): CreativeJobInput => ({
  kind: 'video.seedance',
  provider: 'evolink',
  model: sources ? 'seedance-2.0-fast-reference-to-video' : 'seedance-2.0-fast-text-to-video',
  output: 'vertical',
  prompt: 'A FAKE wave',
  sourceAssets: sources ? [{ kind: 'ww_asset', assetId: ASSET, version: 3, sha256: SOURCE_SHA }] : [],
});

const newJob = () => randomUUID();
function call(jobId: string, input: unknown, stage: string, item = 0, attempt = 1, extra: object = {}) {
  return {
    version: MANAGED_CREATIVE_VERSION,
    jobId,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    input,
    stage,
    item,
    attempt,
    callKey: `${jobId}:${stage}:${item}:${attempt}`,
    ...extra,
  } as ManagedCreativeCallDto;
}
const poll = (handle: object, extra: object = {}) => ({ version: MANAGED_CREATIVE_VERSION, handle, ...extra } as any);
const artifact = (jobId: string, stage: string, item = 0, handle: object | null = null) =>
  ({ version: MANAGED_CREATIVE_VERSION, jobId, stage, item, handle } as any);

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return ((err as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('no refusal');
}

const noSecrets = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('https://');
  expect(text).not.toContain('FAKE-');
};

describe('one call, at most one send', () => {
  it('sends an image once, answers every replay with the recorded answer and serves the retained bytes', async () => {
    const { service, openai, repository } = setup();
    const jobId = newJob();
    const body = call(jobId, IMAGE, 'image.generate');

    const first = await service.call(credential(), body);
    const replay = await service.call(credential(), body);

    expect(first).toEqual({ outcome: 'completed', result: null });
    expect(replay).toEqual(first);
    expect(openai.generateImage).toHaveBeenCalledTimes(1);
    expect(repository.calls).toHaveLength(1);
    expect(repository.calls[0]).toMatchObject({ status: 'COMPLETED', callKey: body.callKey });

    const read = await service.readArtifact(credential(), artifact(jobId, 'image.generate'));
    expect(read).toMatchObject({ kind: 'bytes', contentType: 'image/png' });
    expect((read as any).bytes).toEqual(PNG_BYTES);
    noSecrets(repository.calls);
  });

  it('answers a concurrent duplicate unknown while the first is in flight, and sends once', async () => {
    const { service, openai } = setup();
    let release!: () => void;
    openai.generateImage.mockImplementationOnce(
      () => new Promise<string | undefined>((done) => { release = () => done(PNG_BYTES.toString('base64')); })
    );
    const body = call(newJob(), IMAGE, 'image.generate');

    const first = service.call(credential(), body);
    await new Promise((done) => setImmediate(done));
    const duplicate = await service.call(credential(), body);
    release();

    expect(duplicate).toEqual({ outcome: 'unknown', code: 'CALL_OUTCOME_UNRECORDED' });
    expect(await first).toEqual({ outcome: 'completed', result: null });
    expect(openai.generateImage).toHaveBeenCalledTimes(1);
  });

  it('answers unknown forever for a call whose sender died after the gate, without sending', async () => {
    const { service, openai, repository } = setup();
    const body = call(newJob(), IMAGE, 'image.generate');
    let release!: () => void;
    openai.generateImage.mockImplementationOnce(() => new Promise<string | undefined>((done) => { release = () => done(undefined); }));
    void service.call(credential(), body);
    await new Promise((done) => setImmediate(done));
    // the process is gone: the row stays DISPATCHING
    expect(repository.calls[0].status).toBe('DISPATCHING');

    expect(await service.call(credential(), body)).toEqual({ outcome: 'unknown', code: 'CALL_OUTCOME_UNRECORDED' });
    expect(openai.generateImage).toHaveBeenCalledTimes(1);
    release();
  });

  it('answers unknown when the answer could not be recorded, and so does every replay', async () => {
    const { service, openai, repository } = setup();
    repository.failSettle = true;
    const body = call(newJob(), IMAGE, 'image.generate');

    expect(await service.call(credential(), body)).toEqual({ outcome: 'unknown', code: 'CALL_NOT_RECORDED' });
    repository.failSettle = false;
    expect(await service.call(credential(), body)).toEqual({ outcome: 'unknown', code: 'CALL_OUTCOME_UNRECORDED' });
    expect(openai.generateImage).toHaveBeenCalledTimes(1);
  });

  it('records a lost provider answer as unknown and never sends it again', async () => {
    const { service, openai } = setup();
    openai.generateImage.mockRejectedValueOnce(new Error('FAKE socket hang up https://api.openai.test?key=FAKE-key'));
    const body = call(newJob(), IMAGE, 'image.generate');

    const answer = await service.call(credential(), body);
    expect(answer).toEqual({ outcome: 'unknown', code: 'IMAGE_NO_RECEIPT' });
    expect(await service.call(credential(), body)).toEqual(answer);
    expect(openai.generateImage).toHaveBeenCalledTimes(1);
  });

  it('refuses the same call key for another request, sending nothing', async () => {
    const { service, openai } = setup();
    const jobId = newJob();
    await service.call(credential(), call(jobId, IMAGE, 'image.generate'));

    expect(
      await codeOf(service.call(credential(), call(jobId, { ...IMAGE, prompt: 'Another prompt' }, 'image.generate')))
    ).toBe('CREATIVE_CALL_KEY_CONFLICT');
    expect(openai.generateImage).toHaveBeenCalledTimes(1);
  });

  it('refuses a call key that is not the call it names', async () => {
    const { service, repository } = setup();
    const body = { ...call(newJob(), IMAGE, 'image.generate'), callKey: `${newJob()}:image.generate:0:1` };

    expect(await codeOf(service.call(credential(), body))).toBe('CREATIVE_INPUT_INVALID');
    expect(repository.calls).toHaveLength(0);
  });
});

describe('refusals are recorded, never sent later', () => {
  it('keeps a call refused while its kind was off refused after the kind is switched on', async () => {
    const { service, openai } = setup();
    process.env.POSTIZ_MANAGED_CREATIVE_KINDS = '';
    const body = call(newJob(), IMAGE, 'image.generate');

    expect(await service.call(credential(), body)).toEqual({ outcome: 'not_sent', code: 'CREATIVE_KIND_NOT_ENABLED' });
    process.env.POSTIZ_MANAGED_CREATIVE_KINDS = 'image';
    expect(await service.call(credential(), body)).toEqual({ outcome: 'not_sent', code: 'CREATIVE_KIND_NOT_ENABLED' });
    expect(openai.generateImage).not.toHaveBeenCalled();
  });

  it.each([
    ['an expired window', () => { process.env.POSTIZ_MANAGED_CREATIVE_EXPIRES_AT = '2026-11-06T11:00:00.000Z'; }, 'CREATIVE_ACCESS_EXPIRED'],
    ['an expiry past the operator bound', () => { process.env.POSTIZ_MANAGED_CREATIVE_EXPIRES_AT = '2026-11-11T00:00:00.000Z'; }, 'CREATIVE_ACCESS_EXPIRED'],
    ['an organization off the creative list', () => { process.env.POSTIZ_MANAGED_CREATIVE_ORGANIZATIONS = OTHER_ORG; }, 'CREATIVE_ORGANIZATION_NOT_ENABLED'],
  ])('answers not_sent for %s', async (_name, change, code) => {
    const { service, openai } = setup();
    change();

    expect(await service.call(credential(), call(newJob(), IMAGE, 'image.generate'))).toEqual({ outcome: 'not_sent', code });
    expect(openai.generateImage).not.toHaveBeenCalled();
  });

  it('refuses a credential that holds another scope too, recording nothing', async () => {
    const { service, repository } = setup();

    expect(
      await codeOf(service.call(credential(ORG, ['creative:run', 'posts:write']), call(newJob(), IMAGE, 'image.generate')))
    ).toBe('CREATIVE_CREDENTIAL_NOT_DEDICATED');
    expect(repository.calls).toHaveLength(0);
  });

  it('refuses an input outside the closed contract, a stage of another kind and a wrong item', async () => {
    const { service, openai, providers } = setup();
    const jobId = newJob();

    expect(await service.call(credential(), call(newJob(), { ...IMAGE, model: 'dall-e-3' }, 'image.generate'))).toEqual({
      outcome: 'not_sent',
      code: 'CREATIVE_INPUT_INVALID',
    });
    expect(await service.call(credential(), call(jobId, IMAGE, 'clip.analyse'))).toEqual({ outcome: 'not_sent', code: 'STAGE_KIND_MISMATCH' });
    expect(await service.call(credential(), call(jobId, IMAGE, 'image.generate', 1))).toEqual({ outcome: 'not_sent', code: 'STAGE_ITEM_INVALID' });
    expect(await service.call(credential(), call(newJob(), seedance(0), 'video.status'))).toEqual({ outcome: 'not_sent', code: 'STAGE_NOT_CALLABLE' });
    expect(openai.generateImage).not.toHaveBeenCalled();
    expect(providers.requests).toHaveLength(0);
  });
});

describe('jobs and handles belong to one organization', () => {
  it('binds a job id to its first scope and input', async () => {
    const { service } = setup();
    const jobId = newJob();
    const body = { version: MANAGED_CREATIVE_VERSION, tenantId: TENANT, workspaceId: WORKSPACE, input: IMAGE } as any;

    const bound = await service.bindJob(credential(), jobId, body);
    expect(bound).toEqual({ jobId, kind: 'image', inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await service.bindJob(credential(), jobId, body)).toEqual(bound);
    expect(
      await codeOf(service.bindJob(credential(), jobId, { ...body, workspaceId: '55555555-5555-4555-8555-555555555555' }))
    ).toBe('CREATIVE_JOB_BINDING_MISMATCH');
    expect(
      await service.call(credential(), { ...call(jobId, IMAGE, 'image.generate'), workspaceId: '55555555-5555-4555-8555-555555555555' })
    ).toEqual({ outcome: 'not_sent', code: 'JOB_BINDING_MISMATCH' });
  });

  it('never reads a handle another organization recorded', async () => {
    const { service, providers } = setup();
    providers.outputs.push({ status: 'completed', source: { duration_seconds: 60 }, audio: { bytes: 1 } });
    const answer = await service.call(credential(), call(newJob(), CLIPPING, 'clip.analyse'));
    const handle = (answer as any).handle;
    const reads = providers.requests.length;

    expect(
      await codeOf(service.poll(credential(OTHER_ORG), poll(handle, { call: { stage: 'clip.analyse', item: 0, attempt: 1 } })))
    ).toBe('CREATIVE_HANDLE_NOT_OWNED');
    expect(await codeOf(service.poll(credential(), poll({ kind: 'runpod', jobId: 'rp-forged' }, { call: { stage: 'clip.analyse', item: 0, attempt: 1 } })))).toBe(
      'CREATIVE_HANDLE_NOT_OWNED'
    );
    expect(await codeOf(service.poll(credential(), poll(handle, { call: { stage: 'clip.fetch', item: 1, attempt: 1 } })))).toBe(
      'CREATIVE_HANDLE_INVALID'
    );
    expect(providers.requests).toHaveLength(reads);
  });

  it('keeps the same job id of two organizations apart', async () => {
    const { service, repository } = setup();
    const jobId = newJob();
    await service.call(credential(), call(jobId, IMAGE, 'image.generate'));
    await service.call(credential(OTHER_ORG), call(jobId, IMAGE, 'image.generate'));

    expect(repository.jobs).toHaveLength(2);
    expect(new Set(repository.jobs.map((job) => job.id)).size).toBe(2);
    expect(await service.readArtifact(credential(OTHER_ORG), artifact(jobId, 'image.generate'))).toMatchObject({ kind: 'bytes' });
  });
});

describe('video.seedance', () => {
  it('refuses the submit until the declared source bytes were transferred', async () => {
    const { service, providers } = setup();

    expect(await service.call(credential(), call(newJob(), seedance(), 'video.submit'))).toEqual({
      outcome: 'not_sent',
      code: 'SOURCE_NOT_RETAINED',
    });
    expect(providers.posts()).toHaveLength(0);
  });

  it('verifies the source bytes, submits with signed scratch urls only, and retains the video', async () => {
    const { service, providers, scratch } = setup();
    const jobId = newJob();
    await service.bindJob(credential(), jobId, { version: MANAGED_CREATIVE_VERSION, tenantId: TENANT, workspaceId: WORKSPACE, input: seedance() } as any);
    const put = (bytes: Buffer, sha = SOURCE_SHA, version = 3) =>
      service.putSource(credential(), jobId, ASSET, version, Readable.from([bytes]), 'application/octet-stream', String(bytes.length), sha);

    expect(await codeOf(put(SOURCE, 'f'.repeat(64)))).toBe('CREATIVE_SOURCE_NOT_DECLARED');
    expect(await codeOf(put(SOURCE, SOURCE_SHA, 2))).toBe('CREATIVE_SOURCE_NOT_DECLARED');
    expect(await codeOf(put(Buffer.concat([SOURCE, Buffer.from('x')])))).toBe('CREATIVE_SOURCE_DIGEST_MISMATCH');
    const receipt = await put(SOURCE);
    expect(receipt).toEqual({ jobId, assetId: ASSET, version: 3, sha256: SOURCE_SHA, byteLength: SOURCE.length, contentType: 'image/png' });
    expect(await put(SOURCE)).toEqual(receipt);

    const answer = await service.call(credential(), call(jobId, seedance(), 'video.submit'));
    expect(answer).toEqual({ outcome: 'accepted', handle: { kind: 'evolink', taskId: 'task-1' } });
    const submitted = providers.posts('evolink')[0].body;
    expect(submitted.image_urls).toHaveLength(1);
    expect(new URL(submitted.image_urls[0]).hostname).toBe(SCRATCH_HOST);

    const first = await service.poll(credential(), poll({ kind: 'evolink', taskId: 'task-1' }));
    const reads = providers.requests.length;
    expect(first).toEqual({ status: 'completed', result: null });
    expect(await service.poll(credential(), poll({ kind: 'evolink', taskId: 'task-1' }))).toEqual(first);
    expect(providers.requests).toHaveLength(reads);

    const read = await service.readArtifact(credential(), artifact(jobId, 'video.status', 0, { kind: 'evolink', taskId: 'task-1' }));
    expect(read).toMatchObject({ kind: 'bytes', contentType: 'video/mp4' });
    expect((read as any).bytes).toEqual(MP4_BYTES);
    expect([...scratch.files.keys()].every((key) => key.startsWith('ww-'))).toBe(true);
  });
});

describe('video.image_text_slides', () => {
  const ASSEMBLY = 'b'.repeat(32);

  async function scripted(service: ManagedCreativeService, jobId: string) {
    expect(await service.call(credential(), call(jobId, SLIDES, 'slides.script'))).toEqual({ outcome: 'completed', result: { slides: 2 } });
    for (const item of [1, 2]) {
      expect(await service.call(credential(), call(jobId, SLIDES, 'slides.image', item))).toEqual({ outcome: 'completed', result: null });
      expect(await service.call(credential(), call(jobId, SLIDES, 'slides.speech', item))).toEqual({ outcome: 'completed', result: null });
    }
  }

  it('runs script, images, voices and the assembly, and retains the video', async () => {
    const { service, providers } = setup();
    const jobId = newJob();
    await scripted(service, jobId);

    expect(await service.call(credential(), call(jobId, SLIDES, 'slides.assemble', 0, 1, { assemblyId: ASSEMBLY }))).toEqual({ outcome: 'accepted' });
    const form = providers.posts('transloadit')[0].body as string;
    const steps = JSON.parse(form.split('name="params"\r\n\r\n')[1].split('\r\n')[0]).steps;
    expect(new URL(steps.image0.url).hostname).toBe(SCRATCH_HOST);
    expect(new URL(steps.audio1.url).hostname).toBe(SCRATCH_HOST);

    expect(await service.poll(credential(), poll({ kind: 'transloadit', assemblyId: ASSEMBLY }))).toEqual({ status: 'completed', result: null });
    const read = await service.readArtifact(credential(), artifact(jobId, 'slides.assemble', 0, { kind: 'transloadit', assemblyId: ASSEMBLY }));
    expect(read).toMatchObject({ kind: 'bytes', contentType: 'video/mp4' });
  });

  it('refuses an image beyond the script and an assembly before every slide is retained', async () => {
    const { service, providers } = setup();
    const jobId = newJob();
    await service.call(credential(), call(jobId, SLIDES, 'slides.script'));
    const posts = providers.posts().length;

    expect(await service.call(credential(), call(jobId, SLIDES, 'slides.image', 3))).toEqual({ outcome: 'not_sent', code: 'SLIDE_NOT_SCRIPTED' });
    expect(await service.call(credential(), call(jobId, SLIDES, 'slides.assemble', 0, 1, { assemblyId: ASSEMBLY }))).toEqual({
      outcome: 'not_sent',
      code: 'SLIDE_NOT_RETAINED',
    });
    expect(providers.posts()).toHaveLength(posts);
  });

  it('records the assembly id before sending, so a lost answer can still be read by it', async () => {
    const { service, providers } = setup();
    const jobId = newJob();
    await scripted(service, jobId);
    providers.assemblyThrows = true;

    expect(await service.call(credential(), call(jobId, SLIDES, 'slides.assemble', 0, 1, { assemblyId: ASSEMBLY }))).toEqual({
      outcome: 'unknown',
      code: 'ASSEMBLY_CONNECTION_LOST',
    });
    expect(await service.poll(credential(), poll({ kind: 'transloadit', assemblyId: ASSEMBLY }))).toEqual({ status: 'completed', result: null });
    expect(providers.posts('transloadit')).toHaveLength(1);
  });
});

describe('clipping', () => {
  const runpodCall = (stage: string, item = 0, attempt = 1) => ({ call: { stage, item, attempt } });

  async function analyse(service: ManagedCreativeService, providers: FakeProviders, jobId: string, attempt: number, output: object) {
    providers.outputs.push(output);
    const answer = (await service.call(credential(), call(jobId, CLIPPING, 'clip.analyse', 0, attempt))) as any;
    expect(answer).toEqual({ outcome: 'accepted', handle: { kind: 'runpod', jobId: expect.any(String) } });
    return service.poll(credential(), poll(answer.handle, runpodCall('clip.analyse', 0, attempt)));
  }

  async function clips(service: ManagedCreativeService, providers: FakeProviders, jobId: string) {
    for (const item of [1, 2]) {
      providers.outputs.push({ status: 'completed', source: { trim: { start_seconds: 0 } }, video: { bytes: 10 } });
      const fetch = (await service.call(credential(), call(jobId, CLIPPING, 'clip.fetch', item))) as any;
      expect(await service.poll(credential(), poll(fetch.handle, runpodCall('clip.fetch', item)))).toEqual({ status: 'completed', result: null });

      providers.outputs.push({ status: 'completed', clips: [{ status: 'completed', thumbnail: { bytes: 5 } }] });
      const render = (await service.call(credential(), call(jobId, CLIPPING, 'clip.render', item))) as any;
      expect(await service.poll(credential(), poll(render.handle, runpodCall('clip.render', item)))).toEqual({ status: 'completed', result: null });
    }
  }

  it('falls back to the audio-only analysis and Deepgram after untrusted captions, then clips and renders', async () => {
    const { service, providers, openai } = setup();
    const jobId = newJob();
    providers.transcriptFile = captionFile('uploader_provided');

    expect(
      await analyse(service, providers, jobId, 1, { status: 'completed', source: { title: 'FAKE talk', duration_seconds: 60.2 }, transcript: { origin: 'uploader_provided' } })
    ).toEqual({ status: 'completed', result: { durationSeconds: 61, transcript: 'untrusted' } });
    // the uploader's captions are never the transcript of a selection
    expect(await service.call(credential(), call(jobId, CLIPPING, 'clip.pick'))).toEqual({ outcome: 'not_sent', code: 'TRANSCRIPT_NOT_RETAINED' });
    expect(openai.pickClips).not.toHaveBeenCalled();

    expect(
      await analyse(service, providers, jobId, 2, { status: 'completed', source: { title: 'FAKE talk', duration_seconds: 60.2 }, audio: { bytes: 10 } })
    ).toEqual({ status: 'completed', result: { durationSeconds: 61, transcript: 'none' } });
    expect(providers.posts('fake-ingest')[1].body.input.transcript).toBeUndefined();

    expect(await service.call(credential(), call(jobId, CLIPPING, 'clip.transcribe'))).toEqual({ outcome: 'completed', result: null });
    expect(new URL(providers.posts('deepgram')[0].body.url).hostname).toBe(SCRATCH_HOST);
    expect(await service.call(credential(), call(newJob(), CLIPPING, 'clip.transcribe'))).toEqual({ outcome: 'not_sent', code: 'TRANSCRIBE_NOT_DUE' });
  });

  it('runs the caption path through to two retained clips with burned-in words', async () => {
    const { service, providers, openai } = setup();
    const jobId = newJob();

    expect(
      await analyse(service, providers, jobId, 1, { status: 'completed', source: { title: 'FAKE talk', duration_seconds: 60 }, transcript: { origin: 'auto_generated' } })
    ).toEqual({ status: 'completed', result: { durationSeconds: 60, transcript: 'auto' } });
    expect(await service.call(credential(), call(jobId, CLIPPING, 'clip.pick'))).toEqual({ outcome: 'completed', result: { clips: 2 } });
    expect(openai.pickClips).toHaveBeenCalledTimes(1);

    await clips(service, providers, jobId);

    const render = providers.posts('fake-clipper')[0].body.input;
    expect(render.frame).toEqual({ width: 1080, height: 1920, fit: 'blur' });
    expect(render.captions.words.length).toBeGreaterThan(0);
    for (const request of providers.posts('runpod.ai')) {
      for (const url of JSON.stringify(request.body).match(/https:\/\/[^"]+/g) || []) {
        if (!url.startsWith('https://www.youtube.com/')) expect(new URL(url).hostname).toBe(SCRATCH_HOST);
      }
    }

    for (const item of [1, 2]) {
      const read = await service.readArtifact(credential(), artifact(jobId, 'clip.render', item));
      expect(read).toMatchObject({ kind: 'bytes', contentType: 'video/mp4' });
    }
    expect(await service.readArtifact(credential(), artifact(jobId, 'clip.render', 3))).toEqual({ kind: 'missing', code: 'CLIP_NOT_RENDERED' });
  });

  it('refuses a render whose pinned transcript changed in scratch, before sending', async () => {
    const { service, providers, scratch, repository } = setup();
    const jobId = newJob();
    await analyse(service, providers, jobId, 1, { status: 'completed', source: { duration_seconds: 60 }, transcript: { origin: 'auto_generated' } });
    await service.call(credential(), call(jobId, CLIPPING, 'clip.pick'));
    providers.outputs.push({ status: 'completed', video: { bytes: 10 } });
    const fetch = (await service.call(credential(), call(jobId, CLIPPING, 'clip.fetch', 1))) as any;
    await service.poll(credential(), poll(fetch.handle, runpodCall('clip.fetch', 1)));

    const operation = repository.jobs[0].id.replace(/-/g, '');
    scratch.files.set(managedScratchKeys(operation).transcript, Buffer.concat([captionFile(), Buffer.from(' ')]));
    const posts = providers.posts().length;

    expect(await service.call(credential(), call(jobId, CLIPPING, 'clip.render', 1))).toEqual({
      outcome: 'not_sent',
      code: 'TRANSCRIPT_OBJECT_CHANGED',
    });
    expect(providers.posts()).toHaveLength(posts);
  });

  it('records a RunPod job the provider failed as failed, final and never resent', async () => {
    const { service, providers } = setup();
    const answer = await analyse(service, providers, newJob(), 1, {
      status: 'failed',
      failure: { code: 'SOURCE_UNAVAILABLE', message: 'FAKE https://scratch.fake.test/x?X-Amz-Signature=SECRET-SIG', retryable: false },
    });

    expect(answer).toEqual({ status: 'failed', code: 'SOURCE_UNAVAILABLE' });
    expect(providers.posts('runpod.ai')).toHaveLength(1);
  });
});

describe('voices and the request shape', () => {
  it('lists voice ids and names only', async () => {
    const { service } = setup();
    const voices = await service.voices(credential());

    expect(voices).toEqual({ voices: [{ id: 'Voice0001', label: 'Ada' }] });
    noSecrets(voices);
  });

  it('refuses unknown fields and malformed keys in a call body', async () => {
    const body = call(newJob(), IMAGE, 'image.generate');
    const errors = async (value: object) =>
      (await validate(plainToInstance(ManagedCreativeCallDto, value), { whitelist: true, forbidNonWhitelisted: true })).length;

    expect(await errors(body)).toBe(0);
    expect(await errors({ ...body, organizationId: ORG })).toBeGreaterThan(0);
    expect(await errors({ ...body, attempt: 3 })).toBeGreaterThan(0);
    expect(await errors({ ...body, assemblyId: 'B'.repeat(32) })).toBeGreaterThan(0);
    expect(await errors({ ...body, version: 'ww.creative-runtime.v2' })).toBeGreaterThan(0);
  });
});

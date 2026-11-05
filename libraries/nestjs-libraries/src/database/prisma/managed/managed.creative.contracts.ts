import { HttpException, HttpStatus } from '@nestjs/common';
import { createHash } from 'crypto';
import { z } from 'zod';
import {
  ManagedCredential,
  isManagedOrganization,
} from '@gitroom/nestjs-libraries/database/prisma/managed/managed.mode';
import {
  IMAGE_MODEL,
  MANAGED_CLIPS,
  SEEDANCE_MODELS,
  SLIDES_MAX,
} from '@gitroom/nestjs-libraries/managed-creative/contracts';
import { isAssemblyId } from '@gitroom/nestjs-libraries/managed-creative/slides-builders';

// The owned creative runtime behind W&W's CreativeProviderRuntime port
// (docs/managed-extension/creative-runtime.md). W&W (0119) owns the job, the
// ledger, the confirmation and the spend; this side owns the provider keys,
// the private scratch bucket and one durable row per W&W call key, so a call
// is sent at most once whatever HTTP or a restart does. Pure: no Prisma, no
// Nest DI, no network.

export const MANAGED_CREATIVE_SCOPE = 'creative:run' as const;
export const MANAGED_CREATIVE_VERSION = 'ww.creative-runtime.v1' as const;
// The end of the operator-stated customer access, exclusive. A later or
// missing POSTIZ_MANAGED_CREATIVE_EXPIRES_AT enables nothing
export const MANAGED_CREATIVE_MAX_EXPIRY = new Date('2026-11-10T23:00:00.000Z');

// Same bound as a managed reserved upload (MANAGED_UPLOAD_MAX_BYTES); W&W's
// MEDIA_INGEST_LIMITS.bytesMax is assumed to be the same 20 MiB
export const CREATIVE_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const CREATIVE_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

// ---- the W&W job input (ww.creative-job.v1), closed ------------------------

export const CREATIVE_LIMITS = Object.freeze({
  promptMax: 4000,
  seedanceSourceAssetsMax: 3,
  clipsMin: MANAGED_CLIPS.min,
  clipsMax: MANAGED_CLIPS.max,
  clipSecondsMin: 10,
  clipSecondsMax: 90,
  maxSourceMinutes: 180,
});

const SHA256 = /^[0-9a-f]{64}$/;
export const CREATIVE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// exactly one canonical form: the exact host, /watch and the 11-character id
const YOUTUBE_WATCH_URL =
  /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/;
const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;

const [SEEDANCE_TEXT_MODEL, SEEDANCE_REFERENCE_MODEL] = SEEDANCE_MODELS;
export const seedanceModelFor = (sources: number) =>
  sources === 0 ? SEEDANCE_TEXT_MODEL : SEEDANCE_REFERENCE_MODEL;

const prompt = z
  .string()
  .max(CREATIVE_LIMITS.promptMax)
  .refine((value) => value.trim().length > 0, 'prompt is blank');

const sourceAsset = z
  .object({
    kind: z.literal('ww_asset'),
    assetId: z.string().regex(CREATIVE_UUID),
    version: z.number().int().min(1),
    sha256: z.string().regex(SHA256),
  })
  .strict();

const imageInput = z
  .object({
    kind: z.literal('image'),
    provider: z.literal('openai'),
    model: z.literal(IMAGE_MODEL),
    orientation: z.enum(['square', 'vertical']),
    prompt,
  })
  .strict();

const seedanceInput = z
  .object({
    kind: z.literal('video.seedance'),
    provider: z.literal('evolink'),
    model: z.enum(SEEDANCE_MODELS),
    output: z.enum(['vertical', 'horizontal']),
    prompt,
    sourceAssets: z
      .array(sourceAsset)
      .max(CREATIVE_LIMITS.seedanceSourceAssetsMax),
  })
  .strict()
  .superRefine((input, ctx) => {
    // the model follows from the retained assets, exactly as Seedance picks it
    if (input.model !== seedanceModelFor(input.sourceAssets.length)) {
      ctx.addIssue({ code: 'custom', path: ['model'], message: 'model does not match source assets' });
    }
    if (
      new Set(input.sourceAssets.map((asset) => asset.assetId)).size !==
      input.sourceAssets.length
    ) {
      ctx.addIssue({ code: 'custom', path: ['sourceAssets'], message: 'duplicate source asset' });
    }
  });

const slidesInput = z
  .object({
    kind: z.literal('video.image_text_slides'),
    output: z.enum(['vertical', 'horizontal']),
    voiceId: z.string().regex(VOICE_ID),
    prompt,
  })
  .strict();

const clippingInput = z
  .object({
    kind: z.literal('clipping'),
    sourceUrl: z.string().regex(YOUTUBE_WATCH_URL),
    fit: z.enum(['blur', 'crop']),
    clips: z
      .number()
      .int()
      .min(CREATIVE_LIMITS.clipsMin)
      .max(CREATIVE_LIMITS.clipsMax),
    maxSourceMinutes: z
      .number()
      .int()
      .min(1)
      .max(CREATIVE_LIMITS.maxSourceMinutes),
    clipSeconds: z
      .object({
        min: z.number().int().min(CREATIVE_LIMITS.clipSecondsMin),
        max: z.number().int().max(CREATIVE_LIMITS.clipSecondsMax),
      })
      .strict()
      .refine((range) => range.min <= range.max, 'clip range is inverted'),
  })
  .strict();

const creativeJobInput = z.union([
  imageInput,
  seedanceInput,
  slidesInput,
  clippingInput,
]);

// This repository disables strictNullChecks, so zod's inferred object keys appear optional to TypeScript.
// Both closed schemas require every field; restore that fact only after successful runtime parsing.
type RequiredParsed<T> = T extends readonly (infer Item)[] ? RequiredParsed<Item>[]
  : T extends object ? { [Key in keyof T]-?: RequiredParsed<T[Key]> } : T;
export type CreativeJobInput = RequiredParsed<z.infer<typeof creativeJobInput>>;
export type CreativeKind = CreativeJobInput['kind'];
export type CreativeInputOf<K extends CreativeKind> = Extract<
  CreativeJobInput,
  { kind: K }
>;

export const CREATIVE_KINDS: readonly CreativeKind[] = [
  'image',
  'video.seedance',
  'video.image_text_slides',
  'clipping',
];

// Unknown keys, kinds, providers and models are refused, never ignored
export function parseCreativeJobInput(raw: unknown): CreativeJobInput | null {
  const parsed = creativeJobInput.safeParse(raw);
  return parsed.success ? parsed.data as CreativeJobInput : null;
}

// Sorted keys, no whitespace. Assumed to equal W&W's canonicalJson (engine.js
// was not available here); nothing on this side depends on the two matching
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, unknown>)[key]
          )}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export const sha256Of = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

// ---- stages: W&W name -> owned adapter stage --------------------------------

export const CREATIVE_STAGE_NAMES = [
  'image.generate',
  'video.submit',
  'video.status',
  'slides.script',
  'slides.image',
  'slides.speech',
  'slides.assemble',
  'clip.analyse',
  'clip.transcribe',
  'clip.pick',
  'clip.fetch',
  'clip.render',
] as const;
export type CreativeStageName = (typeof CREATIVE_STAGE_NAMES)[number];

export interface CreativeStageDefinition {
  kind: CreativeKind;
  // the stage name of the owned adapter contract (managed-creative/contracts)
  owned: string;
  billable: boolean;
  handle: 'evolink' | 'runpod' | 'transloadit' | null;
  // 0: item is always 0; n: one call per slide / clip, item 1..n
  items: number;
}

// The W&W `clip.*` stages are the owned `clipping.*` ones, mapped by name
// here and nowhere else. The owned `clipping.clip_caption` (a Deepgram call
// per clip on line-timed captions) has no W&W stage. Line-timed automatic
// captions use the already-budgeted full-source audio/transcription fallback.
export const CREATIVE_STAGE_DEFINITIONS: Readonly<
  Record<CreativeStageName, CreativeStageDefinition>
> = Object.freeze({
  'image.generate': { kind: 'image', owned: 'image.generate', billable: true, handle: null, items: 0 },
  'video.submit': { kind: 'video.seedance', owned: 'video.submit', billable: true, handle: 'evolink', items: 0 },
  'video.status': { kind: 'video.seedance', owned: 'video.status', billable: false, handle: 'evolink', items: 0 },
  'slides.script': { kind: 'video.image_text_slides', owned: 'slides.script', billable: true, handle: null, items: 0 },
  'slides.image': { kind: 'video.image_text_slides', owned: 'slides.image', billable: true, handle: null, items: SLIDES_MAX },
  'slides.speech': { kind: 'video.image_text_slides', owned: 'slides.speech', billable: true, handle: null, items: SLIDES_MAX },
  'slides.assemble': { kind: 'video.image_text_slides', owned: 'slides.assemble', billable: true, handle: 'transloadit', items: 0 },
  'clip.analyse': { kind: 'clipping', owned: 'clipping.analyse', billable: true, handle: 'runpod', items: 0 },
  'clip.transcribe': { kind: 'clipping', owned: 'clipping.transcribe', billable: true, handle: null, items: 0 },
  'clip.pick': { kind: 'clipping', owned: 'clipping.pick', billable: true, handle: null, items: 0 },
  'clip.fetch': { kind: 'clipping', owned: 'clipping.clip_fetch', billable: true, handle: 'runpod', items: MANAGED_CLIPS.max },
  'clip.render': { kind: 'clipping', owned: 'clipping.clip_render', billable: true, handle: 'runpod', items: MANAGED_CLIPS.max },
});

// The stage whose output is the job's artifact
export const CREATIVE_FINAL_STAGE: Readonly<Record<CreativeKind, CreativeStageName>> =
  Object.freeze({
    image: 'image.generate',
    'video.seedance': 'video.status',
    'video.image_text_slides': 'slides.assemble',
    clipping: 'clip.render',
  });

export const callKeyOf = (
  jobId: string,
  stage: string,
  item: number,
  attempt: number
) => `${jobId}:${stage}:${item}:${attempt}`;

// Why this stage / item / attempt can never be a call of a job of this kind,
// or null. A refusal is answered as not_sent
export function creativeStageRefusal(
  kind: CreativeKind,
  stage: CreativeStageName,
  item: number,
  attempt: number
): string | null {
  const definition = CREATIVE_STAGE_DEFINITIONS[stage];
  if (definition.kind !== kind) {
    return 'STAGE_KIND_MISMATCH';
  }
  if (!definition.billable) {
    return 'STAGE_NOT_CALLABLE';
  }
  if (
    definition.items === 0
      ? item !== 0
      : item < 1 || item > definition.items
  ) {
    return 'STAGE_ITEM_INVALID';
  }
  if (attempt === 2 && stage !== 'clip.analyse') {
    return 'STAGE_ATTEMPT_INVALID';
  }
  return null;
}

// ---- handles ----------------------------------------------------------------

// A handle as W&W records it. The RunPod endpoint is ours: it is kept on the
// call row, never taken from W&W
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const wwHandle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('evolink'), taskId: z.string().regex(PROVIDER_ID) }).strict(),
  z.object({ kind: z.literal('runpod'), jobId: z.string().regex(PROVIDER_ID) }).strict(),
  z
    .object({
      kind: z.literal('transloadit'),
      assemblyId: z.string().refine((value) => isAssemblyId(value)),
    })
    .strict(),
]);
export type CreativeWwHandle = RequiredParsed<z.infer<typeof wwHandle>>;

export function parseCreativeWwHandle(raw: unknown): CreativeWwHandle | null {
  const parsed = wwHandle.safeParse(raw);
  return parsed.success ? parsed.data as CreativeWwHandle : null;
}

// The unique lookup key of a handle within an organization
export function creativeHandleKey(handle: {
  kind: string;
  taskId?: string;
  jobId?: string;
  assemblyId?: string;
}) {
  return `${handle.kind}:${handle.taskId ?? handle.jobId ?? handle.assemblyId}`;
}

export const isCreativeAssemblyId = isAssemblyId;

// ---- answers (exactly the shapes of W&W's runtime port) ---------------------

export type CreativeRefusal = {
  outcome: 'not_sent' | 'rejected' | 'unknown';
  code: string;
};

export type CreativeAnalyseResult = {
  durationSeconds: number;
  transcript: 'auto' | 'none' | 'untrusted';
};

export type CreativeCallResult = { slides: number } | { clips: number } | null;

export type CreativeCallAnswer =
  | CreativeRefusal
  | { outcome: 'completed'; result: CreativeCallResult }
  // video.submit, clip.analyse/fetch/render
  | { outcome: 'accepted'; handle: CreativeWwHandle }
  // slides.assemble: the handle is the assembly id W&W committed
  | { outcome: 'accepted' }
  | { outcome: 'failed'; code: string };

export type CreativePollAnswer =
  | { status: 'running' }
  | { status: 'completed'; result: CreativeAnalyseResult | null }
  | { status: 'failed'; code: string }
  | { status: 'not_found' };

// The durable state of one call row. DISPATCHING is written before the
// provider request leaves and is only ever left by the request that wrote
// it; every other status is final
export type CreativeCallStatus =
  | 'DISPATCHING'
  | 'NOT_SENT'
  | 'COMPLETED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'FAILED';

// The final read of an accepted handle, kept on its call row
export type CreativePollStatus = 'COMPLETED' | 'FAILED';

export const notSent = (code: string): CreativeRefusal => ({
  outcome: 'not_sent',
  code,
});

// W&W's code shape; anything else is replaced, never passed on
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const creativeCode = (value: unknown, fallback: string) =>
  typeof value === 'string' && CODE.test(value) ? value : fallback;

// ---- refusals that are not a call answer ------------------------------------

export type ManagedCreativeCode =
  | 'CREATIVE_CREDENTIAL_NOT_DEDICATED'
  | 'CREATIVE_ORGANIZATION_NOT_ENABLED'
  | 'CREATIVE_KIND_NOT_ENABLED'
  | 'CREATIVE_ACCESS_EXPIRED'
  | 'CREATIVE_INPUT_INVALID'
  | 'CREATIVE_JOB_BINDING_MISMATCH'
  | 'CREATIVE_JOB_NOT_FOUND'
  | 'CREATIVE_CALL_KEY_CONFLICT'
  | 'CREATIVE_HANDLE_INVALID'
  | 'CREATIVE_HANDLE_NOT_OWNED'
  | 'CREATIVE_SOURCE_NOT_DECLARED'
  | 'CREATIVE_SOURCE_INVALID'
  | 'CREATIVE_SOURCE_DIGEST_MISMATCH'
  | 'CREATIVE_SOURCE_NOT_RETAINED'
  | 'CREATIVE_VOICES_UNAVAILABLE';

const STATUS: Record<ManagedCreativeCode, HttpStatus> = {
  CREATIVE_CREDENTIAL_NOT_DEDICATED: HttpStatus.FORBIDDEN,
  CREATIVE_ORGANIZATION_NOT_ENABLED: HttpStatus.FORBIDDEN,
  CREATIVE_KIND_NOT_ENABLED: HttpStatus.FORBIDDEN,
  CREATIVE_ACCESS_EXPIRED: HttpStatus.FORBIDDEN,
  CREATIVE_INPUT_INVALID: HttpStatus.BAD_REQUEST,
  CREATIVE_JOB_BINDING_MISMATCH: HttpStatus.CONFLICT,
  CREATIVE_JOB_NOT_FOUND: HttpStatus.NOT_FOUND,
  CREATIVE_CALL_KEY_CONFLICT: HttpStatus.CONFLICT,
  CREATIVE_HANDLE_INVALID: HttpStatus.BAD_REQUEST,
  CREATIVE_HANDLE_NOT_OWNED: HttpStatus.NOT_FOUND,
  CREATIVE_SOURCE_NOT_DECLARED: HttpStatus.UNPROCESSABLE_ENTITY,
  CREATIVE_SOURCE_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  CREATIVE_SOURCE_DIGEST_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  CREATIVE_SOURCE_NOT_RETAINED: HttpStatus.SERVICE_UNAVAILABLE,
  CREATIVE_VOICES_UNAVAILABLE: HttpStatus.BAD_GATEWAY,
};

export class ManagedCreativeException extends HttpException {
  constructor(public readonly code: ManagedCreativeCode, msg: string) {
    super({ code, msg }, STATUS[code]);
  }
}

// ---- operator qualification -------------------------------------------------

function list(value: string | undefined) {
  return new Set(
    String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry)
  );
}

// Every condition read from the environment on every request. The defaults
// (all unset) enable nothing
export function managedCreativeAccessRefusal(
  credential: ManagedCredential,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): ManagedCreativeCode | null {
  // its own principal: a credential that can also write drafts or upload
  // would let generation spend be triggered by a writer
  if (
    credential.scopes.length !== 1 ||
    credential.scopes[0] !== MANAGED_CREATIVE_SCOPE
  ) {
    return 'CREATIVE_CREDENTIAL_NOT_DEDICATED';
  }

  if (
    !isManagedOrganization(credential.organizationId) ||
    !list(env.POSTIZ_MANAGED_CREATIVE_ORGANIZATIONS).has(
      credential.organizationId
    )
  ) {
    return 'CREATIVE_ORGANIZATION_NOT_ENABLED';
  }

  const raw = env.POSTIZ_MANAGED_CREATIVE_EXPIRES_AT;
  const expiresAt = raw ? new Date(raw) : null;
  if (
    !expiresAt ||
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.getTime() > MANAGED_CREATIVE_MAX_EXPIRY.getTime() ||
    now.getTime() >= expiresAt.getTime()
  ) {
    return 'CREATIVE_ACCESS_EXPIRED';
  }

  return null;
}

// Live generation per kind; empty by default, so every kind is off
export function managedCreativeKindEnabled(
  kind: CreativeKind,
  env: NodeJS.ProcessEnv = process.env
) {
  return list(env.POSTIZ_MANAGED_CREATIVE_KINDS).has(kind);
}

export const accessException = (code: ManagedCreativeCode) =>
  new ManagedCreativeException(
    code,
    code === 'CREATIVE_CREDENTIAL_NOT_DEDICATED'
      ? `Creative calls are only served to a credential that holds ${MANAGED_CREATIVE_SCOPE} and no other scope`
      : code === 'CREATIVE_ACCESS_EXPIRED'
      ? 'Creative access is not configured with a valid expiry, or it expired'
      : code === 'CREATIVE_KIND_NOT_ENABLED'
      ? 'This creative kind is not enabled on this server'
      : 'Creative calls are not enabled for this organization'
  );

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

// The private scratch bucket of the creative runtime
// (docs/managed-extension/creative-runtime.md). Providers read and write it
// only through urls signed here for one fixed key of one job; nothing in a
// request names a key, a host or a url. Its own bucket and credentials
// (POSTIZ_MANAGED_CREATIVE_SCRATCH_*), never the public upload bucket of
// CloudflareStorage: objects are written without an ACL and create-only.
// Signed urls are credentials: they are never stored, logged or returned.

// Every key is ww-<32 hex operation>-<parts>.<ext>: managedScratchKeys,
// slideScratchKeys and creativeScratchKeys below
export const CREATIVE_SCRATCH_KEY =
  /^ww-[a-f0-9]{32}(-[a-z0-9]{1,16}){1,3}\.(json|ogg|mp4|jpg|png|webp|mp3)$/;
// as long as CloudflareStorage signs for ClippingService
export const CREATIVE_SCRATCH_SIGN_SECONDS = 3 * 3600;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export type ScratchRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'absent' | 'too_large' | 'read_failed' };

export interface CreativeScratch {
  // the hosts its signed urls are on, for the adapters' isScratchUrl
  readonly hosts: readonly string[];
  signDownload(key: string): Promise<string>;
  signUpload(key: string, contentType: string): Promise<string>;
  // never replaces an object: 'exists' when the key is taken
  create(
    key: string,
    bytes: Buffer,
    contentType: string
  ): Promise<'created' | 'exists'>;
  read(key: string, maxBytes: number): Promise<ScratchRead>;
}

// The files the runtime itself retains, beside the clipping and slide keys
export function creativeScratchKeys(operationId: string) {
  return {
    image: `ww-${operationId}-image.png`,
    video: `ww-${operationId}-video.mp4`,
    slides: `ww-${operationId}-slides.mp4`,
    transcribed: `ww-${operationId}-transcribed.json`,
    source: (slot: number, ext: string) =>
      `ww-${operationId}-source-${slot}.${ext}`,
  };
}

export interface CreativeScratchConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
}

// null (scratch off, every call refused before it is sent) unless all of it
// is configured and well formed
export function creativeScratchConfig(
  env: NodeJS.ProcessEnv
): CreativeScratchConfig | null {
  const accountId = env.POSTIZ_MANAGED_CREATIVE_SCRATCH_ACCOUNT_ID || '';
  const accessKeyId = env.POSTIZ_MANAGED_CREATIVE_SCRATCH_ACCESS_KEY || '';
  const secretAccessKey =
    env.POSTIZ_MANAGED_CREATIVE_SCRATCH_SECRET_ACCESS_KEY || '';
  const bucket = env.POSTIZ_MANAGED_CREATIVE_SCRATCH_BUCKET || '';
  if (
    !ACCOUNT_ID.test(accountId) ||
    !accessKeyId ||
    !secretAccessKey ||
    !BUCKET.test(bucket)
  ) {
    return null;
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    region: env.POSTIZ_MANAGED_CREATIVE_SCRATCH_REGION || 'auto',
  };
}

// Reads at most maxBytes of a stream; never throws
export async function readStreamBounded(
  stream: Readable,
  maxBytes: number
): Promise<ScratchRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    stream.destroy();
    return { ok: false, reason: 'read_failed' };
  }

  return { ok: true, bytes: Buffer.concat(chunks) };
}

const statusOf = (err: any) => err?.$metadata?.httpStatusCode;

export class R2CreativeScratch implements CreativeScratch {
  readonly hosts: readonly string[];
  private _client: S3Client;
  private _bucket: string;

  constructor(config: CreativeScratchConfig) {
    // path style, so every signed url is on this one host and its last path
    // part is the key (isScratchUrl)
    const host = `${config.accountId}.r2.cloudflarestorage.com`;
    this.hosts = Object.freeze([host]);
    this._bucket = config.bucket;
    this._client = new S3Client({
      endpoint: `https://${host}`,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // as CloudflareStorage: a signed PUT must not demand a checksum the
      // media processor does not send
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  private key(key: string) {
    if (!CREATIVE_SCRATCH_KEY.test(key)) {
      throw new Error('Unsupported scratch key.');
    }
    return key;
  }

  signDownload(key: string) {
    return getSignedUrl(
      this._client,
      new GetObjectCommand({ Bucket: this._bucket, Key: this.key(key) }),
      { expiresIn: CREATIVE_SCRATCH_SIGN_SECONDS }
    );
  }

  signUpload(key: string, contentType: string) {
    return getSignedUrl(
      this._client,
      new PutObjectCommand({
        Bucket: this._bucket,
        Key: this.key(key),
        ContentType: contentType,
      }),
      { expiresIn: CREATIVE_SCRATCH_SIGN_SECONDS }
    );
  }

  // A conditional PUT (If-None-Match: *), as CloudflareStorage.createObjectAt,
  // without its public-read ACL
  async create(key: string, bytes: Buffer, contentType: string) {
    try {
      await this._client.send(
        new PutObjectCommand({
          Bucket: this._bucket,
          Key: this.key(key),
          Body: bytes,
          ContentType: contentType,
          ContentLength: bytes.length,
          IfNoneMatch: '*',
        })
      );
      return 'created' as const;
    } catch (err) {
      if (statusOf(err) === 412) {
        return 'exists' as const;
      }
      throw err;
    }
  }

  async read(key: string, maxBytes: number): Promise<ScratchRead> {
    let body: Readable;
    let length: number | undefined;
    try {
      const response = await this._client.send(
        new GetObjectCommand({ Bucket: this._bucket, Key: this.key(key) })
      );
      body = response.Body as Readable;
      length = response.ContentLength;
    } catch (err) {
      return {
        ok: false,
        reason: statusOf(err) === 404 ? 'absent' : 'read_failed',
      };
    }

    if (!body) {
      return { ok: false, reason: 'read_failed' };
    }
    if (length !== undefined && length > maxBytes) {
      body.destroy();
      return { ok: false, reason: 'too_large' };
    }

    return readStreamBounded(body, maxBytes);
  }
}

import { Readable } from 'stream';

export interface UploadedStream {
  filename: string;
  originalname: string;
  path: string;
  mimetype: string;
}

export interface IUploadProvider {
  uploadSimple(path: string): Promise<string>;
  uploadFile(file: Express.Multer.File): Promise<any>;
  // Streams the body straight into storage without buffering it. The caller
  // has already sniffed the real type from the first bytes, so it passes the
  // detected mime/ext instead of the provider re-sniffing a buffer
  uploadStream(
    stream: Readable,
    mimetype: string,
    ext: string
  ): Promise<UploadedStream>;
  removeFile(filePath: string): Promise<void>;
  // Presigned URLs handed to the media processor, which has no storage
  // credentials; only cloud storage can mint them
  signDownloadUrl?(fileName: string): Promise<string>;
  signUploadUrl?(fileName: string, contentType: string): Promise<string>;
  // Public URL of a key the media processor wrote through a presigned upload
  publicUrl?(fileName: string): string;
  // Small text files (a transcript) exchanged with the media processor under a
  // key both sides know, where uploadSimple would pick a random one
  readFile?(fileName: string): Promise<string>;
  writeFile?(
    fileName: string,
    body: string,
    contentType: string
  ): Promise<void>;
  // The stored path createObjectAt(key) will give the object, known before
  // any byte is written, so a caller can record the object's identity first
  objectPath?(key: string): string;
  // The inverse of objectPath: the key a stored media path addresses under
  // this storage's current public address (local files may sit in YYYY/MM/DD
  // folders), or null when the path is not one this storage hands out. A
  // string mapping only, no storage call: it says which key to read, never
  // what is there. A URL is never fetched
  objectKeyOf?(filePath: string): string | null;
  // A server-private digest of the namespace the key methods below resolve
  // keys in (local: the upload directory's real path, device and inode; R2:
  // endpoint account and bucket, never credentials). Two namespaces serving
  // the same public URL still differ, so an object recorded in one is never
  // looked for in another. Never returned by an API. Rejects when the
  // namespace cannot be identified (e.g. a missing upload directory)
  objectNamespace?(): Promise<string>;
  // Writes a new object under a caller-chosen key and never replaces one:
  // rejects with StorageObjectExistsError when the key is already taken. The
  // stream must carry exactly byteLength bytes. `signal` bounds this
  // process's side of the write: on abort the stream / request is torn down,
  // and nothing is started once it has fired. It does not prove storage will
  // not still commit what it already received. A failed write never deletes
  // what it may have left
  createObjectAt?(
    key: string,
    stream: Readable,
    mimetype: string,
    byteLength: number,
    signal: AbortSignal
  ): Promise<void>;
  // Read back an object by its key (one createObjectAt wrote, or any key
  // objectKeyOf gives) and never by a URL, so a changed public address cannot
  // hide it. The version is an opaque marker of the object's current bytes,
  // read from the storage itself (R2: ETag, size and last-modified; local:
  // device, inode, size and modification times); it changes when the object
  // is rewritten in place. null only when the storage itself reports the key
  // does not exist (ENOENT / 404); any other failure (permissions, I/O, a
  // missing upload directory or bucket, a key resolving outside) rejects
  objectVersionAt?(key: string): Promise<string | null>;
  openObjectAt?(
    key: string
  ): Promise<{ stream: Readable; version: string } | null>;
}

export class StorageObjectExistsError extends Error {
  constructor(key: string) {
    super(`An object already exists under ${key}`);
  }
}

// Keys a caller may choose for createObjectAt: one plain segment (no `/`, no
// `..`) with a media extension, so nothing else can be served from storage
export const STORAGE_OBJECT_KEY =
  /^[A-Za-z0-9_-]{1,200}\.(jpg|png|gif|webp|avif|bmp|tif|mp4|mp3|m4a|wav|ogg)$/;

// Keys objectKeyOf may give and the key reads accept: the same file name,
// optionally under plain folders (no `.` / `..` segment can match)
export const STORED_OBJECT_KEY =
  /^([A-Za-z0-9_-]{1,64}\/){0,8}[A-Za-z0-9_-]{1,200}\.(jpg|png|gif|webp|avif|bmp|tif|mp4|mp3|m4a|wav|ogg)$/;

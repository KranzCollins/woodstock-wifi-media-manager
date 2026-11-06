import {
  IUploadProvider,
  STORAGE_OBJECT_KEY,
  STORED_OBJECT_KEY,
  StorageObjectExistsError,
  UploadedStream,
} from './upload.interface';
import {
  createWriteStream,
  mkdirSync,
  Stats,
  unlink,
  writeFileSync,
} from 'fs';
import { FileHandle, open, realpath, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { dirname, resolve, sep } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { ssrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { parseDataUrl } from '@gitroom/nestjs-libraries/upload/data.url';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type');

const LOCAL_STORAGE_ALLOWED_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
]);
export class LocalStorage implements IUploadProvider {
  constructor(private uploadDirectory: string) {}

  // Files live under /YYYY/MM/DD with a random name; creates the folder
  private newFilePath(ext: string) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const innerPath = `/${year}/${month}/${day}`;
    const dir = `${this.uploadDirectory}${innerPath}`;
    mkdirSync(dir, { recursive: true });

    const randomName = Array(32)
      .fill(null)
      .map(() => Math.round(Math.random() * 16).toString(16))
      .join('');

    const filename = `${randomName}.${ext}`;
    return {
      filename,
      filePath: `${dir}/${filename}`,
      path: process.env.FRONTEND_URL + '/uploads' + `${innerPath}/${filename}`,
    };
  }

  async uploadSimple(path: string) {
    const dataUrl = path.startsWith('data:') ? parseDataUrl(path) : null;

    let body: Buffer;
    if (dataUrl) {
      body = dataUrl.buffer;
    } else {
      if (!(await isSafePublicHttpsUrl(path))) {
        throw new Error('Unsafe URL');
      }
      const loadImage = await fetch(path, {
        // @ts-ignore — undici option, not in lib.dom fetch types
        dispatcher: ssrfSafeDispatcher,
      });
      body = Buffer.from(await loadImage.arrayBuffer());
    }

    // Never trust the claimed mime/extension (data URL header, remote
    // content-type, or URL path): sniff the real type from the bytes and
    // only accept the allow-list, otherwise an attacker could write an
    // arbitrary file (e.g. .html/.svg with embedded script) into the
    // publicly served uploads directory on the app's own origin.
    const detected = await fileTypeFromBuffer(body);
    if (!detected || !LOCAL_STORAGE_ALLOWED_MIME.has(detected.mime)) {
      throw new Error('Unsupported file type.');
    }

    const { filePath, path: publicUrl } = this.newFilePath(detected.ext);
    // Logic to save the file to the filesystem goes here
    writeFileSync(filePath, body);

    return publicUrl;
  }

  async uploadFile(file: Express.Multer.File): Promise<any> {
    try {
      const detected = await fileTypeFromBuffer(file.buffer);
      if (!detected || !LOCAL_STORAGE_ALLOWED_MIME.has(detected.mime)) {
        throw new Error('Unsupported file type.');
      }
      const safeMime = detected.mime;

      const { filename, filePath, path } = this.newFilePath(detected.ext);
      writeFileSync(filePath, file.buffer);

      return {
        filename,
        path,
        mimetype: safeMime,
        originalname: filename,
      };
    } catch (err) {
      console.error('Error uploading file to Local Storage:', err);
      throw err;
    }
  }

  async uploadStream(
    stream: Readable,
    mimetype: string,
    ext: string
  ): Promise<UploadedStream> {
    try {
      if (!LOCAL_STORAGE_ALLOWED_MIME.has(mimetype)) {
        throw new Error('Unsupported file type.');
      }

      const { filename, filePath, path } = this.newFilePath(ext);
      try {
        await pipeline(stream, createWriteStream(filePath));
      } catch (err) {
        // Don't leave a truncated file behind (size cap hit, remote closed, ...)
        await this.removeFile(filePath).catch(() => {});
        throw err;
      }

      return {
        filename,
        path,
        mimetype,
        originalname: filename,
      };
    } catch (err) {
      console.error('Error streaming file to Local Storage:', err);
      throw err;
    }
  }

  // The file a key names inside the upload directory. The key must name the
  // file itself: a symlink anywhere below the upload directory, which could
  // point at another file or outside, rejects. Only the file's own absence
  // is null: a missing or unreadable upload directory rejects too
  private async objectLocalPath(key: string) {
    if (!STORED_OBJECT_KEY.test(key)) {
      throw new Error('Unsupported object key.');
    }

    const base = await realpath(resolve(String(this.uploadDirectory)));
    const filePath = resolve(base + '/' + key);
    let localPath: string;
    try {
      localPath = await realpath(filePath);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return null;
      }
      throw err;
    }

    if (localPath !== filePath || !localPath.startsWith(base + sep)) {
      throw new Error('Unsafe file path');
    }

    return localPath;
  }

  // a rewrite in place changes the times, a replacement the inode
  private objectVersion(stats: Stats) {
    return `local:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  }

  private async statVersion(localPath: string) {
    try {
      return this.objectVersion(await stat(localPath));
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  // the version comes from the open descriptor, so it describes the file
  // the stream reads even when the path is replaced meanwhile
  private async openVersioned(localPath: string) {
    let handle: FileHandle;
    try {
      handle = await open(localPath, 'r');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return null;
      }
      throw err;
    }

    try {
      const version = this.objectVersion(await handle.stat());
      return { stream: handle.createReadStream() as Readable, version };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async openObjectAt(key: string) {
    const localPath = await this.objectLocalPath(key);
    return localPath ? this.openVersioned(localPath) : null;
  }

  async objectVersionAt(key: string) {
    const localPath = await this.objectLocalPath(key);
    return localPath ? this.statVersion(localPath) : null;
  }

  // the directory keys resolve in: another directory, or one put in its
  // place at the same path, is another namespace even with the same URL
  async objectNamespace() {
    const base = await realpath(resolve(String(this.uploadDirectory)));
    const stats = await stat(base, { bigint: true });
    if (!stats.isDirectory()) {
      throw new Error('The upload directory is not a directory');
    }

    return (
      'local:' +
      createHash('sha256')
        .update(JSON.stringify([base, String(stats.dev), String(stats.ino)]))
        .digest('hex')
    );
  }

  objectPath(key: string) {
    return process.env.FRONTEND_URL + '/uploads/' + key;
  }

  // only the public URL form this storage hands out has a key
  objectKeyOf(filePath: string) {
    const publicPrefix = process.env.FRONTEND_URL + '/uploads/';
    if (!filePath.startsWith(publicPrefix)) {
      return null;
    }

    const key = filePath.slice(publicPrefix.length);
    return STORED_OBJECT_KEY.test(key) ? key : null;
  }

  // 'wx' opens with O_EXCL: an existing file is never truncated or replaced.
  // The file exists once the open succeeded, before any byte is written. The
  // signal destroys both streams; a truncated file is left for the caller to
  // read back and record, never removed here
  async createObjectAt(
    key: string,
    stream: Readable,
    mimetype: string,
    _byteLength: number,
    signal: AbortSignal
  ) {
    if (!STORAGE_OBJECT_KEY.test(key) || !LOCAL_STORAGE_ALLOWED_MIME.has(mimetype)) {
      throw new Error('Unsupported object key or file type.');
    }

    const base = resolve(String(this.uploadDirectory));
    const filePath = resolve(base + '/' + key);
    if (!filePath.startsWith(base + sep)) {
      throw new Error('Unsafe file path');
    }

    // nothing is created once the deadline passed
    signal.throwIfAborted();
    mkdirSync(dirname(filePath), { recursive: true });
    let handle: FileHandle;
    try {
      handle = await open(filePath, 'wx');
    } catch (err: any) {
      if (err?.code === 'EEXIST') {
        throw new StorageObjectExistsError(key);
      }
      throw err;
    }

    await pipeline(stream, handle.createWriteStream(), { signal });
  }

  // Accepts either the public URL or the filesystem path. Callers can pass a
  // stored media name or path, so only a file inside the upload directory is
  // ever deleted: resolve() collapses any `..` segments before the comparison
  async removeFile(filePath: string): Promise<void> {
    const publicPrefix = process.env.FRONTEND_URL + '/uploads';
    const base = resolve(String(this.uploadDirectory));
    const localPath = resolve(
      filePath.startsWith(publicPrefix)
        ? this.uploadDirectory + filePath.slice(publicPrefix.length)
        : filePath
    );
    if (!localPath.startsWith(base + sep)) {
      throw new Error('Unsafe file path');
    }
    // Logic to remove the file from the filesystem goes here
    return new Promise((resolve, reject) => {
      unlink(localPath, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}

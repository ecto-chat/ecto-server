import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

/**
 * Abstract file storage interface.
 * - LocalFileStorage: writes to disk (self-hosted default)
 * - S3FileStorage: writes to S3-compatible object storage (managed mode, in ecto-gateway)
 */
export interface IFileStorage {
  /**
   * Save a file and return its public-facing URL.
   * @param key - storage key / relative path (e.g., "{serverId}/icons/icon-abc.png")
   * @param data - file contents
   * @param contentType - MIME type
   * @returns the URL that clients use to access the file
   */
  save(key: string, data: Buffer, contentType: string): Promise<string>;

  /**
   * Delete a file by its storage key.
   */
  delete(key: string): Promise<void>;
}

/**
 * Default implementation: writes files to local disk under UPLOAD_DIR.
 * Files are served by file-serve.ts via /files/ routes.
 */
export class LocalFileStorage implements IFileStorage {
  async save(key: string, data: Buffer, _contentType: string): Promise<string> {
    const filePath = path.join(config.UPLOAD_DIR, key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, data);
    return `/files/${key}`;
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(config.UPLOAD_DIR, key);
    await fs.promises.unlink(filePath).catch(() => {});
  }
}

// --- Singleton with setter pattern ---

let _fileStorage: IFileStorage = new LocalFileStorage();

export function setFileStorage(impl: IFileStorage): void {
  _fileStorage = impl;
}

export const fileStorage: IFileStorage = new Proxy({} as IFileStorage, {
  get(_target, prop) {
    return (_fileStorage as unknown as Record<string | symbol, unknown>)[prop];
  },
});

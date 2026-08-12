import type { Env } from "../types";

type ObjectStoragePutValue = ArrayBuffer | ArrayBufferView | ReadableStream | string;

export type ObjectStoragePutOptions = {
  contentType?: string;
};

export type ObjectStorageRange = {
  offset: number;
  length: number;
};

export type ObjectStorageMetadata = {
  size: number;
  etag: string;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
};

export type ObjectStorageObject = ObjectStorageMetadata & {
  body: ReadableStream;
};

export interface ObjectStorage {
  put(key: string, value: ObjectStoragePutValue, options?: ObjectStoragePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<ObjectStorageMetadata | null>;
  get(key: string, options?: { range?: ObjectStorageRange }): Promise<ObjectStorageObject | null>;
  deletePrefix(prefix: string): Promise<void>;
}

class R2ObjectStorage implements ObjectStorage {
  constructor(private readonly bucket: R2Bucket) {}

  async put(
    key: string,
    value: ObjectStoragePutValue,
    options?: ObjectStoragePutOptions
  ): Promise<void> {
    await this.bucket.put(
      key,
      value,
      options
        ? {
            ...(options.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
          }
        : undefined
    );
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async head(key: string): Promise<ObjectStorageMetadata | null> {
    return this.bucket.head(key);
  }

  async get(
    key: string,
    options?: { range?: ObjectStorageRange }
  ): Promise<ObjectStorageObject | null> {
    return this.bucket.get(key, options?.range ? { range: options.range } : undefined);
  }

  async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      if (page.objects.length > 0) {
        await this.bucket.delete(page.objects.map((object) => object.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

export function createMediaObjectStorage(env: Env): ObjectStorage {
  return new R2ObjectStorage(env.MEDIA_BUCKET);
}

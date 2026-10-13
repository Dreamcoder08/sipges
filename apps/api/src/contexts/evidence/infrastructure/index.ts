import type { StorageConfig } from '../../../platform/config.ts';
import type { ObjectStorage } from '../application/ports.ts';
import { createLocalObjectStorage } from './local-object-storage.ts';
import { createS3ObjectStorage } from './s3-object-storage.ts';

export { createSqlAttachmentStore } from './sql-attachment-store.ts';
export { createLocalObjectStorage, createS3ObjectStorage };

/** Picks the object storage adapter from configuration (docs/migration/evidence.md). */
export const createObjectStorage = (config: StorageConfig): ObjectStorage =>
  config.kind === 'local'
    ? createLocalObjectStorage(config.dir)
    : createS3ObjectStorage({
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      });

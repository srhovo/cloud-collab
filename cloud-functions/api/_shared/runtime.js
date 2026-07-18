import { WriteFoundationError } from './http.js';

export const DEFAULT_BLOB_STORE_NAME = 'cloud-collab-v1';

export async function resolveBlobStore(name = DEFAULT_BLOB_STORE_NAME) {
  try {
    const { getStore } = await import('@edgeone/pages-blob');
    return getStore({ name, consistency: 'strong' });
  } catch (error) {
    throw new WriteFoundationError('BLOB_STORAGE_UNAVAILABLE', 'Blob存储SDK或命名空间不可用', {
      status: 503,
      retryable: true,
      details: { name, reason: String(error?.message || error) },
    });
  }
}

export function createStoreResolver(getStoreImpl = null) {
  if (typeof getStoreImpl === 'function') {
    return async name => getStoreImpl({ name, consistency: 'strong' });
  }
  return resolveBlobStore;
}

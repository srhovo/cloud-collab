import { createHash } from 'node:crypto';
import { WriteFoundationError } from './http.js';

export const DEFAULT_STORE_NAME = 'cloud-collab-v1';

export function sha256Hex(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

function isAlreadyExists(error) {
  const status = Number(error?.status || error?.statusCode || error?.code);
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return status === 409 || status === 412 || /already|exist|conflict|precondition/.test(text);
}

export async function resolveBlobStore(name = DEFAULT_STORE_NAME) {
  try {
    const { getStore } = await import('@edgeone/pages-blob');
    return getStore(name);
  } catch (error) {
    throw new WriteFoundationError('BLOB_STORAGE_UNAVAILABLE', 'Blob存储SDK或命名空间不可用', {
      status: 503,
      retryable: true,
      details: { name, reason: String(error?.message || error) },
    });
  }
}

export function createBlobRepository(store) {
  if (!store || typeof store.get !== 'function' || typeof store.setJSON !== 'function') {
    throw new WriteFoundationError('BLOB_STORAGE_UNAVAILABLE', 'Blob存储接口不可用', { status: 503, retryable: true });
  }
  return Object.freeze({
    async getJson(key) {
      return store.get(key, { type: 'json', consistency: 'strong' });
    },
    async putJson(key, value) {
      await store.setJSON(key, value);
      return value;
    },
    async createJson(key, value) {
      try {
        await store.setJSON(key, value, { onlyIfNew: true });
        return { created: true, value };
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        return { created: false, value: await store.get(key, { type: 'json', consistency: 'strong' }) };
      }
    },
    async list(prefix) {
      const result = await store.list({ prefix, consistency: 'strong' });
      return Array.isArray(result?.blobs) ? result.blobs : [];
    },
  });
}

export function deviceProfileKey(deviceId) {
  return `devices/${sha256Hex(deviceId)}.json`;
}
export function idempotencyKeyPath(idempotencyKey) {
  return `idempotency/${sha256Hex(idempotencyKey)}.json`;
}
export function candidateKey(candidateId) {
  return `candidates/${candidateId}.json`;
}
export function rateMarkerKey(deviceId, window, bucket, idempotencyKey) {
  return `rate/${window}/${sha256Hex(deviceId)}/${bucket}/${sha256Hex(idempotencyKey)}.json`;
}
export function ratePrefix(deviceId, window, bucket) {
  return `rate/${window}/${sha256Hex(deviceId)}/${bucket}/`;
}

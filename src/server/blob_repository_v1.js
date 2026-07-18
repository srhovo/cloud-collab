export class BlobRepositoryError extends Error {
  constructor(code, message, details = null, cause = null) {
    super(message || code || 'Blob仓储操作失败');
    this.name = 'BlobRepositoryError';
    this.code = code || 'BLOB_REPOSITORY_ERROR';
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.setJSON !== 'function' || typeof store.delete !== 'function') {
    throw new BlobRepositoryError('INVALID_BLOB_STORE', 'Blob Store必须提供get、setJSON和delete');
  }
  return store;
}

function canonicalizeJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BlobRepositoryError('INVALID_BLOB_JSON', 'Blob JSON包含无效数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJSON).join(',')}]`;
  if (!value || typeof value !== 'object') {
    throw new BlobRepositoryError('INVALID_BLOB_JSON', 'Blob JSON包含不支持的值');
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalizeJSON(value[key])}`).join(',')}}`;
}

function sameJSON(left, right) {
  return canonicalizeJSON(left) === canonicalizeJSON(right);
}

export function normalizeBlobKey(key) {
  const value = String(key || '').trim();
  if (!value || value.length > 512 || value.startsWith('/') || value.endsWith('/') || value.includes('..') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BlobRepositoryError('INVALID_BLOB_KEY', 'Blob对象Key无效');
  }
  return value;
}

export async function getJSONStrong(store, key) {
  assertStore(store);
  const normalizedKey = normalizeBlobKey(key);
  try {
    return await store.get(normalizedKey, { type: 'json', consistency: 'strong' });
  } catch (error) {
    throw new BlobRepositoryError('BLOB_READ_FAILED', '强一致读取Blob失败', { key: normalizedKey }, error);
  }
}

export async function putJSONOnlyIfNew(store, key, value) {
  assertStore(store);
  const normalizedKey = normalizeBlobKey(key);
  try {
    const before = await store.get(normalizedKey, { type: 'json', consistency: 'strong' });
    if (before !== null && before !== undefined) {
      throw new BlobRepositoryError('BLOB_ALREADY_EXISTS', 'Blob对象已存在，条件写入未执行', { key: normalizedKey });
    }

    await store.setJSON(normalizedKey, value, { onlyIfNew: true });

    const after = await store.get(normalizedKey, { type: 'json', consistency: 'strong' });
    if (after === null || after === undefined) {
      throw new BlobRepositoryError('BLOB_WRITE_NOT_VISIBLE', 'Blob条件写入后无法强一致读回', { key: normalizedKey });
    }
    if (!sameJSON(after, value)) {
      throw new BlobRepositoryError('BLOB_ALREADY_EXISTS', 'Blob对象被并发请求占用，条件写入未执行', { key: normalizedKey });
    }

    return Object.freeze({ created: true, key: normalizedKey });
  } catch (error) {
    if (error instanceof BlobRepositoryError) throw error;
    throw new BlobRepositoryError('BLOB_ONLY_IF_NEW_FAILED', 'Blob不可变写入失败', { key: normalizedKey }, error);
  }
}

export async function deleteBlobQuietly(store, key) {
  assertStore(store);
  const normalizedKey = normalizeBlobKey(key);
  try {
    await store.delete(normalizedKey);
    return true;
  } catch (_) {
    return false;
  }
}

export function deviceProfileKey(deviceId) {
  return normalizeBlobKey(`devices/profiles/${deviceId}.json`);
}

export function deviceTokenIndexKey(tokenHash) {
  return normalizeBlobKey(`devices/token-index/${tokenHash}.json`);
}

export function pendingSubmissionKey(libraryId, idempotencyKey) {
  return normalizeBlobKey(`submissions/${libraryId}/pending/${idempotencyKey}.json`);
}

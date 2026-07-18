import { getStore } from '@edgeone/pages-blob';

const STORE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

export class EdgeOneBlobRuntimeError extends Error {
  constructor(code, message, status = 503, details = null, cause = null) {
    super(message || code || 'EdgeOne Blob运行时初始化失败');
    this.name = 'EdgeOneBlobRuntimeError';
    this.code = code || 'EDGEONE_BLOB_RUNTIME_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function normalizeBlobStoreName(value) {
  const name = String(value || '').trim();
  if (!STORE_NAME_PATTERN.test(name)) {
    throw new EdgeOneBlobRuntimeError(
      'BLOB_STORE_NOT_CONFIGURED',
      '预览写入Blob命名空间尚未正确配置',
      503,
    );
  }
  return name;
}

export function createEdgeOneBlobStore(env = {}) {
  const name = normalizeBlobStoreName(env.CLOUD_BLOB_STORE_NAME);
  try {
    return getStore({ name, consistency: 'strong' });
  } catch (error) {
    throw new EdgeOneBlobRuntimeError(
      'BLOB_STORE_INIT_FAILED',
      'EdgeOne Blob Store初始化失败',
      503,
      { name },
      error,
    );
  }
}

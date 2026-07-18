import { createHash, timingSafeEqual } from 'node:crypto';

export const PREVIEW_CLEANUP_SCHEMA_VERSION = 1;
export const PREVIEW_CLEANUP_NAMESPACE = 'cloud-collab-preview-v1';
export const PREVIEW_CLEANUP_CONFIRMATION = 'DELETE_SYNTHETIC_PREVIEW_V1';
export const PREVIEW_CLEANUP_MAX_OBJECTS = 500;

const FIXTURE_GROUP_ID = 'group_fixture';
const FIXTURE_LIBRARY_ID = 'lib_receive_fixture';
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLEANUP_PATTERNS = Object.freeze([
  /^devices\/profiles\/dev_[0-9A-HJKMNP-TV-Z]{26}\.json$/,
  /^devices\/token-index\/dth_v1_[A-Za-z0-9_-]{43}\.json$/,
  /^submissions\/lib_receive_fixture\/pending\/ik_v1_[A-Za-z0-9_-]{43}\.json$/,
  /^preview-rate\/(?:device-register|submission-create)\/[A-Za-z0-9_-]{43}\/[0-9]+\.json$/,
]);

export class PreviewCleanupError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '预览测试对象清理失败');
    this.name = 'PreviewCleanupError';
    this.code = code || 'PREVIEW_CLEANUP_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function secretByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function safeSecretEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function keyDigest(keys) {
  return createHash('sha256').update([...keys].sort().join('\n'), 'utf8').digest('base64url');
}

function assertStore(store) {
  if (!store || typeof store.list !== 'function' || typeof store.delete !== 'function') {
    throw new PreviewCleanupError('INVALID_CLEANUP_STORE', '清理工具需要Blob list和delete能力', 500);
  }
  return store;
}

export function isSyntheticPreviewKey(key) {
  const value = String(key || '');
  return value.length > 0 && value.length <= 512 && CLEANUP_PATTERNS.some(pattern => pattern.test(value));
}

export function readPreviewCleanupConfig(env = {}) {
  if (String(env.CLOUD_PREVIEW_CLEANUP_ENABLED || '').trim() !== '1') {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_DISABLED', '一次性预览清理工具未开启', 503);
  }
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '').trim() !== '0') {
    throw new PreviewCleanupError('PREVIEW_WRITE_MUST_REMAIN_DISABLED', '执行清理时预览写入总开关必须保持关闭', 503);
  }
  if (String(env.CLOUD_BLOB_STORE_NAME || '').trim() !== PREVIEW_CLEANUP_NAMESPACE) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_NAMESPACE_MISMATCH', '清理工具只能访问固定预览命名空间', 503);
  }
  if (String(env.CLOUD_WRITE_ALLOWED_GROUP_ID || '').trim() !== FIXTURE_GROUP_ID
      || String(env.CLOUD_WRITE_ALLOWED_LIBRARY_ID || '').trim() !== FIXTURE_LIBRARY_ID) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_SCOPE_MISMATCH', '清理作用域必须固定为合成测试库', 503);
  }
  if (String(env.CLOUD_PREVIEW_CLEANUP_CONFIRMATION || '').trim() !== PREVIEW_CLEANUP_CONFIRMATION) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_CONFIRMATION_MISSING', '清理确认门禁未正确配置', 503);
  }

  const cleanupAccessKey = String(env.CLOUD_PREVIEW_CLEANUP_KEY || '');
  if (secretByteLength(cleanupAccessKey) < 32 || secretByteLength(cleanupAccessKey) > 256) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_KEY_NOT_CONFIGURED', '一次性清理独立密钥尚未正确配置', 503);
  }

  const previewWriteKey = String(env.CLOUD_WRITE_PREVIEW_KEY || '');
  if (previewWriteKey && safeSecretEqual(cleanupAccessKey, previewWriteKey)) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_KEY_REUSED', '一次性清理密钥不得复用预览写入密钥', 503);
  }

  const rateLimitSalt = String(env.CLOUD_RATE_LIMIT_SALT || '');
  if (rateLimitSalt && safeSecretEqual(cleanupAccessKey, rateLimitSalt)) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_KEY_REUSED', '一次性清理密钥不得复用限流盐值', 503);
  }

  return Object.freeze({
    schemaVersion: PREVIEW_CLEANUP_SCHEMA_VERSION,
    namespace: PREVIEW_CLEANUP_NAMESPACE,
    cleanupAccessKey,
  });
}

export function assertPreviewCleanupAccess(request, config) {
  const supplied = String(request?.headers?.get?.('x-cloud-collab-cleanup-key') || '');
  if (!safeSecretEqual(config?.cleanupAccessKey, supplied)) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_ACCESS_DENIED', '预览清理访问凭据无效', 403);
  }
  return true;
}

async function listKeysStrong(store) {
  let result;
  try {
    result = await store.list({ consistency: 'strong' });
  } catch (error) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_LIST_FAILED', '无法列举预览命名空间对象', 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > PREVIEW_CLEANUP_MAX_OBJECTS) {
    throw new PreviewCleanupError(
      'PREVIEW_CLEANUP_OBJECT_LIMIT',
      '预览命名空间对象数量超过一次性清理上限',
      409,
      { objectCount: blobs.length, maxObjects: PREVIEW_CLEANUP_MAX_OBJECTS },
    );
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_INVALID_LIST', 'Blob列举结果包含空Key或重复Key', 503);
  }
  return keys;
}

function assertAllSynthetic(keys) {
  const unsafe = keys.filter(key => !isSyntheticPreviewKey(key));
  if (unsafe.length) {
    throw new PreviewCleanupError(
      'PREVIEW_CLEANUP_UNSAFE_OBJECTS',
      '命名空间包含不符合阶段4B.2合成对象规则的Key，已中止且未删除任何对象',
      409,
      { unsafeCount: unsafe.length, unsafeKeySetDigest: keyDigest(unsafe) },
    );
  }
}

export async function inspectSyntheticPreviewObjects({ store } = {}) {
  assertStore(store);
  const keys = await listKeysStrong(store);
  assertAllSynthetic(keys);
  return Object.freeze({
    schemaVersion: PREVIEW_CLEANUP_SCHEMA_VERSION,
    namespace: PREVIEW_CLEANUP_NAMESPACE,
    objectCount: keys.length,
    keySetDigest: keyDigest(keys),
    readyToExecute: true,
    publicMutationAllowed: false,
  });
}

export async function cleanupSyntheticPreviewObjects({ store, expectedKeySetDigest } = {}) {
  assertStore(store);
  const expectedDigest = String(expectedKeySetDigest || '').trim();
  if (!DIGEST_PATTERN.test(expectedDigest)) {
    throw new PreviewCleanupError('PREVIEW_CLEANUP_DIGEST_REQUIRED', '执行清理前必须提供检查阶段返回的对象集合摘要', 400);
  }

  const before = await listKeysStrong(store);
  assertAllSynthetic(before);
  const beforeDigest = keyDigest(before);
  if (beforeDigest !== expectedDigest) {
    throw new PreviewCleanupError(
      'PREVIEW_CLEANUP_KEYSET_CHANGED',
      '预览命名空间对象集合已变化，必须重新检查后再执行',
      409,
      { objectCount: before.length, keySetDigest: beforeDigest },
    );
  }

  for (const key of before) {
    try {
      await store.delete(key);
    } catch (error) {
      throw new PreviewCleanupError(
        'PREVIEW_CLEANUP_DELETE_FAILED',
        '删除合成预览对象失败，必须保留工具并重新核验',
        503,
        { attemptedCount: before.length, keySetDigest: beforeDigest },
        error,
      );
    }
  }

  const remaining = await listKeysStrong(store);
  if (remaining.length) {
    throw new PreviewCleanupError(
      'PREVIEW_CLEANUP_INCOMPLETE',
      '预览命名空间仍有对象，清理未完成',
      503,
      { remainingCount: remaining.length, remainingKeySetDigest: keyDigest(remaining) },
    );
  }

  return Object.freeze({
    schemaVersion: PREVIEW_CLEANUP_SCHEMA_VERSION,
    namespace: PREVIEW_CLEANUP_NAMESPACE,
    beforeCount: before.length,
    deletedCount: before.length,
    remainingCount: 0,
    keySetDigest: beforeDigest,
    completed: true,
    publicMutationAllowed: false,
  });
}

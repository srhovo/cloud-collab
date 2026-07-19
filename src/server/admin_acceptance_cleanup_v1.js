import { createHash, timingSafeEqual } from 'node:crypto';
import { getJSONStrong } from './blob_repository_v1.js';
import {
  ADMIN_PREVIEW_STORE_NAME,
  assertAdminSameOriginRequest,
  readAdminPublicOrigin,
} from './admin_auth_v1.js';

export const ADMIN_ACCEPTANCE_CLEANUP_PREFIX = 'admin-preview-rate/login/';
export const ADMIN_ACCEPTANCE_CLEANUP_CONFIRM = 'DELETE_STAGE5A_ADMIN_ACCEPTANCE_OBJECTS';
export const ADMIN_ACCEPTANCE_MAX_OBJECTS = 500;

const RATE_OBJECT_PATTERN = /^admin-preview-rate\/login\/[A-Za-z0-9_-]{43}\/[0-9]+\.json$/;

export class AdminAcceptanceCleanupError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '阶段5A验收清理失败');
    this.name = 'AdminAcceptanceCleanupError';
    this.code = code || 'ADMIN_ACCEPTANCE_CLEANUP_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function fixedDigest(value) {
  return createHash('sha256').update(Buffer.from(String(value || ''), 'utf8')).digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(fixedDigest(left), fixedDigest(right));
}

export function readAdminAcceptanceCleanupConfig(env = {}) {
  if (String(env.CLOUD_ADMIN_ACCEPTANCE_CLEANUP_ENABLED || '').trim() !== '1') {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_CLEANUP_DISABLED',
      '阶段5A验收清理未开启',
      503,
    );
  }
  if (String(env.CLOUD_ADMIN_PREVIEW_ENABLED || '').trim() !== '0') {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_REQUIRES_ADMIN_PREVIEW_DISABLED',
      '阶段5A验收清理前必须关闭管理员登录预览',
      503,
    );
  }
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '0').trim() === '1'
      || String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '0').trim() === '1') {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_REQUIRES_PUBLIC_PREVIEW_DISABLED',
      '阶段5A验收清理不能与公共预览写入同时开启',
      503,
    );
  }

  const cleanupKey = String(env.CLOUD_ADMIN_ACCEPTANCE_CLEANUP_KEY || '');
  if (byteLength(cleanupKey) < 32 || byteLength(cleanupKey) > 256) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_CLEANUP_KEY_NOT_CONFIGURED',
      '阶段5A验收清理密钥必须为32至256字节',
      503,
    );
  }

  const storeName = String(env.CLOUD_ADMIN_BLOB_STORE_NAME || '').trim();
  if (storeName !== ADMIN_PREVIEW_STORE_NAME) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_STORE_MISCONFIGURED',
      '阶段5A验收清理必须硬锁管理员预览Blob命名空间',
      503,
    );
  }

  const configuredSecrets = [
    cleanupKey,
    env.CLOUD_ADMIN_PASSWORD,
    env.CLOUD_ADMIN_SESSION_SECRET,
    env.CLOUD_ADMIN_RATE_LIMIT_SALT,
  ].map(value => String(value || '')).filter(Boolean);
  if (new Set(configuredSecrets).size !== configuredSecrets.length) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_SECRETS_MUST_BE_DISTINCT',
      '验收清理密钥不得复用管理员密码、会话密钥或限流盐值',
      503,
    );
  }

  return Object.freeze({ cleanupKey, storeName, publicOrigin: readAdminPublicOrigin(env) });
}

export function assertAdminAcceptanceCleanupAccess(request, config, { requireOrigin = false } = {}) {
  assertAdminSameOriginRequest(request, { requireOrigin, publicOrigin: config?.publicOrigin });
  const supplied = String(request?.headers?.get?.('x-cloud-admin-acceptance-key') || '');
  if (byteLength(supplied) < 32 || byteLength(supplied) > 256
      || !safeEqual(config?.cleanupKey, supplied)) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_CLEANUP_ACCESS_DENIED',
      '阶段5A验收清理访问被拒绝',
      403,
    );
  }
  return true;
}

async function listNamespaceKeysStrong(store) {
  if (!store || typeof store.list !== 'function' || typeof store.delete !== 'function') {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_BLOB_CAPABILITY_MISSING',
      '阶段5A验收清理需要Blob list与delete能力',
      503,
    );
  }
  let result;
  try {
    result = await store.list({ consistency: 'strong' });
  } catch (error) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_BLOB_LIST_FAILED',
      '阶段5A验收清理无法强一致列举Blob',
      503,
      null,
      error,
    );
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > ADMIN_ACCEPTANCE_MAX_OBJECTS) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_OBJECT_LIMIT_EXCEEDED',
      '管理员验收Blob对象超过安全清理上限',
      409,
      { objectCount: blobs.length, maxObjects: ADMIN_ACCEPTANCE_MAX_OBJECTS },
    );
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_INVALID_BLOB_LIST',
      '管理员验收Blob列举结果无效',
      503,
    );
  }
  const unexpectedCount = keys.filter(key => !RATE_OBJECT_PATTERN.test(key)).length;
  if (unexpectedCount > 0) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_UNEXPECTED_OBJECTS',
      '管理员验收命名空间包含非限流对象，已拒绝清理',
      409,
      { unexpectedCount },
    );
  }
  return keys.sort();
}

async function existingKeysStrong(store, keys) {
  const existing = [];
  for (const key of keys) {
    if (await getJSONStrong(store, key) !== null) existing.push(key);
  }
  return existing;
}

export async function inspectAdminAcceptanceObjects({ store } = {}) {
  const keys = await listNamespaceKeysStrong(store);
  const existing = await existingKeysStrong(store, keys);
  return Object.freeze({
    objectCount: existing.length,
    namespaceClean: existing.length === 0,
    cleanupPrefix: ADMIN_ACCEPTANCE_CLEANUP_PREFIX,
  });
}

export async function cleanupAdminAcceptanceObjects({ store } = {}) {
  const keys = await listNamespaceKeysStrong(store);
  const existingBefore = await existingKeysStrong(store, keys);
  for (const key of existingBefore) {
    try {
      await store.delete(key);
    } catch (error) {
      throw new AdminAcceptanceCleanupError(
        'ADMIN_ACCEPTANCE_BLOB_DELETE_FAILED',
        '管理员验收Blob对象删除失败',
        503,
        null,
        error,
      );
    }
  }

  const afterKeys = await listNamespaceKeysStrong(store);
  const existingAfter = await existingKeysStrong(store, afterKeys);
  if (existingAfter.length !== 0) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_CLEANUP_INCOMPLETE',
      '管理员验收Blob强一致复查仍有剩余对象',
      409,
      { remainingObjectCount: existingAfter.length },
    );
  }

  return Object.freeze({
    deletedObjectCount: existingBefore.length,
    remainingObjectCount: 0,
    namespaceClean: true,
    cleanupPrefix: ADMIN_ACCEPTANCE_CLEANUP_PREFIX,
  });
}

export function assertAdminAcceptanceCleanupConfirmation(value) {
  const expected = ['confirm', 'schemaVersion'];
  const actual = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)
      || value.schemaVersion !== 1
      || value.confirm !== ADMIN_ACCEPTANCE_CLEANUP_CONFIRM) {
    throw new AdminAcceptanceCleanupError(
      'ADMIN_ACCEPTANCE_CONFIRMATION_INVALID',
      '阶段5A验收清理确认词无效',
      400,
    );
  }
  return true;
}

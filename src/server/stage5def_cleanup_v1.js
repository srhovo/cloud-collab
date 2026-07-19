import { createHash, timingSafeEqual } from 'node:crypto';
import {
  assertAdminSameOriginRequest,
  readAdminPublicOrigin,
} from './admin_auth_v1.js';

export const STAGE5DEF_CLEANUP_SCHEMA_VERSION = 1;
export const STAGE5DEF_PUBLIC_STORE = 'cloud-collab-preview-v1';
export const STAGE5DEF_ADMIN_STORE = 'cloud-collab-admin-preview-v1';
export const STAGE5DEF_GROUP_ID = 'group_fixture';
export const STAGE5DEF_LIBRARY_ID = 'lib_receive_fixture';
export const STAGE5DEF_CLEANUP_CONFIRMATION = 'DELETE_STAGE5DEF_SYNTHETIC_PREVIEW_V1';
export const STAGE5DEF_CLEANUP_HEADER = 'x-cloud-stage5def-cleanup-key';
export const STAGE5DEF_PUBLIC_MAX_OBJECTS = 2_000;
export const STAGE5DEF_ADMIN_MAX_OBJECTS = 500;

const HASH_43 = '[A-Za-z0-9_-]{43}';
const DEVICE_ID = 'dev_[0-9A-HJKMNP-TV-Z]{26}';
const VERSION = '[0-9]{12}';
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_PATTERNS = Object.freeze([
  /^stage5def\/seed\/v1\.json$/,
  new RegExp(`^devices/profiles/${DEVICE_ID}\\.json$`),
  new RegExp(`^devices/token-index/dth_v1_${HASH_43}\\.json$`),
  new RegExp(`^devices/governance/heads/${DEVICE_ID}\\.json$`),
  new RegExp(`^devices/governance/events/${DEVICE_ID}/${VERSION}-dge_v1_${HASH_43}\\.json$`),
  new RegExp(`^devices/governance/transitions/${DEVICE_ID}/${VERSION}\\.json$`),
  new RegExp(`^devices/governance/requests/dgrh_v1_${HASH_43}\\.json$`),
  new RegExp(`^public/${STAGE5DEF_LIBRARY_ID}/events/${VERSION}\\.json$`),
  new RegExp(`^public/${STAGE5DEF_LIBRARY_ID}/snapshots/${VERSION}\\.json$`),
  new RegExp(`^public/${STAGE5DEF_LIBRARY_ID}/approvals/ap_v1_${HASH_43}\\.json$`),
  new RegExp(`^public/${STAGE5DEF_LIBRARY_ID}/transitions/bk_v1_${HASH_43}/${VERSION}\\.json$`),
  new RegExp(`^rollbacks/${STAGE5DEF_LIBRARY_ID}/requests/rbtok_v1_${HASH_43}\\.json$`),
  new RegExp(`^rollbacks/${STAGE5DEF_LIBRARY_ID}/decisions/rb_v1_${HASH_43}\\.json$`),
  new RegExp(`^rollbacks/${STAGE5DEF_LIBRARY_ID}/completions/rb_v1_${HASH_43}\\.json$`),
  new RegExp(`^exports/${STAGE5DEF_LIBRARY_ID}/requests/extok_v1_${HASH_43}\\.json$`),
  new RegExp(`^exports/${STAGE5DEF_LIBRARY_ID}/decisions/ex_v1_${HASH_43}\\.json$`),
  new RegExp(`^audit/[0-9]{4}/(?:0[1-9]|1[0-2])/(?:dge_v1|rbau_v1|exau_v1)_${HASH_43}\\.json$`),
]);
const ADMIN_PATTERNS = Object.freeze([
  new RegExp(`^admin-preview-rate/login/${HASH_43}/[0-9]+\\.json$`),
]);

export class Stage5defCleanupError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '阶段5D/5E/5F联合验收清理失败');
    this.name = 'Stage5defCleanupError';
    this.code = code || 'STAGE5DEF_CLEANUP_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function fixedDigest(value) {
  return createHash('sha256').update(Buffer.from(String(value || ''), 'utf8')).digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(fixedDigest(left), fixedDigest(right));
}

function secretBytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function keySetDigest(keys) {
  return createHash('sha256').update([...keys].sort().join('\n'), 'utf8').digest('base64url');
}

function assertExactZero(env, names) {
  const enabled = names.filter(name => String(env[name] || '0').trim() !== '0');
  if (enabled.length) {
    throw new Stage5defCleanupError(
      'STAGE5DEF_CLEANUP_REQUIRES_ALL_CAPABILITIES_CLOSED',
      '清理前必须关闭联合验收、公共写入和全部管理员能力',
      503,
      { enabledCount: enabled.length },
    );
  }
}

export function readStage5defCleanupConfig(env = {}) {
  if (String(env.CLOUD_STAGE5DEF_CLEANUP_ENABLED || '').trim() !== '1') {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_DISABLED', '阶段5D/5E/5F联合验收清理未开启', 503);
  }
  assertExactZero(env, [
    'CLOUD_STAGE5DEF_ACCEPTANCE_ENABLED',
    'CLOUD_WRITE_PREVIEW_ENABLED',
    'CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED',
    'CLOUD_ADMIN_PREVIEW_ENABLED',
    'CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED',
    'CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED',
    'CLOUD_ADMIN_DEVICE_GOVERNANCE_PREVIEW_ENABLED',
    'CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED',
    'CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED',
  ]);
  if (String(env.CLOUD_STAGE5DEF_CLEANUP_CONFIRMATION || '').trim() !== STAGE5DEF_CLEANUP_CONFIRMATION) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_CONFIRMATION_MISSING', '联合验收清理确认门禁无效', 503);
  }
  if (String(env.CLOUD_BLOB_STORE_NAME || '').trim() !== STAGE5DEF_PUBLIC_STORE
      || String(env.CLOUD_ADMIN_BLOB_STORE_NAME || '').trim() !== STAGE5DEF_ADMIN_STORE
      || String(env.CLOUD_ADMIN_DEVICE_GOVERNANCE_BLOB_STORE_NAME || '').trim() !== STAGE5DEF_PUBLIC_STORE
      || String(env.CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME || '').trim() !== STAGE5DEF_PUBLIC_STORE
      || String(env.CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME || '').trim() !== STAGE5DEF_PUBLIC_STORE
      || String(env.CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID || '').trim() !== STAGE5DEF_GROUP_ID
      || String(env.CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID || '').trim() !== STAGE5DEF_LIBRARY_ID
      || String(env.CLOUD_ADMIN_EXPORT_ALLOWED_GROUP_ID || '').trim() !== STAGE5DEF_GROUP_ID
      || String(env.CLOUD_ADMIN_EXPORT_ALLOWED_LIBRARY_ID || '').trim() !== STAGE5DEF_LIBRARY_ID) {
    throw new Stage5defCleanupError(
      'STAGE5DEF_CLEANUP_SCOPE_INVALID',
      '清理器只能访问阶段5D/5E/5F固定合成作用域与两套预览Blob',
      503,
    );
  }

  const cleanupKey = String(env.CLOUD_STAGE5DEF_CLEANUP_KEY || '');
  if (secretBytes(cleanupKey) < 32 || secretBytes(cleanupKey) > 256) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_KEY_INVALID', '联合验收清理密钥必须为32至256字节', 503);
  }
  const otherSecrets = [
    env.CLOUD_STAGE5DEF_ACCEPTANCE_KEY,
    env.CLOUD_ADMIN_PASSWORD,
    env.CLOUD_ADMIN_SESSION_SECRET,
    env.CLOUD_ADMIN_RATE_LIMIT_SALT,
    env.CLOUD_ADMIN_DEVICE_REF_SALT,
    env.CLOUD_ADMIN_ROLLBACK_REF_SALT,
    env.CLOUD_ADMIN_EXPORT_AUDIT_SALT,
    env.CLOUD_WRITE_PREVIEW_KEY,
    env.CLOUD_RATE_LIMIT_SALT,
  ].map(value => String(value || '')).filter(Boolean);
  if (otherSecrets.some(value => safeEqual(cleanupKey, value))) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_KEY_REUSED', '清理密钥不得复用任何验收、管理员或公共预览凭据', 503);
  }

  return Object.freeze({
    schemaVersion: STAGE5DEF_CLEANUP_SCHEMA_VERSION,
    cleanupKey,
    publicOrigin: readAdminPublicOrigin(env),
    publicStoreName: STAGE5DEF_PUBLIC_STORE,
    adminStoreName: STAGE5DEF_ADMIN_STORE,
  });
}

export function assertStage5defCleanupAccess(request, config) {
  assertAdminSameOriginRequest(request, {
    requireOrigin: true,
    publicOrigin: config?.publicOrigin,
  });
  const supplied = String(request?.headers?.get?.(STAGE5DEF_CLEANUP_HEADER) || '');
  if (secretBytes(supplied) < 32 || secretBytes(supplied) > 256 || !safeEqual(config?.cleanupKey, supplied)) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_ACCESS_DENIED', '联合验收清理访问被拒绝', 403);
  }
  return true;
}

function assertStore(store, label) {
  if (!store || typeof store.list !== 'function' || typeof store.delete !== 'function') {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_STORE_INVALID', `${label}Blob缺少list或delete能力`, 503);
  }
}

async function listKeysStrong(store, label, maxObjects) {
  assertStore(store, label);
  let result;
  try {
    result = await store.list({ consistency: 'strong' });
  } catch (error) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_LIST_FAILED', `${label}Blob强一致列举失败`, 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > maxObjects) {
    throw new Stage5defCleanupError(
      'STAGE5DEF_CLEANUP_OBJECT_LIMIT',
      `${label}Blob对象超过安全清理上限`,
      409,
      { objectCount: blobs.length, maxObjects },
    );
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_INVALID_LIST', `${label}Blob列举结果无效`, 503);
  }
  return keys.sort();
}

function assertSafeKeys(keys, patterns, label) {
  const unsafe = keys.filter(key => key.length > 512 || !patterns.some(pattern => pattern.test(key)));
  if (unsafe.length) {
    throw new Stage5defCleanupError(
      'STAGE5DEF_CLEANUP_UNSAFE_OBJECTS',
      `${label}Blob包含不属于本轮联合验收的对象，已在删除前中止`,
      409,
      { unsafeCount: unsafe.length, unsafeKeySetDigest: keySetDigest(unsafe) },
    );
  }
}

async function inspectBoth(publicStore, adminStore) {
  const [publicKeys, adminKeys] = await Promise.all([
    listKeysStrong(publicStore, '公共合成', STAGE5DEF_PUBLIC_MAX_OBJECTS),
    listKeysStrong(adminStore, '管理员合成', STAGE5DEF_ADMIN_MAX_OBJECTS),
  ]);
  assertSafeKeys(publicKeys, PUBLIC_PATTERNS, '公共合成');
  assertSafeKeys(adminKeys, ADMIN_PATTERNS, '管理员合成');
  return { publicKeys, adminKeys };
}

export async function inspectStage5defObjects({ publicStore, adminStore } = {}) {
  const { publicKeys, adminKeys } = await inspectBoth(publicStore, adminStore);
  return Object.freeze({
    schemaVersion: STAGE5DEF_CLEANUP_SCHEMA_VERSION,
    publicObjectCount: publicKeys.length,
    publicKeySetDigest: keySetDigest(publicKeys),
    adminObjectCount: adminKeys.length,
    adminKeySetDigest: keySetDigest(adminKeys),
    totalObjectCount: publicKeys.length + adminKeys.length,
    readyToExecute: true,
  });
}

function normalizeExpectedDigest(value, label) {
  const digest = String(value || '').trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_DIGEST_REQUIRED', `必须提供检查阶段返回的${label}对象摘要`, 400);
  }
  return digest;
}

async function deleteKeys(store, keys, label) {
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch (error) {
      throw new Stage5defCleanupError(
        'STAGE5DEF_CLEANUP_DELETE_FAILED',
        `${label}Blob删除失败；必须重新检查后继续`,
        503,
        { attemptedCount: keys.length },
        error,
      );
    }
  }
}

export async function cleanupStage5defObjects({
  publicStore,
  adminStore,
  expectedPublicKeySetDigest,
  expectedAdminKeySetDigest,
} = {}) {
  const expectedPublic = normalizeExpectedDigest(expectedPublicKeySetDigest, '公共合成');
  const expectedAdmin = normalizeExpectedDigest(expectedAdminKeySetDigest, '管理员合成');
  const before = await inspectBoth(publicStore, adminStore);
  const publicDigest = keySetDigest(before.publicKeys);
  const adminDigest = keySetDigest(before.adminKeys);
  if (publicDigest !== expectedPublic || adminDigest !== expectedAdmin) {
    throw new Stage5defCleanupError(
      'STAGE5DEF_CLEANUP_KEYSET_CHANGED',
      '任一合成Blob对象集合已变化，必须重新检查后再执行',
      409,
      {
        publicObjectCount: before.publicKeys.length,
        publicKeySetDigest: publicDigest,
        adminObjectCount: before.adminKeys.length,
        adminKeySetDigest: adminDigest,
      },
    );
  }

  await deleteKeys(publicStore, before.publicKeys, '公共合成');
  await deleteKeys(adminStore, before.adminKeys, '管理员合成');

  const after = await inspectBoth(publicStore, adminStore);
  if (after.publicKeys.length || after.adminKeys.length) {
    throw new Stage5defCleanupError(
      'STAGE5DEF_CLEANUP_INCOMPLETE',
      '联合验收Blob强一致复查仍有剩余对象',
      409,
      {
        publicRemainingCount: after.publicKeys.length,
        adminRemainingCount: after.adminKeys.length,
      },
    );
  }

  return Object.freeze({
    schemaVersion: STAGE5DEF_CLEANUP_SCHEMA_VERSION,
    publicDeletedCount: before.publicKeys.length,
    adminDeletedCount: before.adminKeys.length,
    totalDeletedCount: before.publicKeys.length + before.adminKeys.length,
    publicRemainingCount: 0,
    adminRemainingCount: 0,
    publicKeySetDigest: keySetDigest([]),
    adminKeySetDigest: keySetDigest([]),
    cleanupComplete: true,
  });
}

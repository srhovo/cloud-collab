import { createHash, timingSafeEqual } from 'node:crypto';
import { assertAdminSameOriginRequest, readAdminPublicOrigin } from './admin_auth_v1.js';

export const STAGE5G6A6B_CLEANUP_SCHEMA_VERSION = 1;
export const STAGE5G6A6B_PUBLIC_STORE = 'cloud-collab-preview-v1';
export const STAGE5G6A6B_ADMIN_STORE = 'cloud-collab-admin-preview-v1';
export const STAGE5G6A6B_LIBRARY_ID = 'lib_receive_fixture';
export const STAGE5G6A6B_CLEANUP_CONFIRMATION = 'DELETE_STAGE5G6A6B_SYNTHETIC_PREVIEW_V1';
export const STAGE5G6A6B_CLEANUP_HEADER = 'x-cloud-stage5g6a6b-cleanup-key';
export const STAGE5G6A6B_PUBLIC_MAX_OBJECTS = 20_000;
export const STAGE5G6A6B_ADMIN_MAX_OBJECTS = 1_000;

const HASH_43 = '[A-Za-z0-9_-]{43}';
const DEVICE_ID = 'dev_[0-9A-HJKMNP-TV-Z]{26}';
const VERSION = '[0-9]{12}';
const SAFE_PUBLIC_PATTERNS = Object.freeze([
  /^stage5g6a6b\/seed\/v1\.json$/,
  new RegExp(`^devices/profiles/${DEVICE_ID}\\.json$`),
  new RegExp(`^devices/token-index/dth_v1_${HASH_43}\\.json$`),
  new RegExp(`^preview-rate/[a-z][a-z0-9_-]{2,31}/${HASH_43}/[0-9]+\\.json$`),
  new RegExp(`^submissions/${STAGE5G6A6B_LIBRARY_ID}/pending/ik_v1_${HASH_43}\\.json$`),
  new RegExp(`^submissions/${STAGE5G6A6B_LIBRARY_ID}/matches/bk_v1_${HASH_43}/pv_${VERSION}/ch_v1_${HASH_43}/${DEVICE_ID}\\.json$`),
  new RegExp(`^reviews/${STAGE5G6A6B_LIBRARY_ID}/pending/bk_v1_${HASH_43}/pv_${VERSION}/ch_v1_${HASH_43}\\.json$`),
  new RegExp(`^reviews/${STAGE5G6A6B_LIBRARY_ID}/resolved/rv_v1_${HASH_43}\\.json$`),
  new RegExp(`^reviews/${STAGE5G6A6B_LIBRARY_ID}/ordinary-decisions/rv_v1_${HASH_43}\\.json$`),
  new RegExp(`^reviews/${STAGE5G6A6B_LIBRARY_ID}/ordinary-completions/rv_v1_${HASH_43}\\.json$`),
  new RegExp(`^reviews/${STAGE5G6A6B_LIBRARY_ID}/ordinary-approval-cycles/bk_v1_${HASH_43}/pv_${VERSION}\\.json$`),
  new RegExp(`^reviews/${STAGE5G6A6B_LIBRARY_ID}/sensitive-resolutions/srv_v1_${HASH_43}\\.json$`),
  new RegExp(`^reviews/${STAGE5G6A6B_LIBRARY_ID}/sensitive-decisions/srv_v1_${HASH_43}\\.json$`),
  new RegExp(`^reviews/${STAGE5G6A6B_LIBRARY_ID}/sensitive-completions/srv_v1_${HASH_43}\\.json$`),
  new RegExp(`^public/${STAGE5G6A6B_LIBRARY_ID}/events/${VERSION}\\.json$`),
  new RegExp(`^public/${STAGE5G6A6B_LIBRARY_ID}/snapshots/${VERSION}\\.json$`),
  new RegExp(`^public/${STAGE5G6A6B_LIBRARY_ID}/approvals/ap_v1_${HASH_43}\\.json$`),
  new RegExp(`^public/${STAGE5G6A6B_LIBRARY_ID}/transitions/bk_v1_${HASH_43}/${VERSION}\\.json$`),
  new RegExp(`^public/${STAGE5G6A6B_LIBRARY_ID}/sensitive-events/${VERSION}\\.json$`),
  new RegExp(`^public/${STAGE5G6A6B_LIBRARY_ID}/sensitive-approvals/sap_v1_${HASH_43}\\.json$`),
  new RegExp(`^public/${STAGE5G6A6B_LIBRARY_ID}/sensitive-snapshots/${VERSION}\\.json$`),
  new RegExp(`^audit/[0-9]{4}/(?:0[1-9]|1[0-2])/(?:au_v1|sau_v1)_${HASH_43}\\.json$`),
]);
const SAFE_ADMIN_PATTERNS = Object.freeze([
  new RegExp(`^admin-preview-rate/login/${HASH_43}/[0-9]+\\.json$`),
]);
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class Stage5g6a6bCleanupError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '阶段5G/6A/6B联合验收清理失败');
    this.name = 'Stage5g6a6bCleanupError';
    this.code = code || 'STAGE5G6A6B_CLEANUP_ERROR';
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
    throw new Stage5g6a6bCleanupError(
      'STAGE5G6A6B_CLEANUP_REQUIRES_ALL_CAPABILITIES_CLOSED',
      '清理前必须关闭联合验收、普通写入、敏感协议和全部管理员能力',
      503,
      { enabledCount: enabled.length },
    );
  }
}

export function readStage5g6a6bCleanupConfig(env = {}) {
  if (String(env.CLOUD_STAGE5G6A6B_CLEANUP_ENABLED || '').trim() !== '1') {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_DISABLED', '联合验收清理未开启', 503);
  }
  assertExactZero(env, [
    'CLOUD_STAGE5G6A6B_ACCEPTANCE_ENABLED',
    'CLOUD_WRITE_PREVIEW_ENABLED',
    'CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED',
    'CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED',
    'CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED',
    'CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED',
    'CLOUD_ADMIN_PREVIEW_ENABLED',
    'CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED',
    'CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED',
  ]);
  if (String(env.CLOUD_STAGE5G6A6B_CLEANUP_CONFIRMATION || '').trim() !== STAGE5G6A6B_CLEANUP_CONFIRMATION) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_CONFIRMATION_MISSING', '联合验收清理确认门禁无效', 503);
  }
  if (String(env.CLOUD_BLOB_STORE_NAME || '').trim() !== STAGE5G6A6B_PUBLIC_STORE
      || String(env.CLOUD_ADMIN_BLOB_STORE_NAME || '').trim() !== STAGE5G6A6B_ADMIN_STORE) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_SCOPE_INVALID', '清理器只能访问固定两套合成Blob', 503);
  }
  const cleanupKey = String(env.CLOUD_STAGE5G6A6B_CLEANUP_KEY || '');
  if (secretBytes(cleanupKey) < 32 || secretBytes(cleanupKey) > 256) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_KEY_INVALID', '联合验收清理密钥必须为32至256字节', 503);
  }
  const otherSecrets = [
    env.CLOUD_STAGE5G6A6B_ACCEPTANCE_KEY,
    env.CLOUD_WRITE_PREVIEW_KEY,
    env.CLOUD_RATE_LIMIT_SALT,
    env.CLOUD_ADMIN_PASSWORD,
    env.CLOUD_ADMIN_SESSION_SECRET,
    env.CLOUD_ADMIN_RATE_LIMIT_SALT,
  ].map(value => String(value || '')).filter(Boolean);
  if (otherSecrets.some(value => safeEqual(cleanupKey, value))) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_KEY_REUSED', '清理密钥不得复用验收或管理员凭据', 503);
  }
  return Object.freeze({
    schemaVersion: STAGE5G6A6B_CLEANUP_SCHEMA_VERSION,
    cleanupKey,
    publicOrigin: readAdminPublicOrigin(env),
    publicStoreName: STAGE5G6A6B_PUBLIC_STORE,
    adminStoreName: STAGE5G6A6B_ADMIN_STORE,
  });
}

export function assertStage5g6a6bCleanupAccess(request, config) {
  assertAdminSameOriginRequest(request, { requireOrigin: true, publicOrigin: config?.publicOrigin });
  const supplied = String(request?.headers?.get?.(STAGE5G6A6B_CLEANUP_HEADER) || '');
  if (secretBytes(supplied) < 32 || secretBytes(supplied) > 256 || !safeEqual(config?.cleanupKey, supplied)) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_ACCESS_DENIED', '联合验收清理访问被拒绝', 403);
  }
  return true;
}

function assertStore(store, label) {
  if (!store || typeof store.list !== 'function' || typeof store.delete !== 'function') {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_STORE_INVALID', `${label}Blob缺少list或delete能力`, 503);
  }
}

async function listKeysStrong(store, label, maxObjects) {
  assertStore(store, label);
  let result;
  try { result = await store.list({ consistency: 'strong' }); }
  catch (error) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_LIST_FAILED', `${label}Blob强一致列举失败`, 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > maxObjects) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_OBJECT_LIMIT', `${label}Blob对象超过安全清理上限`, 409, {
      objectCount: blobs.length,
      maxObjects,
    });
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_INVALID_LIST', `${label}Blob列举结果无效`, 503);
  }
  return keys.sort();
}

function assertSafeKeys(keys, patterns, label) {
  const unsafe = keys.filter(key => key.length > 512 || !patterns.some(pattern => pattern.test(key)));
  if (unsafe.length) {
    throw new Stage5g6a6bCleanupError(
      'STAGE5G6A6B_CLEANUP_UNSAFE_OBJECTS',
      `${label}Blob包含不属于本轮联合验收的对象，已在删除前中止`,
      409,
      { unsafeCount: unsafe.length, unsafeKeySetDigest: keySetDigest(unsafe) },
    );
  }
}

async function inspectBoth(publicStore, adminStore) {
  const [publicKeys, adminKeys] = await Promise.all([
    listKeysStrong(publicStore, '公共合成', STAGE5G6A6B_PUBLIC_MAX_OBJECTS),
    listKeysStrong(adminStore, '管理员合成', STAGE5G6A6B_ADMIN_MAX_OBJECTS),
  ]);
  assertSafeKeys(publicKeys, SAFE_PUBLIC_PATTERNS, '公共合成');
  assertSafeKeys(adminKeys, SAFE_ADMIN_PATTERNS, '管理员合成');
  return { publicKeys, adminKeys };
}

export async function inspectStage5g6a6bObjects({ publicStore, adminStore } = {}) {
  const { publicKeys, adminKeys } = await inspectBoth(publicStore, adminStore);
  return Object.freeze({
    schemaVersion: STAGE5G6A6B_CLEANUP_SCHEMA_VERSION,
    publicObjectCount: publicKeys.length,
    publicKeySetDigest: keySetDigest(publicKeys),
    adminObjectCount: adminKeys.length,
    adminKeySetDigest: keySetDigest(adminKeys),
    totalObjectCount: publicKeys.length + adminKeys.length,
    readyToExecute: true,
  });
}

function normalizeDigest(value, label) {
  const digest = String(value || '').trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_DIGEST_REQUIRED', `必须提供检查阶段返回的${label}对象摘要`, 400);
  }
  return digest;
}

async function deleteKeys(store, keys, label) {
  for (const key of keys) {
    try { await store.delete(key); }
    catch (error) {
      throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_DELETE_FAILED', `${label}Blob删除失败；必须重新检查后继续`, 503, {
        attemptedCount: keys.length,
      }, error);
    }
  }
}

export async function cleanupStage5g6a6bObjects({
  publicStore,
  adminStore,
  expectedPublicKeySetDigest,
  expectedAdminKeySetDigest,
} = {}) {
  const expectedPublic = normalizeDigest(expectedPublicKeySetDigest, '公共合成');
  const expectedAdmin = normalizeDigest(expectedAdminKeySetDigest, '管理员合成');
  const before = await inspectBoth(publicStore, adminStore);
  const publicDigest = keySetDigest(before.publicKeys);
  const adminDigest = keySetDigest(before.adminKeys);
  if (publicDigest !== expectedPublic || adminDigest !== expectedAdmin) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_KEYSET_CHANGED', '任一合成Blob对象集合已变化，必须重新检查后再执行', 409, {
      publicObjectCount: before.publicKeys.length,
      publicKeySetDigest: publicDigest,
      adminObjectCount: before.adminKeys.length,
      adminKeySetDigest: adminDigest,
    });
  }
  await deleteKeys(publicStore, before.publicKeys, '公共合成');
  await deleteKeys(adminStore, before.adminKeys, '管理员合成');
  const after = await inspectBoth(publicStore, adminStore);
  if (after.publicKeys.length || after.adminKeys.length) {
    throw new Stage5g6a6bCleanupError('STAGE5G6A6B_CLEANUP_NOT_EMPTY', '删除后强一致复查仍存在对象', 503, {
      publicObjectCount: after.publicKeys.length,
      adminObjectCount: after.adminKeys.length,
    });
  }
  return Object.freeze({
    schemaVersion: STAGE5G6A6B_CLEANUP_SCHEMA_VERSION,
    deletedPublicObjectCount: before.publicKeys.length,
    deletedAdminObjectCount: before.adminKeys.length,
    publicObjectCount: 0,
    adminObjectCount: 0,
    totalObjectCount: 0,
    strongConsistencyVerified: true,
  });
}

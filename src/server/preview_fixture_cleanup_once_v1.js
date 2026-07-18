import { createHash, timingSafeEqual } from 'node:crypto';

export const PREVIEW_FIXTURE_STORE = 'cloud-collab-preview-v1';
export const PREVIEW_FIXTURE_GROUP_ID = 'group_fixture';
export const PREVIEW_FIXTURE_LIBRARY_ID = 'lib_receive_fixture';
export const CLEANUP_CONFIRMATION = 'DELETE_SYNTHETIC_PREVIEW_FIXTURES';
export const MAX_CLEANUP_OBJECTS = 5000;

const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_HASH_PATTERN = /^dth_v1_[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^ik_v1_[A-Za-z0-9_-]{43}$/;
const RATE_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^req_v1_[A-Za-z0-9_-]{43}$/;

export class PreviewFixtureCleanupError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '预览合成对象清理失败');
    this.name = 'PreviewFixtureCleanupError';
    this.code = code || 'PREVIEW_FIXTURE_CLEANUP_ERROR';
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

export function readPreviewFixtureCleanupConfig(env = {}) {
  if (String(env.CLOUD_PREVIEW_CLEANUP_ENABLED || '').trim() !== '1') {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_DISABLED', '一次性预览清理能力未开启', 503);
  }
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '').trim() !== '0') {
    throw new PreviewFixtureCleanupError('PREVIEW_WRITE_MUST_BE_DISABLED', '执行清理前必须关闭预览写入', 503);
  }
  if (String(env.CLOUD_BLOB_STORE_NAME || '').trim() !== PREVIEW_FIXTURE_STORE) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_STORE_MISMATCH', '清理能力只能连接隔离预览命名空间', 503);
  }
  const cleanupKey = String(env.CLOUD_PREVIEW_CLEANUP_KEY || '');
  if (secretByteLength(cleanupKey) < 32 || secretByteLength(cleanupKey) > 256) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_KEY_NOT_CONFIGURED', '一次性清理密钥尚未正确配置', 503);
  }
  const previewKey = String(env.CLOUD_WRITE_PREVIEW_KEY || '');
  if (previewKey && safeSecretEqual(cleanupKey, previewKey)) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_KEY_REUSED', '一次性清理密钥不得复用预览写入密钥', 503);
  }
  return Object.freeze({ cleanupKey, storeName: PREVIEW_FIXTURE_STORE });
}

export function assertPreviewFixtureCleanupAccess(request, config) {
  const supplied = String(request?.headers?.get?.('x-cloud-collab-cleanup-key') || '');
  if (!safeSecretEqual(config?.cleanupKey, supplied)) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_ACCESS_DENIED', '一次性清理访问凭据无效', 403);
  }
  return true;
}

function classifyKey(key) {
  let match = /^devices\/profiles\/(dev_[0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(key);
  if (match) return { type: 'deviceProfile', deviceId: match[1] };
  match = /^devices\/token-index\/(dth_v1_[A-Za-z0-9_-]{43})\.json$/.exec(key);
  if (match) return { type: 'tokenIndex', tokenHash: match[1] };
  match = /^submissions\/lib_receive_fixture\/pending\/(ik_v1_[A-Za-z0-9_-]{43})\.json$/.exec(key);
  if (match) return { type: 'pendingSubmission', idempotencyKey: match[1] };
  match = /^preview-rate\/(device-register|submission-create)\/([A-Za-z0-9_-]{43})\/(\d+)\.json$/.exec(key);
  if (match) return { type: 'rateSlot', scope: match[1], subjectHash: match[2], slot: Number(match[3]) };
  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertFixtureObject(descriptor, value) {
  if (!isPlainObject(value)) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_INVALID_OBJECT', '预览对象不是有效JSON对象', 409, { category: descriptor.type });
  }
  if (descriptor.type === 'deviceProfile') {
    if (value.schemaVersion !== 1 || value.deviceId !== descriptor.deviceId || !DEVICE_ID_PATTERN.test(value.deviceId)
      || !TOKEN_HASH_PATTERN.test(String(value.tokenHash || '')) || value.publicMutationAllowed === true || value.autoApprovalEnabled === true) {
      throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_INVALID_PROFILE', '设备档案不符合合成预览结构', 409);
    }
    return;
  }
  if (descriptor.type === 'tokenIndex') {
    if (value.schemaVersion !== 1 || value.tokenHash !== descriptor.tokenHash || !TOKEN_HASH_PATTERN.test(value.tokenHash)
      || !DEVICE_ID_PATTERN.test(String(value.deviceId || ''))) {
      throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_INVALID_TOKEN_INDEX', '令牌索引不符合合成预览结构', 409);
    }
    return;
  }
  if (descriptor.type === 'pendingSubmission') {
    const submission = value.submission;
    if (value.schemaVersion !== 1 || !REQUEST_HASH_PATTERN.test(String(value.requestHash || '')) || !isPlainObject(submission)
      || submission.groupId !== PREVIEW_FIXTURE_GROUP_ID || submission.libraryId !== PREVIEW_FIXTURE_LIBRARY_ID
      || submission.dataType !== 'exact_price' || submission.operation !== 'upsert'
      || submission.idempotencyKey !== descriptor.idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(submission.idempotencyKey)
      || value.publicMutationAllowed !== false || value.autoApprovalEnabled !== false) {
      throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_INVALID_SUBMISSION', '候选提交不符合合成测试作用域', 409);
    }
    return;
  }
  if (descriptor.type === 'rateSlot') {
    if (value.schemaVersion !== 1 || value.scope !== descriptor.scope || value.slot !== descriptor.slot
      || !RATE_HASH_PATTERN.test(descriptor.subjectHash)) {
      throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_INVALID_RATE_SLOT', '限流对象不符合合成预览结构', 409);
    }
    return;
  }
  throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_UNKNOWN_OBJECT', '发现未列入白名单的预览对象', 409);
}

function manifestDigest(keys) {
  return createHash('sha256').update(Buffer.from(keys.join('\n'), 'utf8')).digest('base64url');
}

export async function inspectPreviewFixtureObjects(store) {
  if (!store || typeof store.list !== 'function' || typeof store.get !== 'function' || typeof store.delete !== 'function') {
    throw new PreviewFixtureCleanupError('INVALID_CLEANUP_STORE', '清理Store必须提供list/get/delete', 500);
  }
  let listed;
  try {
    listed = await store.list({ consistency: 'strong' });
  } catch (error) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_LIST_FAILED', '无法强一致列举预览对象', 503, null, error);
  }
  const blobs = Array.isArray(listed?.blobs) ? listed.blobs : [];
  if (blobs.length > MAX_CLEANUP_OBJECTS) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_OBJECT_LIMIT', '预览对象数量超过一次性清理上限', 409, { objectCount: blobs.length });
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean).sort();
  const counts = { deviceProfile: 0, tokenIndex: 0, pendingSubmission: 0, rateSlot: 0 };
  const objects = [];
  for (const key of keys) {
    const descriptor = classifyKey(key);
    if (!descriptor) {
      throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_UNKNOWN_KEY', '发现未列入白名单的预览对象，清理已拒绝', 409, { unknownCount: 1 });
    }
    let value;
    try {
      value = await store.get(key, { type: 'json', consistency: 'strong' });
    } catch (error) {
      throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_READ_FAILED', '无法强一致读取预览对象', 503, { category: descriptor.type }, error);
    }
    if (value === null || value === undefined) {
      throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_OBJECT_DISAPPEARED', '预览对象在检查期间发生变化', 409, { category: descriptor.type });
    }
    assertFixtureObject(descriptor, value);
    counts[descriptor.type] += 1;
    objects.push({ key, descriptor });
  }
  return Object.freeze({
    schemaVersion: 1,
    storeName: PREVIEW_FIXTURE_STORE,
    objectCount: objects.length,
    counts: Object.freeze({ ...counts }),
    manifestDigest: manifestDigest(keys),
    objects: Object.freeze(objects),
  });
}

export async function runPreviewFixtureCleanup({ store, expectedDigest, confirmation } = {}) {
  if (confirmation !== CLEANUP_CONFIRMATION) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_CONFIRMATION_REQUIRED', '清理确认短语无效', 400);
  }
  const inspection = await inspectPreviewFixtureObjects(store);
  if (!expectedDigest || expectedDigest !== inspection.manifestDigest) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_MANIFEST_CHANGED', '对象清单与干跑结果不一致，未执行删除', 409, {
      objectCount: inspection.objectCount,
      manifestDigest: inspection.manifestDigest,
    });
  }
  let deletedCount = 0;
  for (const item of inspection.objects) {
    try {
      await store.delete(item.key);
      deletedCount += 1;
    } catch (error) {
      throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_DELETE_FAILED', '预览对象删除未完整完成', 503, {
        attemptedCount: inspection.objectCount,
        deletedCount,
      }, error);
    }
  }
  const verification = await inspectPreviewFixtureObjects(store);
  if (verification.objectCount !== 0) {
    throw new PreviewFixtureCleanupError('PREVIEW_CLEANUP_VERIFY_FAILED', '删除后仍存在白名单预览对象', 503, {
      remainingCount: verification.objectCount,
      deletedCount,
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    storeName: PREVIEW_FIXTURE_STORE,
    deletedCount,
    verifiedEmpty: true,
  });
}

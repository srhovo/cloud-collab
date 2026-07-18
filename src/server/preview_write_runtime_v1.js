import { createHash } from 'node:crypto';
import {
  getJSONStrong,
  normalizeBlobKey,
  pendingSubmissionKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { authenticateDevice, registerDevice } from './device_registration_v1.js';
import { acceptSubmission, buildSubmissionRequestHash } from './submission_acceptance_v1.js';
import { normalizeSubmission } from './submission_policy_v1.js';

export const PREVIEW_WRITE_CONFIG_VERSION = 1;
export const REGISTRATION_RATE_SLOT_MS = 60_000;
export const SUBMISSION_RATE_SLOT_MS = 5_000;

const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;

export class PreviewWriteError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '预览写入请求失败');
    this.name = 'PreviewWriteError';
    this.code = code || 'PREVIEW_WRITE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function normalizeScopedId(value, pattern, code, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!pattern.test(text)) throw new PreviewWriteError(code, `${label}配置无效`, 503);
  return text;
}

export function readPreviewWriteConfig(env = {}) {
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new PreviewWriteError('PREVIEW_WRITE_DISABLED', '预览写入功能未开启', 503);
  }
  const rateLimitSalt = String(env.CLOUD_RATE_LIMIT_SALT || '').trim();
  if (rateLimitSalt.length < 16 || rateLimitSalt.length > 256) {
    throw new PreviewWriteError('RATE_LIMIT_SALT_NOT_CONFIGURED', '预览限流盐值尚未正确配置', 503);
  }
  return Object.freeze({
    schemaVersion: PREVIEW_WRITE_CONFIG_VERSION,
    allowedGroupId: normalizeScopedId(env.CLOUD_WRITE_ALLOWED_GROUP_ID, GROUP_ID_PATTERN, 'INVALID_ALLOWED_GROUP_ID', '允许写入的groupId'),
    allowedLibraryId: normalizeScopedId(env.CLOUD_WRITE_ALLOWED_LIBRARY_ID, LIBRARY_ID_PATTERN, 'INVALID_ALLOWED_LIBRARY_ID', '允许写入的libraryId'),
    rateLimitSalt,
  });
}

function hashRateSubject(salt, subject) {
  return createHash('sha256')
    .update(Buffer.from(`${salt}\u0000${String(subject || '').trim()}`, 'utf8'))
    .digest('base64url');
}

export function previewRateKey({ scope, subject, salt, now, slotMs }) {
  const normalizedScope = String(scope || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(normalizedScope)) {
    throw new PreviewWriteError('INVALID_RATE_SCOPE', '限流作用域无效', 500);
  }
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(slotMs) || slotMs < 1000) {
    throw new PreviewWriteError('INVALID_RATE_WINDOW', '限流窗口无效', 500);
  }
  const slot = Math.floor(now / slotMs);
  const subjectHash = hashRateSubject(salt, subject);
  return normalizeBlobKey(`preview-rate/${normalizedScope}/${subjectHash}/${slot}.json`);
}

export async function consumePreviewRateSlot({ store, scope, subject, salt, now = Date.now(), slotMs } = {}) {
  const key = previewRateKey({ scope, subject, salt, now, slotMs });
  const retryAfterSeconds = Math.max(1, Math.ceil((slotMs - (now % slotMs)) / 1000));
  try {
    await putJSONOnlyIfNew(store, key, Object.freeze({
      schemaVersion: 1,
      scope,
      slot: Math.floor(now / slotMs),
      createdAt: now,
    }));
    return Object.freeze({ allowed: true, key, retryAfterSeconds: 0 });
  } catch (error) {
    const existing = await getJSONStrong(store, key);
    if (existing) {
      throw new PreviewWriteError('PREVIEW_RATE_LIMITED', '请求过于频繁，请稍后重试', 429, { retryAfterSeconds });
    }
    throw new PreviewWriteError('RATE_LIMIT_STORAGE_FAILED', '限流状态写入失败', 503, { key }, error);
  }
}

export function assertPreviewSubmissionScope(submission, config) {
  if (submission.groupId !== config.allowedGroupId || submission.libraryId !== config.allowedLibraryId) {
    throw new PreviewWriteError(
      'PREVIEW_SCOPE_FORBIDDEN',
      '预览写入只允许隔离测试团和测试价格库',
      403,
      { allowedGroupId: config.allowedGroupId, allowedLibraryId: config.allowedLibraryId },
    );
  }
  return submission;
}

export async function registerPreviewDevice({
  store,
  input,
  env,
  now = Date.now(),
  register = registerDevice,
} = {}) {
  const config = readPreviewWriteConfig(env);
  const deviceId = String(input?.deviceId || '').trim();
  await consumePreviewRateSlot({
    store,
    scope: 'device-register',
    subject: deviceId,
    salt: config.rateLimitSalt,
    now,
    slotMs: REGISTRATION_RATE_SLOT_MS,
  });
  return register({ store, input, now });
}

export async function acceptPreviewSubmission({
  store,
  authorization,
  rawSubmission,
  env,
  now = Date.now(),
  authenticate = authenticateDevice,
  accept = acceptSubmission,
} = {}) {
  const config = readPreviewWriteConfig(env);
  let submission;
  try {
    submission = normalizeSubmission(rawSubmission);
  } catch (error) {
    throw new PreviewWriteError(error.code || 'INVALID_SUBMISSION', error.message, 400, error.details, error);
  }
  assertPreviewSubmissionScope(submission, config);

  const identity = await authenticate({ store, authorization, now });
  if (identity.deviceId !== submission.deviceId) {
    throw new PreviewWriteError('DEVICE_SCOPE_MISMATCH', 'Authorization设备与提交deviceId不一致', 403);
  }

  const candidateKey = pendingSubmissionKey(submission.libraryId, submission.idempotencyKey);
  const existingCandidate = await getJSONStrong(store, candidateKey);
  if (!existingCandidate) {
    await consumePreviewRateSlot({
      store,
      scope: 'submission-create',
      subject: identity.deviceId,
      salt: config.rateLimitSalt,
      now,
      slotMs: SUBMISSION_RATE_SLOT_MS,
    });
  } else if (existingCandidate.requestHash !== buildSubmissionRequestHash(submission)) {
    // 让acceptSubmission返回统一的409幂等冲突结构，不在此处重复实现。
  }

  return accept({
    store,
    authorization,
    rawSubmission: submission,
    now,
    authenticate: async () => identity,
  });
}

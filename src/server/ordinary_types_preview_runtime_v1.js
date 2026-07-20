import {
  getJSONStrong,
  pendingSubmissionKey,
} from './blob_repository_v1.js';
import { authenticateDevice } from './device_registration_v1.js';
import { acceptOrdinarySubmission } from './ordinary_submission_acceptance_v1.js';
import {
  normalizeOrdinarySubmission,
  readOrdinaryTypesPreviewConfig,
} from './ordinary_types_policy_v1.js';
import {
  SUBMISSION_RATE_SLOT_MS,
  assertPreviewSubmissionScope,
  consumePreviewRateSlot,
  readPreviewWriteConfig,
} from './preview_write_runtime_v1.js';

export const ORDINARY_TYPES_RUNTIME_VERSION = 1;

export class OrdinaryTypesPreviewRuntimeError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '普通共享类型预览请求失败');
    this.name = 'OrdinaryTypesPreviewRuntimeError';
    this.code = code || 'ORDINARY_TYPES_PREVIEW_RUNTIME_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function readOrdinaryTypesRuntimeConfig(env = {}) {
  const writeConfig = readPreviewWriteConfig(env);
  const ordinaryConfig = readOrdinaryTypesPreviewConfig(env);
  const actualStore = String(env.CLOUD_BLOB_STORE_NAME || '').trim();
  if (actualStore !== ordinaryConfig.storeName) {
    throw new OrdinaryTypesPreviewRuntimeError(
      'ORDINARY_TYPES_STORE_MISMATCH',
      '普通共享类型Blob配置与预览写入Blob不一致',
      503,
    );
  }
  if (writeConfig.allowedGroupId !== ordinaryConfig.groupId
      || writeConfig.allowedLibraryId !== ordinaryConfig.libraryId) {
    throw new OrdinaryTypesPreviewRuntimeError(
      'ORDINARY_TYPES_SCOPE_MISMATCH',
      '普通共享类型作用域与预览写入作用域不一致',
      503,
    );
  }
  return Object.freeze({
    schemaVersion: ORDINARY_TYPES_RUNTIME_VERSION,
    ...writeConfig,
    ordinaryTypesEnabled: true,
    storeName: ordinaryConfig.storeName,
  });
}

export async function acceptPreviewOrdinarySubmission({
  store,
  authorization,
  rawSubmission,
  env,
  now = Date.now(),
  authenticate = authenticateDevice,
  accept = acceptOrdinarySubmission,
} = {}) {
  const config = readOrdinaryTypesRuntimeConfig(env);
  let submission;
  try {
    submission = normalizeOrdinarySubmission(rawSubmission);
  } catch (error) {
    throw new OrdinaryTypesPreviewRuntimeError(
      error?.code || 'INVALID_SUBMISSION',
      error?.message || '普通共享提交无效',
      400,
      error?.details || null,
      error,
    );
  }
  assertPreviewSubmissionScope(submission, config);

  const identity = await authenticate({ store, authorization, now });
  if (identity.deviceId !== submission.deviceId) {
    throw new OrdinaryTypesPreviewRuntimeError(
      'DEVICE_SCOPE_MISMATCH',
      'Authorization设备与提交deviceId不一致',
      403,
    );
  }

  const candidateKey = pendingSubmissionKey(submission.libraryId, submission.idempotencyKey);
  const existingCandidate = await getJSONStrong(store, candidateKey);
  if (!existingCandidate) {
    await consumePreviewRateSlot({
      store,
      scope: 'ordinary-submission-create',
      subject: identity.deviceId,
      salt: config.rateLimitSalt,
      now,
      slotMs: SUBMISSION_RATE_SLOT_MS,
    });
  }

  return accept({
    store,
    authorization,
    rawSubmission: submission,
    now,
    authenticate: async () => identity,
  });
}

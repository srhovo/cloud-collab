import { createHash, timingSafeEqual } from 'node:crypto';

import {
  getJSONStrong,
  normalizeBlobKey,
  pendingSubmissionKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { authenticateDevice, registerDevice } from './device_registration_v1.js';
import { acceptSubmission } from './submission_acceptance_v1.js';
import { normalizeSubmission } from './submission_policy_v1.js';
import { acceptOrdinarySubmission } from './ordinary_submission_acceptance_v1.js';
import { normalizeOrdinarySubmission } from './ordinary_types_policy_v1.js';
import {
  ProductionRuntimeConfigError,
  readProductionRuntimeConfig,
} from './production_runtime_config_v1.js';

export const PRODUCTION_WRITE_RUNTIME_VERSION = 1;
export const PRODUCTION_REGISTRATION_RATE_SLOT_MS = 60_000;
export const PRODUCTION_SUBMISSION_RATE_SLOT_MS = 5_000;
export const PRODUCTION_ORDINARY_TYPES = Object.freeze(['exact_price', 'playable_name', 'boss_profile']);

export class ProductionWriteRuntimeError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '正式普通提交失败');
    this.name = 'ProductionWriteRuntimeError';
    this.code = code || 'PRODUCTION_WRITE_RUNTIME_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function safeSecretEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function readProductionWriteConfig(env = {}) {
  let runtime;
  try { runtime = readProductionRuntimeConfig(env); }
  catch (error) {
    if (error instanceof ProductionRuntimeConfigError) {
      throw new ProductionWriteRuntimeError(error.code, error.message, 503, error.details, error);
    }
    throw error;
  }
  if (runtime.mode !== 'production' || runtime.flags.production !== true
      || runtime.flags.readSync !== true || runtime.flags.ordinarySubmission !== true) {
    throw new ProductionWriteRuntimeError('PRODUCTION_ORDINARY_SUBMISSION_DISABLED', '正式普通提交未开启', 503);
  }
  return Object.freeze({
    schemaVersion: PRODUCTION_WRITE_RUNTIME_VERSION,
    runtime,
    allowedGroupId: runtime.scope.protocol.groupId,
    allowedLibraryId: runtime.scope.protocol.libraryId,
    externalScope: runtime.scope.external,
    storeName: runtime.publicStoreName,
    publicOrigin: runtime.publicOrigin,
    accessKey: runtime.secrets.CLOUD_PRODUCTION_CLIENT_ACCESS_KEY,
    rateLimitSalt: runtime.secrets.CLOUD_PRODUCTION_RATE_LIMIT_SALT,
  });
}

export function assertProductionRequestAccess(request, config) {
  const supplied = String(request?.headers?.get?.('x-cloud-collab-access-key') || '');
  if (!safeSecretEqual(config?.accessKey, supplied)) {
    throw new ProductionWriteRuntimeError('PRODUCTION_ACCESS_DENIED', '正式协作访问凭据无效', 403);
  }
  return true;
}

function hashRateSubject(salt, subject) {
  return createHash('sha256')
    .update(Buffer.from(`${salt}\u0000${String(subject || '').trim()}`, 'utf8'))
    .digest('base64url');
}

export function productionRateKey({ scope, subject, salt, now, slotMs }) {
  const normalizedScope = String(scope || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(normalizedScope)) {
    throw new ProductionWriteRuntimeError('INVALID_RATE_SCOPE', '正式限流作用域无效', 500);
  }
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(slotMs) || slotMs < 1000) {
    throw new ProductionWriteRuntimeError('INVALID_RATE_WINDOW', '正式限流窗口无效', 500);
  }
  const slot = Math.floor(now / slotMs);
  return normalizeBlobKey(`production-rate/${normalizedScope}/${hashRateSubject(salt, subject)}/${slot}.json`);
}

export async function consumeProductionRateSlot({ store, scope, subject, salt, now = Date.now(), slotMs } = {}) {
  const key = productionRateKey({ scope, subject, salt, now, slotMs });
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
      throw new ProductionWriteRuntimeError('PRODUCTION_RATE_LIMITED', '请求过于频繁，请稍后重试', 429, { retryAfterSeconds });
    }
    throw new ProductionWriteRuntimeError('PRODUCTION_RATE_STORAGE_FAILED', '正式限流状态写入失败', 503, { key }, error);
  }
}

export function assertProductionSubmissionScope(submission, config) {
  if (submission.groupId !== config.allowedGroupId || submission.libraryId !== config.allowedLibraryId) {
    throw new ProductionWriteRuntimeError(
      'PRODUCTION_SCOPE_FORBIDDEN',
      '提交不属于正式club和价格库',
      403,
      {
        externalScope: config.externalScope,
        protocolScope: { groupId: config.allowedGroupId, libraryId: config.allowedLibraryId },
      },
    );
  }
  return submission;
}

export async function registerProductionDevice({
  store,
  input,
  env,
  now = Date.now(),
  register = registerDevice,
} = {}) {
  const config = readProductionWriteConfig(env);
  const deviceId = String(input?.deviceId || '').trim();
  await consumeProductionRateSlot({
    store,
    scope: 'device-register',
    subject: deviceId,
    salt: config.rateLimitSalt,
    now,
    slotMs: PRODUCTION_REGISTRATION_RATE_SLOT_MS,
  });
  return register({ store, input, now });
}

function projectProductionAcceptance(result, config, dataType) {
  return Object.freeze({
    ...result,
    dataType,
    externalScope: config.externalScope,
    protocolScope: Object.freeze({ groupId: config.allowedGroupId, libraryId: config.allowedLibraryId }),
    ordinarySubmissionEnabled: true,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
    stablePromotionAuthorized: false,
  });
}

async function consumeCandidateRateIfNew({ store, submission, identity, config, now, rateScope }) {
  const candidateKey = pendingSubmissionKey(submission.libraryId, submission.idempotencyKey);
  const existingCandidate = await getJSONStrong(store, candidateKey);
  if (!existingCandidate) {
    await consumeProductionRateSlot({
      store,
      scope: rateScope,
      subject: identity.deviceId,
      salt: config.rateLimitSalt,
      now,
      slotMs: PRODUCTION_SUBMISSION_RATE_SLOT_MS,
    });
  }
}

export async function acceptProductionExactSubmission({
  store,
  authorization,
  rawSubmission,
  env,
  now = Date.now(),
  authenticate = authenticateDevice,
  accept = acceptSubmission,
} = {}) {
  const config = readProductionWriteConfig(env);
  let submission;
  try {
    submission = normalizeSubmission(rawSubmission);
  } catch (error) {
    throw new ProductionWriteRuntimeError(error.code || 'INVALID_SUBMISSION', error.message, 400, error.details, error);
  }
  assertProductionSubmissionScope(submission, config);

  const identity = await authenticate({ store, authorization, now });
  if (identity.deviceId !== submission.deviceId) {
    throw new ProductionWriteRuntimeError('DEVICE_SCOPE_MISMATCH', 'Authorization设备与提交deviceId不一致', 403);
  }
  await consumeCandidateRateIfNew({
    store, submission, identity, config, now, rateScope: 'submission-create',
  });

  const result = await accept({
    store,
    authorization,
    rawSubmission: submission,
    now,
    authenticate: async () => identity,
  });
  return projectProductionAcceptance(result, config, submission.dataType);
}

export async function acceptProductionOrdinarySubmission({
  store,
  authorization,
  rawSubmission,
  env,
  now = Date.now(),
  authenticate = authenticateDevice,
  accept = acceptOrdinarySubmission,
} = {}) {
  const config = readProductionWriteConfig(env);
  let submission;
  try {
    submission = normalizeOrdinarySubmission(rawSubmission);
  } catch (error) {
    throw new ProductionWriteRuntimeError(
      error?.code || 'INVALID_SUBMISSION',
      error?.message || '普通共享提交无效',
      400,
      error?.details || null,
      error,
    );
  }
  if (submission.dataType === 'exact_price') {
    throw new ProductionWriteRuntimeError('EXACT_PRICE_HANDLER_REQUIRED', '精确价格必须使用精确价格接收器', 500);
  }
  assertProductionSubmissionScope(submission, config);

  const identity = await authenticate({ store, authorization, now });
  if (identity.deviceId !== submission.deviceId) {
    throw new ProductionWriteRuntimeError('DEVICE_SCOPE_MISMATCH', 'Authorization设备与提交deviceId不一致', 403);
  }
  await consumeCandidateRateIfNew({
    store, submission, identity, config, now, rateScope: 'ordinary-submission-create',
  });

  const result = await accept({
    store,
    authorization,
    rawSubmission: submission,
    now,
    authenticate: async () => identity,
  });
  return projectProductionAcceptance(result, config, submission.dataType);
}

export async function acceptProductionCandidateSubmission(input = {}) {
  const dataType = String(input?.rawSubmission?.dataType || '').trim().toLowerCase();
  const operation = String(input?.rawSubmission?.operation || '').trim().toLowerCase();
  if (operation === 'delete' || ['rank_range_rule', 'surcharge_rule', 'gift_rule'].includes(dataType)) {
    throw new ProductionWriteRuntimeError(
      'PRODUCTION_SENSITIVE_HANDLER_REQUIRED',
      '敏感提交必须使用独立人工审核处理器',
      503,
    );
  }
  if (dataType === 'exact_price') return acceptProductionExactSubmission(input);
  if (dataType === 'playable_name' || dataType === 'boss_profile') {
    return acceptProductionOrdinarySubmission(input);
  }
  throw new ProductionWriteRuntimeError('UNSUPPORTED_PRODUCTION_DATA_TYPE', '正式普通提交类型不受支持', 400, {
    allowedDataTypes: PRODUCTION_ORDINARY_TYPES,
  });
}

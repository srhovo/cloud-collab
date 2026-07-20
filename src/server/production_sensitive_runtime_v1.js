import { authenticateDevice } from './device_registration_v1.js';
import { getJSONStrong, pendingSubmissionKey } from './blob_repository_v1.js';
import { buildUnifiedSensitivePublicSnapshot } from './sensitive_public_engine_v1.js';
import { normalizeSensitiveSubmission } from './sensitive_rules_policy_v1.js';
import { acceptSensitiveSubmission } from './sensitive_submission_acceptance_v1.js';
import {
  ProductionRuntimeConfigError,
  readProductionRuntimeConfig,
} from './production_runtime_config_v1.js';
import {
  PRODUCTION_SUBMISSION_RATE_SLOT_MS,
  ProductionWriteRuntimeError,
  consumeProductionRateSlot,
} from './production_write_runtime_v1.js';

export const PRODUCTION_SENSITIVE_RUNTIME_VERSION = 1;
export const PRODUCTION_SENSITIVE_UPSERT_TYPES = Object.freeze([
  'rank_range_rule',
  'surcharge_rule',
  'gift_rule',
  'boss_profile',
]);
export const PRODUCTION_SENSITIVE_DELETE_TYPES = Object.freeze([
  'exact_price',
  'playable_name',
  'boss_profile',
  'rank_range_rule',
  'surcharge_rule',
  'gift_rule',
]);

export class ProductionSensitiveRuntimeError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '正式敏感候选接收失败');
    this.name = 'ProductionSensitiveRuntimeError';
    this.code = code || 'PRODUCTION_SENSITIVE_RUNTIME_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function readProductionSensitiveConfig(env = {}) {
  let runtime;
  try { runtime = readProductionRuntimeConfig(env); }
  catch (error) {
    if (error instanceof ProductionRuntimeConfigError) {
      throw new ProductionSensitiveRuntimeError(error.code, error.message, 503, error.details, error);
    }
    throw error;
  }
  const flags = runtime.flags;
  if (runtime.mode !== 'production' || flags.production !== true || flags.readSync !== true
      || flags.admin !== true || flags.adminReview !== true || flags.sensitiveSubmission !== true) {
    throw new ProductionSensitiveRuntimeError(
      'PRODUCTION_SENSITIVE_SUBMISSION_DISABLED',
      '正式敏感提交或管理员人工审核尚未开启',
      503,
    );
  }
  return Object.freeze({
    schemaVersion: PRODUCTION_SENSITIVE_RUNTIME_VERSION,
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

export function assertProductionSensitiveEnvelope(rawSubmission) {
  const dataType = String(rawSubmission?.dataType || '').trim().toLowerCase();
  const operation = String(rawSubmission?.operation || '').trim().toLowerCase();
  if (operation === 'delete' && PRODUCTION_SENSITIVE_DELETE_TYPES.includes(dataType)) {
    return Object.freeze({ dataType, operation });
  }
  if (operation === 'upsert' && PRODUCTION_SENSITIVE_UPSERT_TYPES.includes(dataType)) {
    return Object.freeze({ dataType, operation });
  }
  if (operation === 'upsert' && ['exact_price', 'playable_name'].includes(dataType)) {
    throw new ProductionSensitiveRuntimeError(
      'PRODUCTION_ORDINARY_HANDLER_REQUIRED',
      '普通提交必须使用普通候选入口',
      400,
    );
  }
  throw new ProductionSensitiveRuntimeError(
    'UNSUPPORTED_PRODUCTION_SENSITIVE_TYPE',
    '正式敏感提交类型或操作不受支持',
    400,
    {
      upsertTypes: PRODUCTION_SENSITIVE_UPSERT_TYPES,
      deleteTypes: PRODUCTION_SENSITIVE_DELETE_TYPES,
    },
  );
}

export function assertProductionSensitiveScope(submission, config) {
  if (submission.groupId !== config.allowedGroupId || submission.libraryId !== config.allowedLibraryId) {
    throw new ProductionSensitiveRuntimeError(
      'PRODUCTION_SENSITIVE_SCOPE_FORBIDDEN',
      '敏感提交不属于正式club和价格库',
      403,
      {
        externalScope: config.externalScope,
        protocolScope: { groupId: config.allowedGroupId, libraryId: config.allowedLibraryId },
      },
    );
  }
  return submission;
}

function sameBoss(left, right) {
  return (left || null) === (right || null);
}

export function createProductionSensitiveBaselineResolver({
  store,
  now = Date.now(),
  buildSnapshot = buildUnifiedSensitivePublicSnapshot,
} = {}) {
  return async function resolveExistingRecord(query) {
    const snapshot = await buildSnapshot({
      store,
      groupId: query.groupId,
      libraryId: query.libraryId,
      now,
    });
    if (!snapshot || snapshot.groupId !== query.groupId || snapshot.libraryId !== query.libraryId) {
      throw new ProductionSensitiveRuntimeError(
        'PRODUCTION_SENSITIVE_BASELINE_SCOPE_MISMATCH',
        '公共基线快照作用域与敏感提交不一致',
        500,
      );
    }
    const records = Array.isArray(snapshot.records) ? snapshot.records : [];
    return records.find(item => item?.businessKey === query.businessKey
      && item?.dataType === query.dataType
      && sameBoss(item?.bossId, query.bossId)) || null;
  };
}

export async function acceptProductionSensitiveCandidate({
  store,
  authorization,
  rawSubmission,
  env,
  now = Date.now(),
  authenticate = authenticateDevice,
  accept = acceptSensitiveSubmission,
  resolveExistingRecord = null,
  buildSnapshot = buildUnifiedSensitivePublicSnapshot,
} = {}) {
  assertProductionSensitiveEnvelope(rawSubmission);
  const config = readProductionSensitiveConfig(env);
  let submission;
  try {
    submission = normalizeSensitiveSubmission(rawSubmission);
  } catch (error) {
    throw new ProductionSensitiveRuntimeError(
      error?.code || 'INVALID_SENSITIVE_SUBMISSION',
      error?.message || '正式敏感提交无效',
      400,
      error?.details || null,
      error,
    );
  }
  assertProductionSensitiveScope(submission, config);

  const identity = await authenticate({ store, authorization, now });
  if (identity.deviceId !== submission.deviceId) {
    throw new ProductionSensitiveRuntimeError('DEVICE_SCOPE_MISMATCH', 'Authorization设备与提交deviceId不一致', 403);
  }

  const candidateKey = pendingSubmissionKey(submission.libraryId, submission.idempotencyKey);
  const existing = await getJSONStrong(store, candidateKey);
  if (!existing) {
    try {
      await consumeProductionRateSlot({
        store,
        scope: 'sensitive-submission-create',
        subject: identity.deviceId,
        salt: config.rateLimitSalt,
        now,
        slotMs: PRODUCTION_SUBMISSION_RATE_SLOT_MS,
      });
    } catch (error) {
      if (error instanceof ProductionWriteRuntimeError) {
        throw new ProductionSensitiveRuntimeError(error.code, error.message, error.status, error.details, error);
      }
      throw error;
    }
  }

  const baselineResolver = typeof resolveExistingRecord === 'function'
    ? resolveExistingRecord
    : createProductionSensitiveBaselineResolver({ store, now, buildSnapshot });
  const result = await accept({
    store,
    authorization,
    rawSubmission: submission,
    resolveExistingRecord: baselineResolver,
    now,
    authenticate: async () => identity,
  });

  return Object.freeze({
    ...result,
    externalScope: config.externalScope,
    protocolScope: Object.freeze({ groupId: config.allowedGroupId, libraryId: config.allowedLibraryId }),
    manualReviewRequired: result?.decision === 'pending_review',
    publicMutationAllowed: false,
    publicMutationApplied: false,
    autoApprovalEnabled: false,
    stablePromotionAuthorized: false,
  });
}

import {
  getJSONStrong,
  pendingSubmissionKey,
} from './blob_repository_v1.js';
import { authenticateDevice } from './device_registration_v1.js';
import { reviewOrdinaryCandidate } from './ordinary_public_engine_v1.js';
import { acceptOrdinarySubmission as acceptOrdinaryCandidate } from './ordinary_submission_acceptance_v1.js';
import { normalizeOrdinarySubmission } from './ordinary_types_policy_v1.js';
import {
  PRODUCTION_SUBMISSION_RATE_SLOT_MS,
  ProductionWriteRuntimeError,
  acceptProductionExactSubmission,
  assertProductionSubmissionScope,
  consumeProductionRateSlot,
  readProductionWriteConfig,
} from './production_write_runtime_v1.js';

export const PRODUCTION_ORDINARY_TYPES_RUNTIME_VERSION = 1;
const NEW_ORDINARY_TYPES = new Set(['playable_name', 'boss_profile']);

function wrapRuntimeError(error, fallbackCode, fallbackMessage, fallbackStatus = 500) {
  if (error instanceof ProductionWriteRuntimeError) return error;
  return new ProductionWriteRuntimeError(
    error?.code || fallbackCode,
    error?.message || fallbackMessage,
    Number.isInteger(error?.status) ? error.status : fallbackStatus,
    error?.details || null,
    error,
  );
}

function projectResult({ config, acceptance, autoApprovalResult = null }) {
  const autoApprovalEnabled = config.runtime.flags.autoApproval === true;
  return Object.freeze({
    ...acceptance,
    externalScope: config.externalScope,
    protocolScope: Object.freeze({
      groupId: config.allowedGroupId,
      libraryId: config.allowedLibraryId,
    }),
    ordinarySubmissionEnabled: true,
    publicMutationAllowed: autoApprovalEnabled,
    publicMutationApplied: autoApprovalResult?.publicMutationApplied === true,
    autoApprovalEnabled,
    autoApprovalResult,
    stablePromotionAuthorized: false,
  });
}

async function acceptProductionNewOrdinarySubmission({
  store,
  authorization,
  rawSubmission,
  env,
  now = Date.now(),
  authenticate = authenticateDevice,
  accept = acceptOrdinaryCandidate,
  review = reviewOrdinaryCandidate,
} = {}) {
  const config = readProductionWriteConfig(env);
  assertProductionSubmissionScope(rawSubmission, config);

  let submission;
  try {
    submission = normalizeOrdinarySubmission(rawSubmission);
  } catch (error) {
    throw wrapRuntimeError(error, 'INVALID_ORDINARY_SUBMISSION', '普通共享提交无效', 400);
  }
  if (!NEW_ORDINARY_TYPES.has(submission.dataType)) {
    throw new ProductionWriteRuntimeError('UNSUPPORTED_PRODUCTION_ORDINARY_TYPE', '正式普通类型不受支持', 400);
  }
  assertProductionSubmissionScope(submission, config);

  let identity;
  try {
    identity = await authenticate({ store, authorization, now });
  } catch (error) {
    throw wrapRuntimeError(error, 'PRODUCTION_DEVICE_AUTH_FAILED', '设备身份校验失败', 403);
  }
  if (identity?.deviceId !== submission.deviceId) {
    throw new ProductionWriteRuntimeError('DEVICE_SCOPE_MISMATCH', 'Authorization设备与提交deviceId不一致', 403);
  }

  const candidateKey = pendingSubmissionKey(submission.libraryId, submission.idempotencyKey);
  const existingCandidate = await getJSONStrong(store, candidateKey);
  if (!existingCandidate) {
    await consumeProductionRateSlot({
      store,
      scope: 'submission-create',
      subject: identity.deviceId,
      salt: config.rateLimitSalt,
      now,
      slotMs: PRODUCTION_SUBMISSION_RATE_SLOT_MS,
    });
  }

  let acceptance;
  try {
    acceptance = await accept({
      store,
      authorization,
      rawSubmission: submission,
      now,
      authenticate: async () => identity,
    });
  } catch (error) {
    throw wrapRuntimeError(error, 'PRODUCTION_ORDINARY_ACCEPTANCE_FAILED', '普通共享候选接收失败', 503);
  }

  let autoApprovalResult = null;
  if (config.runtime.flags.autoApproval === true) {
    const candidate = await getJSONStrong(store, candidateKey);
    if (!candidate) {
      throw new ProductionWriteRuntimeError(
        'PRODUCTION_CANDIDATE_NOT_FOUND_AFTER_ACCEPT',
        '候选接收完成后无法强一致读回，自动审核未执行',
        503,
        { candidateKey },
      );
    }
    try {
      autoApprovalResult = await review({ store, candidate, now });
    } catch (error) {
      throw wrapRuntimeError(error, 'PRODUCTION_ORDINARY_REVIEW_FAILED', '普通共享自动审核失败', 503);
    }
  }

  return projectResult({ config, acceptance, autoApprovalResult });
}

export async function acceptProductionOrdinarySubmission(options = {}) {
  const dataType = String(options?.rawSubmission?.dataType || '').trim().toLowerCase();
  if (dataType === 'exact_price') {
    const acceptExact = options.acceptExact || acceptProductionExactSubmission;
    const { acceptExact: _ignored, ...exactOptions } = options;
    return acceptExact(exactOptions);
  }
  return acceptProductionNewOrdinarySubmission(options);
}

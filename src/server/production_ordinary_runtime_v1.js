import {
  getJSONStrong,
  pendingSubmissionKey,
} from './blob_repository_v1.js';
import { authenticateDevice } from './device_registration_v1.js';
import { reviewOrdinaryCandidate } from './ordinary_public_engine_v1.js';
import { acceptOrdinarySubmission } from './ordinary_submission_acceptance_v1.js';
import { normalizeOrdinarySubmission } from './ordinary_types_policy_v1.js';
import {
  PRODUCTION_SUBMISSION_RATE_SLOT_MS,
  ProductionWriteRuntimeError,
  assertProductionSubmissionScope,
  consumeProductionRateSlot,
  readProductionWriteConfig,
} from './production_write_runtime_v1.js';

export const PRODUCTION_ORDINARY_RUNTIME_VERSION = 1;

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

function projectResult({ config, acceptance, reviewResult = null }) {
  const reviewEnabled = config.runtime.flags.autoApproval === true;
  return Object.freeze({
    schemaVersion: PRODUCTION_ORDINARY_RUNTIME_VERSION,
    submissionId: acceptance.submissionId,
    idempotencyKey: acceptance.idempotencyKey,
    dataType: acceptance.dataType,
    duplicate: acceptance.duplicate,
    candidateStatus: acceptance.status,
    candidateDecision: acceptance.decision,
    externalScope: config.externalScope,
    protocolScope: Object.freeze({
      groupId: config.allowedGroupId,
      libraryId: config.allowedLibraryId,
    }),
    ordinarySubmissionEnabled: true,
    productionAutoApprovalEnabled: reviewEnabled,
    reviewStatus: reviewResult?.status || null,
    reviewDecision: reviewResult?.decision || null,
    reviewReason: reviewResult?.reason || null,
    approvalMode: reviewResult?.approvalMode || null,
    publicVersion: reviewResult?.publicVersion ?? null,
    eventVersion: reviewResult?.eventVersion ?? null,
    publicMutationApplied: reviewResult?.publicMutationApplied === true,
    duplicateApproval: reviewResult?.duplicateApproval === true,
    publicMutationAllowed: false,
    stablePromotionAuthorized: false,
  });
}

export async function acceptProductionOrdinarySubmission({
  store,
  authorization,
  rawSubmission,
  env,
  now = Date.now(),
  authenticate = authenticateDevice,
  accept = acceptOrdinarySubmission,
  review = reviewOrdinaryCandidate,
} = {}) {
  const config = readProductionWriteConfig(env);
  // 先拒绝跨正式作用域请求，再执行完整协议、Hash和幂等校验。
  assertProductionSubmissionScope(rawSubmission, config);
  let submission;
  try {
    submission = normalizeOrdinarySubmission(rawSubmission);
  } catch (error) {
    throw wrapRuntimeError(error, 'INVALID_ORDINARY_SUBMISSION', '普通共享提交无效', 400);
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
      scope: 'ordinary-submission-create',
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

  if (config.runtime.flags.autoApproval !== true) {
    return projectResult({ config, acceptance });
  }

  const storedCandidate = await getJSONStrong(store, candidateKey);
  if (!storedCandidate) {
    throw new ProductionWriteRuntimeError(
      'PRODUCTION_ORDINARY_CANDIDATE_MISSING',
      '普通共享候选写入后无法读取',
      503,
      { candidateKey },
    );
  }

  let reviewResult;
  try {
    reviewResult = await review({ store, candidate: storedCandidate, now });
  } catch (error) {
    throw wrapRuntimeError(error, 'PRODUCTION_ORDINARY_REVIEW_FAILED', '普通共享自动审核失败', 503);
  }
  return projectResult({ config, acceptance, reviewResult });
}

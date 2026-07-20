import { createHash } from 'node:crypto';
import { authenticateDevice, DeviceRegistrationError } from './device_registration_v1.js';
import {
  BlobRepositoryError,
  getJSONStrong,
  pendingSubmissionKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { canonicalize } from './submission_policy_v1.js';
import {
  evaluateSensitiveCandidate,
  normalizeSensitiveSubmission,
} from './sensitive_rules_policy_v1.js';

export class SensitiveSubmissionAcceptanceError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '敏感候选接收失败');
    this.name = 'SensitiveSubmissionAcceptanceError';
    this.code = code || 'SENSITIVE_SUBMISSION_ACCEPTANCE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

export function buildSensitiveSubmissionRequestHash(submission) {
  return `req_v1_${sha256Base64Url(canonicalize(submission))}`;
}

function toResult(candidate, duplicate = false) {
  return Object.freeze({
    schemaVersion: 1,
    submissionId: candidate.submission.submissionId,
    idempotencyKey: candidate.submission.idempotencyKey,
    dataType: candidate.submission.dataType,
    operation: candidate.submission.operation,
    status: candidate.status,
    decision: candidate.decision,
    reason: candidate.reason,
    receivedAt: candidate.receivedAt,
    duplicate,
    stored: candidate.stored !== false,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  });
}

function assertStoredCandidate(value) {
  if (!value || value.schemaVersion !== 1 || value.candidateKind !== 'sensitive_review'
      || !value.submission || typeof value.requestHash !== 'string') {
    throw new SensitiveSubmissionAcceptanceError(
      'INVALID_STORED_SENSITIVE_CANDIDATE',
      '已存敏感候选结构无效',
      500,
    );
  }
  let submission;
  try {
    submission = normalizeSensitiveSubmission(value.submission);
  } catch (error) {
    throw new SensitiveSubmissionAcceptanceError(
      error?.code || 'INVALID_STORED_SENSITIVE_CANDIDATE',
      '已存敏感候选提交无效',
      500,
      error?.details || null,
      error,
    );
  }
  if (!Number.isSafeInteger(value.receivedAt) || value.receivedAt <= 0
      || !Number.isSafeInteger(value.authenticatedTokenVersion) || value.authenticatedTokenVersion < 1
      || value.status !== 'pending_review' || value.decision !== 'pending_review'
      || typeof value.reason !== 'string' || !value.reason
      || value.publicMutationAllowed !== false || value.autoApprovalEnabled !== false
      || value.stored !== true) {
    throw new SensitiveSubmissionAcceptanceError(
      'INVALID_STORED_SENSITIVE_CANDIDATE',
      '已存敏感候选状态无效',
      500,
    );
  }
  return Object.freeze({ ...value, submission });
}

async function resolveStoredCandidate(store, key, requestHash) {
  const existing = await getJSONStrong(store, key);
  if (!existing) return null;
  const candidate = assertStoredCandidate(existing);
  if (candidate.requestHash !== requestHash) {
    throw new SensitiveSubmissionAcceptanceError(
      'IDEMPOTENCY_CONFLICT',
      '同一幂等键对应了不同敏感候选请求正文',
      409,
      {
        submissionId: candidate.submission.submissionId,
        idempotencyKey: candidate.submission.idempotencyKey,
      },
    );
  }
  return toResult(candidate, true);
}

async function resolvePublicBaseline({ submission, existingRecord, resolveExistingRecord }) {
  if (typeof resolveExistingRecord === 'function') {
    const resolved = await resolveExistingRecord({
      groupId: submission.groupId,
      libraryId: submission.libraryId,
      dataType: submission.dataType,
      businessKey: submission.businessKey,
      bossId: submission.bossId,
    });
    return resolved ?? null;
  }
  return existingRecord ?? null;
}

export async function acceptSensitiveSubmission({
  store,
  authorization,
  rawSubmission,
  existingRecord = null,
  resolveExistingRecord = null,
  now = Date.now(),
  authenticate = authenticateDevice,
} = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new SensitiveSubmissionAcceptanceError('INVALID_SERVER_TIME', '服务器时间无效', 500);
  }

  let identity;
  try {
    identity = await authenticate({ store, authorization, now });
  } catch (error) {
    if (error instanceof DeviceRegistrationError) {
      throw new SensitiveSubmissionAcceptanceError(error.code, error.message, error.status, error.details, error);
    }
    throw error;
  }

  let submission;
  try {
    submission = normalizeSensitiveSubmission(rawSubmission);
  } catch (error) {
    throw new SensitiveSubmissionAcceptanceError(
      error?.code || 'INVALID_SENSITIVE_SUBMISSION',
      error?.message || '敏感候选提交无效',
      400,
      error?.details || null,
      error,
    );
  }
  if (submission.deviceId !== identity.deviceId) {
    throw new SensitiveSubmissionAcceptanceError(
      'DEVICE_SCOPE_MISMATCH',
      'Authorization设备与提交deviceId不一致',
      403,
    );
  }

  const requestHash = buildSensitiveSubmissionRequestHash(submission);
  const key = pendingSubmissionKey(submission.libraryId, submission.idempotencyKey);
  const existingResult = await resolveStoredCandidate(store, key, requestHash);
  if (existingResult) return existingResult;

  const baseline = await resolvePublicBaseline({ submission, existingRecord, resolveExistingRecord });
  let eligibility;
  try {
    eligibility = evaluateSensitiveCandidate({
      submission,
      existingRecord: baseline,
      matchingDistinctDeviceCount: 1,
      trustedDevice: false,
      conflictingCandidateCount: 0,
    });
  } catch (error) {
    throw new SensitiveSubmissionAcceptanceError(
      error?.code || 'SENSITIVE_CANDIDATE_REJECTED',
      error?.message || '敏感候选分类失败',
      400,
      error?.details || null,
      error,
    );
  }

  if (eligibility.decision === 'duplicate_noop') {
    return toResult(Object.freeze({
      submission,
      status: 'duplicate_noop',
      decision: 'duplicate_noop',
      reason: eligibility.reason,
      receivedAt: now,
      stored: false,
    }), false);
  }
  if (eligibility.decision !== 'pending_review') {
    throw new SensitiveSubmissionAcceptanceError(
      'SENSITIVE_MANUAL_REVIEW_INVARIANT_BROKEN',
      '敏感候选未稳定进入人工审核',
      500,
      { decision: eligibility.decision, reason: eligibility.reason },
    );
  }

  const candidate = Object.freeze({
    schemaVersion: 1,
    candidateKind: 'sensitive_review',
    requestHash,
    status: 'pending_review',
    decision: 'pending_review',
    reason: eligibility.reason,
    baselineContentHash: eligibility.baselineContentHash,
    tombstoneRequested: eligibility.tombstoneRequested,
    submission,
    receivedAt: now,
    authenticatedTokenVersion: identity.tokenVersion,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
    stored: true,
  });

  try {
    await putJSONOnlyIfNew(store, key, candidate);
  } catch (error) {
    if (error instanceof BlobRepositoryError) {
      const raced = await resolveStoredCandidate(store, key, requestHash);
      if (raced) return raced;
      throw new SensitiveSubmissionAcceptanceError(
        'SENSITIVE_SUBMISSION_STORAGE_FAILED',
        '敏感候选不可变写入失败',
        503,
        error.details,
        error,
      );
    }
    throw error;
  }

  return toResult(candidate, false);
}

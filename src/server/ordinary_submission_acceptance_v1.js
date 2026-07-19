import { createHash } from 'node:crypto';
import { authenticateDevice, DeviceRegistrationError } from './device_registration_v1.js';
import {
  BlobRepositoryError,
  getJSONStrong,
  pendingSubmissionKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  canonicalize,
} from './submission_policy_v1.js';
import {
  evaluateOrdinaryCandidate,
  normalizeOrdinarySubmission,
} from './ordinary_types_policy_v1.js';

export class OrdinarySubmissionAcceptanceError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '普通共享候选接收失败');
    this.name = 'OrdinarySubmissionAcceptanceError';
    this.code = code || 'ORDINARY_SUBMISSION_ACCEPTANCE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('base64url');
}

export function buildOrdinarySubmissionRequestHash(submission) {
  return `req_v1_${sha256Base64Url(canonicalize(submission))}`;
}

function toResult(candidate, duplicate = false) {
  return Object.freeze({
    schemaVersion: 1,
    submissionId: candidate.submission.submissionId,
    idempotencyKey: candidate.submission.idempotencyKey,
    dataType: candidate.submission.dataType,
    status: candidate.status,
    decision: candidate.decision,
    receivedAt: candidate.receivedAt,
    duplicate,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  });
}

function assertStoredCandidate(value) {
  if (!value || value.schemaVersion !== 1 || !value.submission || typeof value.requestHash !== 'string') {
    throw new OrdinarySubmissionAcceptanceError('INVALID_STORED_CANDIDATE', '已存普通候选结构无效', 500);
  }
  let submission;
  try {
    submission = normalizeOrdinarySubmission(value.submission);
  } catch (error) {
    throw new OrdinarySubmissionAcceptanceError(
      error?.code || 'INVALID_STORED_CANDIDATE',
      '已存普通候选提交无效',
      500,
      error?.details || null,
      error,
    );
  }
  if (!Number.isSafeInteger(value.receivedAt) || value.receivedAt <= 0
      || !Number.isSafeInteger(value.authenticatedTokenVersion) || value.authenticatedTokenVersion < 1
      || value.publicMutationAllowed !== false || value.autoApprovalEnabled !== false) {
    throw new OrdinarySubmissionAcceptanceError('INVALID_STORED_CANDIDATE', '已存普通候选状态无效', 500);
  }
  return Object.freeze({ ...value, submission });
}

async function resolveExisting(store, key, requestHash) {
  const existing = await getJSONStrong(store, key);
  if (!existing) return null;
  const candidate = assertStoredCandidate(existing);
  if (candidate.requestHash !== requestHash) {
    throw new OrdinarySubmissionAcceptanceError(
      'IDEMPOTENCY_CONFLICT',
      '同一幂等键对应了不同普通共享请求正文',
      409,
      {
        submissionId: candidate.submission.submissionId,
        idempotencyKey: candidate.submission.idempotencyKey,
      },
    );
  }
  return toResult(candidate, true);
}

export async function acceptOrdinarySubmission({
  store,
  authorization,
  rawSubmission,
  now = Date.now(),
  authenticate = authenticateDevice,
} = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new OrdinarySubmissionAcceptanceError('INVALID_SERVER_TIME', '服务器时间无效', 500);
  }

  let identity;
  try {
    identity = await authenticate({ store, authorization, now });
  } catch (error) {
    if (error instanceof DeviceRegistrationError) {
      throw new OrdinarySubmissionAcceptanceError(error.code, error.message, error.status, error.details, error);
    }
    throw error;
  }

  let submission;
  try {
    submission = normalizeOrdinarySubmission(rawSubmission);
  } catch (error) {
    throw new OrdinarySubmissionAcceptanceError(
      error?.code || 'INVALID_SUBMISSION',
      error?.message || '普通共享提交无效',
      400,
      error?.details || null,
      error,
    );
  }
  if (submission.deviceId !== identity.deviceId) {
    throw new OrdinarySubmissionAcceptanceError('DEVICE_SCOPE_MISMATCH', 'Authorization设备与提交deviceId不一致', 403);
  }

  const requestHash = buildOrdinarySubmissionRequestHash(submission);
  const key = pendingSubmissionKey(submission.libraryId, submission.idempotencyKey);
  const existingResult = await resolveExisting(store, key, requestHash);
  if (existingResult) return existingResult;

  const eligibility = evaluateOrdinaryCandidate({
    submission,
    existingRecord: null,
    matchingDistinctDeviceCount: 1,
    trustedDevice: false,
    conflictingCandidateCount: 0,
  });
  const candidate = Object.freeze({
    schemaVersion: 1,
    requestHash,
    status: eligibility.decision === 'pending_review' ? 'pending_review' : 'waiting_confirmation',
    decision: eligibility.decision,
    reason: eligibility.reason,
    submission,
    receivedAt: now,
    authenticatedTokenVersion: identity.tokenVersion,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  });

  try {
    await putJSONOnlyIfNew(store, key, candidate);
  } catch (error) {
    if (error instanceof BlobRepositoryError) {
      const raced = await resolveExisting(store, key, requestHash);
      if (raced) return raced;
      throw new OrdinarySubmissionAcceptanceError(
        'SUBMISSION_STORAGE_FAILED',
        '普通共享候选不可变写入失败',
        503,
        error.details,
        error,
      );
    }
    throw error;
  }

  return toResult(candidate, false);
}

import { createHash } from 'node:crypto';
import { canonicalize, evaluateExactPriceCandidate, normalizeSubmission } from './submission_policy_v1.js';
import { authenticateDevice, DeviceRegistrationError } from './device_registration_v1.js';
import {
  BlobRepositoryError,
  getJSONStrong,
  pendingSubmissionKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';

export class SubmissionAcceptanceError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '候选提交接收失败');
    this.name = 'SubmissionAcceptanceError';
    this.code = code || 'SUBMISSION_ACCEPTANCE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('base64url');
}

export function buildSubmissionRequestHash(submission) {
  return `req_v1_${sha256Base64Url(canonicalize(submission))}`;
}

function toResult(candidate, duplicate = false) {
  return Object.freeze({
    schemaVersion: 1,
    submissionId: candidate.submission.submissionId,
    idempotencyKey: candidate.submission.idempotencyKey,
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
    throw new SubmissionAcceptanceError('INVALID_STORED_CANDIDATE', '已存候选结构无效', 500);
  }
  return value;
}

async function resolveExisting(store, key, requestHash) {
  const existing = await getJSONStrong(store, key);
  if (!existing) return null;
  assertStoredCandidate(existing);
  if (existing.requestHash !== requestHash) {
    throw new SubmissionAcceptanceError(
      'IDEMPOTENCY_CONFLICT',
      '同一幂等键对应了不同请求正文',
      409,
      { submissionId: existing.submission.submissionId, idempotencyKey: existing.submission.idempotencyKey },
    );
  }
  return toResult(existing, true);
}

export async function acceptSubmission({
  store,
  authorization,
  rawSubmission,
  now = Date.now(),
  authenticate = authenticateDevice,
} = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new SubmissionAcceptanceError('INVALID_SERVER_TIME', '服务器时间无效', 500);
  }

  let identity;
  try {
    identity = await authenticate({ store, authorization, now });
  } catch (error) {
    if (error instanceof DeviceRegistrationError) {
      throw new SubmissionAcceptanceError(error.code, error.message, error.status, error.details, error);
    }
    throw error;
  }

  let submission;
  try {
    submission = normalizeSubmission(rawSubmission);
  } catch (error) {
    throw new SubmissionAcceptanceError(error.code || 'INVALID_SUBMISSION', error.message, 400, error.details, error);
  }
  if (submission.deviceId !== identity.deviceId) {
    throw new SubmissionAcceptanceError('DEVICE_SCOPE_MISMATCH', 'Authorization设备与提交deviceId不一致', 403);
  }

  const requestHash = buildSubmissionRequestHash(submission);
  const key = pendingSubmissionKey(submission.libraryId, submission.idempotencyKey);
  const existingResult = await resolveExisting(store, key, requestHash);
  if (existingResult) return existingResult;

  const eligibility = evaluateExactPriceCandidate({
    submission,
    existingRecord: null,
    matchingDistinctDeviceCount: 1,
    trustedDevice: false,
    conflictingCandidateCount: 0,
  });
  const candidate = Object.freeze({
    schemaVersion: 1,
    requestHash,
    status: 'waiting_confirmation',
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
      throw new SubmissionAcceptanceError('SUBMISSION_STORAGE_FAILED', '候选提交不可变写入失败', 503, error.details, error);
    }
    throw error;
  }

  return toResult(candidate, false);
}

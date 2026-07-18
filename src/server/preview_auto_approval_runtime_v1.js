import {
  getJSONStrong,
  pendingSubmissionKey,
} from './blob_repository_v1.js';
import {
  buildPublicSnapshot,
  listValidPublicEvents,
  reviewExactPriceCandidate,
} from './auto_approval_engine_v1.js';
import {
  acceptPreviewSubmission,
  readPreviewWriteConfig,
} from './preview_write_runtime_v1.js';
import { normalizeSubmission } from './submission_policy_v1.js';

export const PREVIEW_AUTO_APPROVAL_CONFIG_VERSION = 1;

export class PreviewAutoApprovalError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '隔离预览自动审核失败');
    this.name = 'PreviewAutoApprovalError';
    this.code = code || 'PREVIEW_AUTO_APPROVAL_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function normalizeScopePart(value) {
  return String(value || '').trim().toLowerCase();
}

export function readPreviewAutoApprovalConfig(env = {}) {
  const writeConfig = readPreviewWriteConfig(env);
  if (String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new PreviewAutoApprovalError(
      'PREVIEW_AUTO_APPROVAL_DISABLED',
      '隔离预览自动审核未开启',
      503,
    );
  }
  return Object.freeze({
    schemaVersion: PREVIEW_AUTO_APPROVAL_CONFIG_VERSION,
    ...writeConfig,
    previewAutoApprovalEnabled: true,
  });
}

export function assertPreviewAutoApprovalScope(groupId, libraryId, config) {
  const group = normalizeScopePart(groupId);
  const library = normalizeScopePart(libraryId);
  if (group !== config?.allowedGroupId || library !== config?.allowedLibraryId) {
    throw new PreviewAutoApprovalError(
      'PREVIEW_SCOPE_FORBIDDEN',
      '隔离预览自动审核只允许合成测试团和测试价格库',
      403,
      {
        allowedGroupId: config?.allowedGroupId || null,
        allowedLibraryId: config?.allowedLibraryId || null,
      },
    );
  }
  return Object.freeze({ groupId: group, libraryId: library });
}

function normalizeCandidateSubmission(rawSubmission) {
  try {
    return normalizeSubmission(rawSubmission);
  } catch (error) {
    throw new PreviewAutoApprovalError(
      error?.code || 'INVALID_SUBMISSION',
      error?.message || '候选提交格式无效',
      400,
      error?.details || null,
      error,
    );
  }
}

export async function acceptAndReviewPreviewSubmission({
  store,
  authorization,
  rawSubmission,
  env,
  now = Date.now(),
  authenticate,
  accept = acceptPreviewSubmission,
  review = reviewExactPriceCandidate,
  trustedDeviceResolver,
} = {}) {
  const config = readPreviewAutoApprovalConfig(env);
  const submission = normalizeCandidateSubmission(rawSubmission);
  assertPreviewAutoApprovalScope(submission.groupId, submission.libraryId, config);

  const acceptance = await accept({
    store,
    authorization,
    rawSubmission: submission,
    env,
    now,
    ...(authenticate ? { authenticate } : {}),
  });

  const candidateKey = pendingSubmissionKey(submission.libraryId, submission.idempotencyKey);
  const candidate = await getJSONStrong(store, candidateKey);
  if (!candidate) {
    throw new PreviewAutoApprovalError(
      'ACCEPTED_CANDIDATE_NOT_FOUND',
      '候选接收成功后未能强一致读取候选记录',
      503,
      { candidateKey },
    );
  }

  const reviewed = await review({
    store,
    candidate,
    now,
    ...(trustedDeviceResolver ? { trustedDeviceResolver } : {}),
  });

  return Object.freeze({
    schemaVersion: PREVIEW_AUTO_APPROVAL_CONFIG_VERSION,
    submissionId: submission.submissionId,
    idempotencyKey: submission.idempotencyKey,
    duplicate: Boolean(acceptance?.duplicate),
    status: reviewed.status,
    decision: reviewed.decision,
    reason: reviewed.reason,
    approvalMode: reviewed.approvalMode,
    baselineApprovedVersion: reviewed.baselineApprovedVersion,
    matchingDistinctDeviceCount: reviewed.matchingDistinctDeviceCount,
    conflictingCandidateCount: reviewed.conflictingCandidateCount,
    changeRatio: reviewed.changeRatio,
    previewPublicVersion: reviewed.publicVersion,
    previewEventVersion: reviewed.eventVersion,
    previewSnapshotKey: reviewed.snapshotKey,
    previewMutationApplied: Boolean(reviewed.publicMutationApplied),
    previewDuplicateApproval: Boolean(reviewed.duplicateApproval),
    previewAutoApprovalEnabled: true,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  });
}

export async function readPreviewPublicSnapshot({
  store,
  env,
  groupId,
  libraryId,
  now = Date.now(),
} = {}) {
  const config = readPreviewAutoApprovalConfig(env);
  const scope = assertPreviewAutoApprovalScope(groupId, libraryId, config);
  return buildPublicSnapshot({ store, ...scope, now });
}

export async function readPreviewPublicEvents({
  store,
  env,
  groupId,
  libraryId,
} = {}) {
  const config = readPreviewAutoApprovalConfig(env);
  const scope = assertPreviewAutoApprovalScope(groupId, libraryId, config);
  const events = await listValidPublicEvents({ store, libraryId: scope.libraryId });
  for (const event of events) {
    if (event.groupId !== scope.groupId || event.libraryId !== scope.libraryId) {
      throw new PreviewAutoApprovalError(
        'PREVIEW_PUBLIC_EVENT_SCOPE_MISMATCH',
        '动态公共事件作用域与隔离预览不一致',
        500,
        { eventKey: event.eventKey },
      );
    }
  }
  return events;
}

export function projectPreviewPublicEvent(event) {
  return Object.freeze({
    version: event.version,
    approvedAt: event.approvedAt,
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    dataType: event.dataType,
    operation: event.operation,
    payload: event.payload,
  });
}

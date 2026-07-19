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
import { readEffectiveDeviceGovernance } from './device_governance_v1.js';
import { normalizeSubmission } from './submission_policy_v1.js';
import {
  buildOrdinaryPublicSnapshot,
  listValidOrdinaryPublicEvents,
  reviewOrdinaryCandidate,
} from './ordinary_public_engine_v1.js';
import { normalizeOrdinarySubmission } from './ordinary_types_policy_v1.js';
import {
  acceptPreviewOrdinarySubmission,
  readOrdinaryTypesRuntimeConfig,
} from './ordinary_types_preview_runtime_v1.js';

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

function ordinaryTypesGateEnabled(env = {}) {
  return String(env.CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED || '').trim() === '1';
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
  const ordinaryTypesEnabled = ordinaryTypesGateEnabled(env);
  if (ordinaryTypesEnabled) readOrdinaryTypesRuntimeConfig(env);
  return Object.freeze({
    schemaVersion: PREVIEW_AUTO_APPROVAL_CONFIG_VERSION,
    ...writeConfig,
    previewAutoApprovalEnabled: true,
    ordinaryTypesEnabled,
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

function normalizeCandidateSubmission(rawSubmission, ordinaryTypesEnabled) {
  try {
    return ordinaryTypesEnabled
      ? normalizeOrdinarySubmission(rawSubmission)
      : normalizeSubmission(rawSubmission);
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

export async function governanceTrustedDeviceResolver(store, deviceId) {
  const state = await readEffectiveDeviceGovernance({ store, deviceId });
  return state.trusted === true && state.blocked === false;
}

export async function acceptAndReviewPreviewSubmission({
  store,
  authorization,
  rawSubmission,
  env,
  now = Date.now(),
  authenticate,
  accept = null,
  review = null,
  trustedDeviceResolver = governanceTrustedDeviceResolver,
} = {}) {
  const config = readPreviewAutoApprovalConfig(env);
  const ordinaryTypesEnabled = config.ordinaryTypesEnabled === true;
  const submission = normalizeCandidateSubmission(rawSubmission, ordinaryTypesEnabled);
  assertPreviewAutoApprovalScope(submission.groupId, submission.libraryId, config);

  const acceptOperation = accept || (ordinaryTypesEnabled
    ? acceptPreviewOrdinarySubmission
    : acceptPreviewSubmission);
  const reviewOperation = review || (ordinaryTypesEnabled
    ? reviewOrdinaryCandidate
    : reviewExactPriceCandidate);

  const acceptance = await acceptOperation({
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

  const reviewed = await reviewOperation({
    store,
    candidate,
    now,
    trustedDeviceResolver,
  });

  return Object.freeze({
    schemaVersion: PREVIEW_AUTO_APPROVAL_CONFIG_VERSION,
    submissionId: submission.submissionId,
    idempotencyKey: submission.idempotencyKey,
    dataType: submission.dataType,
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
    previewOrdinaryTypesEnabled: ordinaryTypesEnabled,
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
  return config.ordinaryTypesEnabled
    ? buildOrdinaryPublicSnapshot({ store, ...scope, now })
    : buildPublicSnapshot({ store, ...scope, now });
}

export async function readPreviewPublicEvents({
  store,
  env,
  groupId,
  libraryId,
} = {}) {
  const config = readPreviewAutoApprovalConfig(env);
  const scope = assertPreviewAutoApprovalScope(groupId, libraryId, config);
  const events = config.ordinaryTypesEnabled
    ? await listValidOrdinaryPublicEvents({ store, libraryId: scope.libraryId })
    : await listValidPublicEvents({ store, libraryId: scope.libraryId });
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

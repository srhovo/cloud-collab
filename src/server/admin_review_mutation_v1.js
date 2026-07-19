import { createHash } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  buildPublicSnapshot,
  publishAdminReviewApproval,
} from './auto_approval_engine_v1.js';
import {
  ADMIN_REVIEW_ALLOWED_GROUP_ID,
  ADMIN_REVIEW_ALLOWED_LIBRARY_ID,
  ADMIN_REVIEW_PREVIEW_STORE_NAME,
  adminReviewResolutionKey,
  getAdminReviewMutationTarget,
  isAdminReviewId,
  readAdminReviewConfig,
} from './admin_review_projection_v1.js';
import {
  canonicalize,
  computeSubmissionHashes,
  normalizeSubmission,
} from './submission_policy_v1.js';

export const ADMIN_REVIEW_MUTATION_SCHEMA_VERSION = 1;
export const ADMIN_REVIEW_MUTATION_MAX_BODY_BYTES = 1024;

const DECISION_ID_PATTERN = /^rd_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^au_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^arq_v1_[A-Za-z0-9_-]{43}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBMISSION_ID_PATTERN = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;
const ACTIONS = new Set(['approve', 'reject', 'edit_and_approve']);
const REJECT_REASONS = new Set([
  'invalid_price',
  'insufficient_evidence',
  'conflicting_candidates',
  'outdated_baseline',
  'unsupported_change',
]);

export const ADMIN_REVIEW_MUTATION_CAPABILITIES = Object.freeze({
  reviewQueueRead: true,
  reviewDetailRead: true,
  reviewMutation: true,
  reviewApprove: true,
  reviewReject: true,
  reviewEditAndApprove: true,
  deviceMutation: false,
  rollback: false,
  export: false,
  publicMutationAllowed: true,
  syntheticFixtureOnly: true,
});

export class AdminReviewMutationError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员审核写入失败');
    this.name = 'AdminReviewMutationError';
    this.code = code || 'ADMIN_REVIEW_MUTATION_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message, status = 400) {
  if (!isPlainObject(value)) throw new AdminReviewMutationError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AdminReviewMutationError(code, message, status, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function assertSafeTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_MUTATION_TIME_INVALID', '管理员审核时间无效', 500);
  }
  return value;
}

function requestHashFor(command) {
  return `arq_v1_${sha256Base64Url(canonicalize({
    schemaVersion: ADMIN_REVIEW_MUTATION_SCHEMA_VERSION,
    action: command.action,
    reviewId: command.reviewId,
    reasonCode: command.reasonCode,
    unitPrice: command.unitPrice,
  }))}`;
}

function decisionIdFor(reviewId, requestHash) {
  return `rd_v1_${sha256Base64Url(canonicalize({ reviewId, requestHash }))}`;
}

function auditIdFor(decisionId) {
  return `au_v1_${sha256Base64Url(decisionId)}`;
}

function actorTagFor(identity) {
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!username) throw new AdminReviewMutationError('ADMIN_REVIEW_ACTOR_INVALID', '管理员身份无效', 401);
  return `admin_${sha256Base64Url(username).slice(0, 12)}`;
}

function decisionKey(config, reviewId) {
  return `reviews/${config.libraryId}/decisions/${reviewId}.json`;
}

function completionKey(config, reviewId) {
  return `reviews/${config.libraryId}/completions/${reviewId}.json`;
}

function approvalCycleKey(config, businessKey, baselineApprovedVersion) {
  return `reviews/${config.libraryId}/approval-cycles/${businessKey}/pv_${String(baselineApprovedVersion).padStart(12, '0')}.json`;
}

function auditKey(auditId, createdAt) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_AUDIT_TIME_INVALID', '审核审计时间无效', 500);
  }
  return `audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`;
}

function isAlreadyExists(error) {
  return error instanceof BlobRepositoryError && error.code === 'BLOB_ALREADY_EXISTS';
}

async function putImmutableExact(store, key, value, conflictCode, conflictMessage) {
  try {
    await putJSONOnlyIfNew(store, key, value);
    return Object.freeze({ value, created: true });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || canonicalize(existing) !== canonicalize(value)) {
      throw new AdminReviewMutationError(conflictCode, conflictMessage, 409, null, error);
    }
    return Object.freeze({ value: existing, created: false });
  }
}

function normalizeBaseline(value) {
  assertExactKeys(
    value,
    ['approvedVersion', 'contentHash', 'unitPrice'],
    'ADMIN_REVIEW_DECISION_INVALID',
    '管理员审核基线结构无效',
    503,
  );
  if (!Number.isSafeInteger(value.approvedVersion) || value.approvedVersion < 0
      || (value.approvedVersion === 0) !== (value.contentHash === null && value.unitPrice === null)
      || (value.approvedVersion > 0 && (!CONTENT_HASH_PATTERN.test(String(value.contentHash || ''))
        || !Number.isFinite(value.unitPrice) || value.unitPrice <= 0))) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_DECISION_INVALID', '管理员审核基线内容无效', 503);
  }
  return Object.freeze({
    approvedVersion: value.approvedVersion,
    contentHash: value.contentHash,
    unitPrice: value.unitPrice,
  });
}

function normalizeEvidence(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_DECISION_INVALID', '管理员审核证据数量无效', 503);
  }
  const devices = new Set();
  const submissions = new Set();
  const normalized = value.map(item => {
    assertExactKeys(
      item,
      ['deviceId', 'submissionId'],
      'ADMIN_REVIEW_DECISION_INVALID',
      '管理员审核证据结构无效',
      503,
    );
    if (!DEVICE_ID_PATTERN.test(String(item.deviceId || ''))
        || !SUBMISSION_ID_PATTERN.test(String(item.submissionId || ''))
        || devices.has(item.deviceId) || submissions.has(item.submissionId)) {
      throw new AdminReviewMutationError('ADMIN_REVIEW_DECISION_INVALID', '管理员审核证据内容无效', 503);
    }
    devices.add(item.deviceId);
    submissions.add(item.submissionId);
    return Object.freeze({ deviceId: item.deviceId, submissionId: item.submissionId });
  });
  return Object.freeze(normalized);
}

function normalizeRelatedReviews(value, selectedReviewId) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_DECISION_INVALID', '关联审核项目数量无效', 503);
  }
  const ids = new Set();
  const normalized = value.map(item => {
    assertExactKeys(
      item,
      ['reviewId', 'contentHash'],
      'ADMIN_REVIEW_DECISION_INVALID',
      '关联审核项目结构无效',
      503,
    );
    if (!isAdminReviewId(item.reviewId) || !CONTENT_HASH_PATTERN.test(String(item.contentHash || ''))
        || ids.has(item.reviewId)) {
      throw new AdminReviewMutationError('ADMIN_REVIEW_DECISION_INVALID', '关联审核项目内容无效', 503);
    }
    ids.add(item.reviewId);
    return Object.freeze({ reviewId: item.reviewId, contentHash: item.contentHash });
  });
  if (!ids.has(selectedReviewId)) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_DECISION_INVALID', '关联审核项目缺少当前目标', 503);
  }
  return Object.freeze(normalized);
}

function assertDecisionRecord(value, config, expectedRequestHash = null) {
  assertExactKeys(value, [
    'schemaVersion', 'decisionId', 'reviewId', 'action', 'requestHash', 'actorTag',
    'createdAt', 'groupId', 'libraryId', 'businessKey', 'baseline', 'sourceSubmission',
    'targetSubmission', 'evidence', 'relatedReviews', 'reasonCode',
  ], 'ADMIN_REVIEW_DECISION_INVALID', '管理员审核决策声明结构无效', 503);
  if (value.schemaVersion !== ADMIN_REVIEW_MUTATION_SCHEMA_VERSION
      || !DECISION_ID_PATTERN.test(String(value.decisionId || ''))
      || !isAdminReviewId(value.reviewId)
      || !ACTIONS.has(value.action)
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || (expectedRequestHash && value.requestHash !== expectedRequestHash)
      || !ACTOR_TAG_PATTERN.test(String(value.actorTag || ''))
      || value.groupId !== config.groupId
      || value.libraryId !== config.libraryId
      || !BUSINESS_KEY_PATTERN.test(String(value.businessKey || ''))
      || value.decisionId !== decisionIdFor(value.reviewId, value.requestHash)) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_DECISION_INVALID', '管理员审核决策声明内容无效', 503);
  }
  assertSafeTime(value.createdAt);
  const baseline = normalizeBaseline(value.baseline);
  let sourceSubmission;
  let targetSubmission = null;
  try {
    sourceSubmission = normalizeSubmission(value.sourceSubmission);
    if (value.targetSubmission !== null) targetSubmission = normalizeSubmission(value.targetSubmission);
  } catch (error) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_DECISION_INVALID', '管理员审核决策候选无效', 503, null, error);
  }
  const evidence = normalizeEvidence(value.evidence);
  const relatedReviews = normalizeRelatedReviews(value.relatedReviews, value.reviewId);
  const rejectValid = value.action === 'reject'
    && value.targetSubmission === null
    && REJECT_REASONS.has(value.reasonCode);
  const approvalValid = value.action === 'approve'
    && targetSubmission?.contentHash === sourceSubmission.contentHash
    && value.reasonCode === null;
  const editedValid = value.action === 'edit_and_approve'
    && targetSubmission
    && targetSubmission.businessKey === sourceSubmission.businessKey
    && targetSubmission.contentHash !== sourceSubmission.contentHash
    && value.reasonCode === null;
  if ((!rejectValid && !approvalValid && !editedValid)
      || sourceSubmission.groupId !== config.groupId
      || sourceSubmission.libraryId !== config.libraryId
      || sourceSubmission.businessKey !== value.businessKey
      || (targetSubmission && (targetSubmission.groupId !== config.groupId
        || targetSubmission.libraryId !== config.libraryId
        || targetSubmission.businessKey !== value.businessKey))) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_DECISION_INVALID', '管理员审核决策候选关联无效', 503);
  }
  return Object.freeze({
    ...value,
    baseline,
    sourceSubmission,
    targetSubmission,
    evidence,
    relatedReviews,
  });
}

function assertCompletionRecord(value, decision) {
  assertExactKeys(value, [
    'schemaVersion', 'decisionId', 'auditId', 'reviewId', 'action', 'status',
    'completedAt', 'targetContentHash', 'publicVersion', 'eventVersion', 'approvalId',
    'publicMutationApplied', 'resolvedReviewCount',
  ], 'ADMIN_REVIEW_COMPLETION_INVALID', '管理员审核完成记录结构无效', 503);
  const approval = decision.action !== 'reject';
  if (value.schemaVersion !== ADMIN_REVIEW_MUTATION_SCHEMA_VERSION
      || value.decisionId !== decision.decisionId
      || !AUDIT_ID_PATTERN.test(String(value.auditId || ''))
      || value.reviewId !== decision.reviewId
      || value.action !== decision.action
      || !['approved_by_admin', 'edited_and_approved', 'rejected'].includes(value.status)
      || value.targetContentHash !== (decision.targetSubmission?.contentHash ?? null)
      || !Number.isSafeInteger(value.publicVersion) || value.publicVersion < 0
      || typeof value.publicMutationApplied !== 'boolean'
      || !Number.isSafeInteger(value.resolvedReviewCount) || value.resolvedReviewCount < 1
      || (approval && (!Number.isSafeInteger(value.eventVersion) || value.eventVersion < 1
        || typeof value.approvalId !== 'string' || !value.approvalId.startsWith('ap_v1_')))
      || (decision.action === 'approve' && value.status !== 'approved_by_admin')
      || (decision.action === 'edit_and_approve' && value.status !== 'edited_and_approved')
      || (decision.action === 'reject' && value.status !== 'rejected')
      || (!approval && (value.eventVersion !== null || value.approvalId !== null
        || value.publicMutationApplied !== false))) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_COMPLETION_INVALID', '管理员审核完成记录内容无效', 503);
  }
  assertSafeTime(value.completedAt);
  return Object.freeze({ ...value });
}

export function readAdminReviewMutationConfig(env = {}) {
  if (String(env.CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new AdminReviewMutationError('ADMIN_REVIEW_MUTATION_PREVIEW_DISABLED', '管理员审核写入预览未开启', 503);
  }
  const review = readAdminReviewConfig(env);
  if (review.storeName !== ADMIN_REVIEW_PREVIEW_STORE_NAME
      || review.groupId !== ADMIN_REVIEW_ALLOWED_GROUP_ID
      || review.libraryId !== ADMIN_REVIEW_ALLOWED_LIBRARY_ID) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_MUTATION_SCOPE_INVALID', '管理员审核写入作用域无效', 503);
  }
  return Object.freeze({ ...review, mutationPreviewEnabled: true });
}

export function normalizeAdminReviewCommand(action, input) {
  const normalizedAction = String(action || '').trim();
  if (!ACTIONS.has(normalizedAction)) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_ACTION_INVALID', '管理员审核动作无效', 400);
  }
  if (normalizedAction === 'approve') {
    assertExactKeys(input, ['reviewId', 'confirmation'], 'ADMIN_REVIEW_BODY_INVALID', '批准请求字段无效');
    if (input.confirmation !== 'APPROVE') {
      throw new AdminReviewMutationError('ADMIN_REVIEW_CONFIRMATION_REQUIRED', '批准请求缺少明确确认', 400);
    }
    if (!isAdminReviewId(input.reviewId)) {
      throw new AdminReviewMutationError('ADMIN_REVIEW_ID_INVALID', '审核项目ID无效', 400);
    }
    return Object.freeze({ action: normalizedAction, reviewId: input.reviewId, reasonCode: null, unitPrice: null });
  }
  if (normalizedAction === 'reject') {
    assertExactKeys(input, ['reviewId', 'confirmation', 'reasonCode'], 'ADMIN_REVIEW_BODY_INVALID', '拒绝请求字段无效');
    if (input.confirmation !== 'REJECT') {
      throw new AdminReviewMutationError('ADMIN_REVIEW_CONFIRMATION_REQUIRED', '拒绝请求缺少明确确认', 400);
    }
    if (!isAdminReviewId(input.reviewId) || !REJECT_REASONS.has(input.reasonCode)) {
      throw new AdminReviewMutationError('ADMIN_REVIEW_REJECTION_INVALID', '拒绝原因或审核项目ID无效', 400);
    }
    return Object.freeze({ action: normalizedAction, reviewId: input.reviewId, reasonCode: input.reasonCode, unitPrice: null });
  }
  assertExactKeys(input, ['reviewId', 'confirmation', 'unitPrice'], 'ADMIN_REVIEW_BODY_INVALID', '编辑后批准请求字段无效');
  if (input.confirmation !== 'EDIT_AND_APPROVE') {
    throw new AdminReviewMutationError('ADMIN_REVIEW_CONFIRMATION_REQUIRED', '编辑后批准请求缺少明确确认', 400);
  }
  if (!isAdminReviewId(input.reviewId)) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_ID_INVALID', '审核项目ID无效', 400);
  }
  return Object.freeze({ action: normalizedAction, reviewId: input.reviewId, reasonCode: null, unitPrice: input.unitPrice });
}

function buildEditedSubmission(source, unitPrice) {
  const draft = {
    ...source,
    payload: { ...source.payload, unitPrice },
  };
  let computed;
  try {
    computed = computeSubmissionHashes(draft);
  } catch (error) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_EDIT_INVALID', '编辑后的普通单价格式无效', 400, null, error);
  }
  const edited = {
    ...draft,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
  };
  try {
    return normalizeSubmission(edited);
  } catch (error) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_EDIT_INVALID', '编辑后的候选无法通过协议校验', 400, null, error);
  }
}

function buildDecision({ target, command, identity, requestHash, now }) {
  const targetSubmission = command.action === 'reject'
    ? null
    : command.action === 'approve'
      ? target.submission
      : buildEditedSubmission(target.submission, command.unitPrice);
  if (command.action === 'edit_and_approve'
      && targetSubmission.payload.unitPrice === target.submission.payload.unitPrice) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_EDIT_NO_CHANGE', '编辑后批准必须实际修改普通单价', 400);
  }
  const decisionId = decisionIdFor(command.reviewId, requestHash);
  return Object.freeze({
    schemaVersion: ADMIN_REVIEW_MUTATION_SCHEMA_VERSION,
    decisionId,
    reviewId: command.reviewId,
    action: command.action,
    requestHash,
    actorTag: actorTagFor(identity),
    createdAt: now,
    groupId: target.scope.groupId,
    libraryId: target.scope.libraryId,
    businessKey: target.submission.businessKey,
    baseline: Object.freeze({
      approvedVersion: target.baseline.approvedVersion,
      contentHash: target.baseline.contentHash,
      unitPrice: target.baseline.unitPrice,
    }),
    sourceSubmission: target.submission,
    targetSubmission,
    evidence: target.evidence,
    relatedReviews: target.relatedReviews,
    reasonCode: command.reasonCode,
  });
}

async function ensureApprovalCycleClaim(store, config, decision) {
  if (decision.action === 'reject') return;
  const key = approvalCycleKey(config, decision.businessKey, decision.baseline.approvedVersion);
  const claim = Object.freeze({
    schemaVersion: ADMIN_REVIEW_MUTATION_SCHEMA_VERSION,
    decisionId: decision.decisionId,
    reviewId: decision.reviewId,
    businessKey: decision.businessKey,
    baselineApprovedVersion: decision.baseline.approvedVersion,
    targetContentHash: decision.targetSubmission.contentHash,
    createdAt: decision.createdAt,
  });
  await putImmutableExact(
    store,
    key,
    claim,
    'ADMIN_REVIEW_BASELINE_ALREADY_CLAIMED',
    '同一公共基线已经由另一项管理员审核占用',
  );
}

function buildAudit(decision, outcome) {
  const auditId = auditIdFor(decision.decisionId);
  return Object.freeze({
    schemaVersion: ADMIN_REVIEW_MUTATION_SCHEMA_VERSION,
    auditId,
    decisionId: decision.decisionId,
    reviewId: decision.reviewId,
    action: decision.action,
    actorTag: decision.actorTag,
    occurredAt: decision.createdAt,
    groupId: decision.groupId,
    libraryId: decision.libraryId,
    businessKey: decision.businessKey,
    baselineApprovedVersion: decision.baseline.approvedVersion,
    sourceContentHash: decision.sourceSubmission.contentHash,
    targetContentHash: decision.targetSubmission?.contentHash ?? null,
    reasonCode: decision.reasonCode,
    publicVersion: outcome.publicVersion,
    eventVersion: outcome.eventVersion,
    approvalId: outcome.approvalId,
    publicMutationApplied: outcome.publicMutationApplied,
    evidenceCount: decision.evidence.length,
    relatedReviewCount: decision.relatedReviews.length,
  });
}

function resolutionFor(decision, auditId, item, action) {
  return Object.freeze({
    schemaVersion: ADMIN_REVIEW_MUTATION_SCHEMA_VERSION,
    reviewId: item.reviewId,
    decisionId: decision.decisionId,
    auditId,
    action,
    groupId: decision.groupId,
    libraryId: decision.libraryId,
    businessKey: decision.businessKey,
    baselineApprovedVersion: decision.baseline.approvedVersion,
    sourceContentHash: item.contentHash,
    targetContentHash: decision.targetSubmission?.contentHash ?? null,
    resolvedAt: decision.createdAt,
  });
}

async function executeDecision({ store, config, decision }) {
  let outcome;
  if (decision.action === 'reject') {
    const snapshot = await buildPublicSnapshot({
      store,
      groupId: decision.groupId,
      libraryId: decision.libraryId,
      now: decision.createdAt,
    });
    outcome = Object.freeze({
      status: 'rejected',
      publicVersion: snapshot.publicVersion,
      eventVersion: null,
      approvalId: null,
      publicMutationApplied: false,
    });
  } else {
    const published = await publishAdminReviewApproval({
      store,
      submission: decision.targetSubmission,
      baseline: decision.baseline,
      approvalMode: decision.action === 'approve' ? 'admin_approved' : 'admin_edit_and_approved',
      evidence: decision.evidence,
      now: decision.createdAt,
    });
    outcome = Object.freeze({
      status: decision.action === 'approve' ? 'approved_by_admin' : 'edited_and_approved',
      publicVersion: published.snapshot.publicVersion,
      eventVersion: published.event.version,
      approvalId: published.approvalId,
      publicMutationApplied: true,
    });
  }

  const audit = buildAudit(decision, outcome);
  await putImmutableExact(
    store,
    auditKey(audit.auditId, decision.createdAt),
    audit,
    'ADMIN_REVIEW_AUDIT_CONFLICT',
    '管理员审核审计记录冲突',
  );

  const resolved = decision.action === 'reject'
    ? decision.relatedReviews.filter(item => item.reviewId === decision.reviewId)
    : decision.relatedReviews;
  for (const item of resolved) {
    const action = item.reviewId === decision.reviewId
      ? outcome.status
      : 'superseded';
    const resolution = resolutionFor(decision, audit.auditId, item, action);
    await putImmutableExact(
      store,
      adminReviewResolutionKey(config.libraryId, item.reviewId),
      resolution,
      'ADMIN_REVIEW_RESOLUTION_CONFLICT',
      '管理员审核归档记录冲突',
    );
  }

  const completion = Object.freeze({
    schemaVersion: ADMIN_REVIEW_MUTATION_SCHEMA_VERSION,
    decisionId: decision.decisionId,
    auditId: audit.auditId,
    reviewId: decision.reviewId,
    action: decision.action,
    status: outcome.status,
    completedAt: decision.createdAt,
    targetContentHash: decision.targetSubmission?.contentHash ?? null,
    publicVersion: outcome.publicVersion,
    eventVersion: outcome.eventVersion,
    approvalId: outcome.approvalId,
    publicMutationApplied: outcome.publicMutationApplied,
    resolvedReviewCount: resolved.length,
  });
  await putImmutableExact(
    store,
    completionKey(config, decision.reviewId),
    completion,
    'ADMIN_REVIEW_COMPLETION_CONFLICT',
    '管理员审核完成记录冲突',
  );
  return assertCompletionRecord(completion, decision);
}

function projectCompletion(completion, duplicate) {
  return Object.freeze({
    reviewId: completion.reviewId,
    decisionId: completion.decisionId,
    auditId: completion.auditId,
    action: completion.action,
    status: completion.status,
    targetContentHash: completion.targetContentHash,
    publicVersion: completion.publicVersion,
    eventVersion: completion.eventVersion,
    approvalId: completion.approvalId,
    publicMutationApplied: completion.publicMutationApplied,
    resolvedReviewCount: completion.resolvedReviewCount,
    duplicate,
  });
}

export async function mutateAdminReview({
  store,
  config,
  identity,
  command,
  now = Date.now(),
} = {}) {
  assertSafeTime(now);
  if (!config?.mutationPreviewEnabled) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_MUTATION_PREVIEW_DISABLED', '管理员审核写入预览未开启', 503);
  }
  const normalizedCommand = normalizeAdminReviewCommand(command?.action, command?.input || command);
  const requestHash = requestHashFor(normalizedCommand);
  const key = decisionKey(config, normalizedCommand.reviewId);
  const existing = await getJSONStrong(store, key);
  let decision;
  if (existing) {
    decision = assertDecisionRecord(existing, config);
    if (decision.requestHash !== requestHash) {
      throw new AdminReviewMutationError('ADMIN_REVIEW_ALREADY_DECIDED', '该审核项目已经由另一项决策占用', 409);
    }
    const completed = await getJSONStrong(store, completionKey(config, normalizedCommand.reviewId));
    if (completed) return projectCompletion(assertCompletionRecord(completed, decision), true);
  } else {
    const target = await getAdminReviewMutationTarget({
      store,
      config,
      reviewId: normalizedCommand.reviewId,
    });
    if (normalizedCommand.action !== 'reject' && target.baseline.stillCurrent !== true) {
      throw new AdminReviewMutationError('ADMIN_REVIEW_STALE_BASELINE', '公共基线已变化，不能批准该候选', 409);
    }
    decision = assertDecisionRecord(buildDecision({
      target,
      command: normalizedCommand,
      identity,
      requestHash,
      now,
    }), config, requestHash);
    await ensureApprovalCycleClaim(store, config, decision);
    const written = await putImmutableExact(
      store,
      key,
      decision,
      'ADMIN_REVIEW_ALREADY_DECIDED',
      '该审核项目已经由另一项决策占用',
    );
    decision = assertDecisionRecord(written.value, config, requestHash);
  }
  const completion = await executeDecision({ store, config, decision });
  return projectCompletion(completion, false);
}

export function isAdminReviewMutationProjectionSafe(value) {
  const text = JSON.stringify(value);
  return !/dev_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/sub_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/ik_v1_[A-Za-z0-9_-]{43}/.test(text)
    && !text.includes('reviews/')
    && !text.includes('submissions/')
    && !text.includes('audit/');
}

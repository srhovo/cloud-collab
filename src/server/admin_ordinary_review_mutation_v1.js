import { createHash } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  buildOrdinaryPublicSnapshot,
  publishAdminOrdinaryApproval,
} from './ordinary_public_engine_v1.js';
import {
  getAdminOrdinaryReviewMutationTarget,
  readAdminOrdinaryReviewConfig,
} from './admin_ordinary_review_projection_v1.js';
import {
  canonicalize,
} from './submission_policy_v1.js';
import {
  computeOrdinarySubmissionHashes,
  normalizeOrdinarySubmission,
} from './ordinary_types_policy_v1.js';
import {
  adminReviewResolutionKey,
} from './admin_review_key_v1.js';

export const ADMIN_ORDINARY_REVIEW_MUTATION_VERSION = 1;
export const ADMIN_ORDINARY_REVIEW_MUTATION_MAX_BODY_BYTES = 2048;

const REVIEW_ID_PATTERN = /^rv_v1_[A-Za-z0-9_-]{43}$/;
const DECISION_ID_PATTERN = /^rd_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^au_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;
const ACTIONS = new Set(['approve', 'reject', 'edit_and_approve']);
const REJECT_REASONS = new Set([
  'invalid_data',
  'insufficient_evidence',
  'conflicting_candidates',
  'unsupported_change',
]);
const STAGE5G_RESOLVABLE_REASONS = new Set([
  'candidate_conflict',
  'playable_name_public_conflict',
]);

export const ADMIN_ORDINARY_REVIEW_MUTATION_CAPABILITIES = Object.freeze({
  reviewQueueRead: true,
  reviewDetailRead: true,
  reviewMutation: true,
  reviewApprove: true,
  reviewReject: true,
  reviewEditAndApprove: true,
  ordinaryTypes: Object.freeze(['playable_name', 'boss_profile']),
  exactPriceUsesExistingStage5C: true,
  stage6SensitiveChangesBlocked: true,
  publicMutationAllowed: true,
  syntheticFixtureOnly: true,
});

export class AdminOrdinaryReviewMutationError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员普通共享审核写入失败');
    this.name = 'AdminOrdinaryReviewMutationError';
    this.code = code || 'ADMIN_ORDINARY_REVIEW_MUTATION_ERROR';
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
  if (!isPlainObject(value)) throw new AdminOrdinaryReviewMutationError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AdminOrdinaryReviewMutationError(code, message, status, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function assertSafeTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_TIME_INVALID', '管理员普通共享审核时间无效', 500);
  }
  return value;
}

function actorTagFor(identity) {
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!username) throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_ACTOR_INVALID', '管理员身份无效', 401);
  return `admin_${sha256Base64Url(username).slice(0, 12)}`;
}

function requestHashFor(command) {
  return `orq_v1_${sha256Base64Url(canonicalize({
    schemaVersion: ADMIN_ORDINARY_REVIEW_MUTATION_VERSION,
    action: command.action,
    reviewId: command.reviewId,
    reasonCode: command.reasonCode,
    payload: command.payload,
  }))}`;
}

function decisionIdFor(reviewId, requestHash) {
  return `rd_v1_${sha256Base64Url(canonicalize({ reviewId, requestHash }))}`;
}

function auditIdFor(decisionId) {
  return `au_v1_${sha256Base64Url(decisionId)}`;
}

function decisionKey(config, reviewId) {
  return `reviews/${config.libraryId}/ordinary-decisions/${reviewId}.json`;
}

function completionKey(config, reviewId) {
  return `reviews/${config.libraryId}/ordinary-completions/${reviewId}.json`;
}

function approvalCycleKey(config, businessKey, baselineApprovedVersion) {
  return `reviews/${config.libraryId}/ordinary-approval-cycles/${businessKey}/pv_${String(baselineApprovedVersion).padStart(12, '0')}.json`;
}

function auditKey(auditId, createdAt) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_AUDIT_TIME_INVALID', '管理员普通共享审核审计时间无效', 500);
  }
  return `audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`;
}

function alreadyExists(error) {
  return error instanceof BlobRepositoryError && error.code === 'BLOB_ALREADY_EXISTS';
}

async function putImmutableExact(store, key, value, conflictCode, conflictMessage) {
  try {
    await putJSONOnlyIfNew(store, key, value);
    return Object.freeze({ value, created: true });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || canonicalize(existing) !== canonicalize(value)) {
      throw new AdminOrdinaryReviewMutationError(conflictCode, conflictMessage, 409, null, error);
    }
    return Object.freeze({ value: existing, created: false });
  }
}

export function readAdminOrdinaryReviewMutationConfig(env = {}) {
  if (String(env.CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new AdminOrdinaryReviewMutationError(
      'ADMIN_ORDINARY_REVIEW_MUTATION_PREVIEW_DISABLED',
      '管理员普通共享审核写入预览未开启',
      503,
    );
  }
  let review;
  try {
    review = readAdminOrdinaryReviewConfig(env);
  } catch (error) {
    throw new AdminOrdinaryReviewMutationError(
      error?.code || 'ADMIN_ORDINARY_REVIEW_MUTATION_CONFIG_INVALID',
      error?.message || '管理员普通共享审核写入配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  return Object.freeze({ ...review, mutationPreviewEnabled: true });
}

export function normalizeAdminOrdinaryReviewCommand(action, input) {
  const normalizedAction = String(action || '').trim();
  if (!ACTIONS.has(normalizedAction)) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_ACTION_INVALID', '管理员普通共享审核动作无效', 400);
  }
  if (normalizedAction === 'approve') {
    assertExactKeys(input, ['reviewId', 'confirmation'], 'ADMIN_ORDINARY_REVIEW_BODY_INVALID', '普通共享批准请求字段无效');
    if (input.confirmation !== 'APPROVE_ORDINARY') {
      throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_CONFIRMATION_REQUIRED', '普通共享批准请求缺少明确确认', 400);
    }
    if (!REVIEW_ID_PATTERN.test(String(input.reviewId || ''))) {
      throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_ID_INVALID', '普通共享审核项目ID无效', 400);
    }
    return Object.freeze({ action: normalizedAction, reviewId: input.reviewId, reasonCode: null, payload: null });
  }
  if (normalizedAction === 'reject') {
    assertExactKeys(input, ['reviewId', 'confirmation', 'reasonCode'], 'ADMIN_ORDINARY_REVIEW_BODY_INVALID', '普通共享拒绝请求字段无效');
    if (input.confirmation !== 'REJECT_ORDINARY') {
      throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_CONFIRMATION_REQUIRED', '普通共享拒绝请求缺少明确确认', 400);
    }
    if (!REVIEW_ID_PATTERN.test(String(input.reviewId || '')) || !REJECT_REASONS.has(input.reasonCode)) {
      throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_REJECTION_INVALID', '普通共享拒绝原因或审核项目ID无效', 400);
    }
    return Object.freeze({ action: normalizedAction, reviewId: input.reviewId, reasonCode: input.reasonCode, payload: null });
  }
  assertExactKeys(input, ['reviewId', 'confirmation', 'payload'], 'ADMIN_ORDINARY_REVIEW_BODY_INVALID', '普通共享编辑后批准请求字段无效');
  if (input.confirmation !== 'EDIT_AND_APPROVE_ORDINARY') {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_CONFIRMATION_REQUIRED', '普通共享编辑后批准请求缺少明确确认', 400);
  }
  if (!REVIEW_ID_PATTERN.test(String(input.reviewId || '')) || !isPlainObject(input.payload)) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_EDIT_INVALID', '普通共享编辑内容或审核项目ID无效', 400);
  }
  return Object.freeze({ action: normalizedAction, reviewId: input.reviewId, reasonCode: null, payload: input.payload });
}

function buildEditedSubmission(source, payload) {
  const draft = { ...source, payload };
  let computed;
  try {
    computed = computeOrdinarySubmissionHashes(draft);
  } catch (error) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_EDIT_INVALID', '编辑后的普通共享内容无效', 400, null, error);
  }
  const edited = {
    ...draft,
    bossId: computed.submission.bossId,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
  };
  let normalized;
  try {
    normalized = normalizeOrdinarySubmission(edited);
  } catch (error) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_EDIT_INVALID', '编辑后的普通共享候选无法通过协议校验', 400, null, error);
  }
  if (normalized.businessKey !== source.businessKey) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_EDIT_IDENTITY_CHANGE', '编辑后批准不能改变普通共享业务身份', 400);
  }
  if (normalized.contentHash === source.contentHash) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_EDIT_NO_CHANGE', '编辑后批准必须实际修改候选内容', 400);
  }
  return normalized;
}

function findCurrentRecord(snapshot, businessKey) {
  return snapshot.records.find(item => item.businessKey === businessKey) || null;
}

function assertBaselineCurrent(target, currentRecord) {
  const baseline = target.baseline;
  if (baseline.approvedVersion === 0) {
    if (currentRecord !== null) {
      throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_STALE_BASELINE', '公共数据已变化，审核目标需要重新生成', 409);
    }
    return;
  }
  if (!currentRecord
      || currentRecord.approvedVersion !== baseline.approvedVersion
      || currentRecord.contentHash !== baseline.contentHash) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_STALE_BASELINE', '公共数据已变化，审核目标需要重新生成', 409);
  }
}

function isOrdinarySafeForStage5G(submission, currentRecord) {
  if (submission.dataType === 'exact_price') return false;
  if (!currentRecord) return true;
  if (currentRecord.dataType !== submission.dataType || currentRecord.businessKey !== submission.businessKey) return false;
  if (submission.dataType === 'playable_name') return true;
  if (currentRecord.payload?.bossName !== submission.payload.bossName) return false;
  if (currentRecord.payload?.paiDan !== submission.payload.paiDan) return false;
  const currentDiscount = Number(currentRecord.payload?.discount);
  const nextDiscount = Number(submission.payload.discount);
  if (!Number.isFinite(currentDiscount) || !Number.isFinite(nextDiscount) || nextDiscount >= currentDiscount) return false;
  const drop = Math.round((currentDiscount - nextDiscount) * 10_000) / 10_000;
  return drop > 0 && drop <= 0.05;
}

function assertStage5GMutationAllowed(target, targetSubmission, currentRecord) {
  if (!STAGE5G_RESOLVABLE_REASONS.has(target.marker.reason)
      || !isOrdinarySafeForStage5G(targetSubmission, currentRecord)) {
    throw new AdminOrdinaryReviewMutationError(
      'ADMIN_ORDINARY_REVIEW_STAGE6_REQUIRED',
      '该变更属于阶段6敏感审核范围，阶段5G不能处理',
      409,
      { reason: target.marker.reason, dataType: targetSubmission.dataType },
    );
  }
}

function buildDecision({ target, command, identity, requestHash, now, targetSubmission }) {
  const decisionId = decisionIdFor(command.reviewId, requestHash);
  return Object.freeze({
    schemaVersion: ADMIN_ORDINARY_REVIEW_MUTATION_VERSION,
    decisionId,
    reviewId: command.reviewId,
    action: command.action,
    requestHash,
    actorTag: actorTagFor(identity),
    createdAt: now,
    groupId: target.scope.groupId,
    libraryId: target.scope.libraryId,
    businessKey: target.submission.businessKey,
    baseline: target.baseline,
    sourceSubmission: target.submission,
    targetSubmission,
    evidence: target.evidence,
    relatedReviews: target.relatedReviews,
    reasonCode: command.reasonCode,
  });
}

function assertDecisionRecord(value, config, expectedRequestHash = null, expectedActorTag = null) {
  if (!isPlainObject(value)
      || value.schemaVersion !== ADMIN_ORDINARY_REVIEW_MUTATION_VERSION
      || !DECISION_ID_PATTERN.test(String(value.decisionId || ''))
      || !REVIEW_ID_PATTERN.test(String(value.reviewId || ''))
      || !ACTIONS.has(value.action)
      || typeof value.requestHash !== 'string' || !value.requestHash.startsWith('orq_v1_')
      || (expectedRequestHash && value.requestHash !== expectedRequestHash)
      || !ACTOR_TAG_PATTERN.test(String(value.actorTag || ''))
      || (expectedActorTag && value.actorTag !== expectedActorTag)
      || value.groupId !== config.groupId
      || value.libraryId !== config.libraryId
      || !Array.isArray(value.evidence) || value.evidence.length < 1
      || !Array.isArray(value.relatedReviews) || value.relatedReviews.length < 1) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_DECISION_INVALID', '管理员普通共享审核决策记录无效', 503);
  }
  assertSafeTime(value.createdAt);
  try {
    value.sourceSubmission = normalizeOrdinarySubmission(value.sourceSubmission);
    if (value.targetSubmission !== null) value.targetSubmission = normalizeOrdinarySubmission(value.targetSubmission);
  } catch (error) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_DECISION_INVALID', '管理员普通共享审核决策候选无效', 503, null, error);
  }
  return Object.freeze({ ...value });
}

async function ensureApprovalCycleClaim(store, config, decision) {
  if (decision.action === 'reject') return;
  const key = approvalCycleKey(config, decision.businessKey, decision.baseline.approvedVersion);
  const claim = Object.freeze({
    schemaVersion: ADMIN_ORDINARY_REVIEW_MUTATION_VERSION,
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
    'ADMIN_ORDINARY_REVIEW_BASELINE_ALREADY_CLAIMED',
    '同一普通共享公共基线已经由另一项管理员审核占用',
  );
}

function buildAudit(decision, outcome) {
  const auditId = auditIdFor(decision.decisionId);
  return Object.freeze({
    schemaVersion: ADMIN_ORDINARY_REVIEW_MUTATION_VERSION,
    auditId,
    decisionId: decision.decisionId,
    reviewId: decision.reviewId,
    action: decision.action,
    actorTag: decision.actorTag,
    occurredAt: decision.createdAt,
    groupId: decision.groupId,
    libraryId: decision.libraryId,
    businessKey: decision.businessKey,
    dataType: decision.sourceSubmission.dataType,
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
    schemaVersion: ADMIN_ORDINARY_REVIEW_MUTATION_VERSION,
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

function completionRecord(decision, auditId, outcome, resolvedReviewCount) {
  return Object.freeze({
    schemaVersion: ADMIN_ORDINARY_REVIEW_MUTATION_VERSION,
    decisionId: decision.decisionId,
    auditId,
    reviewId: decision.reviewId,
    action: decision.action,
    status: outcome.status,
    completedAt: decision.createdAt,
    dataType: decision.sourceSubmission.dataType,
    targetContentHash: decision.targetSubmission?.contentHash ?? null,
    publicVersion: outcome.publicVersion,
    eventVersion: outcome.eventVersion,
    approvalId: outcome.approvalId,
    publicMutationApplied: outcome.publicMutationApplied,
    resolvedReviewCount,
  });
}

function assertCompletionRecord(value, decision) {
  if (!isPlainObject(value)
      || value.schemaVersion !== ADMIN_ORDINARY_REVIEW_MUTATION_VERSION
      || value.decisionId !== decision.decisionId
      || !AUDIT_ID_PATTERN.test(String(value.auditId || ''))
      || value.reviewId !== decision.reviewId
      || value.action !== decision.action
      || value.dataType !== decision.sourceSubmission.dataType
      || !Number.isSafeInteger(value.publicVersion) || value.publicVersion < 0
      || !Number.isSafeInteger(value.resolvedReviewCount) || value.resolvedReviewCount < 1
      || typeof value.publicMutationApplied !== 'boolean') {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_COMPLETION_INVALID', '管理员普通共享审核完成记录无效', 503);
  }
  assertSafeTime(value.completedAt);
  return Object.freeze({ ...value });
}

async function executeDecision({ store, config, decision }) {
  let outcome;
  if (decision.action === 'reject') {
    const snapshot = await buildOrdinaryPublicSnapshot({
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
    const published = await publishAdminOrdinaryApproval({
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
      publicMutationApplied: published.publicMutationApplied,
    });
  }

  const audit = buildAudit(decision, outcome);
  await putImmutableExact(
    store,
    auditKey(audit.auditId, decision.createdAt),
    audit,
    'ADMIN_ORDINARY_REVIEW_AUDIT_CONFLICT',
    '管理员普通共享审核审计记录冲突',
  );

  const resolved = decision.action === 'reject'
    ? decision.relatedReviews.filter(item => item.reviewId === decision.reviewId)
    : decision.relatedReviews;
  for (const item of resolved) {
    const action = item.reviewId === decision.reviewId ? outcome.status : 'superseded';
    await putImmutableExact(
      store,
      adminReviewResolutionKey(config.libraryId, item.reviewId),
      resolutionFor(decision, audit.auditId, item, action),
      'ADMIN_ORDINARY_REVIEW_RESOLUTION_CONFLICT',
      '管理员普通共享审核归档记录冲突',
    );
  }

  const completion = completionRecord(decision, audit.auditId, outcome, resolved.length);
  await putImmutableExact(
    store,
    completionKey(config, decision.reviewId),
    completion,
    'ADMIN_ORDINARY_REVIEW_COMPLETION_CONFLICT',
    '管理员普通共享审核完成记录冲突',
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
    dataType: completion.dataType,
    targetContentHash: completion.targetContentHash,
    publicVersion: completion.publicVersion,
    eventVersion: completion.eventVersion,
    approvalId: completion.approvalId,
    publicMutationApplied: completion.publicMutationApplied,
    resolvedReviewCount: completion.resolvedReviewCount,
    duplicate,
  });
}

export async function mutateAdminOrdinaryReview({
  store,
  config,
  identity,
  command,
  now = Date.now(),
} = {}) {
  assertSafeTime(now);
  if (!config?.mutationPreviewEnabled) {
    throw new AdminOrdinaryReviewMutationError('ADMIN_ORDINARY_REVIEW_MUTATION_PREVIEW_DISABLED', '管理员普通共享审核写入预览未开启', 503);
  }
  const normalizedCommand = normalizeAdminOrdinaryReviewCommand(command?.action, command?.input || command);
  const requestHash = requestHashFor(normalizedCommand);
  const actorTag = actorTagFor(identity);
  const key = decisionKey(config, normalizedCommand.reviewId);
  const existing = await getJSONStrong(store, key);
  let decision;
  if (existing) {
    decision = assertDecisionRecord(existing, config, requestHash, actorTag);
    const completed = await getJSONStrong(store, completionKey(config, normalizedCommand.reviewId));
    if (completed) return projectCompletion(assertCompletionRecord(completed, decision), true);
  } else {
    let target;
    try {
      target = await getAdminOrdinaryReviewMutationTarget({
        store,
        config,
        reviewId: normalizedCommand.reviewId,
      });
    } catch (error) {
      throw new AdminOrdinaryReviewMutationError(
        error?.code || 'ADMIN_ORDINARY_REVIEW_TARGET_INVALID',
        error?.message || '普通共享审核目标无效',
        error?.status || 503,
        error?.details || null,
        error,
      );
    }
    const snapshot = await buildOrdinaryPublicSnapshot({
      store,
      groupId: config.groupId,
      libraryId: config.libraryId,
      now,
    });
    const currentRecord = findCurrentRecord(snapshot, target.submission.businessKey);
    assertBaselineCurrent(target, currentRecord);
    const targetSubmission = normalizedCommand.action === 'reject'
      ? null
      : normalizedCommand.action === 'approve'
        ? target.submission
        : buildEditedSubmission(target.submission, normalizedCommand.payload);
    assertStage5GMutationAllowed(target, targetSubmission || target.submission, currentRecord);
    decision = buildDecision({
      target,
      command: normalizedCommand,
      identity,
      requestHash,
      now,
      targetSubmission,
    });
    await putImmutableExact(
      store,
      key,
      decision,
      'ADMIN_ORDINARY_REVIEW_ALREADY_DECIDED',
      '该普通共享审核项目已经由另一项决策占用',
    );
  }

  await ensureApprovalCycleClaim(store, config, decision);
  const completed = await executeDecision({ store, config, decision });
  return projectCompletion(completed, false);
}

export function isAdminOrdinaryReviewMutationProjectionSafe(value) {
  const text = JSON.stringify(value);
  return !/dev_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/sub_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/ik_v1_[A-Za-z0-9_-]{43}/.test(text)
    && !/orq_v1_[A-Za-z0-9_-]{43}/.test(text)
    && !text.includes('reviews/')
    && !text.includes('submissions/')
    && !text.includes('public/');
}

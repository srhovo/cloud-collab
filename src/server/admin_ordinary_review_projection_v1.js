import { createHash } from 'node:crypto';
import {
  getJSONStrong,
  pendingSubmissionKey,
} from './blob_repository_v1.js';
import { confirmationPrefix } from './auto_approval_engine_v1.js';
import {
  buildOrdinaryPublicSnapshot,
  listValidOrdinaryPublicEvents,
} from './ordinary_public_engine_v1.js';
import {
  normalizeOrdinarySubmission,
  readOrdinaryTypesPreviewConfig,
} from './ordinary_types_policy_v1.js';
import {
  ADMIN_REVIEW_MAX_OBJECTS,
  adminReviewResolutionKey,
  readAdminReviewConfig,
  reviewIdForKey,
} from './admin_review_projection_v1.js';

export const ADMIN_ORDINARY_REVIEW_PROJECTION_VERSION = 1;

const REVIEW_ID_PATTERN = /^rv_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBMISSION_ID_PATTERN = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;
const IDEMPOTENCY_KEY_PATTERN = /^ik_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^req_v1_[A-Za-z0-9_-]{43}$/;
const DECISION_ID_PATTERN = /^rd_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^au_v1_[A-Za-z0-9_-]{43}$/;
const REVIEW_KEY_PATTERN = /^reviews\/(lib_[a-z0-9][a-z0-9_]{2,55})\/pending\/(bk_v1_[A-Za-z0-9_-]{43})\/pv_([0-9]{12})\/(ch_v1_[A-Za-z0-9_-]{43})\.json$/;
const REVIEW_REASONS = new Set([
  'candidate_conflict',
  'price_change_exceeds_limit',
  'playable_name_public_conflict',
  'boss_name_change_sensitive',
  'boss_direct_report_change_sensitive',
  'boss_discount_increase_sensitive',
  'boss_discount_drop_abnormal',
  'baseline_transition_conflict',
  'stale_public_baseline',
]);
const RESOLUTION_ACTIONS = new Set([
  'approved_by_admin',
  'edited_and_approved',
  'rejected',
  'superseded',
]);

export const ADMIN_ORDINARY_REVIEW_CAPABILITIES = Object.freeze({
  reviewQueueRead: true,
  reviewDetailRead: true,
  reviewMutation: false,
  ordinaryTypes: Object.freeze(['exact_price', 'playable_name', 'boss_profile']),
  publicMutationAllowed: false,
  syntheticFixtureOnly: true,
});

export class AdminOrdinaryReviewError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员普通共享审核失败');
    this.name = 'AdminOrdinaryReviewError';
    this.code = code || 'ADMIN_ORDINARY_REVIEW_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message) {
  if (!isPlainObject(value)) throw new AdminOrdinaryReviewError(code, message, 503);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AdminOrdinaryReviewError(code, message, 503, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function deviceTag(deviceId) {
  return `设备-${sha256Base64Url(deviceId).slice(0, 8)}`;
}

function assertSafeTimestamp(value, code, message) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new AdminOrdinaryReviewError(code, message, 503);
  }
  return value;
}

function reviewPrefix(libraryId) {
  return `reviews/${libraryId}/pending/`;
}

function parseReviewKey(key, config) {
  const match = REVIEW_KEY_PATTERN.exec(String(key || ''));
  if (!match || match[1] !== config.libraryId) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_OBJECT_KEY', '普通共享审核队列包含无效对象Key', 503);
  }
  const baselineApprovedVersion = Number(match[3]);
  if (!Number.isSafeInteger(baselineApprovedVersion) || baselineApprovedVersion < 0) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_OBJECT_KEY', '普通共享审核对象版本无效', 503);
  }
  return Object.freeze({
    key,
    libraryId: match[1],
    businessKey: match[2],
    baselineApprovedVersion,
    contentHash: match[4],
  });
}

function assertReviewMarker(value, parsed, config) {
  assertExactKeys(value, [
    'schemaVersion', 'status', 'reason', 'groupId', 'libraryId', 'businessKey',
    'baselineApprovedVersion', 'publicContentHash', 'contentHash', 'deviceIds', 'createdAt',
  ], 'ADMIN_ORDINARY_REVIEW_INVALID_MARKER', '普通共享待审核标记结构无效');
  const deviceIds = Array.isArray(value.deviceIds) ? value.deviceIds.map(String) : [];
  const publicHashValid = parsed.baselineApprovedVersion === 0
    ? value.publicContentHash === null
    : CONTENT_HASH_PATTERN.test(String(value.publicContentHash || ''));
  if (value.schemaVersion !== 1
      || value.status !== 'pending_review'
      || !REVIEW_REASONS.has(value.reason)
      || value.groupId !== config.groupId
      || value.libraryId !== config.libraryId
      || value.businessKey !== parsed.businessKey
      || value.baselineApprovedVersion !== parsed.baselineApprovedVersion
      || value.contentHash !== parsed.contentHash
      || !publicHashValid
      || deviceIds.length < 1
      || deviceIds.length > 128
      || new Set(deviceIds).size !== deviceIds.length
      || deviceIds.some(id => !DEVICE_ID_PATTERN.test(id))) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_MARKER', '普通共享待审核标记内容无效', 503);
  }
  assertSafeTimestamp(value.createdAt, 'ADMIN_ORDINARY_REVIEW_INVALID_MARKER', '普通共享待审核标记时间无效');
  return Object.freeze({ ...value, deviceIds: Object.freeze([...deviceIds].sort()) });
}

function assertConfirmationMarker(value, expected) {
  assertExactKeys(value, [
    'schemaVersion', 'groupId', 'libraryId', 'businessKey', 'baselineApprovedVersion',
    'contentHash', 'deviceId', 'submissionId', 'idempotencyKey', 'receivedAt',
    'authenticatedTokenVersion',
  ], 'ADMIN_ORDINARY_REVIEW_INVALID_CONFIRMATION', '普通共享审核确认链路结构无效');
  if (value.schemaVersion !== 1
      || value.groupId !== expected.groupId
      || value.libraryId !== expected.libraryId
      || value.businessKey !== expected.businessKey
      || value.baselineApprovedVersion !== expected.baselineApprovedVersion
      || value.contentHash !== expected.contentHash
      || value.deviceId !== expected.deviceId
      || !SUBMISSION_ID_PATTERN.test(String(value.submissionId || ''))
      || !IDEMPOTENCY_KEY_PATTERN.test(String(value.idempotencyKey || ''))
      || !Number.isSafeInteger(value.authenticatedTokenVersion)
      || value.authenticatedTokenVersion < 1) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_CONFIRMATION', '普通共享审核确认链路内容无效', 503);
  }
  assertSafeTimestamp(value.receivedAt, 'ADMIN_ORDINARY_REVIEW_INVALID_CONFIRMATION', '普通共享审核确认时间无效');
  return value;
}

function assertStoredCandidate(value, confirmation, marker, config) {
  assertExactKeys(value, [
    'schemaVersion', 'requestHash', 'status', 'decision', 'reason', 'submission',
    'receivedAt', 'authenticatedTokenVersion', 'publicMutationAllowed', 'autoApprovalEnabled',
  ], 'ADMIN_ORDINARY_REVIEW_INVALID_CANDIDATE', '普通共享审核候选结构无效');
  if (value.schemaVersion !== 1
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || !['waiting_confirmation', 'pending_review'].includes(value.status)
      || !['waiting_confirmation', 'pending_review'].includes(value.decision)
      || value.publicMutationAllowed !== false
      || value.autoApprovalEnabled !== false
      || value.receivedAt !== confirmation.receivedAt
      || value.authenticatedTokenVersion !== confirmation.authenticatedTokenVersion) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_CANDIDATE', '普通共享审核候选状态无效', 503);
  }
  let submission;
  try {
    submission = normalizeOrdinarySubmission(value.submission);
  } catch (error) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_CANDIDATE', '普通共享审核候选内容校验失败', 503, null, error);
  }
  if (submission.groupId !== config.groupId
      || submission.libraryId !== config.libraryId
      || submission.businessKey !== marker.businessKey
      || submission.contentHash !== marker.contentHash
      || submission.deviceId !== confirmation.deviceId
      || submission.submissionId !== confirmation.submissionId
      || submission.idempotencyKey !== confirmation.idempotencyKey
      || submission.operation !== 'upsert'
      || !['exact_price', 'playable_name', 'boss_profile'].includes(submission.dataType)) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_CANDIDATE_LINK_MISMATCH', '普通共享审核候选链路不一致', 503);
  }
  return Object.freeze({ submission, receivedAt: value.receivedAt });
}

function auditKey(auditId, resolvedAt) {
  const date = new Date(resolvedAt);
  if (!AUDIT_ID_PATTERN.test(String(auditId || '')) || !Number.isFinite(date.getTime())) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_RESOLUTION', '普通共享审核归档审计Key无效', 503);
  }
  return `audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`;
}

function assertResolutionAndAudit(resolution, audit, expected, config) {
  assertExactKeys(resolution, [
    'schemaVersion', 'reviewId', 'decisionId', 'auditId', 'action', 'groupId',
    'libraryId', 'businessKey', 'baselineApprovedVersion', 'sourceContentHash',
    'targetContentHash', 'resolvedAt',
  ], 'ADMIN_ORDINARY_REVIEW_INVALID_RESOLUTION', '普通共享审核归档结构无效');
  if (resolution.schemaVersion !== 1
      || resolution.reviewId !== expected.reviewId
      || !DECISION_ID_PATTERN.test(String(resolution.decisionId || ''))
      || !AUDIT_ID_PATTERN.test(String(resolution.auditId || ''))
      || !RESOLUTION_ACTIONS.has(resolution.action)
      || resolution.groupId !== config.groupId
      || resolution.libraryId !== config.libraryId
      || resolution.businessKey !== expected.businessKey
      || resolution.baselineApprovedVersion !== expected.baselineApprovedVersion
      || resolution.sourceContentHash !== expected.contentHash
      || !(resolution.targetContentHash === null || CONTENT_HASH_PATTERN.test(String(resolution.targetContentHash || '')))) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_RESOLUTION', '普通共享审核归档内容无效', 503);
  }
  assertSafeTimestamp(resolution.resolvedAt, 'ADMIN_ORDINARY_REVIEW_INVALID_RESOLUTION', '普通共享审核归档时间无效');
  if (!isPlainObject(audit)
      || audit.schemaVersion !== 1
      || audit.auditId !== resolution.auditId
      || audit.decisionId !== resolution.decisionId
      || audit.reviewId !== resolution.reviewId
      || audit.groupId !== config.groupId
      || audit.libraryId !== config.libraryId
      || audit.businessKey !== resolution.businessKey
      || audit.sourceContentHash !== resolution.sourceContentHash
      || audit.targetContentHash !== resolution.targetContentHash
      || audit.occurredAt !== resolution.resolvedAt) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_AUDIT', '普通共享审核审计内容无效', 503);
  }
  return true;
}

async function listReviewKeysStrong(store, config) {
  if (!store || typeof store.list !== 'function') {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_BLOB_CAPABILITY_MISSING', '普通共享审核需要Blob list能力', 503);
  }
  let result;
  try {
    result = await store.list({ prefix: reviewPrefix(config.libraryId), consistency: 'strong' });
  } catch (error) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_LIST_FAILED', '无法强一致读取普通共享审核队列', 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > ADMIN_REVIEW_MAX_OBJECTS) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_OBJECT_LIMIT_EXCEEDED', '普通共享审核对象超过安全上限', 409);
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_INVALID_LIST', '普通共享审核队列列举结果无效', 503);
  }
  return keys.sort();
}

async function readCandidatesForMarker(store, marker, config) {
  const candidates = [];
  const evidence = [];
  for (const deviceId of marker.deviceIds) {
    const confirmationKey = `${confirmationPrefix(
      marker.libraryId,
      marker.businessKey,
      marker.baselineApprovedVersion,
    )}${marker.contentHash}/${deviceId}.json`;
    const confirmation = assertConfirmationMarker(await getJSONStrong(store, confirmationKey), {
      groupId: marker.groupId,
      libraryId: marker.libraryId,
      businessKey: marker.businessKey,
      baselineApprovedVersion: marker.baselineApprovedVersion,
      contentHash: marker.contentHash,
      deviceId,
    });
    const candidate = await getJSONStrong(store, pendingSubmissionKey(marker.libraryId, confirmation.idempotencyKey));
    candidates.push(assertStoredCandidate(candidate, confirmation, marker, config));
    evidence.push(Object.freeze({ deviceId, submissionId: confirmation.submissionId }));
  }
  if (candidates.length < 1 || candidates.some(item => item.submission.contentHash !== marker.contentHash)) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_CANDIDATE_LINK_MISMATCH', '普通共享审核候选证据链不完整', 503);
  }
  return Object.freeze({
    submission: candidates[0].submission,
    receivedAt: Math.min(...candidates.map(item => item.receivedAt)),
    evidence: Object.freeze(evidence),
  });
}

function indexPublicEvents(events) {
  const byVersion = new Map();
  const currentByBusinessKey = new Map();
  for (const event of events) {
    byVersion.set(event.version, event);
    currentByBusinessKey.set(event.businessKey, event);
  }
  return { byVersion, currentByBusinessKey };
}

function baselineProjection(marker, publicIndex) {
  const current = publicIndex.currentByBusinessKey.get(marker.businessKey) || null;
  if (marker.baselineApprovedVersion === 0) {
    return Object.freeze({
      approvedVersion: 0,
      contentHash: null,
      dataType: null,
      payload: null,
      unitPrice: null,
      stillCurrent: current === null,
    });
  }
  const baseline = publicIndex.byVersion.get(marker.baselineApprovedVersion) || null;
  if (!baseline
      || baseline.businessKey !== marker.businessKey
      || baseline.contentHash !== marker.publicContentHash) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_BASELINE_MISMATCH', '普通共享待审核标记无法关联公共基线', 503);
  }
  return Object.freeze({
    approvedVersion: baseline.version,
    contentHash: baseline.contentHash,
    dataType: baseline.dataType,
    payload: baseline.payload,
    unitPrice: baseline.dataType === 'exact_price' ? baseline.payload.unitPrice : null,
    stillCurrent: Boolean(current)
      && current.version === baseline.version
      && current.contentHash === baseline.contentHash,
  });
}

function projectReview(parsed, marker, candidate, baseline) {
  const { submission } = candidate;
  return Object.freeze({
    reviewId: reviewIdForKey(parsed.key),
    status: 'pending_review',
    reason: marker.reason,
    groupId: marker.groupId,
    libraryId: marker.libraryId,
    businessKey: marker.businessKey,
    contentHash: marker.contentHash,
    dataType: submission.dataType,
    operation: submission.operation,
    payload: submission.payload,
    baseline,
    distinctDeviceCount: marker.deviceIds.length,
    deviceTags: Object.freeze(marker.deviceIds.map(deviceTag)),
    createdAt: new Date(marker.createdAt).toISOString(),
    receivedAt: new Date(candidate.receivedAt).toISOString(),
  });
}

export function readAdminOrdinaryReviewConfig(env = {}) {
  let base;
  let ordinary;
  try {
    base = readAdminReviewConfig(env);
    ordinary = readOrdinaryTypesPreviewConfig(env);
  } catch (error) {
    throw new AdminOrdinaryReviewError(error?.code || 'ADMIN_ORDINARY_REVIEW_CONFIG_INVALID', error?.message || '普通共享审核配置无效', error?.status || 503, error?.details || null, error);
  }
  if (base.storeName !== ordinary.storeName
      || base.groupId !== ordinary.groupId
      || base.libraryId !== ordinary.libraryId) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_SCOPE_MISMATCH', '普通共享审核与提交作用域不一致', 503);
  }
  return Object.freeze({ ...base, ordinaryTypesEnabled: true });
}

async function loadEntries({ store, config } = {}) {
  const keys = await listReviewKeysStrong(store, config);
  let events;
  try {
    events = await listValidOrdinaryPublicEvents({ store, libraryId: config.libraryId });
  } catch (error) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_PUBLIC_BASELINE_INVALID', '普通共享公共基线无法通过校验', 503, null, error);
  }
  const publicIndex = indexPublicEvents(events);
  const entries = [];
  for (const key of keys) {
    const parsed = parseReviewKey(key, config);
    const reviewId = reviewIdForKey(parsed.key);
    const resolution = await getJSONStrong(store, adminReviewResolutionKey(config.libraryId, reviewId));
    if (resolution) {
      const audit = await getJSONStrong(store, auditKey(resolution.auditId, resolution.resolvedAt));
      assertResolutionAndAudit(resolution, audit, { reviewId, ...parsed }, config);
      continue;
    }
    const marker = assertReviewMarker(await getJSONStrong(store, key), parsed, config);
    const candidate = await readCandidatesForMarker(store, marker, config);
    const baseline = baselineProjection(marker, publicIndex);
    entries.push(Object.freeze({
      parsed,
      marker,
      candidate,
      baseline,
      projected: projectReview(parsed, marker, candidate, baseline),
    }));
  }
  return Object.freeze(entries);
}

export async function listAdminOrdinaryReviewQueue({ store, config } = {}) {
  const entries = await loadEntries({ store, config });
  const items = entries.map(entry => entry.projected);
  items.sort((left, right) => right.createdAt.localeCompare(left.createdAt)
    || left.reviewId.localeCompare(right.reviewId));
  return Object.freeze({
    scope: Object.freeze({
      groupId: config.groupId,
      libraryId: config.libraryId,
      syntheticFixtureOnly: true,
    }),
    total: items.length,
    items: Object.freeze(items),
  });
}

export async function getAdminOrdinaryReviewDetail({ store, config, reviewId } = {}) {
  const normalized = String(reviewId || '').trim();
  if (!REVIEW_ID_PATTERN.test(normalized)) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_ID_INVALID', '普通共享审核详情ID无效', 400);
  }
  const queue = await listAdminOrdinaryReviewQueue({ store, config });
  const selected = queue.items.find(item => item.reviewId === normalized) || null;
  if (!selected) throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_NOT_FOUND', '普通共享审核详情不存在', 404);
  const variants = queue.items.filter(item => item.businessKey === selected.businessKey
    && item.baseline.approvedVersion === selected.baseline.approvedVersion);
  return Object.freeze({
    scope: queue.scope,
    review: selected,
    variants: Object.freeze(variants),
    variantCount: variants.length,
    conflictPresent: variants.length > 1 || selected.reason === 'candidate_conflict',
  });
}

export async function getAdminOrdinaryReviewMutationTarget({ store, config, reviewId } = {}) {
  const normalized = String(reviewId || '').trim();
  if (!REVIEW_ID_PATTERN.test(normalized)) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_ID_INVALID', '普通共享审核项目ID无效', 400);
  }
  const entries = await loadEntries({ store, config });
  const selected = entries.find(entry => entry.projected.reviewId === normalized) || null;
  if (!selected) throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_NOT_FOUND', '普通共享审核项目不存在或已经归档', 404);
  const related = entries.filter(entry => entry.marker.businessKey === selected.marker.businessKey
    && entry.marker.baselineApprovedVersion === selected.marker.baselineApprovedVersion);
  return Object.freeze({
    scope: Object.freeze({ groupId: config.groupId, libraryId: config.libraryId }),
    reviewId: normalized,
    marker: selected.marker,
    submission: selected.candidate.submission,
    evidence: selected.candidate.evidence,
    baseline: Object.freeze({
      approvedVersion: selected.baseline.approvedVersion,
      contentHash: selected.baseline.contentHash,
      unitPrice: selected.baseline.unitPrice,
    }),
    relatedReviews: Object.freeze(related.map(entry => Object.freeze({
      reviewId: entry.projected.reviewId,
      contentHash: entry.marker.contentHash,
    }))),
  });
}

export async function getAdminOrdinaryCurrentSnapshot({ store, config, now = Date.now() } = {}) {
  return buildOrdinaryPublicSnapshot({
    store,
    groupId: config.groupId,
    libraryId: config.libraryId,
    now,
  });
}

export function isAdminOrdinaryReviewProjectionSafe(value) {
  const text = JSON.stringify(value);
  return !/dev_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/sub_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/ik_v1_[A-Za-z0-9_-]{43}/.test(text)
    && !/req_v1_[A-Za-z0-9_-]{43}/.test(text)
    && !text.includes('reviews/')
    && !text.includes('submissions/')
    && !text.includes('public/');
}

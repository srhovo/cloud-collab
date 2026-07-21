import { createHash } from 'node:crypto';

import {
  getJSONStrong,
  pendingSubmissionKey,
} from './blob_repository_v1.js';
import { confirmationPrefix } from './auto_approval_engine_v1.js';
import { listValidOrdinaryPublicEvents } from './ordinary_public_engine_v1.js';
import { normalizeOrdinarySubmission } from './ordinary_types_policy_v1.js';
import { readProductionRuntimeConfig } from './production_runtime_config_v1.js';

export const PRODUCTION_ADMIN_REVIEW_READ_VERSION = 1;
export const PRODUCTION_ADMIN_ORDINARY_REVIEW_MAX_OBJECTS = 200;

const REVIEW_ID_PATTERN = /^rv_v1_[A-Za-z0-9_-]{43}$/;
const REVIEW_KEY_PATTERN = /^reviews\/(lib_[a-z0-9][a-z0-9_]{2,55})\/pending\/(bk_v1_[A-Za-z0-9_-]{43})\/pv_([0-9]{12})\/(ch_v1_[A-Za-z0-9_-]{43})\.json$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBMISSION_ID_PATTERN = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;
const IDEMPOTENCY_KEY_PATTERN = /^ik_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^req_v1_[A-Za-z0-9_-]{43}$/;
const DECISION_ID_PATTERN = /^rd_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^au_v1_[A-Za-z0-9_-]{43}$/;
const ORDINARY_REASONS = new Set([
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

export const PRODUCTION_ORDINARY_REVIEW_READ_CAPABILITIES = Object.freeze({
  reviewQueueRead: true,
  reviewDetailRead: true,
  reviewMutation: false,
  ordinaryTypes: Object.freeze(['exact_price', 'playable_name', 'boss_profile']),
  publicMutationAllowed: false,
  stablePromotionAuthorized: false,
});

export class ProductionAdminReviewReadError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '正式管理员只读审核失败');
    this.name = 'ProductionAdminReviewReadError';
    this.code = code || 'PRODUCTION_ADMIN_REVIEW_READ_ERROR';
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
  if (!isPlainObject(value)) throw new ProductionAdminReviewReadError(code, message, 503);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ProductionAdminReviewReadError(code, message, 503, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

export function productionOrdinaryReviewIdForKey(key) {
  return `rv_v1_${sha256Base64Url(key)}`;
}

function deviceTag(deviceId) {
  return `设备-${sha256Base64Url(deviceId).slice(0, 8)}`;
}

function assertSafeTimestamp(value, code, message) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new ProductionAdminReviewReadError(code, message, 503);
  }
  return value;
}

export function readProductionAdminReviewConfig(env = {}) {
  let runtime;
  try { runtime = readProductionRuntimeConfig(env); }
  catch (error) {
    throw new ProductionAdminReviewReadError(
      error?.code || 'PRODUCTION_ADMIN_REVIEW_CONFIG_INVALID',
      error?.message || '正式管理员审核配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  if (runtime.mode !== 'production'
      || runtime.flags.production !== true
      || runtime.flags.readSync !== true
      || runtime.flags.admin !== true
      || runtime.flags.adminReview !== true) {
    throw new ProductionAdminReviewReadError(
      'PRODUCTION_ADMIN_REVIEW_DISABLED',
      '正式管理员只读审核未开启',
      503,
    );
  }
  return Object.freeze({
    schemaVersion: PRODUCTION_ADMIN_REVIEW_READ_VERSION,
    mode: 'production',
    storeName: runtime.publicStoreName,
    groupId: runtime.scope.protocol.groupId,
    libraryId: runtime.scope.protocol.libraryId,
    publicOrigin: runtime.adminOrigin,
    externalScope: runtime.scope.external,
    protocolScope: runtime.scope.protocol,
    syntheticFixtureOnly: false,
    readOnly: true,
    stablePromotionAuthorized: false,
  });
}

async function listKeysStrong(store, prefix, maxObjects) {
  if (!store || typeof store.list !== 'function') {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_LIST_UNAVAILABLE', '正式只读审核需要Blob list能力', 503);
  }
  let result;
  try { result = await store.list({ prefix, consistency: 'strong' }); }
  catch (error) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_LIST_FAILED', '无法强一致读取正式审核队列', 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > maxObjects) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_OBJECT_LIMIT_EXCEEDED', '正式审核对象超过只读安全上限', 409);
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_LIST_INVALID', '正式审核列举结果无效', 503);
  }
  return keys.sort();
}

function parseReviewKey(key, config) {
  const match = REVIEW_KEY_PATTERN.exec(String(key || ''));
  if (!match || match[1] !== config.libraryId) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_KEY_INVALID', '正式普通审核队列包含无效对象Key', 503);
  }
  const baselineApprovedVersion = Number(match[3]);
  if (!Number.isSafeInteger(baselineApprovedVersion) || baselineApprovedVersion < 0) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_KEY_INVALID', '正式普通审核基线版本无效', 503);
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
  ], 'PRODUCTION_ADMIN_REVIEW_MARKER_INVALID', '正式普通待审核标记结构无效');
  const deviceIds = Array.isArray(value.deviceIds) ? value.deviceIds.map(String) : [];
  const publicHashValid = parsed.baselineApprovedVersion === 0
    ? value.publicContentHash === null
    : CONTENT_HASH_PATTERN.test(String(value.publicContentHash || ''));
  if (value.schemaVersion !== 1
      || value.status !== 'pending_review'
      || !ORDINARY_REASONS.has(value.reason)
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
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_MARKER_INVALID', '正式普通待审核标记内容无效', 503);
  }
  assertSafeTimestamp(value.createdAt, 'PRODUCTION_ADMIN_REVIEW_MARKER_INVALID', '正式普通待审核标记时间无效');
  return Object.freeze({ ...value, deviceIds: Object.freeze([...deviceIds].sort()) });
}

function assertConfirmation(value, expected) {
  assertExactKeys(value, [
    'schemaVersion', 'groupId', 'libraryId', 'businessKey', 'baselineApprovedVersion',
    'contentHash', 'deviceId', 'submissionId', 'idempotencyKey', 'receivedAt',
    'authenticatedTokenVersion',
  ], 'PRODUCTION_ADMIN_REVIEW_CONFIRMATION_INVALID', '正式普通审核确认结构无效');
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
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_CONFIRMATION_INVALID', '正式普通审核确认内容无效', 503);
  }
  assertSafeTimestamp(value.receivedAt, 'PRODUCTION_ADMIN_REVIEW_CONFIRMATION_INVALID', '正式普通审核确认时间无效');
  return value;
}

function assertCandidate(value, confirmation, marker, config) {
  assertExactKeys(value, [
    'schemaVersion', 'requestHash', 'status', 'decision', 'reason', 'submission',
    'receivedAt', 'authenticatedTokenVersion', 'publicMutationAllowed', 'autoApprovalEnabled',
  ], 'PRODUCTION_ADMIN_REVIEW_CANDIDATE_INVALID', '正式普通审核候选结构无效');
  if (value.schemaVersion !== 1
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || !['waiting_confirmation', 'pending_review'].includes(value.status)
      || !['waiting_confirmation', 'pending_review'].includes(value.decision)
      || value.publicMutationAllowed !== false
      || value.autoApprovalEnabled !== false
      || value.receivedAt !== confirmation.receivedAt
      || value.authenticatedTokenVersion !== confirmation.authenticatedTokenVersion) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_CANDIDATE_INVALID', '正式普通审核候选状态无效', 503);
  }
  let submission;
  try { submission = normalizeOrdinarySubmission(value.submission); }
  catch (error) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_CANDIDATE_INVALID', '正式普通审核候选内容校验失败', 503, null, error);
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
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_CANDIDATE_LINK_INVALID', '正式普通审核候选链路不一致', 503);
  }
  return Object.freeze({ submission, receivedAt: value.receivedAt });
}

async function readCandidateEvidence(store, marker, config) {
  const candidates = [];
  for (const deviceId of marker.deviceIds) {
    const confirmationKey = `${confirmationPrefix(
      marker.libraryId,
      marker.businessKey,
      marker.baselineApprovedVersion,
    )}${marker.contentHash}/${deviceId}.json`;
    const confirmation = assertConfirmation(await getJSONStrong(store, confirmationKey), {
      groupId: marker.groupId,
      libraryId: marker.libraryId,
      businessKey: marker.businessKey,
      baselineApprovedVersion: marker.baselineApprovedVersion,
      contentHash: marker.contentHash,
      deviceId,
    });
    const candidate = await getJSONStrong(store, pendingSubmissionKey(marker.libraryId, confirmation.idempotencyKey));
    candidates.push(assertCandidate(candidate, confirmation, marker, config));
  }
  if (candidates.length < 1 || candidates.some(item => item.submission.contentHash !== marker.contentHash)) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_EVIDENCE_INCOMPLETE', '正式普通审核证据链不完整', 503);
  }
  return Object.freeze({
    submission: candidates[0].submission,
    receivedAt: Math.min(...candidates.map(item => item.receivedAt)),
  });
}

function resolutionKey(config, reviewId) {
  return `reviews/${config.libraryId}/resolved/${reviewId}.json`;
}

function auditKey(auditId, resolvedAt) {
  const date = new Date(resolvedAt);
  if (!AUDIT_ID_PATTERN.test(String(auditId || '')) || !Number.isFinite(date.getTime())) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_RESOLUTION_INVALID', '正式普通审核归档审计Key无效', 503);
  }
  return `audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`;
}

async function isResolved(store, config, parsed, reviewId) {
  const resolution = await getJSONStrong(store, resolutionKey(config, reviewId));
  if (!resolution) return false;
  if (!isPlainObject(resolution)
      || resolution.schemaVersion !== 1
      || resolution.reviewId !== reviewId
      || !DECISION_ID_PATTERN.test(String(resolution.decisionId || ''))
      || !AUDIT_ID_PATTERN.test(String(resolution.auditId || ''))
      || resolution.groupId !== config.groupId
      || resolution.libraryId !== config.libraryId
      || resolution.businessKey !== parsed.businessKey
      || resolution.baselineApprovedVersion !== parsed.baselineApprovedVersion
      || resolution.sourceContentHash !== parsed.contentHash
      || !Number.isSafeInteger(resolution.resolvedAt)
      || resolution.resolvedAt <= 0) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_RESOLUTION_INVALID', '正式普通审核归档无效', 503);
  }
  const audit = await getJSONStrong(store, auditKey(resolution.auditId, resolution.resolvedAt));
  if (!isPlainObject(audit)
      || audit.auditId !== resolution.auditId
      || audit.decisionId !== resolution.decisionId
      || audit.reviewId !== reviewId
      || audit.groupId !== config.groupId
      || audit.libraryId !== config.libraryId
      || audit.businessKey !== parsed.businessKey
      || audit.sourceContentHash !== parsed.contentHash
      || audit.occurredAt !== resolution.resolvedAt) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_AUDIT_INVALID', '正式普通审核归档审计无效', 503);
  }
  return true;
}

function indexEvents(events) {
  const byVersion = new Map();
  const currentByBusinessKey = new Map();
  for (const event of events) {
    byVersion.set(event.version, event);
    currentByBusinessKey.set(event.businessKey, event);
  }
  return { byVersion, currentByBusinessKey };
}

function baselineProjection(marker, index) {
  const current = index.currentByBusinessKey.get(marker.businessKey) || null;
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
  const baseline = index.byVersion.get(marker.baselineApprovedVersion) || null;
  if (!baseline
      || baseline.businessKey !== marker.businessKey
      || baseline.contentHash !== marker.publicContentHash) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_BASELINE_INVALID', '正式普通审核无法关联公共基线', 503);
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

function projectItem(parsed, marker, candidate, baseline) {
  return Object.freeze({
    reviewId: productionOrdinaryReviewIdForKey(parsed.key),
    status: 'pending_review',
    reason: marker.reason,
    businessKey: marker.businessKey,
    contentHash: marker.contentHash,
    dataType: candidate.submission.dataType,
    operation: candidate.submission.operation,
    payload: candidate.submission.payload,
    baseline,
    distinctDeviceCount: marker.deviceIds.length,
    deviceTags: Object.freeze(marker.deviceIds.map(deviceTag)),
    createdAt: new Date(marker.createdAt).toISOString(),
    receivedAt: new Date(candidate.receivedAt).toISOString(),
  });
}

async function loadOrdinaryEntries({ store, config } = {}) {
  const keys = await listKeysStrong(
    store,
    `reviews/${config.libraryId}/pending/`,
    PRODUCTION_ADMIN_ORDINARY_REVIEW_MAX_OBJECTS,
  );
  let events;
  try { events = await listValidOrdinaryPublicEvents({ store, libraryId: config.libraryId }); }
  catch (error) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_PUBLIC_BASELINE_INVALID', '正式普通公共基线无法通过校验', 503, null, error);
  }
  const index = indexEvents(events);
  const entries = [];
  for (const key of keys) {
    const parsed = parseReviewKey(key, config);
    const reviewId = productionOrdinaryReviewIdForKey(key);
    if (await isResolved(store, config, parsed, reviewId)) continue;
    const marker = assertReviewMarker(await getJSONStrong(store, key), parsed, config);
    const candidate = await readCandidateEvidence(store, marker, config);
    entries.push(Object.freeze({
      parsed,
      marker,
      candidate,
      projected: projectItem(parsed, marker, candidate, baselineProjection(marker, index)),
    }));
  }
  return Object.freeze(entries);
}

export async function listProductionOrdinaryReviewQueue({ store, config } = {}) {
  const entries = await loadOrdinaryEntries({ store, config });
  const items = entries.map(entry => entry.projected)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
      || left.reviewId.localeCompare(right.reviewId));
  return Object.freeze({
    schemaVersion: PRODUCTION_ADMIN_REVIEW_READ_VERSION,
    scope: Object.freeze({
      external: config.externalScope,
      protocol: config.protocolScope,
      syntheticFixtureOnly: false,
    }),
    total: items.length,
    items: Object.freeze(items),
  });
}

export async function getProductionOrdinaryReviewDetail({ store, config, reviewId } = {}) {
  const normalized = String(reviewId || '').trim();
  if (!REVIEW_ID_PATTERN.test(normalized)) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_ID_INVALID', '正式普通审核详情ID无效', 400);
  }
  const queue = await listProductionOrdinaryReviewQueue({ store, config });
  const selected = queue.items.find(item => item.reviewId === normalized) || null;
  if (!selected) throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_NOT_FOUND', '正式普通审核详情不存在', 404);
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

export function isProductionAdminReviewProjectionSafe(value) {
  const text = JSON.stringify(value);
  return !/dev_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/sub_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/ik_v1_[A-Za-z0-9_-]{43}/.test(text)
    && !/req_v1_[A-Za-z0-9_-]{43}/.test(text)
    && !text.includes('reviews/')
    && !text.includes('submissions/')
    && !text.includes('public/');
}

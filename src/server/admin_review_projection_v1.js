import { createHash } from 'node:crypto';
import {
  getJSONStrong,
  pendingSubmissionKey,
} from './blob_repository_v1.js';
import {
  confirmationPrefix,
  listValidPublicEvents,
} from './auto_approval_engine_v1.js';
import { normalizeSubmission } from './submission_policy_v1.js';

export const ADMIN_REVIEW_PREVIEW_STORE_NAME = 'cloud-collab-preview-v1';
export const ADMIN_REVIEW_ALLOWED_GROUP_ID = 'group_fixture';
export const ADMIN_REVIEW_ALLOWED_LIBRARY_ID = 'lib_receive_fixture';
export const ADMIN_REVIEW_MAX_OBJECTS = 200;

const REVIEW_ID_PATTERN = /^rv_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBMISSION_ID_PATTERN = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;
const IDEMPOTENCY_KEY_PATTERN = /^ik_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^req_v1_[A-Za-z0-9_-]{43}$/;
const REVIEW_KEY_PATTERN = /^reviews\/(lib_[a-z0-9][a-z0-9_]{2,55})\/pending\/(bk_v1_[A-Za-z0-9_-]{43})\/pv_([0-9]{12})\/(ch_v1_[A-Za-z0-9_-]{43})\.json$/;
const REVIEW_REASONS = new Set(['candidate_conflict', 'price_change_exceeds_limit']);

export const ADMIN_REVIEW_CAPABILITIES = Object.freeze({
  reviewQueueRead: true,
  reviewDetailRead: true,
  reviewMutation: false,
  deviceMutation: false,
  rollback: false,
  export: false,
  publicMutationAllowed: false,
});

export class AdminReviewError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员只读审核失败');
    this.name = 'AdminReviewError';
    this.code = code || 'ADMIN_REVIEW_ERROR';
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
  if (!isPlainObject(value)) throw new AdminReviewError(code, message, 503);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
      || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new AdminReviewError(code, message, 503);
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function reviewIdForKey(key) {
  return `rv_v1_${sha256Base64Url(key)}`;
}

function deviceTag(deviceId) {
  return `设备-${sha256Base64Url(deviceId).slice(0, 8)}`;
}

function reviewPrefix(libraryId) {
  return `reviews/${libraryId}/pending/`;
}

function parseReviewKey(key, config) {
  const match = REVIEW_KEY_PATTERN.exec(String(key || ''));
  if (!match || match[1] !== config.libraryId) {
    throw new AdminReviewError('ADMIN_REVIEW_INVALID_OBJECT_KEY', '审核队列包含无效对象Key', 503);
  }
  const baselineApprovedVersion = Number(match[3]);
  if (!Number.isSafeInteger(baselineApprovedVersion) || baselineApprovedVersion < 0) {
    throw new AdminReviewError('ADMIN_REVIEW_INVALID_OBJECT_KEY', '审核队列对象版本无效', 503);
  }
  return Object.freeze({
    key,
    libraryId: match[1],
    businessKey: match[2],
    baselineApprovedVersion,
    contentHash: match[4],
  });
}

function assertSafeTimestamp(value, code, message) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new AdminReviewError(code, message, 503);
  }
  return value;
}

function assertReviewMarker(value, parsed, config) {
  assertExactKeys(value, [
    'schemaVersion', 'status', 'reason', 'groupId', 'libraryId', 'businessKey',
    'baselineApprovedVersion', 'publicContentHash', 'contentHash', 'deviceIds', 'createdAt',
  ], 'ADMIN_REVIEW_INVALID_MARKER', '待审核标记结构无效');
  const deviceIds = Array.isArray(value.deviceIds) ? value.deviceIds.map(String) : [];
  const publicContentHashValid = parsed.baselineApprovedVersion === 0
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
      || !publicContentHashValid
      || deviceIds.length < 1
      || deviceIds.length > 128
      || new Set(deviceIds).size !== deviceIds.length
      || deviceIds.some(id => !DEVICE_ID_PATTERN.test(id))) {
    throw new AdminReviewError('ADMIN_REVIEW_INVALID_MARKER', '待审核标记内容无效', 503);
  }
  assertSafeTimestamp(value.createdAt, 'ADMIN_REVIEW_INVALID_MARKER', '待审核标记时间无效');
  return Object.freeze({ ...value, deviceIds: Object.freeze([...deviceIds].sort()) });
}

function assertConfirmationMarker(value, expected) {
  assertExactKeys(value, [
    'schemaVersion', 'groupId', 'libraryId', 'businessKey', 'baselineApprovedVersion',
    'contentHash', 'deviceId', 'submissionId', 'idempotencyKey', 'receivedAt',
    'authenticatedTokenVersion',
  ], 'ADMIN_REVIEW_INVALID_CONFIRMATION', '审核确认链路结构无效');
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
    throw new AdminReviewError('ADMIN_REVIEW_INVALID_CONFIRMATION', '审核确认链路内容无效', 503);
  }
  assertSafeTimestamp(value.receivedAt, 'ADMIN_REVIEW_INVALID_CONFIRMATION', '审核确认时间无效');
  return value;
}

function assertStoredCandidate(value, confirmation, marker, config) {
  assertExactKeys(value, [
    'schemaVersion', 'requestHash', 'status', 'decision', 'reason', 'submission',
    'receivedAt', 'authenticatedTokenVersion', 'publicMutationAllowed', 'autoApprovalEnabled',
  ], 'ADMIN_REVIEW_INVALID_CANDIDATE', '审核候选结构无效');
  if (value.schemaVersion !== 1
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || value.status !== 'waiting_confirmation'
      || value.decision !== 'waiting_confirmation'
      || value.publicMutationAllowed !== false
      || value.autoApprovalEnabled !== false
      || value.receivedAt !== confirmation.receivedAt
      || value.authenticatedTokenVersion !== confirmation.authenticatedTokenVersion) {
    throw new AdminReviewError('ADMIN_REVIEW_INVALID_CANDIDATE', '审核候选状态无效', 503);
  }
  let submission;
  try {
    submission = normalizeSubmission(value.submission);
  } catch (error) {
    throw new AdminReviewError('ADMIN_REVIEW_INVALID_CANDIDATE', '审核候选内容校验失败', 503, null, error);
  }
  if (submission.groupId !== config.groupId
      || submission.libraryId !== config.libraryId
      || submission.businessKey !== marker.businessKey
      || submission.contentHash !== marker.contentHash
      || submission.deviceId !== confirmation.deviceId
      || submission.submissionId !== confirmation.submissionId
      || submission.idempotencyKey !== confirmation.idempotencyKey
      || submission.dataType !== 'exact_price'
      || submission.operation !== 'upsert') {
    throw new AdminReviewError('ADMIN_REVIEW_CANDIDATE_LINK_MISMATCH', '审核候选链路不一致', 503);
  }
  return Object.freeze({ submission, receivedAt: value.receivedAt });
}

async function listReviewKeysStrong(store, config) {
  if (!store || typeof store.list !== 'function') {
    throw new AdminReviewError('ADMIN_REVIEW_BLOB_CAPABILITY_MISSING', '只读审核需要Blob list能力', 503);
  }
  let result;
  try {
    result = await store.list({ prefix: reviewPrefix(config.libraryId), consistency: 'strong' });
  } catch (error) {
    throw new AdminReviewError('ADMIN_REVIEW_LIST_FAILED', '无法强一致读取审核队列', 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > ADMIN_REVIEW_MAX_OBJECTS) {
    throw new AdminReviewError('ADMIN_REVIEW_OBJECT_LIMIT_EXCEEDED', '审核对象超过只读安全上限', 409);
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new AdminReviewError('ADMIN_REVIEW_INVALID_LIST', '审核队列列举结果无效', 503);
  }
  return keys.sort();
}

async function readCandidateForMarker(store, marker, config) {
  const deviceId = marker.deviceIds[0];
  const confirmationKey = `${confirmationPrefix(
    marker.libraryId,
    marker.businessKey,
    marker.baselineApprovedVersion,
  )}${marker.contentHash}/${deviceId}.json`;
  const confirmation = assertConfirmationMarker(
    await getJSONStrong(store, confirmationKey),
    {
      groupId: marker.groupId,
      libraryId: marker.libraryId,
      businessKey: marker.businessKey,
      baselineApprovedVersion: marker.baselineApprovedVersion,
      contentHash: marker.contentHash,
      deviceId,
    },
  );
  const candidate = await getJSONStrong(store, pendingSubmissionKey(marker.libraryId, confirmation.idempotencyKey));
  return assertStoredCandidate(candidate, confirmation, marker, config);
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
      unitPrice: null,
      stillCurrent: current === null,
    });
  }
  const baseline = publicIndex.byVersion.get(marker.baselineApprovedVersion) || null;
  if (!baseline
      || baseline.businessKey !== marker.businessKey
      || baseline.contentHash !== marker.publicContentHash) {
    throw new AdminReviewError('ADMIN_REVIEW_BASELINE_MISMATCH', '待审核标记无法关联公共基线', 503);
  }
  return Object.freeze({
    approvedVersion: baseline.version,
    contentHash: baseline.contentHash,
    unitPrice: baseline.payload.unitPrice,
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
    serviceName: submission.payload.serviceName,
    settleType: submission.payload.settleType,
    candidateUnitPrice: submission.payload.unitPrice,
    baseline,
    distinctDeviceCount: marker.deviceIds.length,
    deviceTags: Object.freeze(marker.deviceIds.map(deviceTag)),
    createdAt: new Date(marker.createdAt).toISOString(),
    receivedAt: new Date(candidate.receivedAt).toISOString(),
  });
}

export function readAdminReviewConfig(env = {}) {
  if (String(env.CLOUD_ADMIN_REVIEW_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new AdminReviewError('ADMIN_REVIEW_PREVIEW_DISABLED', '管理员只读审核预览未开启', 503);
  }
  if (String(env.CLOUD_ADMIN_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new AdminReviewError('ADMIN_REVIEW_REQUIRES_ADMIN_AUTH', '管理员只读审核需要登录预览', 503);
  }
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '0').trim() === '1'
      || String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '0').trim() === '1') {
    throw new AdminReviewError('ADMIN_REVIEW_REQUIRES_PUBLIC_PREVIEW_DISABLED', '只读审核不能与公共预览写入同时开启', 503);
  }
  const storeName = String(env.CLOUD_ADMIN_REVIEW_BLOB_STORE_NAME || '').trim();
  const groupId = String(env.CLOUD_ADMIN_REVIEW_ALLOWED_GROUP_ID || '').trim();
  const libraryId = String(env.CLOUD_ADMIN_REVIEW_ALLOWED_LIBRARY_ID || '').trim();
  if (storeName !== ADMIN_REVIEW_PREVIEW_STORE_NAME
      || groupId !== ADMIN_REVIEW_ALLOWED_GROUP_ID
      || libraryId !== ADMIN_REVIEW_ALLOWED_LIBRARY_ID) {
    throw new AdminReviewError('ADMIN_REVIEW_SCOPE_MISCONFIGURED', '管理员只读审核作用域配置无效', 503);
  }
  return Object.freeze({
    storeName,
    groupId,
    libraryId,
    maxObjects: ADMIN_REVIEW_MAX_OBJECTS,
  });
}

export async function listAdminReviewQueue({ store, config } = {}) {
  const keys = await listReviewKeysStrong(store, config);
  let events;
  try {
    events = await listValidPublicEvents({ store, libraryId: config.libraryId });
  } catch (error) {
    throw new AdminReviewError('ADMIN_REVIEW_PUBLIC_BASELINE_INVALID', '公共基线无法通过只读校验', 503, null, error);
  }
  const publicIndex = indexPublicEvents(events);
  const items = [];
  for (const key of keys) {
    const parsed = parseReviewKey(key, config);
    const marker = assertReviewMarker(await getJSONStrong(store, key), parsed, config);
    const candidate = await readCandidateForMarker(store, marker, config);
    items.push(projectReview(parsed, marker, candidate, baselineProjection(marker, publicIndex)));
  }
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

export async function getAdminReviewDetail({ store, config, reviewId } = {}) {
  const normalizedReviewId = String(reviewId || '').trim();
  if (!REVIEW_ID_PATTERN.test(normalizedReviewId)) {
    throw new AdminReviewError('ADMIN_REVIEW_ID_INVALID', '审核详情ID无效', 400);
  }
  const queue = await listAdminReviewQueue({ store, config });
  const selected = queue.items.find(item => item.reviewId === normalizedReviewId) || null;
  if (!selected) throw new AdminReviewError('ADMIN_REVIEW_NOT_FOUND', '审核详情不存在', 404);
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

export function isAdminReviewId(value) {
  return REVIEW_ID_PATTERN.test(String(value || '').trim());
}

export function isAdminReviewProjectionSafe(value) {
  const text = JSON.stringify(value);
  return !/dev_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/sub_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/ik_v1_[A-Za-z0-9_-]{43}/.test(text)
    && !text.includes('reviews/')
    && !text.includes('submissions/');
}

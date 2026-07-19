import { createHash } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  canonicalize,
  normalizeExactPricePayload,
  normalizeSubmission,
} from './submission_policy_v1.js';

export const AUTO_APPROVAL_SCHEMA_VERSION = 1;
export const PUBLIC_EVENT_SCHEMA_VERSION = 1;
export const PUBLIC_SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_EVENT_RESERVATION_ATTEMPTS = 64;
export const MAX_CONFIRMATION_MARKERS_PER_CYCLE = 128;
export const MAX_PUBLIC_EVENT_OBJECTS = 10_000;
export const MAX_SAFE_PRICE_CHANGE_RATIO = 0.10;

const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBMISSION_ID_PATTERN = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;
const IDEMPOTENCY_KEY_PATTERN = /^ik_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^req_v1_[A-Za-z0-9_-]{43}$/;
const APPROVAL_ID_PATTERN = /^ap_v1_[A-Za-z0-9_-]{43}$/;
const EVENT_FILE_PATTERN = /^([0-9]{12})\.json$/;
const MAX_PUBLIC_VERSION = 999_999_999_999;
const PRICE_EPSILON = 1e-12;

export class AutoApprovalError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '自动审核处理失败');
    this.name = 'AutoApprovalError';
    this.code = code || 'AUTO_APPROVAL_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, keys, code, message) {
  if (!isPlainObject(value)) throw new AutoApprovalError(code, message, 500);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AutoApprovalError(code, message, 500, { actual, expected });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('base64url');
}

function assertSafeTime(now) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new AutoApprovalError('INVALID_SERVER_TIME', '服务器时间无效', 500);
  }
  return now;
}

function assertPattern(value, pattern, code, label) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) throw new AutoApprovalError(code, `${label}格式无效`, 500);
  return text;
}

function normalizeGroupId(value) {
  return assertPattern(String(value || '').trim().toLowerCase(), GROUP_ID_PATTERN, 'INVALID_GROUP_ID', 'groupId');
}

function normalizeLibraryId(value) {
  return assertPattern(String(value || '').trim().toLowerCase(), LIBRARY_ID_PATTERN, 'INVALID_LIBRARY_ID', 'libraryId');
}

function normalizeBusinessKey(value) {
  return assertPattern(value, BUSINESS_KEY_PATTERN, 'INVALID_BUSINESS_KEY', 'businessKey');
}

function normalizeContentHash(value) {
  return assertPattern(value, CONTENT_HASH_PATTERN, 'INVALID_CONTENT_HASH', 'contentHash');
}

function normalizePublicVersion(value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_PUBLIC_VERSION) {
    throw new AutoApprovalError('INVALID_PUBLIC_VERSION', '公共版本超出协议范围', 500, { value });
  }
  return value;
}

function padVersion(version, { allowZero = false } = {}) {
  return String(normalizePublicVersion(version, { allowZero })).padStart(12, '0');
}

function normalizePrefix(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  return `${normalizeBlobKey(base)}/`;
}

function alreadyExists(error) {
  return error instanceof BlobRepositoryError && error.code === 'BLOB_ALREADY_EXISTS';
}

async function listKeysStrong(store, prefix, maxObjects, limitCode) {
  if (!store || typeof store.list !== 'function') {
    throw new AutoApprovalError('BLOB_LIST_UNAVAILABLE', '自动审核需要Blob list能力', 500);
  }
  const normalizedPrefix = normalizePrefix(prefix);
  let result;
  try {
    result = await store.list({ prefix: normalizedPrefix, consistency: 'strong' });
  } catch (error) {
    throw new AutoApprovalError('BLOB_LIST_FAILED', '强一致列举Blob失败', 503, { prefix: normalizedPrefix }, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > maxObjects) {
    throw new AutoApprovalError(limitCode, 'Blob对象数量超过自动审核安全上限', 409, {
      prefix: normalizedPrefix,
      objectCount: blobs.length,
      maxObjects,
    });
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new AutoApprovalError('INVALID_BLOB_LIST', 'Blob列举结果包含空Key或重复Key', 503, { prefix: normalizedPrefix });
  }
  return keys.sort();
}

function recomputeBusinessKey(groupId, libraryId, payload) {
  return `bk_v1_${sha256Base64Url(canonicalize({
    groupId,
    libraryId,
    normalizedServiceName: payload.serviceName.toLowerCase(),
    settleType: payload.settleType,
    ruleType: 'exact',
    variant: 'standard',
  }))}`;
}

function recomputeContentHash(groupId, libraryId, payload) {
  return `ch_v1_${sha256Base64Url(canonicalize({
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    groupId,
    libraryId,
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    payload,
  }))}`;
}

function normalizeBaseline(value = null) {
  if (value === null || value === undefined) {
    return Object.freeze({ approvedVersion: 0, contentHash: null, unitPrice: null });
  }
  assertExactKeys(value, ['approvedVersion', 'contentHash', 'unitPrice'], 'INVALID_BASELINE_RECORD', '公共基线摘要结构无效');
  const approvedVersion = normalizePublicVersion(value.approvedVersion, { allowZero: true });
  if (approvedVersion === 0) {
    if (value.contentHash !== null || value.unitPrice !== null) {
      throw new AutoApprovalError('INVALID_BASELINE_RECORD', '空公共基线必须使用null内容', 500);
    }
    return Object.freeze({ approvedVersion: 0, contentHash: null, unitPrice: null });
  }
  const contentHash = normalizeContentHash(value.contentHash);
  const unitPrice = Number(value.unitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw new AutoApprovalError('INVALID_BASELINE_PRICE', '公共基线价格无效', 500);
  }
  return Object.freeze({ approvedVersion, contentHash, unitPrice });
}

function baselineFromSnapshotRecord(record) {
  if (!record) return normalizeBaseline(null);
  return normalizeBaseline({
    approvedVersion: record.approvedVersion,
    contentHash: record.contentHash,
    unitPrice: record.payload?.unitPrice,
  });
}

function sameBaseline(record, baseline) {
  const current = baselineFromSnapshotRecord(record);
  return current.approvedVersion === baseline.approvedVersion
    && current.contentHash === baseline.contentHash
    && current.unitPrice === baseline.unitPrice;
}

export function confirmationPrefix(libraryId, businessKey, baselineApprovedVersion = 0) {
  return normalizePrefix(
    `submissions/${normalizeLibraryId(libraryId)}/matches/${normalizeBusinessKey(businessKey)}/pv_${padVersion(baselineApprovedVersion, { allowZero: true })}`,
  );
}

export function confirmationMarkerKey(submission, baselineApprovedVersion = 0) {
  const normalized = normalizeSubmission(submission);
  return normalizeBlobKey(
    `${confirmationPrefix(normalized.libraryId, normalized.businessKey, baselineApprovedVersion)}${normalized.contentHash}/${normalized.deviceId}.json`,
  );
}

export function trustedDeviceKey(deviceId) {
  return normalizeBlobKey(`devices/trusted/${assertPattern(deviceId, DEVICE_ID_PATTERN, 'INVALID_DEVICE_ID', 'deviceId')}.json`);
}

export function reviewMarkerKey(libraryId, businessKey, baselineApprovedVersion, contentHash) {
  return normalizeBlobKey(
    `reviews/${normalizeLibraryId(libraryId)}/pending/${normalizeBusinessKey(businessKey)}/pv_${padVersion(baselineApprovedVersion, { allowZero: true })}/${normalizeContentHash(contentHash)}.json`,
  );
}

export function publicEventPrefix(libraryId) {
  return normalizePrefix(`public/${normalizeLibraryId(libraryId)}/events`);
}

export function publicEventKey(libraryId, version) {
  return normalizeBlobKey(`${publicEventPrefix(libraryId)}${padVersion(version)}.json`);
}

export function publicSnapshotKey(libraryId, version) {
  return normalizeBlobKey(`public/${normalizeLibraryId(libraryId)}/snapshots/${padVersion(version)}.json`);
}

export function approvalIdFor(submission, baselineRecord = null) {
  const normalized = normalizeSubmission(submission);
  const baseline = normalizeBaseline(baselineRecord);
  return `ap_v1_${sha256Base64Url(canonicalize({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    groupId: normalized.groupId,
    libraryId: normalized.libraryId,
    businessKey: normalized.businessKey,
    baselineApprovedVersion: baseline.approvedVersion,
    baselineContentHash: baseline.contentHash,
    targetContentHash: normalized.contentHash,
  }))}`;
}

export function approvalIndexKey(libraryId, approvalId) {
  const normalizedApprovalId = assertPattern(approvalId, APPROVAL_ID_PATTERN, 'INVALID_APPROVAL_ID', 'approvalId');
  return normalizeBlobKey(`public/${normalizeLibraryId(libraryId)}/approvals/${normalizedApprovalId}.json`);
}

export function transitionIndexKey(libraryId, businessKey, baselineApprovedVersion) {
  return normalizeBlobKey(
    `public/${normalizeLibraryId(libraryId)}/transitions/${normalizeBusinessKey(businessKey)}/${padVersion(baselineApprovedVersion, { allowZero: true })}.json`,
  );
}

function assertStoredCandidate(candidate) {
  assertExactKeys(candidate, [
    'schemaVersion', 'requestHash', 'status', 'decision', 'reason', 'submission',
    'receivedAt', 'authenticatedTokenVersion', 'publicMutationAllowed', 'autoApprovalEnabled',
  ], 'INVALID_STORED_CANDIDATE', '候选记录结构无效');
  if (candidate.schemaVersion !== 1 || candidate.status !== 'waiting_confirmation'
      || candidate.decision !== 'waiting_confirmation' || candidate.publicMutationAllowed !== false
      || candidate.autoApprovalEnabled !== false) {
    throw new AutoApprovalError('INVALID_CANDIDATE_STATUS', '自动审核只处理冻结的waiting_confirmation候选', 409);
  }
  assertPattern(candidate.requestHash, REQUEST_HASH_PATTERN, 'INVALID_REQUEST_HASH', 'requestHash');
  if (!Number.isSafeInteger(candidate.receivedAt) || candidate.receivedAt <= 0) {
    throw new AutoApprovalError('INVALID_CANDIDATE_TIME', '候选接收时间无效', 500);
  }
  if (!Number.isSafeInteger(candidate.authenticatedTokenVersion) || candidate.authenticatedTokenVersion < 1) {
    throw new AutoApprovalError('INVALID_TOKEN_VERSION', '候选令牌版本无效', 500);
  }
  return normalizeSubmission(candidate.submission);
}

function assertConfirmationMarker(marker, expected) {
  assertExactKeys(marker, [
    'schemaVersion', 'groupId', 'libraryId', 'businessKey', 'baselineApprovedVersion',
    'contentHash', 'deviceId', 'submissionId', 'idempotencyKey', 'receivedAt',
    'authenticatedTokenVersion',
  ], 'INVALID_CONFIRMATION_MARKER', '设备确认标记结构无效');
  if (marker.schemaVersion !== AUTO_APPROVAL_SCHEMA_VERSION
      || marker.groupId !== expected.groupId
      || marker.libraryId !== expected.libraryId
      || marker.businessKey !== expected.businessKey
      || marker.baselineApprovedVersion !== expected.baselineApprovedVersion
      || marker.contentHash !== expected.contentHash
      || marker.deviceId !== expected.deviceId
      || !SUBMISSION_ID_PATTERN.test(String(marker.submissionId || ''))
      || !IDEMPOTENCY_KEY_PATTERN.test(String(marker.idempotencyKey || ''))
      || !Number.isSafeInteger(marker.receivedAt) || marker.receivedAt <= 0
      || !Number.isSafeInteger(marker.authenticatedTokenVersion) || marker.authenticatedTokenVersion < 1) {
    throw new AutoApprovalError('INVALID_CONFIRMATION_MARKER', '设备确认标记内容无效', 500, { key: expected.key });
  }
  return marker;
}

async function ensureConfirmationMarker(store, candidate, submission, baseline) {
  const key = confirmationMarkerKey(submission, baseline.approvedVersion);
  const expected = {
    key,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    businessKey: submission.businessKey,
    baselineApprovedVersion: baseline.approvedVersion,
    contentHash: submission.contentHash,
    deviceId: submission.deviceId,
  };
  const marker = Object.freeze({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    businessKey: submission.businessKey,
    baselineApprovedVersion: baseline.approvedVersion,
    contentHash: submission.contentHash,
    deviceId: submission.deviceId,
    submissionId: submission.submissionId,
    idempotencyKey: submission.idempotencyKey,
    receivedAt: candidate.receivedAt,
    authenticatedTokenVersion: candidate.authenticatedTokenVersion,
  });
  try {
    await putJSONOnlyIfNew(store, key, marker);
    return marker;
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    return assertConfirmationMarker(await getJSONStrong(store, key), expected);
  }
}

function parseConfirmationKey(prefix, key) {
  if (!key.startsWith(prefix)) return null;
  const parts = key.slice(prefix.length).split('/');
  if (parts.length !== 2 || !parts[1].endsWith('.json')) return null;
  const contentHash = parts[0];
  const deviceId = parts[1].slice(0, -5);
  if (!CONTENT_HASH_PATTERN.test(contentHash) || !DEVICE_ID_PATTERN.test(deviceId)) return null;
  return { contentHash, deviceId, key };
}

async function collectBusinessConfirmations(store, submission, baseline) {
  const prefix = confirmationPrefix(submission.libraryId, submission.businessKey, baseline.approvedVersion);
  const keys = await listKeysStrong(
    store,
    prefix,
    MAX_CONFIRMATION_MARKERS_PER_CYCLE,
    'CONFIRMATION_MARKER_LIMIT_EXCEEDED',
  );
  const byContentHash = new Map();
  for (const key of keys) {
    const parsed = parseConfirmationKey(prefix, key);
    if (!parsed) {
      throw new AutoApprovalError('INVALID_CONFIRMATION_KEY', '候选确认目录包含不符合协议的Key', 500, { key });
    }
    const marker = assertConfirmationMarker(await getJSONStrong(store, key), {
      key,
      groupId: submission.groupId,
      libraryId: submission.libraryId,
      businessKey: submission.businessKey,
      baselineApprovedVersion: baseline.approvedVersion,
      contentHash: parsed.contentHash,
      deviceId: parsed.deviceId,
    });
    if (!byContentHash.has(parsed.contentHash)) byContentHash.set(parsed.contentHash, new Map());
    byContentHash.get(parsed.contentHash).set(parsed.deviceId, marker);
  }
  return byContentHash;
}

async function readTrustedDevice(store, deviceId) {
  const record = await getJSONStrong(store, trustedDeviceKey(deviceId));
  if (!record) return false;
  assertExactKeys(record, ['schemaVersion', 'deviceId', 'trusted', 'trustedAt', 'revokedAt'], 'INVALID_TRUSTED_DEVICE_RECORD', '可信设备记录结构无效');
  if (record.schemaVersion !== 1 || record.deviceId !== deviceId || typeof record.trusted !== 'boolean'
      || !Number.isSafeInteger(record.trustedAt) || record.trustedAt <= 0
      || !(record.revokedAt === null || (Number.isSafeInteger(record.revokedAt) && record.revokedAt > 0))) {
    throw new AutoApprovalError('INVALID_TRUSTED_DEVICE_RECORD', '可信设备记录内容无效', 500, { deviceId });
  }
  return record.trusted === true && record.revokedAt === null;
}

function eventVersionFromKey(prefix, key) {
  if (!key.startsWith(prefix)) return null;
  const match = EVENT_FILE_PATTERN.exec(key.slice(prefix.length));
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

function assertBaselineObject(value) {
  assertExactKeys(value, ['approvedVersion', 'contentHash', 'unitPrice'], 'INVALID_EVENT_BASELINE', '批准事件基线结构无效');
  return normalizeBaseline(value);
}

function assertPublicEvent(event, key, version) {
  assertExactKeys(event, [
    'schemaVersion', 'version', 'eventKey', 'approvalId', 'groupId', 'libraryId',
    'approvedAt', 'businessKey', 'contentHash', 'dataType', 'operation', 'payload',
    'baseline', 'approval',
  ], 'INVALID_PUBLIC_EVENT', '公共批准事件结构无效');
  const groupId = normalizeGroupId(event.groupId);
  const libraryId = normalizeLibraryId(event.libraryId);
  const payload = normalizeExactPricePayload(event.payload);
  const baseline = assertBaselineObject(event.baseline);
  assertExactKeys(event.approval, ['mode', 'deviceIds', 'submissionIds'], 'INVALID_EVENT_APPROVAL', '批准证据结构无效');
  const allowedModes = new Set([
    'two_devices_match',
    'trusted_device',
    'two_devices_safe_price_update',
    'admin_approved',
    'admin_edit_and_approved',
  ]);
  const singleEvidenceModes = new Set(['trusted_device', 'admin_approved', 'admin_edit_and_approved']);
  const deviceIds = Array.isArray(event.approval.deviceIds) ? event.approval.deviceIds.map(String) : [];
  const submissionIds = Array.isArray(event.approval.submissionIds) ? event.approval.submissionIds.map(String) : [];
  if (event.schemaVersion !== PUBLIC_EVENT_SCHEMA_VERSION || event.version !== version || event.eventKey !== key
      || !APPROVAL_ID_PATTERN.test(String(event.approvalId || ''))
      || event.businessKey !== recomputeBusinessKey(groupId, libraryId, payload)
      || event.contentHash !== recomputeContentHash(groupId, libraryId, payload)
      || event.dataType !== 'exact_price' || event.operation !== 'upsert'
      || !Number.isFinite(Date.parse(event.approvedAt))
      || !allowedModes.has(event.approval.mode)
      || deviceIds.length !== submissionIds.length || deviceIds.length < 1
      || new Set(deviceIds).size !== deviceIds.length || new Set(submissionIds).size !== submissionIds.length
      || deviceIds.some(id => !DEVICE_ID_PATTERN.test(id))
      || submissionIds.some(id => !SUBMISSION_ID_PATTERN.test(id))
      || (event.approval.mode === 'trusted_device' && deviceIds.length !== 1)
      || (!singleEvidenceModes.has(event.approval.mode) && deviceIds.length < 2)) {
    throw new AutoApprovalError('INVALID_PUBLIC_EVENT', '公共批准事件内容无效', 500, { key, version });
  }
  return Object.freeze({ ...event, groupId, libraryId, payload, baseline });
}

function assertApprovalIndex(index, approvalId = null) {
  assertExactKeys(index, [
    'schemaVersion', 'approvalId', 'groupId', 'libraryId', 'businessKey', 'contentHash',
    'baselineApprovedVersion', 'baselineContentHash', 'version', 'eventKey', 'createdAt',
  ], 'INVALID_APPROVAL_INDEX', '批准索引结构无效');
  if (index.schemaVersion !== AUTO_APPROVAL_SCHEMA_VERSION
      || !APPROVAL_ID_PATTERN.test(String(index.approvalId || ''))
      || !GROUP_ID_PATTERN.test(String(index.groupId || ''))
      || !LIBRARY_ID_PATTERN.test(String(index.libraryId || ''))
      || !BUSINESS_KEY_PATTERN.test(String(index.businessKey || ''))
      || !CONTENT_HASH_PATTERN.test(String(index.contentHash || ''))
      || !Number.isSafeInteger(index.baselineApprovedVersion) || index.baselineApprovedVersion < 0
      || !(index.baselineContentHash === null || CONTENT_HASH_PATTERN.test(String(index.baselineContentHash || '')))
      || !Number.isSafeInteger(index.version) || index.version < 1
      || typeof index.eventKey !== 'string'
      || !Number.isSafeInteger(index.createdAt) || index.createdAt <= 0
      || (index.baselineApprovedVersion === 0) !== (index.baselineContentHash === null)) {
    throw new AutoApprovalError('INVALID_APPROVAL_INDEX', '批准索引内容无效', 500);
  }
  if (approvalId && index.approvalId !== approvalId) {
    throw new AutoApprovalError('APPROVAL_INDEX_MISMATCH', '批准索引与目标批准ID不一致', 500);
  }
  return index;
}

function assertIndexEventLink(index, event) {
  if (index.approvalId !== event.approvalId || index.groupId !== event.groupId
      || index.libraryId !== event.libraryId || index.businessKey !== event.businessKey
      || index.contentHash !== event.contentHash || index.version !== event.version
      || index.eventKey !== event.eventKey
      || index.baselineApprovedVersion !== event.baseline.approvedVersion
      || index.baselineContentHash !== event.baseline.contentHash) {
    throw new AutoApprovalError('APPROVAL_EVENT_MISMATCH', '批准索引与公共事件不一致', 500, { approvalId: index.approvalId });
  }
  return true;
}

function assertTransitionIndex(index, expectedKey = null) {
  assertExactKeys(index, [
    'schemaVersion', 'transitionKey', 'approvalId', 'groupId', 'libraryId', 'businessKey',
    'baselineApprovedVersion', 'baselineContentHash', 'targetContentHash', 'version',
    'eventKey', 'createdAt',
  ], 'INVALID_TRANSITION_INDEX', '基线迁移索引结构无效');
  if (index.schemaVersion !== AUTO_APPROVAL_SCHEMA_VERSION
      || typeof index.transitionKey !== 'string'
      || !APPROVAL_ID_PATTERN.test(String(index.approvalId || ''))
      || !GROUP_ID_PATTERN.test(String(index.groupId || ''))
      || !LIBRARY_ID_PATTERN.test(String(index.libraryId || ''))
      || !BUSINESS_KEY_PATTERN.test(String(index.businessKey || ''))
      || !Number.isSafeInteger(index.baselineApprovedVersion) || index.baselineApprovedVersion < 0
      || !(index.baselineContentHash === null || CONTENT_HASH_PATTERN.test(String(index.baselineContentHash || '')))
      || !CONTENT_HASH_PATTERN.test(String(index.targetContentHash || ''))
      || !Number.isSafeInteger(index.version) || index.version < 1
      || typeof index.eventKey !== 'string'
      || !Number.isSafeInteger(index.createdAt) || index.createdAt <= 0
      || (index.baselineApprovedVersion === 0) !== (index.baselineContentHash === null)) {
    throw new AutoApprovalError('INVALID_TRANSITION_INDEX', '基线迁移索引内容无效', 500);
  }
  if (expectedKey && index.transitionKey !== expectedKey) {
    throw new AutoApprovalError('TRANSITION_INDEX_MISMATCH', '基线迁移索引Key不一致', 500);
  }
  return index;
}

export async function listValidPublicEvents({ store, libraryId } = {}) {
  const normalizedLibraryId = normalizeLibraryId(libraryId);
  const prefix = publicEventPrefix(normalizedLibraryId);
  const keys = await listKeysStrong(store, prefix, MAX_PUBLIC_EVENT_OBJECTS, 'PUBLIC_EVENT_LIMIT_EXCEEDED');
  const events = [];
  for (const key of keys) {
    const version = eventVersionFromKey(prefix, key);
    if (version === null) {
      throw new AutoApprovalError('INVALID_PUBLIC_EVENT_KEY', '公共事件目录包含不符合协议的Key', 500, { key });
    }
    const event = assertPublicEvent(await getJSONStrong(store, key), key, version);
    const index = await getJSONStrong(store, approvalIndexKey(normalizedLibraryId, event.approvalId));
    if (!index) continue;
    const validIndex = assertApprovalIndex(index, event.approvalId);
    if (validIndex.version !== version || validIndex.eventKey !== key) continue;
    assertIndexEventLink(validIndex, event);
    events.push(event);
  }
  return events.sort((left, right) => left.version - right.version);
}

export async function buildPublicSnapshot({ store, groupId, libraryId, now = Date.now() } = {}) {
  assertSafeTime(now);
  const normalizedGroupId = normalizeGroupId(groupId);
  const normalizedLibraryId = normalizeLibraryId(libraryId);
  const events = await listValidPublicEvents({ store, libraryId: normalizedLibraryId });
  const records = new Map();
  for (const event of events) {
    if (event.groupId !== normalizedGroupId || event.libraryId !== normalizedLibraryId) {
      throw new AutoApprovalError('PUBLIC_EVENT_SCOPE_MISMATCH', '公共事件作用域与目标价格库不一致', 500, { eventKey: event.eventKey });
    }
    records.set(event.businessKey, Object.freeze({
      businessKey: event.businessKey,
      contentHash: event.contentHash,
      dataType: event.dataType,
      operation: event.operation,
      approvedVersion: event.version,
      payload: event.payload,
    }));
  }
  const publicVersion = events.length ? events[events.length - 1].version : 0;
  return Object.freeze({
    schemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    payloadSchemaVersion: 1,
    groupId: normalizedGroupId,
    libraryId: normalizedLibraryId,
    publicVersion,
    snapshotVersion: publicVersion,
    cursor: `pv_${publicVersion}`,
    generatedAt: events.length ? events[events.length - 1].approvedAt : new Date(now).toISOString(),
    records: Object.freeze([...records.values()].sort((a, b) => a.businessKey.localeCompare(b.businessKey))),
    tombstones: Object.freeze([]),
  });
}

async function ensureLatestSnapshot(store, groupId, libraryId, now) {
  const snapshot = await buildPublicSnapshot({ store, groupId, libraryId, now });
  if (snapshot.publicVersion === 0) return Object.freeze({ snapshot, snapshotKey: null });
  const key = publicSnapshotKey(libraryId, snapshot.publicVersion);
  try {
    await putJSONOnlyIfNew(store, key, snapshot);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || canonicalize(existing) !== canonicalize(snapshot)) {
      throw new AutoApprovalError('SNAPSHOT_VERSION_CONFLICT', '同一公共版本对应了不同快照', 500, { key }, error);
    }
  }
  return Object.freeze({ snapshot, snapshotKey: key });
}

function findSnapshotRecord(snapshot, businessKey) {
  return snapshot.records.find(record => record.businessKey === businessKey) || null;
}

function decideExactPrice({ submission, baseline, matchingCount, trustedDevice, conflictingCount }) {
  if (conflictingCount > 0) {
    return Object.freeze({ decision: 'pending_review', reason: 'candidate_conflict', approvalMode: null, changeRatio: null });
  }
  if (baseline.approvedVersion === 0) {
    if (trustedDevice) {
      return Object.freeze({ decision: 'eligible_auto_approval', reason: 'trusted_device', approvalMode: 'trusted_device', changeRatio: null });
    }
    if (matchingCount >= 2) {
      return Object.freeze({ decision: 'eligible_auto_approval', reason: 'two_devices_match', approvalMode: 'two_devices_match', changeRatio: null });
    }
    return Object.freeze({ decision: 'waiting_confirmation', reason: 'second_device_required', approvalMode: null, changeRatio: null });
  }

  const changeRatio = Math.abs(submission.payload.unitPrice - baseline.unitPrice) / baseline.unitPrice;
  if (changeRatio > MAX_SAFE_PRICE_CHANGE_RATIO + PRICE_EPSILON) {
    return Object.freeze({ decision: 'pending_review', reason: 'price_change_exceeds_limit', approvalMode: null, changeRatio });
  }
  if (matchingCount >= 2) {
    return Object.freeze({
      decision: 'eligible_auto_approval',
      reason: 'two_devices_safe_price_update',
      approvalMode: 'two_devices_safe_price_update',
      changeRatio,
    });
  }
  return Object.freeze({
    decision: 'waiting_confirmation',
    reason: 'second_device_required_for_update',
    approvalMode: null,
    changeRatio,
  });
}

async function ensureReviewMarkers({ store, submission, baseline, confirmations, reason, now }) {
  const hashes = new Set([...confirmations.keys(), submission.contentHash]);
  for (const contentHash of [...hashes].sort()) {
    const markers = confirmations.get(contentHash) || new Map();
    const key = reviewMarkerKey(submission.libraryId, submission.businessKey, baseline.approvedVersion, contentHash);
    const marker = Object.freeze({
      schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
      status: 'pending_review',
      reason,
      groupId: submission.groupId,
      libraryId: submission.libraryId,
      businessKey: submission.businessKey,
      baselineApprovedVersion: baseline.approvedVersion,
      publicContentHash: baseline.contentHash,
      contentHash,
      deviceIds: Object.freeze([...markers.keys()].sort()),
      createdAt: now,
    });
    try {
      await putJSONOnlyIfNew(store, key, marker);
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      const existing = await getJSONStrong(store, key);
      if (!existing || existing.schemaVersion !== AUTO_APPROVAL_SCHEMA_VERSION
          || existing.status !== 'pending_review' || existing.groupId !== submission.groupId
          || existing.libraryId !== submission.libraryId || existing.businessKey !== submission.businessKey
          || existing.baselineApprovedVersion !== baseline.approvedVersion
          || existing.publicContentHash !== baseline.contentHash || existing.contentHash !== contentHash) {
        throw new AutoApprovalError('REVIEW_MARKER_CONFLICT', '待审核标记与当前候选不一致', 500, { key }, error);
      }
    }
  }
}

async function reserveEventSlot(store, submission, baseline, approvalId, approvalMode, markers, now) {
  const prefix = publicEventPrefix(submission.libraryId);
  for (let attempt = 0; attempt < MAX_EVENT_RESERVATION_ATTEMPTS; attempt += 1) {
    const keys = await listKeysStrong(store, prefix, MAX_PUBLIC_EVENT_OBJECTS, 'PUBLIC_EVENT_LIMIT_EXCEEDED');
    let maxVersion = 0;
    for (const key of keys) {
      const version = eventVersionFromKey(prefix, key);
      if (version === null) throw new AutoApprovalError('INVALID_PUBLIC_EVENT_KEY', '公共事件目录包含不符合协议的Key', 500, { key });
      maxVersion = Math.max(maxVersion, version);
    }
    const version = maxVersion + 1;
    const eventKey = publicEventKey(submission.libraryId, version);
    const deviceIds = [...markers.keys()].sort();
    const submissionIds = deviceIds.map(id => String(markers.get(id)?.submissionId || '')).filter(Boolean);
    const event = Object.freeze({
      schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
      version,
      eventKey,
      approvalId,
      groupId: submission.groupId,
      libraryId: submission.libraryId,
      approvedAt: new Date(now).toISOString(),
      businessKey: submission.businessKey,
      contentHash: submission.contentHash,
      dataType: submission.dataType,
      operation: submission.operation,
      payload: submission.payload,
      baseline: Object.freeze({
        approvedVersion: baseline.approvedVersion,
        contentHash: baseline.contentHash,
        unitPrice: baseline.unitPrice,
      }),
      approval: Object.freeze({
        mode: approvalMode,
        deviceIds: Object.freeze(deviceIds),
        submissionIds: Object.freeze(submissionIds),
      }),
    });
    try {
      await putJSONOnlyIfNew(store, eventKey, event);
      return event;
    } catch (error) {
      if (!alreadyExists(error)) throw error;
    }
  }
  throw new AutoApprovalError('PUBLIC_EVENT_RESERVATION_EXHAUSTED', '公共事件版本预留重试次数已耗尽', 503);
}

async function readEventByIndex(store, index) {
  const event = assertPublicEvent(await getJSONStrong(store, index.eventKey), index.eventKey, index.version);
  assertIndexEventLink(index, event);
  return event;
}

async function ensureTransitionClaim({ store, submission, baseline, approvalId, reservedEvent, now }) {
  const key = transitionIndexKey(submission.libraryId, submission.businessKey, baseline.approvedVersion);
  const proposed = Object.freeze({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    transitionKey: key,
    approvalId,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    businessKey: submission.businessKey,
    baselineApprovedVersion: baseline.approvedVersion,
    baselineContentHash: baseline.contentHash,
    targetContentHash: submission.contentHash,
    version: reservedEvent.version,
    eventKey: reservedEvent.eventKey,
    createdAt: now,
  });
  try {
    await putJSONOnlyIfNew(store, key, proposed);
    return Object.freeze({ transition: proposed, created: true });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const existing = assertTransitionIndex(await getJSONStrong(store, key), key);
    if (existing.approvalId !== approvalId || existing.baselineContentHash !== baseline.contentHash
        || existing.targetContentHash !== submission.contentHash) {
      throw new AutoApprovalError('BASELINE_TRANSITION_CONFLICT', '同一公共基线已被另一个候选值占用', 409, {
        businessKey: submission.businessKey,
        baselineApprovedVersion: baseline.approvedVersion,
      }, error);
    }
    return Object.freeze({ transition: existing, created: false });
  }
}

async function publishAutomaticApproval({ store, submission, baseline, approvalMode, markers, now }) {
  const approvalId = approvalIdFor(submission, baseline);
  const indexKey = approvalIndexKey(submission.libraryId, approvalId);
  const existingIndex = await getJSONStrong(store, indexKey);
  if (existingIndex) {
    const index = assertApprovalIndex(existingIndex, approvalId);
    const event = await readEventByIndex(store, index);
    const latest = await ensureLatestSnapshot(store, submission.groupId, submission.libraryId, now);
    return Object.freeze({ approvalId, index, event, ...latest, duplicateApproval: true, publicMutationApplied: false });
  }

  const currentSnapshot = await buildPublicSnapshot({
    store,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    now,
  });
  const currentRecord = findSnapshotRecord(currentSnapshot, submission.businessKey);
  if (!sameBaseline(currentRecord, baseline)) {
    throw new AutoApprovalError('STALE_PUBLIC_BASELINE', '公共价格已变化，当前候选必须重新审核', 409, {
      businessKey: submission.businessKey,
      baselineApprovedVersion: baseline.approvedVersion,
    });
  }

  const transitionKey = transitionIndexKey(submission.libraryId, submission.businessKey, baseline.approvedVersion);
  let transition = await getJSONStrong(store, transitionKey);
  let reservedEvent = null;
  let transitionCreated = false;
  if (transition) {
    transition = assertTransitionIndex(transition, transitionKey);
    if (transition.approvalId !== approvalId || transition.baselineContentHash !== baseline.contentHash
        || transition.targetContentHash !== submission.contentHash) {
      throw new AutoApprovalError('BASELINE_TRANSITION_CONFLICT', '同一公共基线已批准其他候选值', 409, {
        businessKey: submission.businessKey,
        baselineApprovedVersion: baseline.approvedVersion,
      });
    }
  } else {
    reservedEvent = await reserveEventSlot(store, submission, baseline, approvalId, approvalMode, markers, now);
    const claimed = await ensureTransitionClaim({ store, submission, baseline, approvalId, reservedEvent, now });
    transition = claimed.transition;
    transitionCreated = claimed.created;
  }

  const canonicalEvent = assertPublicEvent(
    await getJSONStrong(store, transition.eventKey),
    transition.eventKey,
    transition.version,
  );
  if (canonicalEvent.approvalId !== approvalId) {
    throw new AutoApprovalError('TRANSITION_EVENT_MISMATCH', '基线迁移索引与批准事件不一致', 500);
  }

  const proposedIndex = Object.freeze({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    approvalId,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    baselineApprovedVersion: baseline.approvedVersion,
    baselineContentHash: baseline.contentHash,
    version: canonicalEvent.version,
    eventKey: canonicalEvent.eventKey,
    createdAt: now,
  });

  let index = proposedIndex;
  let indexCreated = false;
  try {
    await putJSONOnlyIfNew(store, indexKey, proposedIndex);
    indexCreated = true;
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    index = assertApprovalIndex(await getJSONStrong(store, indexKey), approvalId);
  }
  const event = await readEventByIndex(store, index);
  const latest = await ensureLatestSnapshot(store, submission.groupId, submission.libraryId, now);
  return Object.freeze({
    approvalId,
    index,
    event,
    ...latest,
    duplicateApproval: !indexCreated || !transitionCreated || Boolean(reservedEvent && reservedEvent.eventKey !== event.eventKey),
    publicMutationApplied: indexCreated,
  });
}

export async function publishAdminReviewApproval({
  store,
  submission,
  baseline,
  approvalMode,
  evidence,
  now = Date.now(),
} = {}) {
  assertSafeTime(now);
  const normalizedSubmission = normalizeSubmission(submission);
  const normalizedBaseline = normalizeBaseline(baseline);
  if (!['admin_approved', 'admin_edit_and_approved'].includes(approvalMode)) {
    throw new AutoApprovalError('INVALID_ADMIN_APPROVAL_MODE', '管理员批准模式无效', 400);
  }
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > MAX_CONFIRMATION_MARKERS_PER_CYCLE) {
    throw new AutoApprovalError('INVALID_ADMIN_APPROVAL_EVIDENCE', '管理员批准证据数量无效', 400);
  }
  const markers = new Map();
  for (const item of evidence) {
    const deviceId = assertPattern(item?.deviceId, DEVICE_ID_PATTERN, 'INVALID_DEVICE_ID', 'deviceId');
    const submissionId = assertPattern(item?.submissionId, SUBMISSION_ID_PATTERN, 'INVALID_SUBMISSION_ID', 'submissionId');
    if (markers.has(deviceId)) {
      throw new AutoApprovalError('INVALID_ADMIN_APPROVAL_EVIDENCE', '管理员批准证据包含重复设备', 400);
    }
    markers.set(deviceId, Object.freeze({ submissionId }));
  }
  return publishAutomaticApproval({
    store,
    submission: normalizedSubmission,
    baseline: normalizedBaseline,
    approvalMode,
    markers,
    now,
  });
}

function autoApprovedNoopResult({ decision, reason, approvalMode, matchingCount, conflictingCount, latest, eventVersion, baseline, changeRatio = null }) {
  return Object.freeze({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    status: 'auto_approved',
    decision,
    reason,
    approvalMode,
    approvalId: null,
    baselineApprovedVersion: baseline.approvedVersion,
    matchingDistinctDeviceCount: matchingCount,
    conflictingCandidateCount: conflictingCount,
    changeRatio,
    publicVersion: latest.snapshot.publicVersion,
    eventVersion,
    snapshotKey: latest.snapshotKey,
    publicMutationApplied: false,
    duplicateApproval: true,
    autoApprovalEnabled: true,
  });
}

function pendingResult({ status, decision, reason, matchingCount, conflictingCount, snapshot, baseline, changeRatio = null }) {
  return Object.freeze({
    schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
    status,
    decision,
    reason,
    approvalMode: null,
    approvalId: null,
    baselineApprovedVersion: baseline.approvedVersion,
    matchingDistinctDeviceCount: matchingCount,
    conflictingCandidateCount: conflictingCount,
    changeRatio,
    publicVersion: snapshot.publicVersion,
    eventVersion: null,
    snapshotKey: null,
    publicMutationApplied: false,
    duplicateApproval: false,
    autoApprovalEnabled: true,
  });
}

export async function reviewExactPriceCandidate({
  store,
  candidate,
  now = Date.now(),
  trustedDeviceResolver = readTrustedDevice,
} = {}) {
  assertSafeTime(now);
  const submission = assertStoredCandidate(candidate);
  const snapshot = await buildPublicSnapshot({
    store,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    now,
  });
  const existingRecord = findSnapshotRecord(snapshot, submission.businessKey);
  const baseline = baselineFromSnapshotRecord(existingRecord);

  if (existingRecord?.contentHash === submission.contentHash) {
    const latest = await ensureLatestSnapshot(store, submission.groupId, submission.libraryId, now);
    return autoApprovedNoopResult({
      decision: 'duplicate_noop',
      reason: 'same_as_public',
      approvalMode: 'public_duplicate',
      matchingCount: 0,
      conflictingCount: 0,
      latest,
      eventVersion: existingRecord.approvedVersion,
      baseline,
    });
  }

  await ensureConfirmationMarker(store, candidate, submission, baseline);
  const confirmations = await collectBusinessConfirmations(store, submission, baseline);
  const matchingMarkers = confirmations.get(submission.contentHash) || new Map();
  const conflictingCount = [...confirmations.keys()].filter(hash => hash !== submission.contentHash).length;
  const trustedDevice = Boolean(await trustedDeviceResolver(store, submission.deviceId));
  const decision = decideExactPrice({
    submission,
    baseline,
    matchingCount: matchingMarkers.size,
    trustedDevice,
    conflictingCount,
  });

  if (decision.decision === 'pending_review') {
    await ensureReviewMarkers({ store, submission, baseline, confirmations, reason: decision.reason, now });
    return pendingResult({
      status: 'pending_review',
      decision: decision.decision,
      reason: decision.reason,
      matchingCount: matchingMarkers.size,
      conflictingCount,
      snapshot,
      baseline,
      changeRatio: decision.changeRatio,
    });
  }

  if (decision.decision === 'waiting_confirmation') {
    return pendingResult({
      status: 'waiting_confirmation',
      decision: decision.decision,
      reason: decision.reason,
      matchingCount: matchingMarkers.size,
      conflictingCount,
      snapshot,
      baseline,
      changeRatio: decision.changeRatio,
    });
  }

  try {
    const published = await publishAutomaticApproval({
      store,
      submission,
      baseline,
      approvalMode: decision.approvalMode,
      markers: matchingMarkers,
      now,
    });
    return Object.freeze({
      schemaVersion: AUTO_APPROVAL_SCHEMA_VERSION,
      status: 'auto_approved',
      decision: decision.decision,
      reason: decision.reason,
      approvalMode: decision.approvalMode,
      approvalId: published.approvalId,
      baselineApprovedVersion: baseline.approvedVersion,
      matchingDistinctDeviceCount: matchingMarkers.size,
      conflictingCandidateCount: conflictingCount,
      changeRatio: decision.changeRatio,
      publicVersion: published.snapshot.publicVersion,
      eventVersion: published.event.version,
      snapshotKey: published.snapshotKey,
      publicMutationApplied: published.publicMutationApplied,
      duplicateApproval: published.duplicateApproval,
      autoApprovalEnabled: true,
    });
  } catch (error) {
    if (!(error instanceof AutoApprovalError)
        || !['BASELINE_TRANSITION_CONFLICT', 'STALE_PUBLIC_BASELINE'].includes(error.code)) {
      throw error;
    }
    const refreshed = await buildPublicSnapshot({
      store,
      groupId: submission.groupId,
      libraryId: submission.libraryId,
      now,
    });
    const refreshedRecord = findSnapshotRecord(refreshed, submission.businessKey);
    if (refreshedRecord?.contentHash === submission.contentHash) {
      const latest = await ensureLatestSnapshot(store, submission.groupId, submission.libraryId, now);
      return autoApprovedNoopResult({
        decision: 'duplicate_noop',
        reason: 'same_as_public_after_race',
        approvalMode: 'public_duplicate',
        matchingCount: matchingMarkers.size,
        conflictingCount,
        latest,
        eventVersion: refreshedRecord.approvedVersion,
        baseline: baselineFromSnapshotRecord(refreshedRecord),
        changeRatio: decision.changeRatio,
      });
    }
    const reason = error.code === 'BASELINE_TRANSITION_CONFLICT'
      ? 'baseline_transition_conflict'
      : 'stale_public_baseline';
    await ensureReviewMarkers({ store, submission, baseline, confirmations, reason, now });
    return pendingResult({
      status: 'pending_review',
      decision: 'pending_review',
      reason,
      matchingCount: matchingMarkers.size,
      conflictingCount,
      snapshot: refreshed,
      baseline,
      changeRatio: decision.changeRatio,
    });
  }
}

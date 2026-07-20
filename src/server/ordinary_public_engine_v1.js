import { createHash } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  approvalIndexKey,
  confirmationPrefix,
  publicEventKey,
  publicEventPrefix,
  publicSnapshotKey,
  reviewMarkerKey,
  transitionIndexKey,
  trustedDeviceKey,
} from './auto_approval_engine_v1.js';
import {
  canonicalize,
} from './submission_policy_v1.js';
import {
  computeOrdinarySubmissionHashes,
  deriveBossId,
  evaluateOrdinaryCandidate,
  normalizeBossProfilePayload,
  normalizeOrdinarySubmission,
  normalizePlayableNamePayload,
} from './ordinary_types_policy_v1.js';

export const ORDINARY_PUBLIC_ENGINE_VERSION = 1;
export const ORDINARY_PUBLIC_EVENT_SCHEMA_VERSION = 1;
export const ORDINARY_PUBLIC_SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_ORDINARY_CONFIRMATION_MARKERS = 128;
export const MAX_ORDINARY_PUBLIC_EVENTS = 10_000;
export const MAX_ORDINARY_EVENT_RESERVATION_ATTEMPTS = 64;
export const MAX_SAFE_EXACT_PRICE_CHANGE_RATIO = 0.10;

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
const SUPPORTED_DATA_TYPES = new Set(['exact_price', 'playable_name', 'boss_profile']);
const ALLOWED_APPROVAL_MODES = new Set([
  'two_devices_match',
  'trusted_device',
  'two_devices_safe_price_update',
  'two_devices_ordinary_update',
  'admin_approved',
  'admin_edit_and_approved',
]);
const SINGLE_EVIDENCE_MODES = new Set([
  'trusted_device',
  'admin_approved',
  'admin_edit_and_approved',
]);

export class OrdinaryPublicEngineError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '普通共享公共事件处理失败');
    this.name = 'OrdinaryPublicEngineError';
    this.code = code || 'ORDINARY_PUBLIC_ENGINE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message, status = 500) {
  if (!isPlainObject(value)) throw new OrdinaryPublicEngineError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new OrdinaryPublicEngineError(code, message, status, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function assertPattern(value, pattern, code, label, status = 500) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) throw new OrdinaryPublicEngineError(code, `${label}格式无效`, status);
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

function assertSafeTime(now) {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new OrdinaryPublicEngineError('INVALID_SERVER_TIME', '服务器时间无效', 500);
  }
  return now;
}

function normalizePublicVersion(value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_PUBLIC_VERSION) {
    throw new OrdinaryPublicEngineError('INVALID_PUBLIC_VERSION', '公共版本超出协议范围', 500, { value });
  }
  return value;
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
    throw new OrdinaryPublicEngineError('BLOB_LIST_UNAVAILABLE', '普通共享公共事件需要Blob list能力', 500);
  }
  const normalizedPrefix = normalizePrefix(prefix);
  let result;
  try {
    result = await store.list({ prefix: normalizedPrefix, consistency: 'strong' });
  } catch (error) {
    throw new OrdinaryPublicEngineError('BLOB_LIST_FAILED', '强一致列举Blob失败', 503, { prefix: normalizedPrefix }, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > maxObjects) {
    throw new OrdinaryPublicEngineError(limitCode, 'Blob对象数量超过普通共享安全上限', 409, {
      prefix: normalizedPrefix,
      objectCount: blobs.length,
      maxObjects,
    });
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new OrdinaryPublicEngineError('INVALID_BLOB_LIST', 'Blob列举结果包含空Key或重复Key', 503, { prefix: normalizedPrefix });
  }
  return keys.sort();
}

function normalizeBaseline(value = null, dataType = 'exact_price') {
  if (value === null || value === undefined) {
    return Object.freeze({ approvedVersion: 0, contentHash: null, unitPrice: null });
  }
  assertExactKeys(value, ['approvedVersion', 'contentHash', 'unitPrice'], 'INVALID_BASELINE_RECORD', '公共基线摘要结构无效');
  const approvedVersion = normalizePublicVersion(value.approvedVersion, { allowZero: true });
  if (approvedVersion === 0) {
    if (value.contentHash !== null || value.unitPrice !== null) {
      throw new OrdinaryPublicEngineError('INVALID_BASELINE_RECORD', '空公共基线必须使用null内容', 500);
    }
    return Object.freeze({ approvedVersion: 0, contentHash: null, unitPrice: null });
  }
  const contentHash = normalizeContentHash(value.contentHash);
  if (dataType === 'exact_price') {
    const unitPrice = Number(value.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new OrdinaryPublicEngineError('INVALID_BASELINE_PRICE', '普通单价公共基线无效', 500);
    }
    return Object.freeze({ approvedVersion, contentHash, unitPrice });
  }
  if (value.unitPrice !== null) {
    throw new OrdinaryPublicEngineError('INVALID_BASELINE_RECORD', '非价格公共基线unitPrice必须为null', 500);
  }
  return Object.freeze({ approvedVersion, contentHash, unitPrice: null });
}

function baselineFromSnapshotRecord(record, dataType) {
  if (!record) return normalizeBaseline(null, dataType);
  return normalizeBaseline({
    approvedVersion: record.approvedVersion,
    contentHash: record.contentHash,
    unitPrice: dataType === 'exact_price' ? record.payload?.unitPrice : null,
  }, dataType);
}

function sameBaseline(record, baseline, dataType) {
  const current = baselineFromSnapshotRecord(record, dataType);
  return current.approvedVersion === baseline.approvedVersion
    && current.contentHash === baseline.contentHash
    && current.unitPrice === baseline.unitPrice;
}

function eventVersionFromKey(prefix, key) {
  if (!key.startsWith(prefix)) return null;
  const match = EVENT_FILE_PATTERN.exec(key.slice(prefix.length));
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

function normalizeEventPayload(dataType, payload) {
  if (dataType === 'exact_price') {
    const raw = {
      schemaVersion: 1,
      payloadSchemaVersion: 1,
      submissionId: 'sub_01JABCDEF0123456789XYZABCD',
      deviceId: 'dev_01JABCDEF0123456789XYZABCD',
      groupId: 'group_fixture',
      libraryId: 'lib_receive_fixture',
      bossId: null,
      dataType: 'exact_price',
      operation: 'upsert',
      origin: 'user',
      clientCreatedAt: 0,
      businessKey: `bk_v1_${'A'.repeat(43)}`,
      contentHash: `ch_v1_${'A'.repeat(43)}`,
      idempotencyKey: `ik_v1_${'A'.repeat(43)}`,
      payload,
      clientContext: { appVersion: '8.2.28-stage5g', projectionSpecVersion: 1, queueSchemaVersion: 1 },
    };
    return computeOrdinarySubmissionHashes(raw).submission.payload;
  }
  if (dataType === 'playable_name') return normalizePlayableNamePayload(payload);
  if (dataType === 'boss_profile') return normalizeBossProfilePayload(payload);
  throw new OrdinaryPublicEngineError('UNSUPPORTED_PUBLIC_DATA_TYPE', '公共事件数据类型不受支持', 500);
}

function recomputeEventHashes(event, deviceId, submissionId) {
  const raw = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId,
    deviceId,
    groupId: event.groupId,
    libraryId: event.libraryId,
    bossId: null,
    dataType: event.dataType,
    operation: event.operation,
    origin: 'user',
    clientCreatedAt: 0,
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    idempotencyKey: `ik_v1_${'A'.repeat(43)}`,
    payload: event.payload,
    clientContext: { appVersion: '8.2.28-stage5g', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  return computeOrdinarySubmissionHashes(raw);
}

function assertPublicEvent(event, key, version) {
  assertExactKeys(event, [
    'schemaVersion', 'version', 'eventKey', 'approvalId', 'groupId', 'libraryId',
    'approvedAt', 'businessKey', 'contentHash', 'dataType', 'operation', 'payload',
    'baseline', 'approval',
  ], 'INVALID_PUBLIC_EVENT', '公共批准事件结构无效');
  const groupId = normalizeGroupId(event.groupId);
  const libraryId = normalizeLibraryId(event.libraryId);
  const dataType = String(event.dataType || '').trim().toLowerCase();
  if (!SUPPORTED_DATA_TYPES.has(dataType) || event.operation !== 'upsert') {
    throw new OrdinaryPublicEngineError('INVALID_PUBLIC_EVENT', '公共事件类型或操作无效', 500, { key, version });
  }
  const payload = normalizeEventPayload(dataType, event.payload);
  const baseline = normalizeBaseline(event.baseline, dataType);
  assertExactKeys(event.approval, ['mode', 'deviceIds', 'submissionIds'], 'INVALID_EVENT_APPROVAL', '批准证据结构无效');
  const deviceIds = Array.isArray(event.approval.deviceIds) ? event.approval.deviceIds.map(String) : [];
  const submissionIds = Array.isArray(event.approval.submissionIds) ? event.approval.submissionIds.map(String) : [];
  if (event.schemaVersion !== ORDINARY_PUBLIC_EVENT_SCHEMA_VERSION || event.version !== version || event.eventKey !== key
      || !APPROVAL_ID_PATTERN.test(String(event.approvalId || ''))
      || !Number.isFinite(Date.parse(event.approvedAt))
      || !ALLOWED_APPROVAL_MODES.has(event.approval.mode)
      || deviceIds.length !== submissionIds.length || deviceIds.length < 1
      || new Set(deviceIds).size !== deviceIds.length || new Set(submissionIds).size !== submissionIds.length
      || deviceIds.some(id => !DEVICE_ID_PATTERN.test(id))
      || submissionIds.some(id => !SUBMISSION_ID_PATTERN.test(id))
      || (event.approval.mode === 'trusted_device' && deviceIds.length !== 1)
      || (!SINGLE_EVIDENCE_MODES.has(event.approval.mode) && deviceIds.length < 2)) {
    throw new OrdinaryPublicEngineError('INVALID_PUBLIC_EVENT', '公共批准事件内容无效', 500, { key, version });
  }
  let computed;
  try {
    computed = recomputeEventHashes({ ...event, groupId, libraryId, dataType, payload }, deviceIds[0], submissionIds[0]);
  } catch (error) {
    throw new OrdinaryPublicEngineError(error?.code || 'INVALID_PUBLIC_EVENT', '公共事件Hash重算失败', 500, error?.details || null, error);
  }
  if (computed.businessKey !== event.businessKey || computed.contentHash !== event.contentHash) {
    throw new OrdinaryPublicEngineError('INVALID_PUBLIC_EVENT_HASH', '公共事件业务键或内容Hash无效', 500, { key, version });
  }
  return Object.freeze({ ...event, groupId, libraryId, dataType, payload, baseline });
}

function assertApprovalIndex(index, approvalId = null) {
  assertExactKeys(index, [
    'schemaVersion', 'approvalId', 'groupId', 'libraryId', 'businessKey', 'contentHash',
    'baselineApprovedVersion', 'baselineContentHash', 'version', 'eventKey', 'createdAt',
  ], 'INVALID_APPROVAL_INDEX', '批准索引结构无效');
  if (index.schemaVersion !== ORDINARY_PUBLIC_ENGINE_VERSION
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
    throw new OrdinaryPublicEngineError('INVALID_APPROVAL_INDEX', '批准索引内容无效', 500);
  }
  if (approvalId && index.approvalId !== approvalId) {
    throw new OrdinaryPublicEngineError('APPROVAL_INDEX_MISMATCH', '批准索引与目标批准ID不一致', 500);
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
    throw new OrdinaryPublicEngineError('APPROVAL_EVENT_MISMATCH', '批准索引与公共事件不一致', 500, { approvalId: index.approvalId });
  }
  return true;
}

function assertTransitionIndex(index, expectedKey = null) {
  assertExactKeys(index, [
    'schemaVersion', 'transitionKey', 'approvalId', 'groupId', 'libraryId', 'businessKey',
    'baselineApprovedVersion', 'baselineContentHash', 'targetContentHash', 'version',
    'eventKey', 'createdAt',
  ], 'INVALID_TRANSITION_INDEX', '基线迁移索引结构无效');
  if (index.schemaVersion !== ORDINARY_PUBLIC_ENGINE_VERSION
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
    throw new OrdinaryPublicEngineError('INVALID_TRANSITION_INDEX', '基线迁移索引内容无效', 500);
  }
  if (expectedKey && index.transitionKey !== expectedKey) {
    throw new OrdinaryPublicEngineError('TRANSITION_INDEX_MISMATCH', '基线迁移索引Key不一致', 500);
  }
  return index;
}

export async function listValidOrdinaryPublicEvents({ store, libraryId } = {}) {
  const normalizedLibraryId = normalizeLibraryId(libraryId);
  const prefix = publicEventPrefix(normalizedLibraryId);
  const keys = await listKeysStrong(store, prefix, MAX_ORDINARY_PUBLIC_EVENTS, 'PUBLIC_EVENT_LIMIT_EXCEEDED');
  const events = [];
  for (const key of keys) {
    const version = eventVersionFromKey(prefix, key);
    if (version === null) {
      throw new OrdinaryPublicEngineError('INVALID_PUBLIC_EVENT_KEY', '公共事件目录包含不符合协议的Key', 500, { key });
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

export async function buildOrdinaryPublicSnapshot({ store, groupId, libraryId, now = Date.now() } = {}) {
  assertSafeTime(now);
  const normalizedGroupId = normalizeGroupId(groupId);
  const normalizedLibraryId = normalizeLibraryId(libraryId);
  const events = await listValidOrdinaryPublicEvents({ store, libraryId: normalizedLibraryId });
  const records = new Map();
  for (const event of events) {
    if (event.groupId !== normalizedGroupId || event.libraryId !== normalizedLibraryId) {
      throw new OrdinaryPublicEngineError('PUBLIC_EVENT_SCOPE_MISMATCH', '公共事件作用域与目标价格库不一致', 500, { eventKey: event.eventKey });
    }
    const record = {
      businessKey: event.businessKey,
      contentHash: event.contentHash,
      dataType: event.dataType,
      operation: event.operation,
      approvedVersion: event.version,
      payload: event.payload,
    };
    if (event.dataType === 'boss_profile') record.bossId = deriveBossId(event.groupId, event.payload.bossName);
    records.set(event.businessKey, Object.freeze(record));
  }
  const publicVersion = events.length ? events[events.length - 1].version : 0;
  return Object.freeze({
    schemaVersion: ORDINARY_PUBLIC_SNAPSHOT_SCHEMA_VERSION,
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
  const snapshot = await buildOrdinaryPublicSnapshot({ store, groupId, libraryId, now });
  if (snapshot.publicVersion === 0) return Object.freeze({ snapshot, snapshotKey: null });
  const key = publicSnapshotKey(libraryId, snapshot.publicVersion);
  try {
    await putJSONOnlyIfNew(store, key, snapshot);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || canonicalize(existing) !== canonicalize(snapshot)) {
      throw new OrdinaryPublicEngineError('SNAPSHOT_VERSION_CONFLICT', '同一公共版本对应了不同快照', 500, { key }, error);
    }
  }
  return Object.freeze({ snapshot, snapshotKey: key });
}

function findSnapshotRecord(snapshot, businessKey) {
  return snapshot.records.find(record => record.businessKey === businessKey) || null;
}

function assertStoredCandidate(candidate) {
  assertExactKeys(candidate, [
    'schemaVersion', 'requestHash', 'status', 'decision', 'reason', 'submission',
    'receivedAt', 'authenticatedTokenVersion', 'publicMutationAllowed', 'autoApprovalEnabled',
  ], 'INVALID_STORED_CANDIDATE', '普通共享候选记录结构无效');
  if (candidate.schemaVersion !== 1
      || !['waiting_confirmation', 'pending_review'].includes(candidate.status)
      || !['waiting_confirmation', 'pending_review'].includes(candidate.decision)
      || candidate.publicMutationAllowed !== false || candidate.autoApprovalEnabled !== false
      || !REQUEST_HASH_PATTERN.test(String(candidate.requestHash || ''))
      || !Number.isSafeInteger(candidate.receivedAt) || candidate.receivedAt <= 0
      || !Number.isSafeInteger(candidate.authenticatedTokenVersion) || candidate.authenticatedTokenVersion < 1) {
    throw new OrdinaryPublicEngineError('INVALID_STORED_CANDIDATE', '普通共享候选状态无效', 409);
  }
  try {
    return normalizeOrdinarySubmission(candidate.submission);
  } catch (error) {
    throw new OrdinaryPublicEngineError(error?.code || 'INVALID_STORED_CANDIDATE', '普通共享候选提交无效', 500, error?.details || null, error);
  }
}

function markerKey(submission, baselineApprovedVersion) {
  return normalizeBlobKey(
    `${confirmationPrefix(submission.libraryId, submission.businessKey, baselineApprovedVersion)}${submission.contentHash}/${submission.deviceId}.json`,
  );
}

function assertConfirmationMarker(marker, expected) {
  assertExactKeys(marker, [
    'schemaVersion', 'groupId', 'libraryId', 'businessKey', 'baselineApprovedVersion',
    'contentHash', 'deviceId', 'submissionId', 'idempotencyKey', 'receivedAt',
    'authenticatedTokenVersion',
  ], 'INVALID_CONFIRMATION_MARKER', '设备确认标记结构无效');
  if (marker.schemaVersion !== ORDINARY_PUBLIC_ENGINE_VERSION
      || marker.groupId !== expected.groupId || marker.libraryId !== expected.libraryId
      || marker.businessKey !== expected.businessKey || marker.baselineApprovedVersion !== expected.baselineApprovedVersion
      || marker.contentHash !== expected.contentHash || marker.deviceId !== expected.deviceId
      || !SUBMISSION_ID_PATTERN.test(String(marker.submissionId || ''))
      || !IDEMPOTENCY_KEY_PATTERN.test(String(marker.idempotencyKey || ''))
      || !Number.isSafeInteger(marker.receivedAt) || marker.receivedAt <= 0
      || !Number.isSafeInteger(marker.authenticatedTokenVersion) || marker.authenticatedTokenVersion < 1) {
    throw new OrdinaryPublicEngineError('INVALID_CONFIRMATION_MARKER', '设备确认标记内容无效', 500, { key: expected.key });
  }
  return marker;
}

async function ensureConfirmationMarker(store, candidate, submission, baseline) {
  const key = markerKey(submission, baseline.approvedVersion);
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
    schemaVersion: ORDINARY_PUBLIC_ENGINE_VERSION,
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
  const keys = await listKeysStrong(store, prefix, MAX_ORDINARY_CONFIRMATION_MARKERS, 'CONFIRMATION_MARKER_LIMIT_EXCEEDED');
  const byContentHash = new Map();
  for (const key of keys) {
    const parsed = parseConfirmationKey(prefix, key);
    if (!parsed) throw new OrdinaryPublicEngineError('INVALID_CONFIRMATION_KEY', '候选确认目录包含不符合协议的Key', 500, { key });
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
  if (record.schemaVersion !== 1 || record.deviceId !== deviceId || record.trusted !== true || record.revokedAt !== null) return false;
  return true;
}

function existingSummary(record, submission) {
  if (!record) return null;
  if (submission.dataType === 'exact_price') {
    return { businessKey: record.businessKey, contentHash: record.contentHash };
  }
  return {
    businessKey: record.businessKey,
    contentHash: record.contentHash,
    dataType: record.dataType,
    bossId: record.dataType === 'boss_profile'
      ? (record.bossId || deriveBossId(submission.groupId, record.payload.bossName))
      : null,
    payload: record.payload,
  };
}

function decideExactPrice(submission, baseline, matchingCount, trustedDevice, conflictingCount) {
  if (conflictingCount > 0) return { decision: 'pending_review', reason: 'candidate_conflict', approvalMode: null, changeRatio: null };
  if (baseline.approvedVersion === 0) {
    if (trustedDevice) return { decision: 'eligible_auto_approval', reason: 'trusted_device', approvalMode: 'trusted_device', changeRatio: null };
    if (matchingCount >= 2) return { decision: 'eligible_auto_approval', reason: 'two_devices_match', approvalMode: 'two_devices_match', changeRatio: null };
    return { decision: 'waiting_confirmation', reason: 'second_device_required', approvalMode: null, changeRatio: null };
  }
  const changeRatio = Math.abs(submission.payload.unitPrice - baseline.unitPrice) / baseline.unitPrice;
  if (changeRatio > MAX_SAFE_EXACT_PRICE_CHANGE_RATIO + PRICE_EPSILON) {
    return { decision: 'pending_review', reason: 'price_change_exceeds_limit', approvalMode: null, changeRatio };
  }
  if (matchingCount >= 2) {
    return { decision: 'eligible_auto_approval', reason: 'two_devices_safe_price_update', approvalMode: 'two_devices_safe_price_update', changeRatio };
  }
  return { decision: 'waiting_confirmation', reason: 'second_device_required_for_update', approvalMode: null, changeRatio };
}

function decideOrdinary(submission, existingRecord, matchingCount, trustedDevice, conflictingCount) {
  const evaluated = evaluateOrdinaryCandidate({
    submission,
    existingRecord: existingSummary(existingRecord, submission),
    matchingDistinctDeviceCount: matchingCount,
    trustedDevice,
    conflictingCandidateCount: conflictingCount,
  });
  let approvalMode = null;
  if (evaluated.decision === 'eligible_auto_approval') {
    if (evaluated.reason === 'trusted_device') approvalMode = 'trusted_device';
    else if (existingRecord && submission.dataType === 'boss_profile') approvalMode = 'two_devices_ordinary_update';
    else approvalMode = 'two_devices_match';
  }
  return { ...evaluated, approvalMode, changeRatio: null };
}

async function ensureReviewMarkers({ store, submission, baseline, confirmations, reason, now }) {
  const hashes = new Set([...confirmations.keys(), submission.contentHash]);
  for (const contentHash of [...hashes].sort()) {
    const markers = confirmations.get(contentHash) || new Map();
    const key = reviewMarkerKey(submission.libraryId, submission.businessKey, baseline.approvedVersion, contentHash);
    const marker = Object.freeze({
      schemaVersion: ORDINARY_PUBLIC_ENGINE_VERSION,
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
      if (!existing || existing.schemaVersion !== ORDINARY_PUBLIC_ENGINE_VERSION
          || existing.status !== 'pending_review' || existing.groupId !== submission.groupId
          || existing.libraryId !== submission.libraryId || existing.businessKey !== submission.businessKey
          || existing.baselineApprovedVersion !== baseline.approvedVersion
          || existing.publicContentHash !== baseline.contentHash || existing.contentHash !== contentHash) {
        throw new OrdinaryPublicEngineError('REVIEW_MARKER_CONFLICT', '待审核标记与当前候选不一致', 500, { key }, error);
      }
    }
  }
}

function approvalIdFor(submission, baseline) {
  return `ap_v1_${sha256Base64Url(canonicalize({
    schemaVersion: ORDINARY_PUBLIC_ENGINE_VERSION,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    businessKey: submission.businessKey,
    baselineApprovedVersion: baseline.approvedVersion,
    baselineContentHash: baseline.contentHash,
    targetContentHash: submission.contentHash,
  }))}`;
}

async function reserveEventSlot(store, submission, baseline, approvalId, approvalMode, markers, now) {
  const prefix = publicEventPrefix(submission.libraryId);
  for (let attempt = 0; attempt < MAX_ORDINARY_EVENT_RESERVATION_ATTEMPTS; attempt += 1) {
    const keys = await listKeysStrong(store, prefix, MAX_ORDINARY_PUBLIC_EVENTS, 'PUBLIC_EVENT_LIMIT_EXCEEDED');
    let maxVersion = 0;
    for (const key of keys) {
      const version = eventVersionFromKey(prefix, key);
      if (version === null) throw new OrdinaryPublicEngineError('INVALID_PUBLIC_EVENT_KEY', '公共事件目录包含不符合协议的Key', 500, { key });
      maxVersion = Math.max(maxVersion, version);
    }
    const version = maxVersion + 1;
    const eventKey = publicEventKey(submission.libraryId, version);
    const deviceIds = [...markers.keys()].sort();
    const submissionIds = deviceIds.map(id => String(markers.get(id)?.submissionId || '')).filter(Boolean);
    const event = Object.freeze({
      schemaVersion: ORDINARY_PUBLIC_EVENT_SCHEMA_VERSION,
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
        unitPrice: submission.dataType === 'exact_price' ? baseline.unitPrice : null,
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
  throw new OrdinaryPublicEngineError('PUBLIC_EVENT_RESERVATION_EXHAUSTED', '公共事件版本预留重试次数已耗尽', 503);
}

async function ensureTransitionClaim({ store, submission, baseline, approvalId, reservedEvent, now }) {
  const key = transitionIndexKey(submission.libraryId, submission.businessKey, baseline.approvedVersion);
  const proposed = Object.freeze({
    schemaVersion: ORDINARY_PUBLIC_ENGINE_VERSION,
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
      throw new OrdinaryPublicEngineError('BASELINE_TRANSITION_CONFLICT', '同一公共基线已被另一个候选值占用', 409, {
        businessKey: submission.businessKey,
        baselineApprovedVersion: baseline.approvedVersion,
      }, error);
    }
    return Object.freeze({ transition: existing, created: false });
  }
}

async function readEventByIndex(store, index) {
  const event = assertPublicEvent(await getJSONStrong(store, index.eventKey), index.eventKey, index.version);
  assertIndexEventLink(index, event);
  return event;
}

async function publishApproval({ store, submission, baseline, approvalMode, markers, now }) {
  const approvalId = approvalIdFor(submission, baseline);
  const indexKey = approvalIndexKey(submission.libraryId, approvalId);
  const existingIndex = await getJSONStrong(store, indexKey);
  if (existingIndex) {
    const index = assertApprovalIndex(existingIndex, approvalId);
    const event = await readEventByIndex(store, index);
    const latest = await ensureLatestSnapshot(store, submission.groupId, submission.libraryId, now);
    return Object.freeze({ approvalId, index, event, ...latest, duplicateApproval: true, publicMutationApplied: false });
  }

  const currentSnapshot = await buildOrdinaryPublicSnapshot({ store, groupId: submission.groupId, libraryId: submission.libraryId, now });
  const currentRecord = findSnapshotRecord(currentSnapshot, submission.businessKey);
  if (!sameBaseline(currentRecord, baseline, submission.dataType)) {
    throw new OrdinaryPublicEngineError('STALE_PUBLIC_BASELINE', '公共数据已变化，当前候选必须重新审核', 409, {
      businessKey: submission.businessKey,
      baselineApprovedVersion: baseline.approvedVersion,
    });
  }

  const key = transitionIndexKey(submission.libraryId, submission.businessKey, baseline.approvedVersion);
  let transition = await getJSONStrong(store, key);
  let reservedEvent = null;
  let transitionCreated = false;
  if (transition) {
    transition = assertTransitionIndex(transition, key);
    if (transition.approvalId !== approvalId || transition.baselineContentHash !== baseline.contentHash
        || transition.targetContentHash !== submission.contentHash) {
      throw new OrdinaryPublicEngineError('BASELINE_TRANSITION_CONFLICT', '同一公共基线已批准其他候选值', 409);
    }
  } else {
    reservedEvent = await reserveEventSlot(store, submission, baseline, approvalId, approvalMode, markers, now);
    const claimed = await ensureTransitionClaim({ store, submission, baseline, approvalId, reservedEvent, now });
    transition = claimed.transition;
    transitionCreated = claimed.created;
  }

  const canonicalEvent = assertPublicEvent(await getJSONStrong(store, transition.eventKey), transition.eventKey, transition.version);
  if (canonicalEvent.approvalId !== approvalId) {
    throw new OrdinaryPublicEngineError('TRANSITION_EVENT_MISMATCH', '基线迁移索引与批准事件不一致', 500);
  }
  const proposedIndex = Object.freeze({
    schemaVersion: ORDINARY_PUBLIC_ENGINE_VERSION,
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

function pendingResult({ status, decision, reason, matchingCount, conflictingCount, snapshot, baseline, changeRatio = null }) {
  return Object.freeze({
    schemaVersion: ORDINARY_PUBLIC_ENGINE_VERSION,
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

function noopResult({ latest, record, baseline }) {
  return Object.freeze({
    schemaVersion: ORDINARY_PUBLIC_ENGINE_VERSION,
    status: 'auto_approved',
    decision: 'duplicate_noop',
    reason: 'same_as_public',
    approvalMode: 'public_duplicate',
    approvalId: null,
    baselineApprovedVersion: baseline.approvedVersion,
    matchingDistinctDeviceCount: 0,
    conflictingCandidateCount: 0,
    changeRatio: null,
    publicVersion: latest.snapshot.publicVersion,
    eventVersion: record.approvedVersion,
    snapshotKey: latest.snapshotKey,
    publicMutationApplied: false,
    duplicateApproval: true,
    autoApprovalEnabled: true,
  });
}

export async function reviewOrdinaryCandidate({
  store,
  candidate,
  now = Date.now(),
  trustedDeviceResolver = readTrustedDevice,
} = {}) {
  assertSafeTime(now);
  const submission = assertStoredCandidate(candidate);
  const snapshot = await buildOrdinaryPublicSnapshot({ store, groupId: submission.groupId, libraryId: submission.libraryId, now });
  const existingRecord = findSnapshotRecord(snapshot, submission.businessKey);
  const baseline = baselineFromSnapshotRecord(existingRecord, submission.dataType);
  if (existingRecord?.contentHash === submission.contentHash) {
    const latest = await ensureLatestSnapshot(store, submission.groupId, submission.libraryId, now);
    return noopResult({ latest, record: existingRecord, baseline });
  }

  await ensureConfirmationMarker(store, candidate, submission, baseline);
  const confirmations = await collectBusinessConfirmations(store, submission, baseline);
  const matchingMarkers = confirmations.get(submission.contentHash) || new Map();
  const conflictingCount = [...confirmations.keys()].filter(hash => hash !== submission.contentHash).length;
  const trustedDevice = Boolean(await trustedDeviceResolver(store, submission.deviceId));
  const decision = submission.dataType === 'exact_price'
    ? decideExactPrice(submission, baseline, matchingMarkers.size, trustedDevice, conflictingCount)
    : decideOrdinary(submission, existingRecord, matchingMarkers.size, trustedDevice, conflictingCount);

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
    const published = await publishApproval({
      store,
      submission,
      baseline,
      approvalMode: decision.approvalMode,
      markers: matchingMarkers,
      now,
    });
    return Object.freeze({
      schemaVersion: ORDINARY_PUBLIC_ENGINE_VERSION,
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
    if (!(error instanceof OrdinaryPublicEngineError)
        || !['BASELINE_TRANSITION_CONFLICT', 'STALE_PUBLIC_BASELINE'].includes(error.code)) {
      throw error;
    }
    const refreshed = await buildOrdinaryPublicSnapshot({ store, groupId: submission.groupId, libraryId: submission.libraryId, now });
    const refreshedRecord = findSnapshotRecord(refreshed, submission.businessKey);
    if (refreshedRecord?.contentHash === submission.contentHash) {
      const latest = await ensureLatestSnapshot(store, submission.groupId, submission.libraryId, now);
      return noopResult({ latest, record: refreshedRecord, baseline: baselineFromSnapshotRecord(refreshedRecord, submission.dataType) });
    }
    const reason = error.code === 'BASELINE_TRANSITION_CONFLICT' ? 'baseline_transition_conflict' : 'stale_public_baseline';
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

export async function publishAdminOrdinaryApproval({
  store,
  submission,
  baseline,
  approvalMode,
  evidence,
  now = Date.now(),
} = {}) {
  assertSafeTime(now);
  const normalizedSubmission = normalizeOrdinarySubmission(submission);
  const normalizedBaseline = normalizeBaseline(baseline, normalizedSubmission.dataType);
  if (!['admin_approved', 'admin_edit_and_approved'].includes(approvalMode)) {
    throw new OrdinaryPublicEngineError('INVALID_ADMIN_APPROVAL_MODE', '管理员批准模式无效', 400);
  }
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > MAX_ORDINARY_CONFIRMATION_MARKERS) {
    throw new OrdinaryPublicEngineError('INVALID_ADMIN_APPROVAL_EVIDENCE', '管理员批准证据数量无效', 400);
  }
  const markers = new Map();
  for (const item of evidence) {
    const deviceId = assertPattern(item?.deviceId, DEVICE_ID_PATTERN, 'INVALID_DEVICE_ID', 'deviceId', 400);
    const submissionId = assertPattern(item?.submissionId, SUBMISSION_ID_PATTERN, 'INVALID_SUBMISSION_ID', 'submissionId', 400);
    if (markers.has(deviceId)) throw new OrdinaryPublicEngineError('INVALID_ADMIN_APPROVAL_EVIDENCE', '管理员批准证据包含重复设备', 400);
    markers.set(deviceId, Object.freeze({ submissionId }));
  }
  return publishApproval({
    store,
    submission: normalizedSubmission,
    baseline: normalizedBaseline,
    approvalMode,
    markers,
    now,
  });
}

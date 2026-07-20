import { createHash } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { canonicalize } from './submission_policy_v1.js';
import {
  computeSensitiveSubmissionHashes,
  normalizeSensitiveSubmission,
} from './sensitive_rules_policy_v1.js';
import {
  buildOrdinaryPublicSnapshot,
  listValidOrdinaryPublicEvents,
} from './ordinary_public_engine_v1.js';

export const SENSITIVE_PUBLIC_ENGINE_VERSION = 1;
export const SENSITIVE_PUBLIC_EVENT_SCHEMA_VERSION = 1;
export const SENSITIVE_PUBLIC_SNAPSHOT_SCHEMA_VERSION = 2;
export const MAX_SENSITIVE_PUBLIC_EVENTS = 10_000;
export const MAX_SENSITIVE_EVENT_RESERVATION_ATTEMPTS = 64;

const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const BOSS_ID_PATTERN = /^boss_v1_[A-Za-z0-9_-]{43}$/;
const APPROVAL_ID_PATTERN = /^sap_v1_[A-Za-z0-9_-]{43}$/;
const DECISION_ID_PATTERN = /^srd_v1_[A-Za-z0-9_-]{43}$/;
const REVIEW_ID_PATTERN = /^srv_v1_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;
const EVENT_FILE_PATTERN = /^([0-9]{12})\.json$/;
const SUPPORTED_DATA_TYPES = new Set([
  'exact_price', 'playable_name', 'boss_profile',
  'rank_range_rule', 'surcharge_rule', 'gift_rule',
]);
const APPROVAL_MODES = new Set(['admin_sensitive_approved', 'admin_sensitive_edit_and_approved']);
const MAX_PUBLIC_VERSION = 999_999_999_999;

export class SensitivePublicEngineError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '敏感公共事件处理失败');
    this.name = 'SensitivePublicEngineError';
    this.code = code || 'SENSITIVE_PUBLIC_ENGINE_ERROR';
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
  if (!isPlainObject(value)) throw new SensitivePublicEngineError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new SensitivePublicEngineError(code, message, status, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function normalizeId(value, pattern, code, label, status = 500) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) throw new SensitivePublicEngineError(code, `${label}格式无效`, status);
  return text;
}

function normalizeGroupId(value) {
  return normalizeId(String(value || '').trim().toLowerCase(), GROUP_ID_PATTERN, 'INVALID_GROUP_ID', 'groupId');
}

function normalizeLibraryId(value) {
  return normalizeId(String(value || '').trim().toLowerCase(), LIBRARY_ID_PATTERN, 'INVALID_LIBRARY_ID', 'libraryId');
}

function normalizeVersion(value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_PUBLIC_VERSION) {
    throw new SensitivePublicEngineError('INVALID_PUBLIC_VERSION', '公共版本超出协议范围', 500, { value });
  }
  return value;
}

function assertSafeTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new SensitivePublicEngineError('INVALID_SERVER_TIME', '服务器时间无效', 500);
  }
  return value;
}

function alreadyExists(error) {
  return error instanceof BlobRepositoryError && error.code === 'BLOB_ALREADY_EXISTS';
}

function padVersion(value) {
  return String(normalizeVersion(value)).padStart(12, '0');
}

export function sensitivePublicEventPrefix(libraryId) {
  return `${normalizeBlobKey(`public/${normalizeLibraryId(libraryId)}/sensitive-events`)}/`;
}

export function sensitivePublicEventKey(libraryId, version) {
  return `${sensitivePublicEventPrefix(libraryId)}${padVersion(version)}.json`;
}

export function sensitiveApprovalIndexKey(libraryId, approvalId) {
  return normalizeBlobKey(`public/${normalizeLibraryId(libraryId)}/sensitive-approvals/${normalizeId(approvalId, APPROVAL_ID_PATTERN, 'INVALID_APPROVAL_ID', 'approvalId')}.json`);
}

export function sensitiveSnapshotKey(libraryId, version) {
  return normalizeBlobKey(`public/${normalizeLibraryId(libraryId)}/sensitive-snapshots/${padVersion(version)}.json`);
}

async function listKeysStrong(store, prefix) {
  if (!store || typeof store.list !== 'function') {
    throw new SensitivePublicEngineError('BLOB_LIST_UNAVAILABLE', '敏感公共事件需要Blob list能力', 500);
  }
  let result;
  try {
    result = await store.list({ prefix, consistency: 'strong' });
  } catch (error) {
    throw new SensitivePublicEngineError('BLOB_LIST_FAILED', '强一致列举敏感公共事件失败', 503, { prefix }, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > MAX_SENSITIVE_PUBLIC_EVENTS) {
    throw new SensitivePublicEngineError('SENSITIVE_PUBLIC_EVENT_LIMIT_EXCEEDED', '敏感公共事件超过安全上限', 409);
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new SensitivePublicEngineError('INVALID_BLOB_LIST', '敏感公共事件列举包含空Key或重复Key', 503);
  }
  return keys.sort();
}

function versionFromKey(prefix, key) {
  if (!String(key).startsWith(prefix)) return null;
  const match = EVENT_FILE_PATTERN.exec(String(key).slice(prefix.length));
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

function syntheticSubmission(event) {
  return {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: 'sub_01JABCDEF0123456789XYZABCD',
    deviceId: 'dev_01JABCDEF0123456789XYZABCD',
    groupId: event.groupId,
    libraryId: event.libraryId,
    bossId: event.bossId,
    dataType: event.dataType,
    operation: event.operation,
    origin: 'user',
    clientCreatedAt: 0,
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    idempotencyKey: `ik_v1_${'A'.repeat(43)}`,
    payload: event.payload,
    clientContext: { appVersion: '8.2.31-stage6b', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
}

function assertBaseline(value) {
  assertExactKeys(value, ['approvedVersion', 'contentHash'], 'INVALID_SENSITIVE_EVENT_BASELINE', '敏感事件基线结构无效');
  const approvedVersion = normalizeVersion(value.approvedVersion, { allowZero: true });
  const contentHash = approvedVersion === 0
    ? (() => {
        if (value.contentHash !== null) throw new SensitivePublicEngineError('INVALID_SENSITIVE_EVENT_BASELINE', '空基线contentHash必须为null', 500);
        return null;
      })()
    : normalizeId(value.contentHash, CONTENT_HASH_PATTERN, 'INVALID_SENSITIVE_EVENT_BASELINE', 'contentHash');
  return Object.freeze({ approvedVersion, contentHash });
}

function assertSensitiveEvent(value, key, version) {
  assertExactKeys(value, [
    'schemaVersion', 'version', 'eventKey', 'approvalId', 'decisionId', 'reviewId',
    'groupId', 'libraryId', 'baseOrdinaryVersion', 'approvedAt', 'businessKey',
    'contentHash', 'dataType', 'operation', 'payload', 'bossId', 'baseline', 'approval',
  ], 'INVALID_SENSITIVE_PUBLIC_EVENT', '敏感公共事件结构无效');
  const groupId = normalizeGroupId(value.groupId);
  const libraryId = normalizeLibraryId(value.libraryId);
  const dataType = String(value.dataType || '').trim().toLowerCase();
  const operation = String(value.operation || '').trim().toLowerCase();
  if (!SUPPORTED_DATA_TYPES.has(dataType) || !['upsert', 'delete'].includes(operation)) {
    throw new SensitivePublicEngineError('INVALID_SENSITIVE_PUBLIC_EVENT', '敏感公共事件类型或操作无效', 500);
  }
  if ((operation === 'delete') !== (value.payload === null)) {
    throw new SensitivePublicEngineError('INVALID_SENSITIVE_PUBLIC_EVENT', '敏感删除事件必须使用null payload', 500);
  }
  const bossId = dataType === 'boss_profile'
    ? normalizeId(value.bossId, BOSS_ID_PATTERN, 'INVALID_SENSITIVE_PUBLIC_EVENT', 'bossId')
    : (() => {
        if (value.bossId !== null) throw new SensitivePublicEngineError('INVALID_SENSITIVE_PUBLIC_EVENT', '非老板事件bossId必须为null', 500);
        return null;
      })();
  const baseline = assertBaseline(value.baseline);
  assertExactKeys(value.approval, ['mode', 'actorTag'], 'INVALID_SENSITIVE_EVENT_APPROVAL', '敏感事件批准证据结构无效');
  if (value.schemaVersion !== SENSITIVE_PUBLIC_EVENT_SCHEMA_VERSION
      || value.version !== version || value.eventKey !== key
      || !APPROVAL_ID_PATTERN.test(String(value.approvalId || ''))
      || !DECISION_ID_PATTERN.test(String(value.decisionId || ''))
      || !REVIEW_ID_PATTERN.test(String(value.reviewId || ''))
      || !Number.isSafeInteger(value.baseOrdinaryVersion) || value.baseOrdinaryVersion < 0
      || !Number.isFinite(Date.parse(value.approvedAt))
      || !BUSINESS_KEY_PATTERN.test(String(value.businessKey || ''))
      || !CONTENT_HASH_PATTERN.test(String(value.contentHash || ''))
      || !APPROVAL_MODES.has(value.approval.mode)
      || !ACTOR_TAG_PATTERN.test(String(value.approval.actorTag || ''))) {
    throw new SensitivePublicEngineError('INVALID_SENSITIVE_PUBLIC_EVENT', '敏感公共事件内容无效', 500, { key, version });
  }
  let computed;
  try {
    computed = computeSensitiveSubmissionHashes(syntheticSubmission({ ...value, groupId, libraryId, dataType, operation, bossId }));
  } catch (error) {
    throw new SensitivePublicEngineError(error?.code || 'INVALID_SENSITIVE_PUBLIC_EVENT', '敏感公共事件Hash重算失败', 500, error?.details || null, error);
  }
  if (computed.businessKey !== value.businessKey || computed.contentHash !== value.contentHash) {
    throw new SensitivePublicEngineError('INVALID_SENSITIVE_PUBLIC_EVENT_HASH', '敏感公共事件业务键或内容Hash无效', 500, { key, version });
  }
  return Object.freeze({ ...value, groupId, libraryId, dataType, operation, bossId, baseline });
}

function assertApprovalIndex(value, approvalId) {
  assertExactKeys(value, [
    'schemaVersion', 'approvalId', 'decisionId', 'reviewId', 'groupId', 'libraryId',
    'businessKey', 'contentHash', 'version', 'eventKey', 'createdAt',
  ], 'INVALID_SENSITIVE_APPROVAL_INDEX', '敏感批准索引结构无效');
  if (value.schemaVersion !== SENSITIVE_PUBLIC_ENGINE_VERSION
      || value.approvalId !== approvalId
      || !DECISION_ID_PATTERN.test(String(value.decisionId || ''))
      || !REVIEW_ID_PATTERN.test(String(value.reviewId || ''))
      || !GROUP_ID_PATTERN.test(String(value.groupId || ''))
      || !LIBRARY_ID_PATTERN.test(String(value.libraryId || ''))
      || !BUSINESS_KEY_PATTERN.test(String(value.businessKey || ''))
      || !CONTENT_HASH_PATTERN.test(String(value.contentHash || ''))
      || !Number.isSafeInteger(value.version) || value.version < 1
      || typeof value.eventKey !== 'string'
      || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    throw new SensitivePublicEngineError('INVALID_SENSITIVE_APPROVAL_INDEX', '敏感批准索引内容无效', 500);
  }
  return value;
}

export async function listValidSensitivePublicEvents({ store, libraryId, ordinaryVersion = null } = {}) {
  const normalizedLibraryId = normalizeLibraryId(libraryId);
  const prefix = sensitivePublicEventPrefix(normalizedLibraryId);
  const keys = await listKeysStrong(store, prefix);
  const events = [];
  for (const key of keys) {
    const version = versionFromKey(prefix, key);
    if (version === null) throw new SensitivePublicEngineError('INVALID_SENSITIVE_PUBLIC_EVENT_KEY', '敏感公共事件目录包含无效Key', 500, { key });
    const event = assertSensitiveEvent(await getJSONStrong(store, key), key, version);
    const index = await getJSONStrong(store, sensitiveApprovalIndexKey(normalizedLibraryId, event.approvalId));
    if (!index) continue;
    const validIndex = assertApprovalIndex(index, event.approvalId);
    if (validIndex.version !== event.version || validIndex.eventKey !== event.eventKey
        || validIndex.decisionId !== event.decisionId || validIndex.reviewId !== event.reviewId
        || validIndex.businessKey !== event.businessKey || validIndex.contentHash !== event.contentHash) {
      throw new SensitivePublicEngineError('SENSITIVE_APPROVAL_EVENT_MISMATCH', '敏感批准索引与公共事件不一致', 500);
    }
    events.push(event);
  }
  events.sort((left, right) => left.version - right.version);
  if (events.length) {
    const base = events[0].baseOrdinaryVersion;
    if (events.some(event => event.baseOrdinaryVersion !== base || event.version <= base)) {
      throw new SensitivePublicEngineError('SENSITIVE_PUBLIC_CHAIN_INVALID', '敏感公共事件链基线或版本无效', 500);
    }
    if (ordinaryVersion !== null && ordinaryVersion !== base) {
      throw new SensitivePublicEngineError('SENSITIVE_PUBLIC_BASE_MOVED', '敏感事件发布后普通公共基线发生变化，必须重新生成联合快照', 409, { expected: base, actual: ordinaryVersion });
    }
  }
  return events;
}

function recordFromEvent(event) {
  const record = {
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    dataType: event.dataType,
    operation: 'upsert',
    approvedVersion: event.version,
    payload: event.payload,
  };
  if (event.dataType === 'boss_profile') record.bossId = event.bossId;
  return Object.freeze(record);
}

function tombstoneFromEvent(event) {
  const tombstone = {
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    dataType: event.dataType,
    operation: 'delete',
    approvedVersion: event.version,
    deletedAt: event.approvedAt,
  };
  if (event.dataType === 'boss_profile') tombstone.bossId = event.bossId;
  return Object.freeze(tombstone);
}

export async function buildUnifiedSensitivePublicSnapshot({ store, groupId, libraryId, now = Date.now() } = {}) {
  assertSafeTime(now);
  const normalizedGroupId = normalizeGroupId(groupId);
  const normalizedLibraryId = normalizeLibraryId(libraryId);
  const ordinary = await buildOrdinaryPublicSnapshot({ store, groupId: normalizedGroupId, libraryId: normalizedLibraryId, now });
  const events = await listValidSensitivePublicEvents({ store, libraryId: normalizedLibraryId, ordinaryVersion: ordinary.publicVersion });
  const records = new Map(ordinary.records.map(record => [record.businessKey, record]));
  const tombstones = new Map(ordinary.tombstones.map(item => [item.businessKey, item]));
  for (const event of events) {
    if (event.groupId !== normalizedGroupId || event.libraryId !== normalizedLibraryId) {
      throw new SensitivePublicEngineError('SENSITIVE_PUBLIC_EVENT_SCOPE_MISMATCH', '敏感公共事件作用域与目标价格库不一致', 500);
    }
    if (event.operation === 'delete') {
      records.delete(event.businessKey);
      tombstones.set(event.businessKey, tombstoneFromEvent(event));
    } else {
      tombstones.delete(event.businessKey);
      records.set(event.businessKey, recordFromEvent(event));
    }
  }
  const publicVersion = events.length ? events[events.length - 1].version : ordinary.publicVersion;
  const lastApprovedAt = events.length ? events[events.length - 1].approvedAt : ordinary.generatedAt;
  return Object.freeze({
    schemaVersion: SENSITIVE_PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    payloadSchemaVersion: 1,
    groupId: normalizedGroupId,
    libraryId: normalizedLibraryId,
    baseOrdinaryVersion: ordinary.publicVersion,
    publicVersion,
    snapshotVersion: publicVersion,
    cursor: `pv_${publicVersion}`,
    generatedAt: lastApprovedAt,
    records: Object.freeze([...records.values()].sort((a, b) => a.businessKey.localeCompare(b.businessKey))),
    tombstones: Object.freeze([...tombstones.values()].sort((a, b) => a.businessKey.localeCompare(b.businessKey))),
  });
}

function findRecord(snapshot, businessKey) {
  return snapshot.records.find(item => item.businessKey === businessKey) || null;
}

function baselineFor(record) {
  return Object.freeze({
    approvedVersion: record?.approvedVersion || 0,
    contentHash: record?.contentHash || null,
  });
}

function assertBaselineCurrent(expected, current) {
  const wanted = assertBaseline(expected);
  const actual = baselineFor(current);
  if (wanted.approvedVersion !== actual.approvedVersion || wanted.contentHash !== actual.contentHash) {
    throw new SensitivePublicEngineError('SENSITIVE_REVIEW_STALE_BASELINE', '公共基线已变化，敏感审核必须重新生成', 409, { expected: wanted, actual });
  }
  return wanted;
}

function approvalIdFor(decisionId) {
  return `sap_v1_${sha256Base64Url(canonicalize({ schemaVersion: 1, decisionId }))}`;
}

async function resolveExistingApproval(store, libraryId, approvalId) {
  const index = await getJSONStrong(store, sensitiveApprovalIndexKey(libraryId, approvalId));
  if (!index) return null;
  const validIndex = assertApprovalIndex(index, approvalId);
  const event = await getJSONStrong(store, validIndex.eventKey);
  if (!event) throw new SensitivePublicEngineError('SENSITIVE_APPROVAL_EVENT_MISSING', '敏感批准索引对应事件不存在', 500);
  return Object.freeze({ index: validIndex, event: assertSensitiveEvent(event, validIndex.eventKey, validIndex.version) });
}

export async function publishSensitiveAdminApproval({
  store,
  submission,
  baseline,
  reviewId,
  decisionId,
  actorTag,
  edited = false,
  now = Date.now(),
} = {}) {
  assertSafeTime(now);
  let normalized;
  try { normalized = normalizeSensitiveSubmission(submission); }
  catch (error) {
    throw new SensitivePublicEngineError(error?.code || 'INVALID_SENSITIVE_SUBMISSION', '待发布敏感提交无效', 400, error?.details || null, error);
  }
  const normalizedReviewId = normalizeId(reviewId, REVIEW_ID_PATTERN, 'INVALID_REVIEW_ID', 'reviewId', 400);
  const normalizedDecisionId = normalizeId(decisionId, DECISION_ID_PATTERN, 'INVALID_DECISION_ID', 'decisionId', 400);
  const normalizedActorTag = normalizeId(actorTag, ACTOR_TAG_PATTERN, 'INVALID_ACTOR_TAG', 'actorTag', 400);
  const approvalId = approvalIdFor(normalizedDecisionId);
  const replay = await resolveExistingApproval(store, normalized.libraryId, approvalId);
  if (replay) {
    if (replay.event.reviewId !== normalizedReviewId || replay.event.businessKey !== normalized.businessKey
        || replay.event.contentHash !== normalized.contentHash || replay.event.operation !== normalized.operation) {
      throw new SensitivePublicEngineError('SENSITIVE_APPROVAL_IDEMPOTENCY_CONFLICT', '同一敏感批准决定对应不同发布内容', 409);
    }
    return Object.freeze({ ...replay, duplicate: true, snapshot: await buildUnifiedSensitivePublicSnapshot({ store, groupId: normalized.groupId, libraryId: normalized.libraryId, now }) });
  }

  const snapshot = await buildUnifiedSensitivePublicSnapshot({ store, groupId: normalized.groupId, libraryId: normalized.libraryId, now });
  const current = findRecord(snapshot, normalized.businessKey);
  const checkedBaseline = assertBaselineCurrent(baseline, current);
  if (normalized.operation === 'delete' && !current) {
    throw new SensitivePublicEngineError('DELETE_TARGET_NOT_FOUND', '敏感删除目标不存在', 409);
  }
  if (normalized.operation === 'upsert' && current?.contentHash === normalized.contentHash) {
    throw new SensitivePublicEngineError('SENSITIVE_APPROVAL_NO_CHANGE', '敏感批准内容与公共基线相同', 409);
  }

  const existingEvents = await listKeysStrong(store, sensitivePublicEventPrefix(normalized.libraryId));
  let highestOccupied = snapshot.publicVersion;
  for (const key of existingEvents) {
    const version = versionFromKey(sensitivePublicEventPrefix(normalized.libraryId), key);
    if (version !== null) highestOccupied = Math.max(highestOccupied, version);
  }

  const eventBase = {
    schemaVersion: SENSITIVE_PUBLIC_EVENT_SCHEMA_VERSION,
    approvalId,
    decisionId: normalizedDecisionId,
    reviewId: normalizedReviewId,
    groupId: normalized.groupId,
    libraryId: normalized.libraryId,
    baseOrdinaryVersion: snapshot.baseOrdinaryVersion,
    approvedAt: new Date(now).toISOString(),
    businessKey: normalized.businessKey,
    contentHash: normalized.contentHash,
    dataType: normalized.dataType,
    operation: normalized.operation,
    payload: normalized.payload,
    bossId: normalized.bossId,
    baseline: checkedBaseline,
    approval: Object.freeze({
      mode: edited ? 'admin_sensitive_edit_and_approved' : 'admin_sensitive_approved',
      actorTag: normalizedActorTag,
    }),
  };

  let event = null;
  let eventKey = null;
  for (let attempt = 1; attempt <= MAX_SENSITIVE_EVENT_RESERVATION_ATTEMPTS; attempt += 1) {
    const version = highestOccupied + attempt;
    const key = sensitivePublicEventKey(normalized.libraryId, version);
    const candidate = Object.freeze({ ...eventBase, version, eventKey: key });
    try {
      await putJSONOnlyIfNew(store, key, candidate);
      event = candidate;
      eventKey = key;
      break;
    } catch (error) {
      if (!alreadyExists(error)) throw error;
    }
  }
  if (!event) throw new SensitivePublicEngineError('SENSITIVE_EVENT_RESERVATION_EXHAUSTED', '无法保留敏感公共事件版本', 409);

  const index = Object.freeze({
    schemaVersion: SENSITIVE_PUBLIC_ENGINE_VERSION,
    approvalId,
    decisionId: normalizedDecisionId,
    reviewId: normalizedReviewId,
    groupId: normalized.groupId,
    libraryId: normalized.libraryId,
    businessKey: normalized.businessKey,
    contentHash: normalized.contentHash,
    version: event.version,
    eventKey,
    createdAt: now,
  });
  try {
    await putJSONOnlyIfNew(store, sensitiveApprovalIndexKey(normalized.libraryId, approvalId), index);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const existing = await resolveExistingApproval(store, normalized.libraryId, approvalId);
    if (!existing || canonicalize(existing.event) !== canonicalize(event)) {
      throw new SensitivePublicEngineError('SENSITIVE_APPROVAL_INDEX_CONFLICT', '敏感批准索引发生冲突', 409, null, error);
    }
  }

  const nextSnapshot = await buildUnifiedSensitivePublicSnapshot({ store, groupId: normalized.groupId, libraryId: normalized.libraryId, now });
  const key = sensitiveSnapshotKey(normalized.libraryId, nextSnapshot.publicVersion);
  try {
    await putJSONOnlyIfNew(store, key, nextSnapshot);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || canonicalize(existing) !== canonicalize(nextSnapshot)) {
      throw new SensitivePublicEngineError('SENSITIVE_SNAPSHOT_VERSION_CONFLICT', '同一敏感公共版本对应不同快照', 500, { key }, error);
    }
  }
  return Object.freeze({ event, index, snapshot: nextSnapshot, snapshotKey: key, duplicate: false });
}

export async function listUnifiedPublicEvents({ store, groupId, libraryId } = {}) {
  const normalizedGroupId = normalizeGroupId(groupId);
  const normalizedLibraryId = normalizeLibraryId(libraryId);
  const ordinary = await listValidOrdinaryPublicEvents({ store, libraryId: normalizedLibraryId });
  for (const event of ordinary) {
    if (event.groupId !== normalizedGroupId) throw new SensitivePublicEngineError('PUBLIC_EVENT_SCOPE_MISMATCH', '普通公共事件作用域不一致', 500);
  }
  const ordinaryVersion = ordinary.length ? ordinary[ordinary.length - 1].version : 0;
  const sensitive = await listValidSensitivePublicEvents({ store, libraryId: normalizedLibraryId, ordinaryVersion });
  return Object.freeze([...ordinary, ...sensitive].sort((a, b) => a.version - b.version));
}

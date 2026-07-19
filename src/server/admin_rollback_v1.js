import { createHash, createHmac } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  approvalIndexKey,
  buildPublicSnapshot,
  listValidPublicEvents,
  publicEventKey,
  publicEventPrefix,
  publicSnapshotKey,
  transitionIndexKey,
} from './auto_approval_engine_v1.js';
import { canonicalize } from './submission_policy_v1.js';

export const ADMIN_ROLLBACK_SCHEMA_VERSION = 1;
export const ADMIN_ROLLBACK_MAX_BODY_BYTES = 768;
export const ADMIN_ROLLBACK_PREVIEW_STORE_NAME = 'cloud-collab-preview-v1';
export const ADMIN_ROLLBACK_ALLOWED_GROUP_ID = 'group_fixture';
export const ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID = 'lib_receive_fixture';
export const MAX_ADMIN_ROLLBACK_CANDIDATES = 500;
export const MAX_ADMIN_ROLLBACK_EVENT_OBJECTS = 10_000;
export const MAX_ADMIN_ROLLBACK_RESERVATION_ATTEMPTS = 64;

const ROLLBACK_REF_PATTERN = /^rbref_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_PATTERN = /^rbrq_v1_[A-Za-z0-9_-]{22,64}$/;
const REQUEST_HASH_PATTERN = /^rbrh_v1_[A-Za-z0-9_-]{43}$/;
const DECISION_ID_PATTERN = /^rbd_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^rbau_v1_[A-Za-z0-9_-]{43}$/;
const APPROVAL_ID_PATTERN = /^ap_v1_[A-Za-z0-9_-]{43}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;
const EVENT_FILE_PATTERN = /^([0-9]{12})\.json$/;
const REASON_CODES = new Set(['restore_previous_approved_value']);

export const ADMIN_ROLLBACK_CAPABILITIES = Object.freeze({
  rollbackListRead: true,
  rollbackExecute: true,
  deviceMutation: false,
  reviewMutation: false,
  export: false,
  publicMutationAllowed: true,
  syntheticFixtureOnly: true,
});

export class AdminRollbackError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员回滚失败');
    this.name = 'AdminRollbackError';
    this.code = code || 'ADMIN_ROLLBACK_ERROR';
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
  if (!isPlainObject(value)) throw new AdminRollbackError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AdminRollbackError(code, message, status, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function hmacBase64Url(value, secret) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(String(value), 'utf8').digest('base64url');
}

function assertSafeTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_TIME_INVALID', '管理员回滚时间无效', 500);
  }
  return value;
}

function assertSecret(value, code, label) {
  const text = String(value || '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 32 || bytes > 256) {
    throw new AdminRollbackError(code, `${label}必须为32至256字节`, 503);
  }
  return text;
}

function actorTagFor(identity) {
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!username) throw new AdminRollbackError('ADMIN_ROLLBACK_ACTOR_INVALID', '管理员身份无效', 401);
  return `admin_${sha256Base64Url(username).slice(0, 12)}`;
}

function normalizeRollbackRef(value) {
  const text = String(value || '').trim();
  if (!ROLLBACK_REF_PATTERN.test(text)) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_REF_INVALID', '回滚目标引用无效', 400);
  }
  return text;
}

function normalizeRequestId(value) {
  const text = String(value || '').trim();
  if (!REQUEST_ID_PATTERN.test(text)) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_REQUEST_ID_INVALID', '回滚请求ID无效', 400);
  }
  return text;
}

function normalizeReasonCode(value) {
  const text = String(value || '').trim();
  if (!REASON_CODES.has(text)) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_REASON_INVALID', '回滚原因无效', 400);
  }
  return text;
}

function normalizeCommand(command) {
  assertExactKeys(command, ['schemaVersion', 'rollbackRef', 'requestId', 'reasonCode'], 'ADMIN_ROLLBACK_INPUT_INVALID', '回滚请求字段无效');
  if (command.schemaVersion !== ADMIN_ROLLBACK_SCHEMA_VERSION) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_SCHEMA_UNSUPPORTED', '回滚协议版本不受支持', 400);
  }
  return Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    rollbackRef: normalizeRollbackRef(command.rollbackRef),
    requestId: normalizeRequestId(command.requestId),
    reasonCode: normalizeReasonCode(command.reasonCode),
  });
}

function normalizeInternalEvent(event) {
  if (!isPlainObject(event)
      || !Number.isSafeInteger(event.version) || event.version < 1
      || typeof event.eventKey !== 'string'
      || !APPROVAL_ID_PATTERN.test(String(event.approvalId || ''))
      || event.groupId !== ADMIN_ROLLBACK_ALLOWED_GROUP_ID
      || event.libraryId !== ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID
      || !BUSINESS_KEY_PATTERN.test(String(event.businessKey || ''))
      || !CONTENT_HASH_PATTERN.test(String(event.contentHash || ''))
      || event.dataType !== 'exact_price'
      || event.operation !== 'upsert'
      || !isPlainObject(event.payload)
      || !Number.isFinite(event.payload.unitPrice) || event.payload.unitPrice <= 0
      || !isPlainObject(event.approval)
      || !Array.isArray(event.approval.deviceIds) || event.approval.deviceIds.length < 1
      || !Array.isArray(event.approval.submissionIds)
      || event.approval.submissionIds.length !== event.approval.deviceIds.length) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_INVALID', '公共事件不满足回滚要求', 503);
  }
  return event;
}

export function readAdminRollbackConfig(env = {}) {
  if (String(env.CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new AdminRollbackError('ADMIN_ROLLBACK_PREVIEW_DISABLED', '管理员回滚预览未开启', 503);
  }
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '0').trim() === '1'
      || String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '0').trim() === '1'
      || String(env.CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED || '0').trim() === '1') {
    throw new AdminRollbackError(
      'ADMIN_ROLLBACK_REQUIRES_OTHER_MUTATIONS_CLOSED',
      '回滚预览要求公共写入、自动审核和审核写入全部关闭',
      503,
    );
  }
  const storeName = String(env.CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME || '').trim();
  const groupId = String(env.CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID || '').trim().toLowerCase();
  const libraryId = String(env.CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID || '').trim().toLowerCase();
  if (storeName !== ADMIN_ROLLBACK_PREVIEW_STORE_NAME
      || groupId !== ADMIN_ROLLBACK_ALLOWED_GROUP_ID
      || libraryId !== ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_SCOPE_INVALID', '回滚只允许合成预览价格库', 503);
  }
  const rollbackRefSalt = assertSecret(
    env.CLOUD_ADMIN_ROLLBACK_REF_SALT,
    'ADMIN_ROLLBACK_REF_SALT_INVALID',
    '回滚引用盐值',
  );
  const otherSecrets = [
    env.CLOUD_ADMIN_PASSWORD,
    env.CLOUD_ADMIN_SESSION_SECRET,
    env.CLOUD_ADMIN_RATE_LIMIT_SALT,
    env.CLOUD_ADMIN_DEVICE_REF_SALT,
    env.CLOUD_WRITE_PREVIEW_KEY,
    env.CLOUD_RATE_LIMIT_SALT,
  ].map(value => String(value || '')).filter(Boolean);
  if (otherSecrets.includes(rollbackRefSalt)) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_REF_SALT_REUSED', '回滚引用盐值不得复用其他凭据', 503);
  }
  return Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    storeName,
    groupId,
    libraryId,
    rollbackRefSalt,
  });
}

function rollbackRefForCandidate(candidate, salt) {
  return `rbref_v1_${hmacBase64Url(canonicalize({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    groupId: candidate.current.groupId,
    libraryId: candidate.current.libraryId,
    businessKey: candidate.current.businessKey,
    currentVersion: candidate.current.version,
    currentContentHash: candidate.current.contentHash,
    previousVersion: candidate.previous.version,
    previousContentHash: candidate.previous.contentHash,
  }), salt)}`;
}

function projectCandidate(candidate, config) {
  return Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    rollbackRef: rollbackRefForCandidate(candidate, config.rollbackRefSalt),
    serviceName: candidate.current.payload.serviceName,
    settleType: candidate.current.payload.settleType,
    currentUnitPrice: candidate.current.payload.unitPrice,
    previousUnitPrice: candidate.previous.payload.unitPrice,
    currentVersion: candidate.current.version,
    previousVersion: candidate.previous.version,
    currentApprovedAt: candidate.current.approvedAt,
    previousApprovedAt: candidate.previous.approvedAt,
  });
}

async function collectCandidates({ store, config } = {}) {
  const events = await listValidPublicEvents({ store, libraryId: config.libraryId });
  const histories = new Map();
  for (const rawEvent of events) {
    const event = normalizeInternalEvent(rawEvent);
    if (!histories.has(event.businessKey)) histories.set(event.businessKey, []);
    histories.get(event.businessKey).push(event);
  }
  const candidates = [];
  for (const history of histories.values()) {
    history.sort((left, right) => left.version - right.version);
    if (history.length < 2) continue;
    const current = history[history.length - 1];
    const previous = history[history.length - 2];
    if (current.contentHash === previous.contentHash) continue;
    candidates.push(Object.freeze({ current, previous }));
  }
  if (candidates.length > MAX_ADMIN_ROLLBACK_CANDIDATES) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_CANDIDATE_LIMIT_EXCEEDED', '回滚候选数量超过安全上限', 409);
  }
  return candidates.sort((left, right) => right.current.version - left.current.version);
}

export async function listAdminRollbackCandidates({ store, config } = {}) {
  const candidates = await collectCandidates({ store, config });
  return Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    count: candidates.length,
    candidates: Object.freeze(candidates.map(candidate => projectCandidate(candidate, config))),
  });
}

async function resolveCandidateByRef({ store, config, rollbackRef } = {}) {
  const normalizedRef = normalizeRollbackRef(rollbackRef);
  const candidates = await collectCandidates({ store, config });
  const matches = candidates.filter(candidate => rollbackRefForCandidate(candidate, config.rollbackRefSalt) === normalizedRef);
  if (matches.length === 0) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_TARGET_STALE_OR_MISSING', '回滚目标不存在或已经过期', 409);
  }
  if (matches.length !== 1) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_REF_COLLISION', '回滚引用发生冲突', 500);
  }
  return matches[0];
}

function requestHashFor(command, actorTag) {
  return `rbrh_v1_${sha256Base64Url(canonicalize({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    actorTag,
    rollbackRef: command.rollbackRef,
    requestId: command.requestId,
    reasonCode: command.reasonCode,
  }))}`;
}

function decisionIdFor(requestHash) {
  return `rbd_v1_${sha256Base64Url(requestHash)}`;
}

function approvalIdForRollback(requestHash) {
  return `ap_v1_${sha256Base64Url(canonicalize({ mode: 'admin_rollback', requestHash }))}`;
}

function auditIdFor(decisionId) {
  return `rbau_v1_${sha256Base64Url(decisionId)}`;
}

function rollbackRequestKey(config, requestId) {
  return normalizeBlobKey(`rollbacks/${config.libraryId}/requests/${requestId}.json`);
}

function rollbackDecisionKey(config, approvalId) {
  return normalizeBlobKey(`public/${config.libraryId}/rollbacks/${approvalId}.json`);
}

function rollbackAuditKey(auditId, createdAt) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_AUDIT_TIME_INVALID', '回滚审计时间无效', 500);
  }
  return normalizeBlobKey(`audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`);
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
      throw new AdminRollbackError(conflictCode, conflictMessage, 409, null, error);
    }
    return Object.freeze({ value: existing, created: false });
  }
}

async function listEventKeysStrong(store, libraryId) {
  if (!store || typeof store.list !== 'function') {
    throw new AdminRollbackError('ADMIN_ROLLBACK_LIST_UNAVAILABLE', '回滚需要Blob list能力', 503);
  }
  const prefix = publicEventPrefix(libraryId);
  let result;
  try {
    result = await store.list({ prefix, consistency: 'strong' });
  } catch (error) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_LIST_FAILED', '强一致列举公共事件失败', 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > MAX_ADMIN_ROLLBACK_EVENT_OBJECTS) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_LIMIT_EXCEEDED', '公共事件数量超过回滚安全上限', 409);
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_LIST_INVALID', '公共事件列举结果无效', 503);
  }
  return { prefix, keys: keys.sort() };
}

function eventVersionFromKey(prefix, key) {
  if (!key.startsWith(prefix)) return null;
  const match = EVENT_FILE_PATTERN.exec(key.slice(prefix.length));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

async function reserveRollbackEvent({ store, config, candidate, approvalId, now } = {}) {
  for (let attempt = 0; attempt < MAX_ADMIN_ROLLBACK_RESERVATION_ATTEMPTS; attempt += 1) {
    const { prefix, keys } = await listEventKeysStrong(store, config.libraryId);
    let maxVersion = 0;
    for (const key of keys) {
      const version = eventVersionFromKey(prefix, key);
      if (version === null) {
        throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_KEY_INVALID', '公共事件目录包含无效Key', 503);
      }
      maxVersion = Math.max(maxVersion, version);
    }
    const version = maxVersion + 1;
    const eventKey = publicEventKey(config.libraryId, version);
    const previous = candidate.previous;
    const current = candidate.current;
    const event = Object.freeze({
      schemaVersion: 1,
      version,
      eventKey,
      approvalId,
      groupId: config.groupId,
      libraryId: config.libraryId,
      approvedAt: new Date(now).toISOString(),
      businessKey: current.businessKey,
      contentHash: previous.contentHash,
      dataType: 'exact_price',
      operation: 'upsert',
      payload: previous.payload,
      baseline: Object.freeze({
        approvedVersion: current.version,
        contentHash: current.contentHash,
        unitPrice: current.payload.unitPrice,
      }),
      approval: Object.freeze({
        mode: 'admin_approved',
        deviceIds: Object.freeze([...previous.approval.deviceIds]),
        submissionIds: Object.freeze([...previous.approval.submissionIds]),
      }),
    });
    try {
      await putJSONOnlyIfNew(store, eventKey, event);
      return event;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_RESERVATION_EXHAUSTED', '回滚事件版本预留失败', 503);
}

function assertTransition(value, expectedKey) {
  if (!isPlainObject(value)
      || value.schemaVersion !== 1
      || value.transitionKey !== expectedKey
      || !APPROVAL_ID_PATTERN.test(String(value.approvalId || ''))
      || value.groupId !== ADMIN_ROLLBACK_ALLOWED_GROUP_ID
      || value.libraryId !== ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID
      || !BUSINESS_KEY_PATTERN.test(String(value.businessKey || ''))
      || !Number.isSafeInteger(value.baselineApprovedVersion) || value.baselineApprovedVersion < 1
      || !CONTENT_HASH_PATTERN.test(String(value.baselineContentHash || ''))
      || !CONTENT_HASH_PATTERN.test(String(value.targetContentHash || ''))
      || !Number.isSafeInteger(value.version) || value.version < 1
      || typeof value.eventKey !== 'string'
      || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_TRANSITION_INVALID', '回滚基线迁移声明无效', 503);
  }
  return value;
}

async function claimTransition({ store, config, candidate, approvalId, event, now } = {}) {
  const key = transitionIndexKey(config.libraryId, candidate.current.businessKey, candidate.current.version);
  const proposed = Object.freeze({
    schemaVersion: 1,
    transitionKey: key,
    approvalId,
    groupId: config.groupId,
    libraryId: config.libraryId,
    businessKey: candidate.current.businessKey,
    baselineApprovedVersion: candidate.current.version,
    baselineContentHash: candidate.current.contentHash,
    targetContentHash: candidate.previous.contentHash,
    version: event.version,
    eventKey: event.eventKey,
    createdAt: now,
  });
  try {
    await putJSONOnlyIfNew(store, key, proposed);
    return Object.freeze({ transition: proposed, created: true });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = assertTransition(await getJSONStrong(store, key), key);
    if (existing.approvalId !== approvalId
        || existing.baselineContentHash !== candidate.current.contentHash
        || existing.targetContentHash !== candidate.previous.contentHash) {
      throw new AdminRollbackError('ADMIN_ROLLBACK_BASELINE_CONFLICT', '当前公共版本已被另一操作占用', 409, null, error);
    }
    return Object.freeze({ transition: existing, created: false });
  }
}

function assertDecision(value, expected = {}) {
  assertExactKeys(value, [
    'schemaVersion', 'decisionId', 'approvalId', 'requestHash', 'requestId', 'rollbackRef',
    'actorTag', 'reasonCode', 'groupId', 'libraryId', 'businessKey', 'currentVersion',
    'currentContentHash', 'currentUnitPrice', 'previousVersion', 'previousContentHash',
    'previousUnitPrice', 'eventVersion', 'eventKey', 'createdAt',
  ], 'ADMIN_ROLLBACK_DECISION_INVALID', '回滚决策声明结构无效', 503);
  if (value.schemaVersion !== ADMIN_ROLLBACK_SCHEMA_VERSION
      || !DECISION_ID_PATTERN.test(String(value.decisionId || ''))
      || !APPROVAL_ID_PATTERN.test(String(value.approvalId || ''))
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || !REQUEST_ID_PATTERN.test(String(value.requestId || ''))
      || !ROLLBACK_REF_PATTERN.test(String(value.rollbackRef || ''))
      || !ACTOR_TAG_PATTERN.test(String(value.actorTag || ''))
      || !REASON_CODES.has(value.reasonCode)
      || value.groupId !== ADMIN_ROLLBACK_ALLOWED_GROUP_ID
      || value.libraryId !== ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID
      || !BUSINESS_KEY_PATTERN.test(String(value.businessKey || ''))
      || !Number.isSafeInteger(value.currentVersion) || value.currentVersion < 2
      || !CONTENT_HASH_PATTERN.test(String(value.currentContentHash || ''))
      || !Number.isFinite(value.currentUnitPrice) || value.currentUnitPrice <= 0
      || !Number.isSafeInteger(value.previousVersion) || value.previousVersion < 1
      || value.previousVersion >= value.currentVersion
      || !CONTENT_HASH_PATTERN.test(String(value.previousContentHash || ''))
      || !Number.isFinite(value.previousUnitPrice) || value.previousUnitPrice <= 0
      || !Number.isSafeInteger(value.eventVersion) || value.eventVersion <= value.currentVersion
      || typeof value.eventKey !== 'string'
      || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
      || (expected.requestHash && value.requestHash !== expected.requestHash)
      || (expected.requestId && value.requestId !== expected.requestId)
      || (expected.approvalId && value.approvalId !== expected.approvalId)) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_DECISION_INVALID', '回滚决策声明内容无效', 503);
  }
  return value;
}

function assertRequestRecord(value, expected = {}) {
  assertExactKeys(value, [
    'schemaVersion', 'requestId', 'requestHash', 'decisionId', 'approvalId', 'createdAt',
  ], 'ADMIN_ROLLBACK_REQUEST_INVALID', '回滚请求索引结构无效', 503);
  if (value.schemaVersion !== ADMIN_ROLLBACK_SCHEMA_VERSION
      || !REQUEST_ID_PATTERN.test(String(value.requestId || ''))
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || !DECISION_ID_PATTERN.test(String(value.decisionId || ''))
      || !APPROVAL_ID_PATTERN.test(String(value.approvalId || ''))
      || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
      || (expected.requestId && value.requestId !== expected.requestId)
      || (expected.requestHash && value.requestHash !== expected.requestHash)) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_REQUEST_INVALID', '回滚请求索引内容无效', 503);
  }
  return value;
}

async function ensureSnapshot(store, config, now) {
  const snapshot = await buildPublicSnapshot({
    store,
    groupId: config.groupId,
    libraryId: config.libraryId,
    now,
  });
  if (snapshot.publicVersion < 1) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_SNAPSHOT_INVALID', '回滚后公共快照无有效版本', 503);
  }
  const key = publicSnapshotKey(config.libraryId, snapshot.publicVersion);
  await putImmutableExact(
    store,
    key,
    snapshot,
    'ADMIN_ROLLBACK_SNAPSHOT_CONFLICT',
    '同一公共版本对应不同快照',
  );
  return { snapshot, snapshotKey: key };
}

async function finalizeRollback({ store, config, decision, duplicate, now } = {}) {
  const event = normalizeInternalEvent(await getJSONStrong(store, decision.eventKey));
  if (event.version !== decision.eventVersion
      || event.approvalId !== decision.approvalId
      || event.businessKey !== decision.businessKey
      || event.contentHash !== decision.previousContentHash
      || event.baseline.approvedVersion !== decision.currentVersion
      || event.baseline.contentHash !== decision.currentContentHash) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_LINK_INVALID', '回滚事件与决策声明不一致', 503);
  }

  const index = Object.freeze({
    schemaVersion: 1,
    approvalId: decision.approvalId,
    groupId: config.groupId,
    libraryId: config.libraryId,
    businessKey: decision.businessKey,
    contentHash: decision.previousContentHash,
    baselineApprovedVersion: decision.currentVersion,
    baselineContentHash: decision.currentContentHash,
    version: decision.eventVersion,
    eventKey: decision.eventKey,
    createdAt: decision.createdAt,
  });
  const indexResult = await putImmutableExact(
    store,
    approvalIndexKey(config.libraryId, decision.approvalId),
    index,
    'ADMIN_ROLLBACK_APPROVAL_INDEX_CONFLICT',
    '回滚批准索引冲突',
  );

  const requestRecord = Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    requestId: decision.requestId,
    requestHash: decision.requestHash,
    decisionId: decision.decisionId,
    approvalId: decision.approvalId,
    createdAt: decision.createdAt,
  });
  await putImmutableExact(
    store,
    rollbackRequestKey(config, decision.requestId),
    requestRecord,
    'ADMIN_ROLLBACK_REQUEST_CONFLICT',
    '回滚请求索引冲突',
  );

  const auditId = auditIdFor(decision.decisionId);
  const audit = Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    auditId,
    decisionId: decision.decisionId,
    actorTag: decision.actorTag,
    action: 'rollback_previous_approved_value',
    reasonCode: decision.reasonCode,
    currentVersion: decision.currentVersion,
    previousVersion: decision.previousVersion,
    eventVersion: decision.eventVersion,
    createdAt: decision.createdAt,
  });
  await putImmutableExact(
    store,
    rollbackAuditKey(auditId, decision.createdAt),
    audit,
    'ADMIN_ROLLBACK_AUDIT_CONFLICT',
    '回滚审计冲突',
  );

  const latest = await ensureSnapshot(store, config, now);
  const record = latest.snapshot.records.find(item => item.businessKey === decision.businessKey);
  if (!record || record.approvedVersion !== decision.eventVersion
      || record.contentHash !== decision.previousContentHash
      || record.payload.unitPrice !== decision.previousUnitPrice) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_SNAPSHOT_MISMATCH', '回滚后快照未恢复到上一批准值', 503);
  }

  return Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    rollbackRef: decision.rollbackRef,
    serviceName: record.payload.serviceName,
    settleType: record.payload.settleType,
    restoredUnitPrice: decision.previousUnitPrice,
    replacedUnitPrice: decision.currentUnitPrice,
    restoredFromVersion: decision.previousVersion,
    replacedVersion: decision.currentVersion,
    eventVersion: decision.eventVersion,
    publicVersion: latest.snapshot.publicVersion,
    duplicate: Boolean(duplicate || !indexResult.created),
  });
}

export async function executeAdminRollback({ store, config, identity, command, now = Date.now() } = {}) {
  assertSafeTime(now);
  const input = normalizeCommand(command);
  const actorTag = actorTagFor(identity);
  const requestHash = requestHashFor(input, actorTag);
  const decisionId = decisionIdFor(requestHash);
  const approvalId = approvalIdForRollback(requestHash);

  const existingRequest = await getJSONStrong(store, rollbackRequestKey(config, input.requestId));
  if (existingRequest) {
    const request = assertRequestRecord(existingRequest, { requestId: input.requestId, requestHash });
    const decision = assertDecision(
      await getJSONStrong(store, rollbackDecisionKey(config, request.approvalId)),
      { requestHash, requestId: input.requestId, approvalId: request.approvalId },
    );
    return finalizeRollback({ store, config, decision, duplicate: true, now });
  }

  const existingDecision = await getJSONStrong(store, rollbackDecisionKey(config, approvalId));
  if (existingDecision) {
    const decision = assertDecision(existingDecision, { requestHash, requestId: input.requestId, approvalId });
    return finalizeRollback({ store, config, decision, duplicate: true, now });
  }

  const candidate = await resolveCandidateByRef({ store, config, rollbackRef: input.rollbackRef });
  const event = await reserveRollbackEvent({ store, config, candidate, approvalId, now });
  const claimed = await claimTransition({ store, config, candidate, approvalId, event, now });
  const canonicalEvent = normalizeInternalEvent(await getJSONStrong(store, claimed.transition.eventKey));
  if (canonicalEvent.approvalId !== approvalId) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_TRANSITION_EVENT_MISMATCH', '回滚迁移声明与事件不一致', 503);
  }

  const decision = Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    decisionId,
    approvalId,
    requestHash,
    requestId: input.requestId,
    rollbackRef: input.rollbackRef,
    actorTag,
    reasonCode: input.reasonCode,
    groupId: config.groupId,
    libraryId: config.libraryId,
    businessKey: candidate.current.businessKey,
    currentVersion: candidate.current.version,
    currentContentHash: candidate.current.contentHash,
    currentUnitPrice: candidate.current.payload.unitPrice,
    previousVersion: candidate.previous.version,
    previousContentHash: candidate.previous.contentHash,
    previousUnitPrice: candidate.previous.payload.unitPrice,
    eventVersion: canonicalEvent.version,
    eventKey: canonicalEvent.eventKey,
    createdAt: now,
  });
  const stored = await putImmutableExact(
    store,
    rollbackDecisionKey(config, approvalId),
    decision,
    'ADMIN_ROLLBACK_DECISION_CONFLICT',
    '回滚决策声明冲突',
  );
  return finalizeRollback({
    store,
    config,
    decision: assertDecision(stored.value, { requestHash, requestId: input.requestId, approvalId }),
    duplicate: !stored.created || !claimed.created,
    now,
  });
}

export function isAdminRollbackProjectionSafe(value) {
  const forbiddenKeys = new Set([
    'businessKey', 'contentHash', 'currentContentHash', 'previousContentHash',
    'eventKey', 'snapshotKey', 'approvalId', 'requestHash', 'requestId', 'decisionId',
    'auditId', 'deviceId', 'deviceIds', 'submissionId', 'submissionIds', 'tokenHash',
    'blobKey', 'secret', 'salt', 'actorTag',
  ]);
  const visit = (item, depth = 0) => {
    if (depth > 12) return false;
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) return true;
    if (Array.isArray(item)) return item.every(entry => visit(entry, depth + 1));
    if (!isPlainObject(item)) return false;
    return Object.entries(item).every(([key, entry]) => !forbiddenKeys.has(key) && visit(entry, depth + 1));
  };
  return visit(value);
}

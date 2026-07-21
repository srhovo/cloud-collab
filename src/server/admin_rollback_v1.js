import { createHash, createHmac } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  listValidPublicEvents,
  publishAdminReviewApproval,
} from './auto_approval_engine_v1.js';
import {
  buildIdempotencyKey,
  canonicalize,
  normalizeExactPricePayload,
  normalizeSubmission,
} from './submission_policy_v1.js';

export const ADMIN_ROLLBACK_SCHEMA_VERSION = 1;
export const ADMIN_ROLLBACK_MAX_BODY_BYTES = 768;
export const ADMIN_ROLLBACK_PREVIEW_STORE_NAME = 'cloud-collab-preview-v1';
export const ADMIN_ROLLBACK_ALLOWED_GROUP_ID = 'group_fixture';
export const ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID = 'lib_receive_fixture';
export const ADMIN_ROLLBACK_CONFIRMATION = 'ROLLBACK_TO_PREVIOUS_APPROVED_VALUE';
export const MAX_ADMIN_ROLLBACK_CANDIDATES = 500;
export const MAX_ADMIN_ROLLBACK_EVENT_OBJECTS = 10_000;

const ROLLBACK_REF_PATTERN = /^rbref_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_PATTERN = /^rbrq_v1_[A-Za-z0-9_-]{22,64}$/;
const REQUEST_TOKEN_PATTERN = /^rbtok_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^rbrh_v1_[A-Za-z0-9_-]{43}$/;
const ROLLBACK_ID_PATTERN = /^rb_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^rbau_v1_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const APPROVAL_ID_PATTERN = /^ap_v1_[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_PATTERN = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBMISSION_ID_PATTERN = /^sub_[0-9A-HJKMNP-TV-Z]{26}$/;

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
    super(message || code || '管理员公共数据回滚失败');
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

function normalizeCommand(command) {
  assertExactKeys(command, ['schemaVersion', 'rollbackRef', 'requestId', 'confirmation'], 'ADMIN_ROLLBACK_INPUT_INVALID', '回滚请求字段无效');
  if (command.schemaVersion !== ADMIN_ROLLBACK_SCHEMA_VERSION) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_SCHEMA_UNSUPPORTED', '回滚协议版本不受支持', 400);
  }
  if (command.confirmation !== ADMIN_ROLLBACK_CONFIRMATION) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_CONFIRMATION_REQUIRED', '回滚请求缺少明确确认', 400);
  }
  return Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    rollbackRef: normalizeRollbackRef(command.rollbackRef),
    requestId: normalizeRequestId(command.requestId),
    confirmation: ADMIN_ROLLBACK_CONFIRMATION,
  });
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

export function readAdminRollbackConfig(env = {}) {
  if (String(env.CLOUD_ADMIN_ROLLBACK_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new AdminRollbackError('ADMIN_ROLLBACK_PREVIEW_DISABLED', '管理员回滚预览未开启', 503);
  }
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '0').trim() === '1'
      || String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '0').trim() === '1'
      || String(env.CLOUD_ADMIN_REVIEW_MUTATION_PREVIEW_ENABLED || '0').trim() === '1') {
    throw new AdminRollbackError('ADMIN_ROLLBACK_REQUIRES_OTHER_MUTATIONS_CLOSED', '回滚预览要求公共写入、自动审核和审核写入全部关闭', 503);
  }
  const storeName = String(env.CLOUD_ADMIN_ROLLBACK_BLOB_STORE_NAME || '').trim();
  const groupId = String(env.CLOUD_ADMIN_ROLLBACK_ALLOWED_GROUP_ID || '').trim().toLowerCase();
  const libraryId = String(env.CLOUD_ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID || '').trim().toLowerCase();
  if (storeName !== ADMIN_ROLLBACK_PREVIEW_STORE_NAME || groupId !== ADMIN_ROLLBACK_ALLOWED_GROUP_ID || libraryId !== ADMIN_ROLLBACK_ALLOWED_LIBRARY_ID) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_SCOPE_INVALID', '回滚只允许合成预览价格库', 503);
  }
  const rollbackRefSalt = assertSecret(env.CLOUD_ADMIN_ROLLBACK_REF_SALT, 'ADMIN_ROLLBACK_REF_SALT_INVALID', '回滚引用盐值');
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
  return Object.freeze({ schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION, previewEnabled: true, storeName, groupId, libraryId, rollbackRefSalt });
}

function normalizeEvidence(value, label) {
  const deviceIds = Array.isArray(value?.deviceIds) ? value.deviceIds.map(String) : [];
  const submissionIds = Array.isArray(value?.submissionIds) ? value.submissionIds.map(String) : [];
  if (deviceIds.length < 1 || deviceIds.length > 128 || deviceIds.length !== submissionIds.length
      || new Set(deviceIds).size !== deviceIds.length || new Set(submissionIds).size !== submissionIds.length
      || deviceIds.some(id => !DEVICE_ID_PATTERN.test(id)) || submissionIds.some(id => !SUBMISSION_ID_PATTERN.test(id))) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_EVIDENCE_INVALID', `${label}事件批准证据无效`, 503);
  }
  return Object.freeze(deviceIds.map((deviceId, index) => Object.freeze({ deviceId, submissionId: submissionIds[index] })));
}

function normalizeInternalEvent(event, config, label = '公共') {
  if (!config || typeof config.groupId !== 'string' || typeof config.libraryId !== 'string') {
    throw new AdminRollbackError('ADMIN_ROLLBACK_SCOPE_INVALID', `${label}事件缺少回滚作用域`, 503);
  }
  if (!isPlainObject(event) || !Number.isSafeInteger(event.version) || event.version < 1
      || event.groupId !== config.groupId || event.libraryId !== config.libraryId
      || !BUSINESS_KEY_PATTERN.test(String(event.businessKey || '')) || !CONTENT_HASH_PATTERN.test(String(event.contentHash || ''))
      || event.dataType !== 'exact_price' || event.operation !== 'upsert' || !Number.isFinite(Date.parse(event.approvedAt))) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_INVALID', `${label}事件不满足回滚要求`, 503);
  }
  let payload;
  try { payload = normalizeExactPricePayload(event.payload); }
  catch (error) { throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_INVALID', `${label}事件普通单价无效`, 503, null, error); }
  return Object.freeze({
    version: event.version,
    groupId: event.groupId,
    libraryId: event.libraryId,
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    approvedAt: event.approvedAt,
    payload,
    evidence: normalizeEvidence(event.approval, label),
  });
}

function rollbackRefFromParts(config, source, restore) {
  return `rbref_v1_${hmacBase64Url(canonicalize({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    groupId: config.groupId,
    libraryId: config.libraryId,
    businessKey: source.businessKey,
    sourceVersion: source.version,
    sourceContentHash: source.contentHash,
    restoreVersion: restore?.version ?? 0,
    restoreContentHash: restore?.contentHash ?? null,
  }), config.rollbackRefSalt)}`;
}

export function rollbackRefForEventPair({ config, current, previous = null } = {}) {
  const source = normalizeInternalEvent(current, config, '当前');
  const restore = previous === null ? null : normalizeInternalEvent(previous, config, '上一');
  if (restore && restore.businessKey !== source.businessKey) throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_PAIR_INVALID', '回滚事件业务键不一致', 503);
  return rollbackRefFromParts(config, source, restore);
}

async function collectHistories({ store, config } = {}) {
  const events = await listValidPublicEvents({ store, libraryId: config.libraryId });
  if (events.length > MAX_ADMIN_ROLLBACK_EVENT_OBJECTS) throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_LIMIT_EXCEEDED', '公共事件数量超过回滚安全上限', 409);
  const histories = new Map();
  for (const rawEvent of events) {
    const event = normalizeInternalEvent(rawEvent, config);
    if (event.groupId !== config.groupId || event.libraryId !== config.libraryId) throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_SCOPE_MISMATCH', '公共事件作用域与回滚配置不一致', 503);
    if (!histories.has(event.businessKey)) histories.set(event.businessKey, []);
    histories.get(event.businessKey).push(Object.freeze({ raw: rawEvent, normalized: event }));
  }
  for (const history of histories.values()) history.sort((left, right) => left.normalized.version - right.normalized.version);
  return histories;
}

function projectCandidate(config, current, previous) {
  return Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    rollbackRef: rollbackRefFromParts(config, current.normalized, previous.normalized),
    serviceName: current.normalized.payload.serviceName,
    settleType: current.normalized.payload.settleType,
    currentUnitPrice: current.normalized.payload.unitPrice,
    previousUnitPrice: previous.normalized.payload.unitPrice,
    currentVersion: current.normalized.version,
    previousVersion: previous.normalized.version,
    currentApprovedAt: current.normalized.approvedAt,
    previousApprovedAt: previous.normalized.approvedAt,
  });
}

export async function listAdminRollbackCandidates({ store, config } = {}) {
  const histories = await collectHistories({ store, config });
  const candidates = [];
  for (const history of histories.values()) {
    if (history.length < 2) continue;
    const current = history[history.length - 1];
    const previous = history[history.length - 2];
    if (current.normalized.contentHash === previous.normalized.contentHash) continue;
    candidates.push(projectCandidate(config, current, previous));
  }
  if (candidates.length > MAX_ADMIN_ROLLBACK_CANDIDATES) throw new AdminRollbackError('ADMIN_ROLLBACK_CANDIDATE_LIMIT_EXCEEDED', '回滚候选数量超过安全上限', 409);
  candidates.sort((left, right) => right.currentVersion - left.currentVersion || left.serviceName.localeCompare(right.serviceName));
  return Object.freeze({ schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION, count: candidates.length, candidates: Object.freeze(candidates) });
}

async function resolveCandidateByRef({ store, config, rollbackRef } = {}) {
  const normalizedRef = normalizeRollbackRef(rollbackRef);
  const histories = await collectHistories({ store, config });
  let historicalMatch = false;
  for (const history of histories.values()) {
    for (let index = 0; index < history.length; index += 1) {
      const current = history[index];
      const previous = index > 0 ? history[index - 1] : null;
      const candidateRef = rollbackRefFromParts(config, current.normalized, previous?.normalized ?? null);
      if (candidateRef !== normalizedRef) continue;
      if (index !== history.length - 1) { historicalMatch = true; continue; }
      if (!previous) throw new AdminRollbackError('ADMIN_ROLLBACK_NO_PREVIOUS_VALUE', '首次新增项目没有上一份已批准值，不能通过回滚删除', 409);
      if (current.normalized.contentHash === previous.normalized.contentHash) throw new AdminRollbackError('ADMIN_ROLLBACK_NO_CHANGE', '当前值与上一批准值相同，无需回滚', 409);
      return Object.freeze({ current, previous });
    }
  }
  if (historicalMatch) throw new AdminRollbackError('ADMIN_ROLLBACK_TARGET_STALE', '回滚目标已不是当前公共值', 409);
  throw new AdminRollbackError('ADMIN_ROLLBACK_TARGET_NOT_FOUND', '回滚目标不存在', 404);
}

function requestTokenFor(requestId) { return `rbtok_v1_${sha256Base64Url(requestId)}`; }
function requestHashFor(command, actorTag) { return `rbrh_v1_${sha256Base64Url(canonicalize({ ...command, actorTag }))}`; }
function rollbackIdFor(requestHash) { return `rb_v1_${sha256Base64Url(requestHash)}`; }
function auditIdFor(rollbackId) { return `rbau_v1_${sha256Base64Url(rollbackId)}`; }

function requestIndexKey(config, requestToken) {
  if (!REQUEST_TOKEN_PATTERN.test(requestToken)) throw new AdminRollbackError('ADMIN_ROLLBACK_REQUEST_TOKEN_INVALID', '回滚请求索引无效', 500);
  return normalizeBlobKey(`rollbacks/${config.libraryId}/requests/${requestToken}.json`);
}
function decisionKey(config, rollbackId) {
  if (!ROLLBACK_ID_PATTERN.test(rollbackId)) throw new AdminRollbackError('ADMIN_ROLLBACK_ID_INVALID', '回滚决策ID无效', 500);
  return normalizeBlobKey(`rollbacks/${config.libraryId}/decisions/${rollbackId}.json`);
}
function completionKey(config, rollbackId) { return normalizeBlobKey(`rollbacks/${config.libraryId}/completions/${rollbackId}.json`); }
function auditKey(auditId, occurredAt) {
  if (!AUDIT_ID_PATTERN.test(auditId)) throw new AdminRollbackError('ADMIN_ROLLBACK_AUDIT_ID_INVALID', '回滚审计ID无效', 500);
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) throw new AdminRollbackError('ADMIN_ROLLBACK_AUDIT_TIME_INVALID', '回滚审计时间无效', 500);
  return normalizeBlobKey(`audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`);
}

function buildReplaySubmission(target) {
  const primary = target.previous.normalized.evidence[0];
  const submission = {
    schemaVersion: 1,
    payloadSchemaVersion: 1,
    submissionId: primary.submissionId,
    deviceId: primary.deviceId,
    groupId: target.previous.normalized.groupId,
    libraryId: target.previous.normalized.libraryId,
    bossId: null,
    dataType: 'exact_price',
    operation: 'upsert',
    origin: 'user',
    clientCreatedAt: 0,
    businessKey: target.previous.normalized.businessKey,
    contentHash: target.previous.normalized.contentHash,
    idempotencyKey: buildIdempotencyKey(primary.deviceId, primary.submissionId),
    payload: target.previous.normalized.payload,
    clientContext: { appVersion: '8.2.28-stage5e', projectionSpecVersion: 1, queueSchemaVersion: 1 },
  };
  try { return Object.freeze({ submission: normalizeSubmission(submission), evidence: target.previous.normalized.evidence }); }
  catch (error) { throw new AdminRollbackError('ADMIN_ROLLBACK_REPLAY_SUBMISSION_INVALID', '上一批准值无法构造回滚补偿事件', 503, null, error); }
}

function buildDecision({ config, identity, command, requestHash, rollbackId, target, createdAt }) {
  const replay = buildReplaySubmission(target);
  return Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    rollbackId,
    requestHash,
    rollbackRef: command.rollbackRef,
    actorTag: actorTagFor(identity),
    createdAt,
    groupId: config.groupId,
    libraryId: config.libraryId,
    businessKey: target.current.normalized.businessKey,
    source: Object.freeze({ version: target.current.normalized.version, contentHash: target.current.normalized.contentHash, unitPrice: target.current.normalized.payload.unitPrice, approvedAt: target.current.normalized.approvedAt }),
    restore: Object.freeze({ version: target.previous.normalized.version, contentHash: target.previous.normalized.contentHash, unitPrice: target.previous.normalized.payload.unitPrice, approvedAt: target.previous.normalized.approvedAt }),
    targetSubmission: replay.submission,
    evidence: replay.evidence,
  });
}

function normalizeVersionSummary(value, label) {
  assertExactKeys(value, ['version', 'contentHash', 'unitPrice', 'approvedAt'], 'ADMIN_ROLLBACK_DECISION_INVALID', `${label}版本摘要无效`, 503);
  if (!Number.isSafeInteger(value.version) || value.version < 1 || !CONTENT_HASH_PATTERN.test(String(value.contentHash || ''))
      || !Number.isFinite(value.unitPrice) || value.unitPrice <= 0 || !Number.isFinite(Date.parse(value.approvedAt))) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_DECISION_INVALID', `${label}版本摘要内容无效`, 503);
  }
  return Object.freeze({ ...value });
}

function normalizeStoredEvidence(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) throw new AdminRollbackError('ADMIN_ROLLBACK_DECISION_INVALID', '回滚批准证据数量无效', 503);
  const devices = new Set();
  const submissions = new Set();
  return Object.freeze(value.map(item => {
    assertExactKeys(item, ['deviceId', 'submissionId'], 'ADMIN_ROLLBACK_DECISION_INVALID', '回滚批准证据结构无效', 503);
    if (!DEVICE_ID_PATTERN.test(String(item.deviceId || '')) || !SUBMISSION_ID_PATTERN.test(String(item.submissionId || ''))
        || devices.has(item.deviceId) || submissions.has(item.submissionId)) throw new AdminRollbackError('ADMIN_ROLLBACK_DECISION_INVALID', '回滚批准证据内容无效', 503);
    devices.add(item.deviceId);
    submissions.add(item.submissionId);
    return Object.freeze({ deviceId: item.deviceId, submissionId: item.submissionId });
  }));
}

function assertDecision(value, config, expected = {}) {
  assertExactKeys(value, ['schemaVersion','rollbackId','requestHash','rollbackRef','actorTag','createdAt','groupId','libraryId','businessKey','source','restore','targetSubmission','evidence'], 'ADMIN_ROLLBACK_DECISION_INVALID', '管理员回滚决策结构无效', 503);
  if (value.schemaVersion !== ADMIN_ROLLBACK_SCHEMA_VERSION || !ROLLBACK_ID_PATTERN.test(String(value.rollbackId || ''))
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || '')) || !ROLLBACK_REF_PATTERN.test(String(value.rollbackRef || ''))
      || !ACTOR_TAG_PATTERN.test(String(value.actorTag || '')) || value.groupId !== config.groupId || value.libraryId !== config.libraryId
      || !BUSINESS_KEY_PATTERN.test(String(value.businessKey || '')) || (expected.rollbackId && value.rollbackId !== expected.rollbackId)
      || (expected.requestHash && value.requestHash !== expected.requestHash)) throw new AdminRollbackError('ADMIN_ROLLBACK_DECISION_INVALID', '管理员回滚决策内容无效', 503);
  assertSafeTime(value.createdAt);
  const source = normalizeVersionSummary(value.source, '当前');
  const restore = normalizeVersionSummary(value.restore, '恢复');
  if (restore.version >= source.version) throw new AdminRollbackError('ADMIN_ROLLBACK_DECISION_INVALID', '恢复版本必须早于当前版本', 503);
  let targetSubmission;
  try { targetSubmission = normalizeSubmission(value.targetSubmission); }
  catch (error) { throw new AdminRollbackError('ADMIN_ROLLBACK_DECISION_INVALID', '回滚补偿提交无效', 503, null, error); }
  const evidence = normalizeStoredEvidence(value.evidence);
  if (targetSubmission.groupId !== config.groupId || targetSubmission.libraryId !== config.libraryId || targetSubmission.businessKey !== value.businessKey
      || targetSubmission.contentHash !== restore.contentHash || targetSubmission.payload.unitPrice !== restore.unitPrice
      || value.rollbackRef !== rollbackRefFromParts(config, { businessKey: value.businessKey, version: source.version, contentHash: source.contentHash }, { businessKey: value.businessKey, version: restore.version, contentHash: restore.contentHash })) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_DECISION_INVALID', '回滚目标与补偿提交不一致', 503);
  }
  return Object.freeze({ ...value, source, restore, targetSubmission, evidence });
}

function assertRequestIndex(value, expectedToken = null) {
  assertExactKeys(value, ['schemaVersion','requestToken','requestHash','rollbackId','createdAt'], 'ADMIN_ROLLBACK_REQUEST_INDEX_INVALID', '回滚请求索引结构无效', 503);
  if (value.schemaVersion !== ADMIN_ROLLBACK_SCHEMA_VERSION || !REQUEST_TOKEN_PATTERN.test(String(value.requestToken || ''))
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || '')) || !ROLLBACK_ID_PATTERN.test(String(value.rollbackId || ''))
      || (expectedToken && value.requestToken !== expectedToken)) throw new AdminRollbackError('ADMIN_ROLLBACK_REQUEST_INDEX_INVALID', '回滚请求索引内容无效', 503);
  assertSafeTime(value.createdAt);
  return Object.freeze({ ...value });
}

async function claimRequestIndex(store, key, proposed) {
  try {
    await putJSONOnlyIfNew(store, key, proposed);
    return assertRequestIndex(proposed, proposed.requestToken);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = assertRequestIndex(await getJSONStrong(store, key), proposed.requestToken);
    if (existing.requestHash !== proposed.requestHash || existing.rollbackId !== proposed.rollbackId) {
      throw new AdminRollbackError('ADMIN_ROLLBACK_REQUEST_CONFLICT', '同一回滚请求ID对应了不同正文', 409, null, error);
    }
    return existing;
  }
}

function assertCompletion(value, decision) {
  assertExactKeys(value, ['schemaVersion','rollbackId','auditId','status','completedAt','sourceVersion','restoreVersion','publicVersion','eventVersion','approvalId','publicMutationApplied'], 'ADMIN_ROLLBACK_COMPLETION_INVALID', '回滚完成记录结构无效', 503);
  if (value.schemaVersion !== ADMIN_ROLLBACK_SCHEMA_VERSION || value.rollbackId !== decision.rollbackId || !AUDIT_ID_PATTERN.test(String(value.auditId || ''))
      || value.status !== 'rolled_back' || value.sourceVersion !== decision.source.version || value.restoreVersion !== decision.restore.version
      || !Number.isSafeInteger(value.publicVersion) || value.publicVersion < 1 || !Number.isSafeInteger(value.eventVersion) || value.eventVersion < 1
      || !APPROVAL_ID_PATTERN.test(String(value.approvalId || '')) || typeof value.publicMutationApplied !== 'boolean') throw new AdminRollbackError('ADMIN_ROLLBACK_COMPLETION_INVALID', '回滚完成记录内容无效', 503);
  assertSafeTime(value.completedAt);
  return Object.freeze({ ...value });
}

function projectCompletion(decision, completion, duplicate) {
  return Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    rollbackRef: decision.rollbackRef,
    status: completion.status,
    serviceName: decision.targetSubmission.payload.serviceName,
    settleType: decision.targetSubmission.payload.settleType,
    restoredUnitPrice: decision.restore.unitPrice,
    replacedUnitPrice: decision.source.unitPrice,
    restoredFromVersion: decision.restore.version,
    replacedVersion: decision.source.version,
    eventVersion: completion.eventVersion,
    publicVersion: completion.publicVersion,
    publicMutationApplied: completion.publicMutationApplied,
    duplicate: Boolean(duplicate),
  });
}

async function executeDecision({ store, config, decision }) {
  let published;
  try {
    published = await publishAdminReviewApproval({
      store,
      submission: decision.targetSubmission,
      baseline: { approvedVersion: decision.source.version, contentHash: decision.source.contentHash, unitPrice: decision.source.unitPrice },
      approvalMode: 'admin_edit_and_approved',
      evidence: decision.evidence,
      now: decision.createdAt,
    });
  } catch (error) {
    if (error?.code === 'BASELINE_TRANSITION_CONFLICT') throw new AdminRollbackError('ADMIN_ROLLBACK_TRANSITION_CONFLICT', '当前公共基线已被另一项批准或回滚占用', 409, null, error);
    if (error?.code === 'STALE_PUBLIC_BASELINE') throw new AdminRollbackError('ADMIN_ROLLBACK_TARGET_STALE', '回滚目标已不是当前公共值', 409, null, error);
    throw error;
  }
  if (published.event.businessKey !== decision.businessKey || published.event.contentHash !== decision.restore.contentHash
      || published.event.payload.unitPrice !== decision.restore.unitPrice || published.event.baseline.approvedVersion !== decision.source.version
      || published.event.baseline.contentHash !== decision.source.contentHash) throw new AdminRollbackError('ADMIN_ROLLBACK_EVENT_LINK_INVALID', '回滚补偿事件与决策不一致', 503);
  const record = published.snapshot.records.find(item => item.businessKey === decision.businessKey);
  if (!record || record.approvedVersion !== published.event.version || record.contentHash !== decision.restore.contentHash
      || record.payload.unitPrice !== decision.restore.unitPrice) throw new AdminRollbackError('ADMIN_ROLLBACK_SNAPSHOT_MISMATCH', '回滚后快照未恢复到上一批准值', 503);

  const auditId = auditIdFor(decision.rollbackId);
  const audit = Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    auditId,
    rollbackId: decision.rollbackId,
    action: 'admin_rollback',
    actorTag: decision.actorTag,
    occurredAt: decision.createdAt,
    groupId: decision.groupId,
    libraryId: decision.libraryId,
    businessKey: decision.businessKey,
    sourceVersion: decision.source.version,
    sourceContentHash: decision.source.contentHash,
    restoreVersion: decision.restore.version,
    restoreContentHash: decision.restore.contentHash,
    publicVersion: published.snapshot.publicVersion,
    eventVersion: published.event.version,
    approvalId: published.approvalId,
  });
  await putImmutableExact(store, auditKey(auditId, decision.createdAt), audit, 'ADMIN_ROLLBACK_AUDIT_CONFLICT', '管理员回滚审计记录冲突');
  const completion = Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    rollbackId: decision.rollbackId,
    auditId,
    status: 'rolled_back',
    completedAt: decision.createdAt,
    sourceVersion: decision.source.version,
    restoreVersion: decision.restore.version,
    publicVersion: published.snapshot.publicVersion,
    eventVersion: published.event.version,
    approvalId: published.approvalId,
    publicMutationApplied: true,
  });
  await putImmutableExact(store, completionKey(config, decision.rollbackId), completion, 'ADMIN_ROLLBACK_COMPLETION_CONFLICT', '管理员回滚完成记录冲突');
  return assertCompletion(completion, decision);
}

export async function executeAdminRollback({ store, config, identity, command, now = Date.now() } = {}) {
  assertSafeTime(now);
  if (!config?.previewEnabled) throw new AdminRollbackError('ADMIN_ROLLBACK_PREVIEW_DISABLED', '管理员回滚预览未开启', 503);
  const input = normalizeCommand(command?.input || command);
  const actorTag = actorTagFor(identity);
  const requestToken = requestTokenFor(input.requestId);
  const requestHash = requestHashFor(input, actorTag);
  const rollbackId = rollbackIdFor(requestHash);
  const requestIndex = await claimRequestIndex(store, requestIndexKey(config, requestToken), Object.freeze({
    schemaVersion: ADMIN_ROLLBACK_SCHEMA_VERSION,
    requestToken,
    requestHash,
    rollbackId,
    createdAt: now,
  }));

  const storedDecisionKey = decisionKey(config, rollbackId);
  let decision = await getJSONStrong(store, storedDecisionKey);
  if (decision) decision = assertDecision(decision, config, { rollbackId, requestHash });
  else {
    const target = await resolveCandidateByRef({ store, config, rollbackRef: input.rollbackRef });
    decision = assertDecision(buildDecision({ config, identity, command: input, requestHash, rollbackId, target, createdAt: requestIndex.createdAt }), config, { rollbackId, requestHash });
    const written = await putImmutableExact(store, storedDecisionKey, decision, 'ADMIN_ROLLBACK_DECISION_CONFLICT', '管理员回滚决策冲突');
    decision = assertDecision(written.value, config, { rollbackId, requestHash });
  }

  const existingCompletion = await getJSONStrong(store, completionKey(config, rollbackId));
  if (existingCompletion) return projectCompletion(decision, assertCompletion(existingCompletion, decision), true);
  const completion = await executeDecision({ store, config, decision });
  return projectCompletion(decision, completion, false);
}

export function isAdminRollbackProjectionSafe(value) {
  const forbiddenKeys = new Set([
    'businessKey','contentHash','sourceContentHash','restoreContentHash','eventKey','snapshotKey','approvalId','requestHash','requestId','requestToken',
    'rollbackId','auditId','deviceId','deviceIds','submissionId','submissionIds','idempotencyKey','tokenHash','blobKey','secret','salt','actorTag',
  ]);
  const visit = (item, depth = 0) => {
    if (depth > 12) return false;
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
      if (typeof item === 'string' && (item.includes('public/') || item.includes('rollbacks/') || item.includes('audit/'))) return false;
      return true;
    }
    if (Array.isArray(item)) return item.every(entry => visit(entry, depth + 1));
    if (!isPlainObject(item)) return false;
    return Object.entries(item).every(([key, entry]) => !forbiddenKeys.has(key) && visit(entry, depth + 1));
  };
  return visit(value);
}

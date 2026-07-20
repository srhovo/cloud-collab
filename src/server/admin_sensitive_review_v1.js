import { createHash } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { canonicalize } from './submission_policy_v1.js';
import {
  computeSensitiveSubmissionHashes,
  normalizeSensitiveSubmission,
  readSensitiveRulesPreviewConfig,
} from './sensitive_rules_policy_v1.js';
import {
  buildUnifiedSensitivePublicSnapshot,
  publishSensitiveAdminApproval,
} from './sensitive_public_engine_v1.js';

export const ADMIN_SENSITIVE_REVIEW_VERSION = 1;
export const ADMIN_SENSITIVE_REVIEW_MAX_OBJECTS = 10_000;
export const ADMIN_SENSITIVE_REVIEW_MAX_BODY_BYTES = 16 * 1024;

const REVIEW_ID_PATTERN = /^srv_v1_[A-Za-z0-9_-]{43}$/;
const DECISION_ID_PATTERN = /^srd_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^sau_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^req_v1_[A-Za-z0-9_-]{43}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;
const PENDING_KEY_PATTERN = /^submissions\/(lib_[a-z0-9][a-z0-9_]{2,55})\/pending\/(ik_v1_[A-Za-z0-9_-]{43})\.json$/;
const ACTIONS = new Set(['approve', 'reject', 'edit_and_approve']);
const REJECT_REASONS = new Set([
  'invalid_data', 'insufficient_evidence', 'conflicting_candidates',
  'unsupported_change', 'identity_uncertain', 'delete_not_confirmed',
]);
const SENSITIVE_REASONS = new Set([
  'rank_range_rule_manual_review', 'surcharge_rule_manual_review', 'gift_rule_manual_review',
  'explicit_delete_manual_review', 'boss_name_change_sensitive',
  'boss_direct_report_change_sensitive', 'boss_discount_increase_sensitive',
  'boss_discount_drop_abnormal',
]);
const FORBIDDEN_PROJECTION_FIELDS = new Set([
  'authorization', 'deviceToken', 'adminToken', 'rawChat', 'originalChat',
  'history', 'order', 'orderContent', 'note', 'notes', 'customRatios',
]);

export const ADMIN_SENSITIVE_REVIEW_CAPABILITIES = Object.freeze({
  queueRead: true,
  detailRead: true,
  approve: true,
  reject: true,
  editAndApprove: true,
  tombstonePublish: true,
  automaticApproval: false,
  trustedDeviceBypass: false,
  twoDeviceBypass: false,
  syntheticFixtureOnly: true,
});

export class AdminSensitiveReviewError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员敏感审核失败');
    this.name = 'AdminSensitiveReviewError';
    this.code = code || 'ADMIN_SENSITIVE_REVIEW_ERROR';
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
  if (!isPlainObject(value)) throw new AdminSensitiveReviewError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AdminSensitiveReviewError(code, message, status, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function assertSafeTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REVIEW_TIME_INVALID', '管理员敏感审核时间无效', 500);
  }
  return value;
}

function normalizeReviewId(value) {
  const text = String(value || '').trim();
  if (!REVIEW_ID_PATTERN.test(text)) throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REVIEW_ID_INVALID', '敏感审核项目ID无效', 400);
  return text;
}

function actorTagFor(identity) {
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!username) throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REVIEW_ACTOR_INVALID', '管理员身份无效', 401);
  return `admin_${sha256Base64Url(username).slice(0, 12)}`;
}

function reviewIdFor(candidateKey, candidate) {
  return `srv_v1_${sha256Base64Url(canonicalize({
    schemaVersion: ADMIN_SENSITIVE_REVIEW_VERSION,
    candidateKey,
    requestHash: candidate.requestHash,
    businessKey: candidate.submission.businessKey,
  }))}`;
}

function requestHashFor(command) {
  return `sarq_v1_${sha256Base64Url(canonicalize({
    schemaVersion: ADMIN_SENSITIVE_REVIEW_VERSION,
    action: command.action,
    reviewId: command.reviewId,
    reasonCode: command.reasonCode,
    payload: command.payload,
  }))}`;
}

function decisionIdFor(reviewId, requestHash) {
  return `srd_v1_${sha256Base64Url(canonicalize({ reviewId, requestHash }))}`;
}

function auditIdFor(decisionId) {
  return `sau_v1_${sha256Base64Url(decisionId)}`;
}

function resolutionKey(config, reviewId) {
  return `reviews/${config.libraryId}/sensitive-resolutions/${reviewId}.json`;
}

function decisionKey(config, reviewId) {
  return `reviews/${config.libraryId}/sensitive-decisions/${reviewId}.json`;
}

function completionKey(config, reviewId) {
  return `reviews/${config.libraryId}/sensitive-completions/${reviewId}.json`;
}

function auditKey(auditId, createdAt) {
  const date = new Date(createdAt);
  if (!AUDIT_ID_PATTERN.test(auditId) || !Number.isFinite(date.getTime())) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_AUDIT_KEY_INVALID', '敏感审核审计Key无效', 500);
  }
  return `audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`;
}

function alreadyExists(error) {
  return error instanceof BlobRepositoryError && error.code === 'BLOB_ALREADY_EXISTS';
}

async function putImmutableExact(store, key, value, code, message) {
  try {
    await putJSONOnlyIfNew(store, key, value);
    return Object.freeze({ value, created: true });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || canonicalize(existing) !== canonicalize(value)) {
      throw new AdminSensitiveReviewError(code, message, 409, null, error);
    }
    return Object.freeze({ value: existing, created: false });
  }
}

export function readAdminSensitiveReviewConfig(env = {}) {
  if (String(env.CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REVIEW_PREVIEW_DISABLED', '管理员敏感审核预览未开启', 503);
  }
  let protocol;
  try { protocol = readSensitiveRulesPreviewConfig(env); }
  catch (error) {
    throw new AdminSensitiveReviewError(error?.code || 'ADMIN_SENSITIVE_REVIEW_CONFIG_INVALID', error?.message || '敏感审核配置无效', 503, error?.details || null, error);
  }
  const storeName = String(env.CLOUD_SENSITIVE_REVIEW_BLOB_STORE_NAME || '').trim();
  const groupId = String(env.CLOUD_SENSITIVE_REVIEW_ALLOWED_GROUP_ID || '').trim().toLowerCase();
  const libraryId = String(env.CLOUD_SENSITIVE_REVIEW_ALLOWED_LIBRARY_ID || '').trim().toLowerCase();
  if (storeName !== protocol.storeName || groupId !== protocol.groupId || libraryId !== protocol.libraryId) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REVIEW_SCOPE_INVALID', '管理员敏感审核必须与敏感协议使用同一合成作用域', 503);
  }
  return Object.freeze({
    schemaVersion: ADMIN_SENSITIVE_REVIEW_VERSION,
    enabled: true,
    storeName,
    groupId,
    libraryId,
  });
}

function parsePendingKey(key, config) {
  const match = PENDING_KEY_PATTERN.exec(String(key || ''));
  if (!match || match[1] !== config.libraryId) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_PENDING_KEY_INVALID', '敏感候选目录包含无效Key', 503, { key });
  }
  return Object.freeze({ key, libraryId: match[1], idempotencyKey: match[2] });
}

function assertCandidate(value, parsed, config) {
  assertExactKeys(value, [
    'schemaVersion', 'candidateKind', 'requestHash', 'status', 'decision', 'reason',
    'baselineContentHash', 'tombstoneRequested', 'submission', 'receivedAt',
    'authenticatedTokenVersion', 'publicMutationAllowed', 'autoApprovalEnabled', 'stored',
  ], 'ADMIN_SENSITIVE_CANDIDATE_INVALID', '敏感候选结构无效', 503);
  if (value.schemaVersion !== 1 || value.candidateKind !== 'sensitive_review'
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || value.status !== 'pending_review' || value.decision !== 'pending_review'
      || !SENSITIVE_REASONS.has(value.reason)
      || !(value.baselineContentHash === null || CONTENT_HASH_PATTERN.test(String(value.baselineContentHash || '')))
      || typeof value.tombstoneRequested !== 'boolean'
      || !Number.isSafeInteger(value.receivedAt) || value.receivedAt <= 0
      || !Number.isSafeInteger(value.authenticatedTokenVersion) || value.authenticatedTokenVersion < 1
      || value.publicMutationAllowed !== false || value.autoApprovalEnabled !== false
      || value.stored !== true) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_CANDIDATE_INVALID', '敏感候选内容无效', 503, { key: parsed.key });
  }
  let submission;
  try { submission = normalizeSensitiveSubmission(value.submission); }
  catch (error) {
    throw new AdminSensitiveReviewError(error?.code || 'ADMIN_SENSITIVE_CANDIDATE_INVALID', '敏感候选提交校验失败', 503, error?.details || null, error);
  }
  if (submission.groupId !== config.groupId || submission.libraryId !== config.libraryId
      || submission.idempotencyKey !== parsed.idempotencyKey
      || value.tombstoneRequested !== (submission.operation === 'delete')) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_CANDIDATE_LINK_MISMATCH', '敏感候选Key、作用域或操作不一致', 503);
  }
  return Object.freeze({ ...value, submission });
}

async function listPendingKeys(store, config) {
  if (!store || typeof store.list !== 'function') {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_BLOB_CAPABILITY_MISSING', '敏感审核需要Blob list能力', 503);
  }
  let result;
  try {
    result = await store.list({ prefix: `submissions/${config.libraryId}/pending/`, consistency: 'strong' });
  } catch (error) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_LIST_FAILED', '无法强一致读取敏感候选', 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > ADMIN_SENSITIVE_REVIEW_MAX_OBJECTS) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_OBJECT_LIMIT_EXCEEDED', '敏感候选对象超过安全上限', 409);
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_LIST_INVALID', '敏感候选列举结果无效', 503);
  }
  return keys.sort();
}

function currentRecord(snapshot, businessKey) {
  return snapshot.records.find(item => item.businessKey === businessKey) || null;
}

function assertCandidateBaseline(candidate, record) {
  const actual = record?.contentHash || null;
  if (candidate.baselineContentHash !== actual) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REVIEW_STALE_BASELINE', '公共基线已变化，敏感候选必须重新提交', 409, {
      expectedContentHash: candidate.baselineContentHash,
      actualContentHash: actual,
    });
  }
  if (candidate.submission.operation === 'delete' && !record) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_DELETE_TARGET_NOT_FOUND', '敏感删除目标已不存在', 409);
  }
  return Object.freeze({
    approvedVersion: record?.approvedVersion || 0,
    contentHash: actual,
  });
}

function projectPayload(dataType, payload) {
  if (payload === null) return null;
  if (dataType === 'rank_range_rule') return {
    rangeLabel: payload.rangeLabel, alias: payload.alias, rankType: payload.rankType,
    minStar: payload.minStar, maxStar: payload.maxStar,
    namedRanks: [...payload.namedRanks],
    prices: structuredClone(payload.prices),
  };
  if (dataType === 'surcharge_rule') return {
    name: payload.name, keywords: [...payload.keywords], prices: structuredClone(payload.prices), enabled: payload.enabled,
  };
  if (dataType === 'gift_rule') return { serviceName: payload.serviceName, mode: payload.mode, unitPrice: payload.unitPrice };
  if (dataType === 'boss_profile') return { bossName: payload.bossName, paiDan: payload.paiDan, discount: payload.discount };
  if (dataType === 'exact_price') return { serviceName: payload.serviceName, settleType: payload.settleType, unitPrice: payload.unitPrice };
  if (dataType === 'playable_name') return { name: payload.name };
  throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_DATA_TYPE_UNSUPPORTED', '敏感审核数据类型不受支持', 503);
}

function queueItem(candidateKey, candidate, resolution = null) {
  const submission = candidate.submission;
  return Object.freeze({
    reviewId: reviewIdFor(candidateKey, candidate),
    status: resolution ? 'resolved' : 'pending_review',
    action: resolution?.action || null,
    reason: candidate.reason,
    dataType: submission.dataType,
    operation: submission.operation,
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    baselineContentHash: candidate.baselineContentHash,
    tombstoneRequested: candidate.tombstoneRequested,
    receivedAt: candidate.receivedAt,
  });
}

async function readCandidateEntries(store, config, { includeResolved = false } = {}) {
  const entries = [];
  for (const key of await listPendingKeys(store, config)) {
    const parsed = parsePendingKey(key, config);
    const raw = await getJSONStrong(store, key);
    if (!raw || raw.candidateKind !== 'sensitive_review') continue;
    const candidate = assertCandidate(raw, parsed, config);
    const reviewId = reviewIdFor(key, candidate);
    const resolution = await getJSONStrong(store, resolutionKey(config, reviewId));
    if (!includeResolved && resolution) continue;
    entries.push(Object.freeze({ key, parsed, candidate, reviewId, resolution }));
  }
  return entries.sort((a, b) => a.candidate.receivedAt - b.candidate.receivedAt || a.reviewId.localeCompare(b.reviewId));
}

export async function listAdminSensitiveReviewQueue({ store, config } = {}) {
  const entries = await readCandidateEntries(store, config);
  return Object.freeze({
    schemaVersion: ADMIN_SENSITIVE_REVIEW_VERSION,
    scope: Object.freeze({ groupId: config.groupId, libraryId: config.libraryId }),
    count: entries.length,
    items: Object.freeze(entries.map(entry => queueItem(entry.key, entry.candidate))),
    capabilities: ADMIN_SENSITIVE_REVIEW_CAPABILITIES,
  });
}

async function findEntry(store, config, reviewId, includeResolved = true) {
  const normalized = normalizeReviewId(reviewId);
  const entries = await readCandidateEntries(store, config, { includeResolved });
  const found = entries.find(entry => entry.reviewId === normalized);
  if (!found) throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REVIEW_NOT_FOUND', '敏感审核项目不存在', 404);
  return found;
}

export async function getAdminSensitiveReviewDetail({ store, config, reviewId, now = Date.now() } = {}) {
  assertSafeTime(now);
  const entry = await findEntry(store, config, reviewId, true);
  const snapshot = await buildUnifiedSensitivePublicSnapshot({ store, groupId: config.groupId, libraryId: config.libraryId, now });
  const record = currentRecord(snapshot, entry.candidate.submission.businessKey);
  return Object.freeze({
    schemaVersion: ADMIN_SENSITIVE_REVIEW_VERSION,
    scope: Object.freeze({ groupId: config.groupId, libraryId: config.libraryId }),
    item: queueItem(entry.key, entry.candidate, entry.resolution),
    candidate: Object.freeze({
      dataType: entry.candidate.submission.dataType,
      operation: entry.candidate.submission.operation,
      bossId: entry.candidate.submission.bossId,
      businessKey: entry.candidate.submission.businessKey,
      contentHash: entry.candidate.submission.contentHash,
      payload: projectPayload(entry.candidate.submission.dataType, entry.candidate.submission.payload),
    }),
    baseline: record ? Object.freeze({
      approvedVersion: record.approvedVersion,
      contentHash: record.contentHash,
      dataType: record.dataType,
      bossId: record.bossId || null,
      payload: projectPayload(record.dataType, record.payload),
    }) : null,
    capabilities: ADMIN_SENSITIVE_REVIEW_CAPABILITIES,
  });
}

export function normalizeAdminSensitiveReviewCommand(action, input) {
  const normalizedAction = String(action || '').trim();
  if (!ACTIONS.has(normalizedAction)) throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_ACTION_INVALID', '敏感审核动作无效', 400);
  if (normalizedAction === 'approve') {
    assertExactKeys(input, ['reviewId', 'confirmation'], 'ADMIN_SENSITIVE_BODY_INVALID', '敏感批准请求字段无效');
    if (input.confirmation !== 'APPROVE_SENSITIVE') throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_CONFIRMATION_REQUIRED', '敏感批准缺少明确确认词', 400);
    return Object.freeze({ action: normalizedAction, reviewId: normalizeReviewId(input.reviewId), reasonCode: null, payload: null });
  }
  if (normalizedAction === 'reject') {
    assertExactKeys(input, ['reviewId', 'confirmation', 'reasonCode'], 'ADMIN_SENSITIVE_BODY_INVALID', '敏感拒绝请求字段无效');
    if (input.confirmation !== 'REJECT_SENSITIVE') throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_CONFIRMATION_REQUIRED', '敏感拒绝缺少明确确认词', 400);
    if (!REJECT_REASONS.has(input.reasonCode)) throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REJECT_REASON_INVALID', '敏感拒绝原因无效', 400);
    return Object.freeze({ action: normalizedAction, reviewId: normalizeReviewId(input.reviewId), reasonCode: input.reasonCode, payload: null });
  }
  assertExactKeys(input, ['reviewId', 'confirmation', 'payload'], 'ADMIN_SENSITIVE_BODY_INVALID', '敏感编辑后批准请求字段无效');
  if (input.confirmation !== 'EDIT_AND_APPROVE_SENSITIVE') throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_CONFIRMATION_REQUIRED', '敏感编辑后批准缺少明确确认词', 400);
  if (!isPlainObject(input.payload)) throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_EDIT_INVALID', '敏感编辑内容必须是对象', 400);
  return Object.freeze({ action: normalizedAction, reviewId: normalizeReviewId(input.reviewId), reasonCode: null, payload: input.payload });
}

function buildEditedSubmission(source, payload) {
  if (source.operation === 'delete') throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_DELETE_EDIT_FORBIDDEN', '删除候选不能编辑后批准', 400);
  let computed;
  try { computed = computeSensitiveSubmissionHashes({ ...source, payload }); }
  catch (error) {
    throw new AdminSensitiveReviewError(error?.code || 'ADMIN_SENSITIVE_EDIT_INVALID', '编辑后的敏感内容无效', 400, error?.details || null, error);
  }
  const edited = {
    ...source,
    bossId: computed.submission.bossId,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    idempotencyKey: computed.idempotencyKey,
    payload: computed.submission.payload,
  };
  let normalized;
  try { normalized = normalizeSensitiveSubmission(edited); }
  catch (error) {
    throw new AdminSensitiveReviewError(error?.code || 'ADMIN_SENSITIVE_EDIT_INVALID', '编辑后的敏感内容未通过协议校验', 400, error?.details || null, error);
  }
  if (normalized.businessKey !== source.businessKey) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_EDIT_IDENTITY_CHANGE', '编辑后批准不能改变敏感业务身份', 400);
  }
  if (normalized.contentHash === source.contentHash) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_EDIT_NO_CHANGE', '编辑后批准必须实际修改内容', 400);
  }
  return normalized;
}

function assertResolution(value, config, reviewId) {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || value.reviewId !== reviewId
      || !DECISION_ID_PATTERN.test(String(value.decisionId || ''))
      || !AUDIT_ID_PATTERN.test(String(value.auditId || ''))
      || !ACTIONS.has(value.action)
      || value.groupId !== config.groupId || value.libraryId !== config.libraryId
      || !BUSINESS_KEY_PATTERN.test(String(value.businessKey || ''))
      || !(value.targetContentHash === null || CONTENT_HASH_PATTERN.test(String(value.targetContentHash || '')))
      || !Number.isSafeInteger(value.resolvedAt) || value.resolvedAt <= 0) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_RESOLUTION_INVALID', '敏感审核归档无效', 503);
  }
  return value;
}

export async function mutateAdminSensitiveReview({
  store,
  config,
  identity,
  action,
  input,
  now = Date.now(),
} = {}) {
  assertSafeTime(now);
  const command = normalizeAdminSensitiveReviewCommand(action, input);
  const existingResolution = await getJSONStrong(store, resolutionKey(config, command.reviewId));
  const requestHash = requestHashFor(command);
  if (existingResolution) {
    const resolution = assertResolution(existingResolution, config, command.reviewId);
    const decision = await getJSONStrong(store, decisionKey(config, command.reviewId));
    if (!decision || decision.requestHash !== requestHash || decision.decisionId !== resolution.decisionId) {
      throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REVIEW_ALREADY_RESOLVED', '敏感审核项目已由不同请求处理', 409);
    }
    return Object.freeze({ schemaVersion: 1, duplicate: true, resolution, publicResult: decision.publicResult || null });
  }

  const entry = await findEntry(store, config, command.reviewId, false);
  const snapshot = await buildUnifiedSensitivePublicSnapshot({ store, groupId: config.groupId, libraryId: config.libraryId, now });
  const record = currentRecord(snapshot, entry.candidate.submission.businessKey);
  const baseline = assertCandidateBaseline(entry.candidate, record);
  const targetSubmission = command.action === 'edit_and_approve'
    ? buildEditedSubmission(entry.candidate.submission, command.payload)
    : entry.candidate.submission;
  const decisionId = decisionIdFor(command.reviewId, requestHash);
  const auditId = auditIdFor(decisionId);
  const actorTag = actorTagFor(identity);

  let publicResult = null;
  if (command.action !== 'reject') {
    publicResult = await publishSensitiveAdminApproval({
      store,
      submission: targetSubmission,
      baseline,
      reviewId: command.reviewId,
      decisionId,
      actorTag,
      edited: command.action === 'edit_and_approve',
      now,
    });
  }

  const publicProjection = publicResult ? Object.freeze({
    approvalId: publicResult.event.approvalId,
    version: publicResult.event.version,
    eventKey: publicResult.event.eventKey,
    operation: publicResult.event.operation,
    snapshotKey: publicResult.snapshotKey,
  }) : null;
  const decision = Object.freeze({
    schemaVersion: ADMIN_SENSITIVE_REVIEW_VERSION,
    decisionId,
    reviewId: command.reviewId,
    requestHash,
    action: command.action,
    actorTag,
    createdAt: now,
    groupId: config.groupId,
    libraryId: config.libraryId,
    businessKey: entry.candidate.submission.businessKey,
    sourceContentHash: entry.candidate.submission.contentHash,
    targetContentHash: command.action === 'reject' ? null : targetSubmission.contentHash,
    reasonCode: command.reasonCode,
    publicResult: publicProjection,
  });
  await putImmutableExact(store, decisionKey(config, command.reviewId), decision, 'ADMIN_SENSITIVE_DECISION_CONFLICT', '敏感审核决定发生冲突');

  const audit = Object.freeze({
    schemaVersion: ADMIN_SENSITIVE_REVIEW_VERSION,
    auditId,
    decisionId,
    reviewId: command.reviewId,
    action: command.action,
    actorTag,
    occurredAt: now,
    groupId: config.groupId,
    libraryId: config.libraryId,
    businessKey: entry.candidate.submission.businessKey,
    sourceContentHash: entry.candidate.submission.contentHash,
    targetContentHash: command.action === 'reject' ? null : targetSubmission.contentHash,
    reasonCode: command.reasonCode,
    publicVersion: publicProjection?.version || null,
  });
  await putImmutableExact(store, auditKey(auditId, now), audit, 'ADMIN_SENSITIVE_AUDIT_CONFLICT', '敏感审核审计发生冲突');

  const resolution = Object.freeze({
    schemaVersion: ADMIN_SENSITIVE_REVIEW_VERSION,
    reviewId: command.reviewId,
    decisionId,
    auditId,
    action: command.action,
    groupId: config.groupId,
    libraryId: config.libraryId,
    businessKey: entry.candidate.submission.businessKey,
    sourceContentHash: entry.candidate.submission.contentHash,
    targetContentHash: command.action === 'reject' ? null : targetSubmission.contentHash,
    resolvedAt: now,
  });
  await putImmutableExact(store, resolutionKey(config, command.reviewId), resolution, 'ADMIN_SENSITIVE_RESOLUTION_CONFLICT', '敏感审核归档发生冲突');
  await putImmutableExact(store, completionKey(config, command.reviewId), Object.freeze({
    schemaVersion: 1,
    reviewId: command.reviewId,
    decisionId,
    completedAt: now,
  }), 'ADMIN_SENSITIVE_COMPLETION_CONFLICT', '敏感审核完成标记发生冲突');

  return Object.freeze({ schemaVersion: 1, duplicate: false, resolution, publicResult: publicProjection });
}

export function isAdminSensitiveProjectionSafe(value) {
  let safe = true;
  function visit(item) {
    if (!safe || item === null || item === undefined) return;
    if (Array.isArray(item)) return item.forEach(visit);
    if (!isPlainObject(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_PROJECTION_FIELDS.has(key)) { safe = false; return; }
      visit(child);
    }
  }
  visit(value);
  return safe;
}

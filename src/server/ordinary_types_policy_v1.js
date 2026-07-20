import { createHash } from 'node:crypto';
import {
  MAX_SUBMISSION_BYTES,
  NEVER_UPLOAD_FIELDS,
  PAYLOAD_SCHEMA_VERSION,
  PROJECTION_SPEC_VERSION,
  QUEUE_SCHEMA_VERSION,
  SUBMISSION_SCHEMA_VERSION,
  SubmissionValidationError,
  assertSubmissionRequestBytes,
  buildIdempotencyKey,
  canonicalize,
  computeSubmissionHashes,
  evaluateExactPriceCandidate,
  normalizeSubmission,
} from './submission_policy_v1.js';

export const ORDINARY_TYPES_SCHEMA_VERSION = 1;
export const ORDINARY_TYPES_PREVIEW_STORE_NAME = 'cloud-collab-preview-v1';
export const ORDINARY_TYPES_ALLOWED_GROUP_ID = 'group_fixture';
export const ORDINARY_TYPES_ALLOWED_LIBRARY_ID = 'lib_receive_fixture';
export const MAX_PLAYABLE_NAME_LENGTH = 30;
export const MAX_BOSS_NAME_LENGTH = 30;
export const MAX_PAI_DAN_LENGTH = 30;
export const MIN_BOSS_DISCOUNT = 0.8;
export const MAX_BOSS_DISCOUNT = 1;
export const MAX_AUTOMATIC_DISCOUNT_DROP = 0.05;

const CROCKFORD_ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const DEVICE_ID_PATTERN = new RegExp(`^dev_${CROCKFORD_ULID}$`);
const SUBMISSION_ID_PATTERN = new RegExp(`^sub_${CROCKFORD_ULID}$`);
const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^ik_v1_[A-Za-z0-9_-]{43}$/;
const BOSS_ID_PATTERN = /^boss_v1_[A-Za-z0-9_-]{43}$/;
const APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;
const URL_PATTERN = /(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|gg|app)\b)/iu;
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/u;
const PHONE_PATTERN = /(?:\+?\d[\d\s()-]{5,}\d)/u;
const CONTACT_HANDLE_PATTERN = /(?:微信|微\s*信|wechat|(?:^|[^a-z])wx|(?:^|[^a-z])vx|v信|qq|企鹅|telegram|(?:^|[^a-z])tg|电话|手机|联系我|加我)\s*[:：_\-]?\s*[A-Za-z0-9_-]{4,}/iu;
const CLIENT_ORIGINS = new Set(['user', 'initialBinding']);
const NEW_DATA_TYPES = new Set(['playable_name', 'boss_profile']);
const EXTRA_FORBIDDEN_FIELDS = Object.freeze([
  'bossLocalId', 'localBossId', 'playableLocalId', 'sourceOrderId', 'sourceMessageId',
  'confirmedAt', 'createdAt', 'updatedAt', 'lastSeenAt', 'rawName', 'wrongName',
  'correctionContext', 'sourceText', 'sourceType', 'recentBoss', 'historyItems',
]);

export class OrdinaryTypesValidationError extends SubmissionValidationError {
  constructor(code, message, details = null) {
    super(code, message, details);
    this.name = 'OrdinaryTypesValidationError';
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message) {
  if (!isPlainObject(value)) throw new OrdinaryTypesValidationError(code, message);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new OrdinaryTypesValidationError(code, message, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function normalizeId(value, pattern, code, label) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) throw new OrdinaryTypesValidationError(code, `${label}格式无效`);
  return text;
}

function normalizePublicId(value, pattern, code, label) {
  return normalizeId(String(value || '').trim().toLowerCase(), pattern, code, label);
}

function assertNoForbiddenFields(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (NEVER_UPLOAD_FIELDS.includes(key) || EXTRA_FORBIDDEN_FIELDS.includes(key)) {
      throw new OrdinaryTypesValidationError('FORBIDDEN_FIELD', '普通共享提交包含永不上传字段', {
        path: `${path}.${key}`,
      });
    }
    assertNoForbiddenFields(item, `${path}.${key}`);
  }
}

function normalizeHumanText(value, {
  label,
  maxLength,
  allowEmpty = false,
  contactSafe = true,
} = {}) {
  let text = String(value ?? '');
  try { text = text.normalize('NFKC'); } catch (_) {}
  if (CONTROL_PATTERN.test(text)) {
    throw new OrdinaryTypesValidationError('ORDINARY_TEXT_CONTROL_CHARACTER', `${label}不能包含控制字符`);
  }
  text = text.replace(/\s+/gu, ' ').trim();
  if ((!allowEmpty && !text) || text.length > maxLength) {
    const minimum = allowEmpty ? 0 : 1;
    throw new OrdinaryTypesValidationError('ORDINARY_TEXT_LENGTH_INVALID', `${label}长度必须为${minimum}至${maxLength}个字符`);
  }
  if (contactSafe && text && (
    URL_PATTERN.test(text)
    || EMAIL_PATTERN.test(text)
    || PHONE_PATTERN.test(text)
    || CONTACT_HANDLE_PATTERN.test(text)
  )) {
    throw new OrdinaryTypesValidationError('ORDINARY_CONTACT_INFO_FORBIDDEN', `${label}不能包含链接、邮箱或联系方式`);
  }
  return text;
}

export function normalizePlayableNamePayload(value) {
  assertExactKeys(value, ['name'], 'INVALID_PLAYABLE_NAME_FIELDS', '陪玩名字字段必须严格符合白名单');
  return Object.freeze({
    name: normalizeHumanText(value.name, {
      label: '陪玩名字',
      maxLength: MAX_PLAYABLE_NAME_LENGTH,
    }),
  });
}

function normalizeDiscount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < MIN_BOSS_DISCOUNT || number > MAX_BOSS_DISCOUNT) {
    throw new OrdinaryTypesValidationError(
      'INVALID_BOSS_DISCOUNT',
      `老板折数必须在${MIN_BOSS_DISCOUNT}至${MAX_BOSS_DISCOUNT}之间`,
    );
  }
  const rounded = Math.round(number * 10_000) / 10_000;
  if (Math.abs(rounded - number) > 1e-10) {
    throw new OrdinaryTypesValidationError('INVALID_BOSS_DISCOUNT', '老板折数最多保留4位小数');
  }
  return rounded;
}

export function normalizeBossProfilePayload(value) {
  assertExactKeys(
    value,
    ['bossName', 'paiDan', 'discount'],
    'INVALID_BOSS_PROFILE_FIELDS',
    '老板资料字段必须严格符合白名单',
  );
  return Object.freeze({
    bossName: normalizeHumanText(value.bossName, {
      label: '老板名',
      maxLength: MAX_BOSS_NAME_LENGTH,
    }),
    paiDan: normalizeHumanText(value.paiDan, {
      label: '直属/派单',
      maxLength: MAX_PAI_DAN_LENGTH,
      allowEmpty: true,
    }),
    discount: normalizeDiscount(value.discount),
  });
}

export function deriveBossId(groupId, bossName) {
  const normalizedGroupId = normalizePublicId(groupId, GROUP_ID_PATTERN, 'INVALID_GROUP_ID', 'groupId');
  const normalizedBossName = normalizeHumanText(bossName, {
    label: '老板名',
    maxLength: MAX_BOSS_NAME_LENGTH,
  });
  return `boss_v1_${sha256Base64Url(canonicalize({
    schemaVersion: ORDINARY_TYPES_SCHEMA_VERSION,
    groupId: normalizedGroupId,
    normalizedBossName: normalizedBossName.toLocaleLowerCase('und'),
  }))}`;
}

function normalizeClientContext(value) {
  assertExactKeys(
    value,
    ['appVersion', 'projectionSpecVersion', 'queueSchemaVersion'],
    'INVALID_CLIENT_CONTEXT_FIELDS',
    'clientContext字段必须严格符合协议',
  );
  const appVersion = String(value.appVersion || '').trim();
  if (!APP_VERSION_PATTERN.test(appVersion) || appVersion.length > 32) {
    throw new OrdinaryTypesValidationError('INVALID_APP_VERSION', 'appVersion格式无效');
  }
  if (value.projectionSpecVersion !== PROJECTION_SPEC_VERSION) {
    throw new OrdinaryTypesValidationError('UNSUPPORTED_PROJECTION_SPEC', '投影规范版本不受支持');
  }
  if (value.queueSchemaVersion !== QUEUE_SCHEMA_VERSION) {
    throw new OrdinaryTypesValidationError('UNSUPPORTED_QUEUE_SCHEMA', '队列协议版本不受支持');
  }
  return Object.freeze({
    appVersion,
    projectionSpecVersion: PROJECTION_SPEC_VERSION,
    queueSchemaVersion: QUEUE_SCHEMA_VERSION,
  });
}

function normalizeNewTypeEnvelope(input) {
  assertNoForbiddenFields(input);
  assertSubmissionRequestBytes(input, MAX_SUBMISSION_BYTES);
  assertExactKeys(input, [
    'schemaVersion', 'payloadSchemaVersion', 'submissionId', 'deviceId',
    'groupId', 'libraryId', 'bossId', 'dataType', 'operation', 'origin',
    'clientCreatedAt', 'businessKey', 'contentHash', 'idempotencyKey',
    'payload', 'clientContext',
  ], 'INVALID_SUBMISSION_FIELDS', '普通共享提交顶层字段必须严格符合冻结协议');

  if (input.schemaVersion !== SUBMISSION_SCHEMA_VERSION) {
    throw new OrdinaryTypesValidationError('UNSUPPORTED_SUBMISSION_SCHEMA', '提交协议版本不受支持');
  }
  if (input.payloadSchemaVersion !== PAYLOAD_SCHEMA_VERSION) {
    throw new OrdinaryTypesValidationError('UNSUPPORTED_PAYLOAD_SCHEMA', '提交内容版本不受支持');
  }

  const dataType = String(input.dataType || '').trim().toLowerCase();
  if (!NEW_DATA_TYPES.has(dataType)) {
    throw new OrdinaryTypesValidationError('UNSUPPORTED_ORDINARY_DATA_TYPE', '普通共享类型只允许playable_name或boss_profile');
  }
  const operation = String(input.operation || '').trim().toLowerCase();
  if (operation !== 'upsert') {
    throw new OrdinaryTypesValidationError('SENSITIVE_OPERATION_REQUIRES_REVIEW', '删除与其他敏感操作留给阶段6人工审核');
  }
  const origin = String(input.origin || '').trim();
  if (!CLIENT_ORIGINS.has(origin)) {
    throw new OrdinaryTypesValidationError('INVALID_SUBMISSION_ORIGIN', 'origin只能是user或initialBinding');
  }
  const clientCreatedAt = Number(input.clientCreatedAt);
  if (!Number.isSafeInteger(clientCreatedAt) || clientCreatedAt < 0 || clientCreatedAt > 9_999_999_999_999) {
    throw new OrdinaryTypesValidationError('INVALID_CLIENT_CREATED_AT', 'clientCreatedAt必须是协议范围内的整数时间戳');
  }

  const groupId = normalizePublicId(input.groupId, GROUP_ID_PATTERN, 'INVALID_GROUP_ID', 'groupId');
  const libraryId = normalizePublicId(input.libraryId, LIBRARY_ID_PATTERN, 'INVALID_LIBRARY_ID', 'libraryId');
  const payload = dataType === 'playable_name'
    ? normalizePlayableNamePayload(input.payload)
    : normalizeBossProfilePayload(input.payload);

  let bossId = null;
  if (dataType === 'playable_name') {
    if (input.bossId !== null) {
      throw new OrdinaryTypesValidationError('INVALID_BOSS_SCOPE', '陪玩名字提交的bossId必须为null');
    }
  } else {
    const derived = deriveBossId(groupId, payload.bossName);
    if (input.bossId !== null && normalizeId(input.bossId, BOSS_ID_PATTERN, 'INVALID_BOSS_ID', 'bossId') !== derived) {
      throw new OrdinaryTypesValidationError('BOSS_IDENTITY_MISMATCH', 'bossId与老板名的服务器身份映射不一致');
    }
    bossId = derived;
  }

  return Object.freeze({
    schemaVersion: SUBMISSION_SCHEMA_VERSION,
    payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
    submissionId: normalizeId(input.submissionId, SUBMISSION_ID_PATTERN, 'INVALID_SUBMISSION_ID', 'submissionId'),
    deviceId: normalizeId(input.deviceId, DEVICE_ID_PATTERN, 'INVALID_DEVICE_ID', 'deviceId'),
    groupId,
    libraryId,
    bossId,
    dataType,
    operation,
    origin,
    clientCreatedAt,
    businessKey: normalizeId(input.businessKey, BUSINESS_KEY_PATTERN, 'INVALID_BUSINESS_KEY', 'businessKey'),
    contentHash: normalizeId(input.contentHash, CONTENT_HASH_PATTERN, 'INVALID_CONTENT_HASH', 'contentHash'),
    idempotencyKey: normalizeId(input.idempotencyKey, IDEMPOTENCY_KEY_PATTERN, 'INVALID_IDEMPOTENCY_KEY', 'idempotencyKey'),
    payload,
    clientContext: normalizeClientContext(input.clientContext),
  });
}

function buildPlayableNameIdentity(submission) {
  return {
    groupId: submission.groupId,
    normalizedName: submission.payload.name.toLocaleLowerCase('und'),
    dataType: 'playable_name',
  };
}

function buildBossProfileIdentity(submission) {
  return {
    groupId: submission.groupId,
    bossId: submission.bossId,
    dataType: 'boss_profile',
  };
}

function buildOrdinaryContent(submission) {
  return {
    schemaVersion: submission.schemaVersion,
    payloadSchemaVersion: submission.payloadSchemaVersion,
    groupId: submission.groupId,
    bossId: submission.bossId,
    dataType: submission.dataType,
    operation: submission.operation,
    payload: submission.payload,
  };
}

export function computeOrdinarySubmissionHashes(rawSubmission) {
  const dataType = String(rawSubmission?.dataType || '').trim().toLowerCase();
  if (dataType === 'exact_price') return computeSubmissionHashes(rawSubmission);
  const submission = normalizeNewTypeEnvelope(rawSubmission);
  const identity = submission.dataType === 'playable_name'
    ? buildPlayableNameIdentity(submission)
    : buildBossProfileIdentity(submission);
  return Object.freeze({
    submission,
    businessKey: `bk_v1_${sha256Base64Url(canonicalize(identity))}`,
    contentHash: `ch_v1_${sha256Base64Url(canonicalize(buildOrdinaryContent(submission)))}`,
    idempotencyKey: buildIdempotencyKey(submission.deviceId, submission.submissionId),
  });
}

export function normalizeOrdinarySubmission(input) {
  const dataType = String(input?.dataType || '').trim().toLowerCase();
  if (dataType === 'exact_price') return normalizeSubmission(input);
  const computed = computeOrdinarySubmissionHashes(input);
  if (computed.submission.businessKey !== computed.businessKey) {
    throw new OrdinaryTypesValidationError('BUSINESS_KEY_MISMATCH', '客户端businessKey与服务端重算结果不一致');
  }
  if (computed.submission.contentHash !== computed.contentHash) {
    throw new OrdinaryTypesValidationError('CONTENT_HASH_MISMATCH', '客户端contentHash与服务端重算结果不一致');
  }
  if (computed.submission.idempotencyKey !== computed.idempotencyKey) {
    throw new OrdinaryTypesValidationError('IDEMPOTENCY_KEY_MISMATCH', '客户端idempotencyKey与服务端重算结果不一致');
  }
  return computed.submission;
}

function normalizeExistingRecord(value, submission) {
  if (value === null || value === undefined) return null;
  assertExactKeys(
    value,
    ['businessKey', 'contentHash', 'dataType', 'bossId', 'payload'],
    'INVALID_EXISTING_RECORD',
    '公共普通记录摘要字段无效',
  );
  const dataType = String(value.dataType || '').trim().toLowerCase();
  if (dataType !== submission.dataType) {
    throw new OrdinaryTypesValidationError('EXISTING_DATA_TYPE_MISMATCH', '公共记录类型与候选类型不一致');
  }
  const businessKey = normalizeId(value.businessKey, BUSINESS_KEY_PATTERN, 'INVALID_EXISTING_RECORD', 'businessKey');
  const contentHash = normalizeId(value.contentHash, CONTENT_HASH_PATTERN, 'INVALID_EXISTING_RECORD', 'contentHash');
  if (businessKey !== submission.businessKey) {
    throw new OrdinaryTypesValidationError('EXISTING_BUSINESS_KEY_MISMATCH', '公共记录业务键与候选不一致');
  }
  if (dataType === 'playable_name') {
    if (value.bossId !== null) throw new OrdinaryTypesValidationError('INVALID_EXISTING_RECORD', '陪玩名字公共记录bossId必须为null');
    return Object.freeze({ businessKey, contentHash, dataType, bossId: null, payload: normalizePlayableNamePayload(value.payload) });
  }
  const bossId = normalizeId(value.bossId, BOSS_ID_PATTERN, 'INVALID_EXISTING_RECORD', 'bossId');
  if (bossId !== submission.bossId) {
    throw new OrdinaryTypesValidationError('EXISTING_BOSS_ID_MISMATCH', '公共老板身份与候选不一致');
  }
  return Object.freeze({ businessKey, contentHash, dataType, bossId, payload: normalizeBossProfilePayload(value.payload) });
}

function validateCounts(matchingDistinctDeviceCount, conflictingCandidateCount) {
  if (!Number.isInteger(matchingDistinctDeviceCount) || matchingDistinctDeviceCount < 1) {
    throw new OrdinaryTypesValidationError('INVALID_MATCHING_DEVICE_COUNT', 'matchingDistinctDeviceCount必须是正整数');
  }
  if (!Number.isInteger(conflictingCandidateCount) || conflictingCandidateCount < 0) {
    throw new OrdinaryTypesValidationError('INVALID_CONFLICT_COUNT', 'conflictingCandidateCount必须是非负整数');
  }
}

function decisionResult(submission, decision, reason) {
  return Object.freeze({
    decision,
    reason,
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  });
}

function confirmationDecision(submission, matchingDistinctDeviceCount, trustedDevice) {
  const eligible = matchingDistinctDeviceCount >= 2 || Boolean(trustedDevice);
  return decisionResult(
    submission,
    eligible ? 'eligible_auto_approval' : 'waiting_confirmation',
    eligible ? (trustedDevice ? 'trusted_device' : 'two_devices_match') : 'second_device_required',
  );
}

export function evaluateOrdinaryCandidate({
  submission,
  existingRecord = null,
  matchingDistinctDeviceCount = 1,
  trustedDevice = false,
  conflictingCandidateCount = 0,
} = {}) {
  const dataType = String(submission?.dataType || '').trim().toLowerCase();
  if (dataType === 'exact_price') {
    return evaluateExactPriceCandidate({
      submission,
      existingRecord,
      matchingDistinctDeviceCount,
      trustedDevice,
      conflictingCandidateCount,
    });
  }

  const normalized = normalizeOrdinarySubmission(submission);
  const existing = normalizeExistingRecord(existingRecord, normalized);
  validateCounts(matchingDistinctDeviceCount, conflictingCandidateCount);

  if (existing?.contentHash === normalized.contentHash) {
    return decisionResult(normalized, 'duplicate_noop', 'same_as_public');
  }
  if (conflictingCandidateCount > 0) {
    return decisionResult(normalized, 'pending_review', 'candidate_conflict');
  }

  if (normalized.dataType === 'playable_name') {
    if (existing) return decisionResult(normalized, 'pending_review', 'playable_name_public_conflict');
    return confirmationDecision(normalized, matchingDistinctDeviceCount, trustedDevice);
  }

  if (!existing) return confirmationDecision(normalized, matchingDistinctDeviceCount, trustedDevice);
  if (existing.payload.bossName !== normalized.payload.bossName) {
    return decisionResult(normalized, 'pending_review', 'boss_name_change_sensitive');
  }
  if (existing.payload.paiDan !== normalized.payload.paiDan) {
    return decisionResult(normalized, 'pending_review', 'boss_direct_report_change_sensitive');
  }
  if (normalized.payload.discount > existing.payload.discount) {
    return decisionResult(normalized, 'pending_review', 'boss_discount_increase_sensitive');
  }
  if (normalized.payload.discount === existing.payload.discount) {
    return decisionResult(normalized, 'duplicate_noop', 'same_as_public');
  }
  const drop = Math.round((existing.payload.discount - normalized.payload.discount) * 10_000) / 10_000;
  if (drop > MAX_AUTOMATIC_DISCOUNT_DROP) {
    return decisionResult(normalized, 'pending_review', 'boss_discount_drop_abnormal');
  }
  return confirmationDecision(normalized, matchingDistinctDeviceCount, trustedDevice);
}

export function readOrdinaryTypesPreviewConfig(env = {}) {
  if (String(env.CLOUD_ORDINARY_TYPES_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new OrdinaryTypesValidationError('ORDINARY_TYPES_PREVIEW_DISABLED', '普通共享类型预览未开启');
  }
  const storeName = String(env.CLOUD_ORDINARY_TYPES_BLOB_STORE_NAME || '').trim();
  const groupId = String(env.CLOUD_ORDINARY_TYPES_ALLOWED_GROUP_ID || '').trim().toLowerCase();
  const libraryId = String(env.CLOUD_ORDINARY_TYPES_ALLOWED_LIBRARY_ID || '').trim().toLowerCase();
  if (storeName !== ORDINARY_TYPES_PREVIEW_STORE_NAME
      || groupId !== ORDINARY_TYPES_ALLOWED_GROUP_ID
      || libraryId !== ORDINARY_TYPES_ALLOWED_LIBRARY_ID) {
    throw new OrdinaryTypesValidationError('ORDINARY_TYPES_SCOPE_INVALID', '普通共享类型只允许合成预览价格库');
  }
  return Object.freeze({
    schemaVersion: ORDINARY_TYPES_SCHEMA_VERSION,
    enabled: true,
    storeName,
    groupId,
    libraryId,
  });
}

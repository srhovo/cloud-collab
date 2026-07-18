import { createHash } from 'node:crypto';

export const SUBMISSION_SCHEMA_VERSION = 1;
export const PAYLOAD_SCHEMA_VERSION = 1;
export const PROJECTION_SPEC_VERSION = 1;
export const QUEUE_SCHEMA_VERSION = 1;
export const MAX_SUBMISSION_BYTES = 16 * 1024;
export const MAX_SERVICE_NAME_LENGTH = 50;
export const MAX_UNIT_PRICE = 1_000_000;

const CROCKFORD_ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
const DEVICE_ID_PATTERN = new RegExp(`^dev_${CROCKFORD_ULID}$`);
const SUBMISSION_ID_PATTERN = new RegExp(`^sub_${CROCKFORD_ULID}$`);
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^ik_v1_[A-Za-z0-9_-]{43}$/;
const APP_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;

export const NEVER_UPLOAD_FIELDS = Object.freeze([
  'history', 'order', 'orderContent', 'rawChat', 'originalChat', 'note', 'notes',
  'recentBosses', 'lockedFields', 'layout', 'layoutTemplates', 'customRatios',
  'usageCount', 'lastUsed', 'timestamp', 'personalSort', 'temporaryState',
  'originalNameContext', 'deviceToken', 'adminToken', 'authorization',
]);

export class SubmissionValidationError extends Error {
  constructor(code, message, details = null) {
    super(message || code || '提交校验失败');
    this.name = 'SubmissionValidationError';
    this.code = code || 'SUBMISSION_VALIDATION_ERROR';
    this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message) {
  if (!isPlainObject(value)) throw new SubmissionValidationError(code, message);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new SubmissionValidationError(code, message, { actual, expected: wanted });
  }
}

function assertNoForbiddenFields(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (NEVER_UPLOAD_FIELDS.includes(key)) {
      throw new SubmissionValidationError('FORBIDDEN_FIELD', '提交中包含永不上传字段', { path: `${path}.${key}` });
    }
    assertNoForbiddenFields(item, `${path}.${key}`);
  }
}

export function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SubmissionValidationError('INVALID_CANONICAL_NUMBER', '规范对象含无效数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (!isPlainObject(value)) throw new SubmissionValidationError('INVALID_CANONICAL_VALUE', '规范对象含不支持的值');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('base64url');
}

function normalizeId(value, pattern, code, label) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) throw new SubmissionValidationError(code, `${label}格式无效`);
  return text;
}

function normalizePublicId(value, pattern, code, label) {
  return normalizeId(String(value || '').trim().toLowerCase(), pattern, code, label);
}

function normalizeServiceName(value) {
  let text = String(value ?? '');
  try { text = text.normalize('NFKC'); } catch (_) {}
  if (/[\u0000-\u001F\u007F]/.test(text)) {
    throw new SubmissionValidationError('INVALID_SERVICE_NAME', '服务名称不能包含控制字符');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_SERVICE_NAME_LENGTH) {
    throw new SubmissionValidationError('INVALID_SERVICE_NAME', `服务名称长度必须为1至${MAX_SERVICE_NAME_LENGTH}个字符`);
  }
  return text;
}

function normalizeUnitPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_UNIT_PRICE) {
    throw new SubmissionValidationError('INVALID_UNIT_PRICE', `普通单价必须大于0且不超过${MAX_UNIT_PRICE}`);
  }
  const rounded = Math.round(number * 1000) / 1000;
  if (Math.abs(rounded - number) > 1e-9) {
    throw new SubmissionValidationError('INVALID_UNIT_PRICE', '普通单价最多保留3位小数');
  }
  return rounded;
}

export function normalizeExactPricePayload(value) {
  assertExactKeys(value, ['serviceName', 'settleType', 'unitPrice'], 'INVALID_EXACT_PRICE_FIELDS', '普通单价字段必须严格符合白名单');
  const settleType = String(value.settleType || '').trim().toLowerCase();
  if (!['round', 'hour'].includes(settleType)) {
    throw new SubmissionValidationError('INVALID_SETTLE_TYPE', '结算方式只能是round或hour');
  }
  return Object.freeze({
    serviceName: normalizeServiceName(value.serviceName),
    settleType,
    unitPrice: normalizeUnitPrice(value.unitPrice),
  });
}

function normalizeClientContext(value) {
  assertExactKeys(value, ['appVersion', 'projectionSpecVersion', 'queueSchemaVersion'], 'INVALID_CLIENT_CONTEXT_FIELDS', 'clientContext字段必须严格符合协议');
  const appVersion = String(value.appVersion || '').trim();
  if (!APP_VERSION_PATTERN.test(appVersion) || appVersion.length > 32) {
    throw new SubmissionValidationError('INVALID_APP_VERSION', 'appVersion格式无效');
  }
  if (value.projectionSpecVersion !== PROJECTION_SPEC_VERSION) {
    throw new SubmissionValidationError('UNSUPPORTED_PROJECTION_SPEC', '投影规范版本不受支持');
  }
  if (value.queueSchemaVersion !== QUEUE_SCHEMA_VERSION) {
    throw new SubmissionValidationError('UNSUPPORTED_QUEUE_SCHEMA', '队列协议版本不受支持');
  }
  return Object.freeze({
    appVersion,
    projectionSpecVersion: PROJECTION_SPEC_VERSION,
    queueSchemaVersion: QUEUE_SCHEMA_VERSION,
  });
}

export function assertSubmissionRequestBytes(rawBody, maxBytes = MAX_SUBMISSION_BYTES) {
  const text = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    throw new SubmissionValidationError('SUBMISSION_TOO_LARGE', `单次提交不得超过${maxBytes}字节`, { bytes, maxBytes });
  }
  return bytes;
}

function normalizeSubmissionEnvelope(input) {
  assertNoForbiddenFields(input);
  assertExactKeys(input, [
    'schemaVersion', 'payloadSchemaVersion', 'submissionId', 'deviceId',
    'groupId', 'libraryId', 'bossId', 'dataType', 'operation', 'origin',
    'clientCreatedAt', 'businessKey', 'contentHash', 'idempotencyKey',
    'payload', 'clientContext',
  ], 'INVALID_SUBMISSION_FIELDS', '提交顶层字段必须严格符合冻结协议');

  if (input.schemaVersion !== SUBMISSION_SCHEMA_VERSION) {
    throw new SubmissionValidationError('UNSUPPORTED_SUBMISSION_SCHEMA', '提交协议版本不受支持');
  }
  if (input.payloadSchemaVersion !== PAYLOAD_SCHEMA_VERSION) {
    throw new SubmissionValidationError('UNSUPPORTED_PAYLOAD_SCHEMA', '提交内容版本不受支持');
  }

  const dataType = String(input.dataType || '').trim().toLowerCase();
  if (dataType !== 'exact_price') {
    throw new SubmissionValidationError('UNSUPPORTED_DATA_TYPE', '阶段4A仅开放普通精确价格协议');
  }
  const operation = String(input.operation || '').trim().toLowerCase();
  if (operation !== 'upsert') {
    throw new SubmissionValidationError('SENSITIVE_OPERATION_REQUIRES_REVIEW', '删除与其他敏感操作尚未开放');
  }
  const origin = String(input.origin || '').trim();
  if (!['user', 'initialBinding'].includes(origin)) {
    throw new SubmissionValidationError('INVALID_SUBMISSION_ORIGIN', 'origin只能是user或initialBinding');
  }
  if (input.bossId !== null) {
    throw new SubmissionValidationError('INVALID_BOSS_SCOPE', '普通价格提交的bossId必须为null');
  }
  const clientCreatedAt = Number(input.clientCreatedAt);
  if (!Number.isSafeInteger(clientCreatedAt) || clientCreatedAt < 0 || clientCreatedAt > 9_999_999_999_999) {
    throw new SubmissionValidationError('INVALID_CLIENT_CREATED_AT', 'clientCreatedAt必须是协议范围内的整数时间戳');
  }

  return Object.freeze({
    schemaVersion: SUBMISSION_SCHEMA_VERSION,
    payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
    submissionId: normalizeId(input.submissionId, SUBMISSION_ID_PATTERN, 'INVALID_SUBMISSION_ID', 'submissionId'),
    deviceId: normalizeId(input.deviceId, DEVICE_ID_PATTERN, 'INVALID_DEVICE_ID', 'deviceId'),
    groupId: normalizePublicId(input.groupId, GROUP_ID_PATTERN, 'INVALID_GROUP_ID', 'groupId'),
    libraryId: normalizePublicId(input.libraryId, LIBRARY_ID_PATTERN, 'INVALID_LIBRARY_ID', 'libraryId'),
    bossId: null,
    dataType,
    operation,
    origin,
    clientCreatedAt,
    businessKey: normalizeId(input.businessKey, BUSINESS_KEY_PATTERN, 'INVALID_BUSINESS_KEY', 'businessKey'),
    contentHash: normalizeId(input.contentHash, CONTENT_HASH_PATTERN, 'INVALID_CONTENT_HASH', 'contentHash'),
    idempotencyKey: normalizeId(input.idempotencyKey, IDEMPOTENCY_KEY_PATTERN, 'INVALID_IDEMPOTENCY_KEY', 'idempotencyKey'),
    payload: normalizeExactPricePayload(input.payload),
    clientContext: normalizeClientContext(input.clientContext),
  });
}

function buildExactPriceIdentity(submission) {
  return {
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    normalizedServiceName: submission.payload.serviceName.toLowerCase(),
    settleType: submission.payload.settleType,
    ruleType: 'exact',
    variant: 'standard',
  };
}

function buildExactPriceContent(submission) {
  return {
    schemaVersion: submission.schemaVersion,
    payloadSchemaVersion: submission.payloadSchemaVersion,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    bossId: submission.bossId,
    dataType: submission.dataType,
    operation: submission.operation,
    payload: submission.payload,
  };
}

export function buildIdempotencyKey(deviceId, submissionId) {
  const normalizedDeviceId = normalizeId(deviceId, DEVICE_ID_PATTERN, 'INVALID_DEVICE_ID', 'deviceId');
  const normalizedSubmissionId = normalizeId(submissionId, SUBMISSION_ID_PATTERN, 'INVALID_SUBMISSION_ID', 'submissionId');
  return `ik_v1_${sha256Base64Url(canonicalize({
    schemaVersion: SUBMISSION_SCHEMA_VERSION,
    deviceId: normalizedDeviceId,
    submissionId: normalizedSubmissionId,
  }))}`;
}

export function computeSubmissionHashes(rawSubmission) {
  const submission = normalizeSubmissionEnvelope(rawSubmission);
  const businessKey = `bk_v1_${sha256Base64Url(canonicalize(buildExactPriceIdentity(submission)))}`;
  const contentHash = `ch_v1_${sha256Base64Url(canonicalize(buildExactPriceContent(submission)))}`;
  const idempotencyKey = buildIdempotencyKey(submission.deviceId, submission.submissionId);
  return Object.freeze({ submission, businessKey, contentHash, idempotencyKey });
}

export function normalizeSubmission(input) {
  assertSubmissionRequestBytes(input);
  const computed = computeSubmissionHashes(input);
  if (computed.submission.businessKey !== computed.businessKey) {
    throw new SubmissionValidationError('BUSINESS_KEY_MISMATCH', '客户端businessKey与服务端重算结果不一致');
  }
  if (computed.submission.contentHash !== computed.contentHash) {
    throw new SubmissionValidationError('CONTENT_HASH_MISMATCH', '客户端contentHash与服务端重算结果不一致');
  }
  if (computed.submission.idempotencyKey !== computed.idempotencyKey) {
    throw new SubmissionValidationError('IDEMPOTENCY_KEY_MISMATCH', '客户端idempotencyKey与服务端重算结果不一致');
  }
  return computed.submission;
}

function normalizeExistingRecord(value) {
  if (value === null || value === undefined) return null;
  assertExactKeys(value, ['businessKey', 'contentHash'], 'INVALID_EXISTING_RECORD', '正式记录摘要字段无效');
  return {
    businessKey: normalizeId(value.businessKey, BUSINESS_KEY_PATTERN, 'INVALID_EXISTING_RECORD', 'businessKey'),
    contentHash: normalizeId(value.contentHash, CONTENT_HASH_PATTERN, 'INVALID_EXISTING_RECORD', 'contentHash'),
  };
}

export function evaluateExactPriceCandidate({
  submission,
  existingRecord = null,
  matchingDistinctDeviceCount = 1,
  trustedDevice = false,
  conflictingCandidateCount = 0,
} = {}) {
  const normalized = normalizeSubmission(submission);
  const existing = normalizeExistingRecord(existingRecord);
  if (!Number.isInteger(matchingDistinctDeviceCount) || matchingDistinctDeviceCount < 1) {
    throw new SubmissionValidationError('INVALID_MATCHING_DEVICE_COUNT', 'matchingDistinctDeviceCount必须是正整数');
  }
  if (!Number.isInteger(conflictingCandidateCount) || conflictingCandidateCount < 0) {
    throw new SubmissionValidationError('INVALID_CONFLICT_COUNT', 'conflictingCandidateCount必须是非负整数');
  }

  if (existing?.contentHash === normalized.contentHash) {
    return Object.freeze({
      decision: 'duplicate_noop',
      reason: 'same_as_public',
      businessKey: normalized.businessKey,
      contentHash: normalized.contentHash,
      publicMutationAllowed: false,
      autoApprovalEnabled: false,
    });
  }

  if (conflictingCandidateCount > 0 || (existing && existing.contentHash !== normalized.contentHash)) {
    return Object.freeze({
      decision: 'pending_review',
      reason: conflictingCandidateCount > 0 ? 'candidate_conflict' : 'public_value_conflict',
      businessKey: normalized.businessKey,
      contentHash: normalized.contentHash,
      publicMutationAllowed: false,
      autoApprovalEnabled: false,
    });
  }

  const independentlyConfirmed = matchingDistinctDeviceCount >= 2;
  const eligibleForAutomaticApproval = independentlyConfirmed || Boolean(trustedDevice);
  return Object.freeze({
    decision: eligibleForAutomaticApproval ? 'eligible_auto_approval' : 'waiting_confirmation',
    reason: eligibleForAutomaticApproval
      ? (trustedDevice ? 'trusted_device' : 'two_devices_match')
      : 'second_device_required',
    businessKey: normalized.businessKey,
    contentHash: normalized.contentHash,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  });
}

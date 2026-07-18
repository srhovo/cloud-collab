import { createHash } from 'node:crypto';

export const SUBMISSION_SCHEMA_VERSION = 1;
export const PAYLOAD_SCHEMA_VERSION = 1;
export const MAX_SUBMISSION_BYTES = 64 * 1024;
export const MAX_SERVICE_NAME_LENGTH = 50;
export const MAX_UNIT_PRICE = 1_000_000;

const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_-]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_-]{2,53}$/;
const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{16,80}$/;
const SUBMISSION_ID_PATTERN = /^sub_[A-Za-z0-9_-]{20,80}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;

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
  return {
    serviceName: normalizeServiceName(value.serviceName),
    settleType,
    unitPrice: normalizeUnitPrice(value.unitPrice),
  };
}

export function assertSubmissionRequestBytes(rawBody, maxBytes = MAX_SUBMISSION_BYTES) {
  const bytes = Buffer.byteLength(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8');
  if (bytes > maxBytes) {
    throw new SubmissionValidationError('SUBMISSION_TOO_LARGE', `单次提交不得超过${maxBytes}字节`, { bytes, maxBytes });
  }
  return bytes;
}

export function normalizeSubmission(input) {
  assertExactKeys(input, [
    'schemaVersion', 'submissionId', 'deviceId', 'groupId', 'libraryId',
    'dataType', 'operation', 'basePublicVersion', 'clientCreatedAt', 'payload',
  ], 'INVALID_SUBMISSION_FIELDS', '提交顶层字段必须严格符合白名单');

  if (input.schemaVersion !== SUBMISSION_SCHEMA_VERSION) {
    throw new SubmissionValidationError('UNSUPPORTED_SUBMISSION_SCHEMA', '提交协议版本不受支持');
  }
  const dataType = String(input.dataType || '').trim().toLowerCase();
  if (dataType !== 'exact_price') {
    throw new SubmissionValidationError('UNSUPPORTED_DATA_TYPE', '阶段4A仅开放普通精确价格协议');
  }
  const operation = String(input.operation || '').trim().toLowerCase();
  if (operation !== 'upsert') {
    throw new SubmissionValidationError('SENSITIVE_OPERATION_REQUIRES_REVIEW', '删除与其他敏感操作尚未开放');
  }
  const basePublicVersion = Number(input.basePublicVersion);
  if (!Number.isInteger(basePublicVersion) || basePublicVersion < 0) {
    throw new SubmissionValidationError('INVALID_BASE_PUBLIC_VERSION', 'basePublicVersion必须是非负整数');
  }
  const clientCreatedAt = Number(input.clientCreatedAt);
  if (!Number.isSafeInteger(clientCreatedAt) || clientCreatedAt <= 0) {
    throw new SubmissionValidationError('INVALID_CLIENT_CREATED_AT', 'clientCreatedAt必须是正整数时间戳');
  }

  return Object.freeze({
    schemaVersion: SUBMISSION_SCHEMA_VERSION,
    submissionId: normalizeId(input.submissionId, SUBMISSION_ID_PATTERN, 'INVALID_SUBMISSION_ID', 'submissionId'),
    deviceId: normalizeId(input.deviceId, DEVICE_ID_PATTERN, 'INVALID_DEVICE_ID', 'deviceId'),
    groupId: normalizePublicId(input.groupId, GROUP_ID_PATTERN, 'INVALID_GROUP_ID', 'groupId'),
    libraryId: normalizePublicId(input.libraryId, LIBRARY_ID_PATTERN, 'INVALID_LIBRARY_ID', 'libraryId'),
    dataType,
    operation,
    basePublicVersion,
    clientCreatedAt,
    payload: Object.freeze(normalizeExactPricePayload(input.payload)),
  });
}

function buildExactPriceIdentity(submission) {
  return {
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    normalizedServiceName: submission.payload.serviceName.toLowerCase(),
    ruleType: 'exact',
    settleType: submission.payload.settleType,
    variant: 'standard',
  };
}

function buildExactPriceContent(submission) {
  return {
    schemaVersion: SUBMISSION_SCHEMA_VERSION,
    payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    bossId: null,
    dataType: submission.dataType,
    operation: submission.operation,
    payload: submission.payload,
  };
}

export function computeSubmissionHashes(rawSubmission) {
  const submission = normalizeSubmission(rawSubmission);
  const businessKey = `bk_v1_${sha256Base64Url(canonicalize(buildExactPriceIdentity(submission)))}`;
  const contentHash = `ch_v1_${sha256Base64Url(canonicalize(buildExactPriceContent(submission)))}`;
  return Object.freeze({ submission, businessKey, contentHash });
}

export function buildIdempotencyKey(deviceId, submissionId) {
  const normalizedDeviceId = normalizeId(deviceId, DEVICE_ID_PATTERN, 'INVALID_DEVICE_ID', 'deviceId');
  const normalizedSubmissionId = normalizeId(submissionId, SUBMISSION_ID_PATTERN, 'INVALID_SUBMISSION_ID', 'submissionId');
  return `idem_v1_${sha256Base64Url(`${normalizedDeviceId}\u0000${normalizedSubmissionId}`)}`;
}

function normalizeExistingRecord(value) {
  if (value === null || value === undefined) return null;
  assertExactKeys(value, ['businessKey', 'contentHash', 'unitPrice'], 'INVALID_EXISTING_RECORD', '正式记录摘要字段无效');
  if (!BUSINESS_KEY_PATTERN.test(value.businessKey) || !CONTENT_HASH_PATTERN.test(value.contentHash)) {
    throw new SubmissionValidationError('INVALID_EXISTING_RECORD', '正式记录摘要Hash无效');
  }
  return { businessKey: value.businessKey, contentHash: value.contentHash, unitPrice: normalizeUnitPrice(value.unitPrice) };
}

export function evaluateExactPriceCandidate({
  submission,
  existingRecord = null,
  matchingDeviceCount = 1,
  trustedDevice = false,
  conflictingCandidateCount = 0,
} = {}) {
  const computed = computeSubmissionHashes(submission);
  const existing = normalizeExistingRecord(existingRecord);
  if (!Number.isInteger(matchingDeviceCount) || matchingDeviceCount < 1) {
    throw new SubmissionValidationError('INVALID_MATCHING_DEVICE_COUNT', 'matchingDeviceCount必须是正整数');
  }
  if (!Number.isInteger(conflictingCandidateCount) || conflictingCandidateCount < 0) {
    throw new SubmissionValidationError('INVALID_CONFLICT_COUNT', 'conflictingCandidateCount必须是非负整数');
  }

  if (existing?.contentHash === computed.contentHash) {
    return Object.freeze({
      decision: 'duplicate_noop',
      reason: 'same_as_public',
      businessKey: computed.businessKey,
      contentHash: computed.contentHash,
      publicMutationAllowed: false,
    });
  }

  if (conflictingCandidateCount > 0 || (existing && existing.businessKey !== computed.businessKey)) {
    return Object.freeze({
      decision: 'pending_review',
      reason: 'conflict_detected',
      businessKey: computed.businessKey,
      contentHash: computed.contentHash,
      publicMutationAllowed: false,
    });
  }

  let changeRatio = null;
  if (existing) {
    changeRatio = Math.abs(computed.submission.payload.unitPrice - existing.unitPrice) / existing.unitPrice;
    if (changeRatio > 0.10 + 1e-12) {
      return Object.freeze({
        decision: 'pending_review',
        reason: 'price_change_over_10_percent',
        changeRatio,
        businessKey: computed.businessKey,
        contentHash: computed.contentHash,
        publicMutationAllowed: false,
      });
    }
  }

  const independentlyConfirmed = matchingDeviceCount >= 2;
  const eligibleForAutomaticApproval = independentlyConfirmed || Boolean(trustedDevice);
  return Object.freeze({
    decision: eligibleForAutomaticApproval ? 'eligible_auto_approval' : 'waiting_confirmation',
    reason: eligibleForAutomaticApproval
      ? (trustedDevice ? 'trusted_device' : 'two_devices_match')
      : 'second_device_required',
    changeRatio,
    businessKey: computed.businessKey,
    contentHash: computed.contentHash,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  });
}

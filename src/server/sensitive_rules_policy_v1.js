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
  normalizeExactPricePayload,
} from './submission_policy_v1.js';
import {
  MAX_AUTOMATIC_DISCOUNT_DROP,
  computeOrdinarySubmissionHashes,
  evaluateOrdinaryCandidate,
  normalizeBossProfilePayload,
  normalizeOrdinarySubmission,
  normalizePlayableNamePayload,
} from './ordinary_types_policy_v1.js';

export const SENSITIVE_RULES_SCHEMA_VERSION = 1;
export const SENSITIVE_RULES_PREVIEW_STORE_NAME = 'cloud-collab-preview-v1';
export const SENSITIVE_RULES_ALLOWED_GROUP_ID = 'group_fixture';
export const SENSITIVE_RULES_ALLOWED_LIBRARY_ID = 'lib_receive_fixture';
export const MAX_RULE_TEXT_LENGTH = 60;
export const MAX_RANGE_LABEL_LENGTH = 24;
export const MAX_RANGE_ALIAS_LENGTH = 24;
export const MAX_SURCHARGE_NAME_LENGTH = 24;
export const MAX_SURCHARGE_KEYWORDS = 12;
export const MAX_NAMED_RANKS = 20;
export const MAX_RULE_PRICE = 1_000_000;
export const MAX_STAR_VALUE = 100_000;

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
const CONTACT_PATTERN = /(?:https?:\/\/|www\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}|(?:\+?\d[\d\s()-]{5,}\d)|(?:微信|微\s*信|wechat|(?:^|[^a-z])wx|(?:^|[^a-z])vx|v信|qq|企鹅|telegram|(?:^|[^a-z])tg|电话|手机|联系我|加我)\s*[:：_\-]?\s*[A-Za-z0-9_-]{4,})/iu;

const CLIENT_ORIGINS = new Set(['user', 'initialBinding']);
const RULE_UPSERT_TYPES = new Set(['rank_range_rule', 'surcharge_rule', 'gift_rule']);
const DELETE_TYPES = new Set([
  'exact_price',
  'playable_name',
  'boss_profile',
  'rank_range_rule',
  'surcharge_rule',
  'gift_rule',
]);
const BOSS_SENSITIVE_REASONS = new Set([
  'boss_name_change_sensitive',
  'boss_direct_report_change_sensitive',
  'boss_discount_increase_sensitive',
  'boss_discount_drop_abnormal',
]);
const EXTRA_FORBIDDEN_FIELDS = Object.freeze([
  'id', 'ruleId', 'localRuleId', 'serviceKey', 'bossLocalId', 'localBossId',
  'sourceOrderId', 'sourceMessageId', 'sourceText', 'sourceType', 'sourceContext',
  'createdAt', 'updatedAt', 'lastUsed', 'confirmedAt', 'deletedAt',
  'usageCount', 'sortIndex', 'displayOrder', 'recentBoss', 'historyItems',
  'backupMeta', 'undoSnapshot', 'migrationId', 'importId',
]);

export class SensitiveRulesValidationError extends SubmissionValidationError {
  constructor(code, message, details = null) {
    super(code, message, details);
    this.name = 'SensitiveRulesValidationError';
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message) {
  if (!isPlainObject(value)) throw new SensitiveRulesValidationError(code, message);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new SensitiveRulesValidationError(code, message, { actual, expected: wanted });
  }
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function normalizeId(value, pattern, code, label) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) throw new SensitiveRulesValidationError(code, `${label}格式无效`);
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
      throw new SensitiveRulesValidationError('FORBIDDEN_FIELD', '敏感规则提交包含永不上传字段', {
        path: `${path}.${key}`,
      });
    }
    assertNoForbiddenFields(item, `${path}.${key}`);
  }
}

function normalizeHumanText(value, {
  label,
  maxLength = MAX_RULE_TEXT_LENGTH,
  allowEmpty = false,
  lowerCase = false,
} = {}) {
  let text = String(value ?? '');
  try { text = text.normalize('NFKC'); } catch (_) {}
  if (CONTROL_PATTERN.test(text)) {
    throw new SensitiveRulesValidationError('SENSITIVE_TEXT_CONTROL_CHARACTER', `${label}不能包含控制字符`);
  }
  text = text.replace(/[\s　]+/gu, ' ').trim();
  if ((!allowEmpty && !text) || text.length > maxLength) {
    throw new SensitiveRulesValidationError(
      'SENSITIVE_TEXT_LENGTH_INVALID',
      `${label}长度必须为${allowEmpty ? 0 : 1}至${maxLength}个字符`,
    );
  }
  if (text && CONTACT_PATTERN.test(text)) {
    throw new SensitiveRulesValidationError('SENSITIVE_CONTACT_INFO_FORBIDDEN', `${label}不能包含链接、邮箱或联系方式`);
  }
  return lowerCase ? text.toLocaleLowerCase('und') : text;
}

function normalizePrice(value, label, { allowNull = true } = {}) {
  if (value === null && allowNull) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_RULE_PRICE) {
    throw new SensitiveRulesValidationError('INVALID_SENSITIVE_RULE_PRICE', `${label}必须大于0且不超过${MAX_RULE_PRICE}`);
  }
  const rounded = Math.round(number * 1000) / 1000;
  if (Math.abs(rounded - number) > 1e-9) {
    throw new SensitiveRulesValidationError('INVALID_SENSITIVE_RULE_PRICE', `${label}最多保留3位小数`);
  }
  return rounded;
}

function normalizePricePair(value, label) {
  assertExactKeys(value, ['round', 'hour'], 'INVALID_SENSITIVE_PRICE_FIELDS', `${label}价格字段必须严格为round/hour`);
  return Object.freeze({
    round: normalizePrice(value.round, `${label}局数价格`),
    hour: normalizePrice(value.hour, `${label}小时价格`),
  });
}

function hasAnyPrice(value) {
  return Object.values(value).some(item => {
    if (isPlainObject(item)) return Object.values(item).some(price => price !== null);
    return item !== null;
  });
}

function normalizeVariantPrices(value) {
  assertExactKeys(
    value,
    ['normal', 'carry', 'starGuarantee'],
    'INVALID_RANGE_PRICE_VARIANTS',
    '区间规则价格必须严格包含normal/carry/starGuarantee',
  );
  const prices = Object.freeze({
    normal: normalizePricePair(value.normal, '普排'),
    carry: normalizePricePair(value.carry, '包C'),
    starGuarantee: normalizePricePair(value.starGuarantee, '包星'),
  });
  if (!hasAnyPrice(prices)) {
    throw new SensitiveRulesValidationError('RANGE_PRICE_REQUIRED', '区间规则至少需要一个有效价格');
  }
  return prices;
}

function normalizeNamedRanks(value) {
  if (!Array.isArray(value) || value.length > MAX_NAMED_RANKS) {
    throw new SensitiveRulesValidationError('INVALID_NAMED_RANKS', `命名段位必须是最多${MAX_NAMED_RANKS}项的数组`);
  }
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const rank = normalizeHumanText(item, { label: '命名段位', maxLength: 24 });
    const key = rank.toLocaleLowerCase('und');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(rank);
  }
  return Object.freeze(result);
}

export function normalizeRankRangeRulePayload(value) {
  assertExactKeys(
    value,
    ['rangeLabel', 'alias', 'rankType', 'minStar', 'maxStar', 'namedRanks', 'prices'],
    'INVALID_RANK_RANGE_RULE_FIELDS',
    '区间规则字段必须严格符合白名单',
  );
  const rangeLabel = normalizeHumanText(value.rangeLabel, {
    label: '区间名称',
    maxLength: MAX_RANGE_LABEL_LENGTH,
  });
  const alias = normalizeHumanText(value.alias, {
    label: '区间别名',
    maxLength: MAX_RANGE_ALIAS_LENGTH,
    allowEmpty: true,
  });
  const rankType = String(value.rankType || '').trim();
  if (!['star', 'namedTier', 'lowerTier'].includes(rankType)) {
    throw new SensitiveRulesValidationError('INVALID_RANK_TYPE', 'rankType只能是star、namedTier或lowerTier');
  }
  let minStar = null;
  let maxStar = null;
  let namedRanks = Object.freeze([]);
  if (rankType === 'star') {
    minStar = Number(value.minStar);
    maxStar = Number(value.maxStar);
    if (!Number.isInteger(minStar) || !Number.isInteger(maxStar)
        || minStar < 0 || maxStar < minStar || maxStar > MAX_STAR_VALUE) {
      throw new SensitiveRulesValidationError('INVALID_STAR_RANGE', '星数区间必须是有效的非负整数范围');
    }
    if (!Array.isArray(value.namedRanks) || value.namedRanks.length !== 0) {
      throw new SensitiveRulesValidationError('INVALID_STAR_NAMED_RANKS', '星数区间的namedRanks必须为空数组');
    }
  } else {
    if (value.minStar !== null || value.maxStar !== null) {
      throw new SensitiveRulesValidationError('INVALID_NAMED_STAR_RANGE', '名称段位规则的minStar和maxStar必须为null');
    }
    namedRanks = normalizeNamedRanks(value.namedRanks);
    if (!namedRanks.length) {
      throw new SensitiveRulesValidationError('NAMED_RANK_REQUIRED', '名称段位规则至少需要一个段位');
    }
  }
  return Object.freeze({
    rangeLabel,
    alias,
    rankType,
    minStar,
    maxStar,
    namedRanks,
    prices: normalizeVariantPrices(value.prices),
  });
}

function normalizeKeywordList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SURCHARGE_KEYWORDS) {
    throw new SensitiveRulesValidationError('INVALID_SURCHARGE_KEYWORDS', `加价关键词必须是1至${MAX_SURCHARGE_KEYWORDS}项的数组`);
  }
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const keyword = normalizeHumanText(item, { label: '加价关键词', maxLength: 24 });
    const key = keyword.toLocaleLowerCase('und');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
  }
  if (!result.length) throw new SensitiveRulesValidationError('INVALID_SURCHARGE_KEYWORDS', '加价关键词不能为空');
  return Object.freeze(result);
}

export function normalizeSurchargeRulePayload(value) {
  assertExactKeys(
    value,
    ['name', 'keywords', 'prices', 'enabled'],
    'INVALID_SURCHARGE_RULE_FIELDS',
    '加价规则字段必须严格符合白名单',
  );
  if (typeof value.enabled !== 'boolean') {
    throw new SensitiveRulesValidationError('INVALID_SURCHARGE_ENABLED', 'enabled必须是布尔值');
  }
  const prices = normalizePricePair(value.prices, '加价');
  if (!hasAnyPrice(prices)) {
    throw new SensitiveRulesValidationError('SURCHARGE_PRICE_REQUIRED', '加价规则至少需要一个有效价格');
  }
  return Object.freeze({
    name: normalizeHumanText(value.name, { label: '加价规则名称', maxLength: MAX_SURCHARGE_NAME_LENGTH }),
    keywords: normalizeKeywordList(value.keywords),
    prices,
    enabled: value.enabled,
  });
}

export function normalizeGiftRulePayload(value) {
  assertExactKeys(
    value,
    ['serviceName', 'mode', 'unitPrice'],
    'INVALID_GIFT_RULE_FIELDS',
    '礼物规则字段必须严格符合白名单',
  );
  const mode = String(value.mode || '').trim().toLowerCase();
  if (!['fixed', 'variable'].includes(mode)) {
    throw new SensitiveRulesValidationError('INVALID_GIFT_MODE', '礼物金额模式只能是fixed或variable');
  }
  if (mode === 'variable' && value.unitPrice !== null) {
    throw new SensitiveRulesValidationError('VARIABLE_GIFT_PRICE_MUST_BE_NULL', '随机金额礼物的unitPrice必须为null');
  }
  return Object.freeze({
    serviceName: normalizeHumanText(value.serviceName, { label: '礼物名称', maxLength: 60 }),
    mode,
    unitPrice: mode === 'fixed' ? normalizePrice(value.unitPrice, '礼物固定金额', { allowNull: false }) : null,
  });
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
    throw new SensitiveRulesValidationError('INVALID_APP_VERSION', 'appVersion格式无效');
  }
  if (value.projectionSpecVersion !== PROJECTION_SPEC_VERSION) {
    throw new SensitiveRulesValidationError('UNSUPPORTED_PROJECTION_SPEC', '投影规范版本不受支持');
  }
  if (value.queueSchemaVersion !== QUEUE_SCHEMA_VERSION) {
    throw new SensitiveRulesValidationError('UNSUPPORTED_QUEUE_SCHEMA', '队列协议版本不受支持');
  }
  return Object.freeze({
    appVersion,
    projectionSpecVersion: PROJECTION_SPEC_VERSION,
    queueSchemaVersion: QUEUE_SCHEMA_VERSION,
  });
}

function normalizeRulePayload(dataType, payload) {
  if (dataType === 'rank_range_rule') return normalizeRankRangeRulePayload(payload);
  if (dataType === 'surcharge_rule') return normalizeSurchargeRulePayload(payload);
  if (dataType === 'gift_rule') return normalizeGiftRulePayload(payload);
  throw new SensitiveRulesValidationError('UNSUPPORTED_SENSITIVE_DATA_TYPE', '敏感规则类型不受支持');
}

function normalizeCustomEnvelope(input) {
  assertNoForbiddenFields(input);
  assertSubmissionRequestBytes(input, MAX_SUBMISSION_BYTES);
  assertExactKeys(input, [
    'schemaVersion', 'payloadSchemaVersion', 'submissionId', 'deviceId',
    'groupId', 'libraryId', 'bossId', 'dataType', 'operation', 'origin',
    'clientCreatedAt', 'businessKey', 'contentHash', 'idempotencyKey',
    'payload', 'clientContext',
  ], 'INVALID_SUBMISSION_FIELDS', '敏感规则提交顶层字段必须严格符合冻结协议');

  if (input.schemaVersion !== SUBMISSION_SCHEMA_VERSION) {
    throw new SensitiveRulesValidationError('UNSUPPORTED_SUBMISSION_SCHEMA', '提交协议版本不受支持');
  }
  if (input.payloadSchemaVersion !== PAYLOAD_SCHEMA_VERSION) {
    throw new SensitiveRulesValidationError('UNSUPPORTED_PAYLOAD_SCHEMA', '提交内容版本不受支持');
  }

  const dataType = String(input.dataType || '').trim().toLowerCase();
  const operation = String(input.operation || '').trim().toLowerCase();
  if (!['upsert', 'delete'].includes(operation)) {
    throw new SensitiveRulesValidationError('UNSUPPORTED_SENSITIVE_OPERATION', '敏感规则操作只能是upsert或delete');
  }
  if (operation === 'upsert' && !RULE_UPSERT_TYPES.has(dataType)) {
    throw new SensitiveRulesValidationError('UNSUPPORTED_SENSITIVE_DATA_TYPE', '阶段6A规则upsert只允许区间、加价或礼物规则');
  }
  if (operation === 'delete' && !DELETE_TYPES.has(dataType)) {
    throw new SensitiveRulesValidationError('UNSUPPORTED_DELETE_DATA_TYPE', '显式删除目标类型不受支持');
  }
  const origin = String(input.origin || '').trim();
  if (!CLIENT_ORIGINS.has(origin)) {
    throw new SensitiveRulesValidationError('INVALID_SUBMISSION_ORIGIN', 'origin只能是user或initialBinding');
  }
  const clientCreatedAt = Number(input.clientCreatedAt);
  if (!Number.isSafeInteger(clientCreatedAt) || clientCreatedAt < 0 || clientCreatedAt > 9_999_999_999_999) {
    throw new SensitiveRulesValidationError('INVALID_CLIENT_CREATED_AT', 'clientCreatedAt必须是协议范围内的整数时间戳');
  }

  const bossId = dataType === 'boss_profile'
    ? normalizeId(input.bossId, BOSS_ID_PATTERN, 'INVALID_BOSS_ID', 'bossId')
    : (() => {
        if (input.bossId !== null) throw new SensitiveRulesValidationError('INVALID_BOSS_SCOPE', '非老板敏感提交的bossId必须为null');
        return null;
      })();

  let payload = null;
  if (operation === 'delete') {
    if (input.payload !== null) {
      throw new SensitiveRulesValidationError('DELETE_PAYLOAD_MUST_BE_NULL', '显式删除的payload必须为null');
    }
  } else {
    payload = normalizeRulePayload(dataType, input.payload);
  }

  return Object.freeze({
    schemaVersion: SUBMISSION_SCHEMA_VERSION,
    payloadSchemaVersion: PAYLOAD_SCHEMA_VERSION,
    submissionId: normalizeId(input.submissionId, SUBMISSION_ID_PATTERN, 'INVALID_SUBMISSION_ID', 'submissionId'),
    deviceId: normalizeId(input.deviceId, DEVICE_ID_PATTERN, 'INVALID_DEVICE_ID', 'deviceId'),
    groupId: normalizePublicId(input.groupId, GROUP_ID_PATTERN, 'INVALID_GROUP_ID', 'groupId'),
    libraryId: normalizePublicId(input.libraryId, LIBRARY_ID_PATTERN, 'INVALID_LIBRARY_ID', 'libraryId'),
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

function buildRuleIdentity(submission) {
  if (submission.dataType === 'rank_range_rule') {
    const boundary = submission.payload.rankType === 'star'
      ? `${submission.payload.minStar}-${submission.payload.maxStar}`
      : [...submission.payload.namedRanks]
        .map(item => item.toLocaleLowerCase('und'))
        .sort()
        .join('|');
    return {
      groupId: submission.groupId,
      libraryId: submission.libraryId,
      dataType: submission.dataType,
      rankType: submission.payload.rankType,
      boundary,
      rangeLabel: submission.payload.rangeLabel.toLocaleLowerCase('und'),
    };
  }
  if (submission.dataType === 'surcharge_rule') {
    return {
      groupId: submission.groupId,
      libraryId: submission.libraryId,
      dataType: submission.dataType,
      name: submission.payload.name.toLocaleLowerCase('und'),
      keywords: [...submission.payload.keywords]
        .map(item => item.toLocaleLowerCase('und'))
        .sort(),
    };
  }
  return {
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    dataType: submission.dataType,
    serviceName: submission.payload.serviceName.toLocaleLowerCase('und'),
  };
}

function buildSensitiveContent(submission) {
  return {
    schemaVersion: submission.schemaVersion,
    payloadSchemaVersion: submission.payloadSchemaVersion,
    groupId: submission.groupId,
    libraryId: submission.libraryId,
    bossId: submission.bossId,
    dataType: submission.dataType,
    operation: submission.operation,
    businessKey: submission.operation === 'delete' ? submission.businessKey : null,
    payload: submission.payload,
  };
}

export function buildSensitiveSubmissionRequestHash(submission) {
  return `req_v1_${sha256Base64Url(canonicalize(submission))}`;
}

export function computeSensitiveSubmissionHashes(rawSubmission) {
  const dataType = String(rawSubmission?.dataType || '').trim().toLowerCase();
  const operation = String(rawSubmission?.operation || '').trim().toLowerCase();
  if (dataType === 'boss_profile' && operation === 'upsert') {
    const computed = computeOrdinarySubmissionHashes(rawSubmission);
    return Object.freeze({
      ...computed,
      businessKeyRequiresExistingVerification: false,
      protocolClass: 'boss_sensitive_upsert',
    });
  }
  const submission = normalizeCustomEnvelope(rawSubmission);
  const businessKey = submission.operation === 'delete'
    ? submission.businessKey
    : `bk_v1_${sha256Base64Url(canonicalize(buildRuleIdentity(submission)))}`;
  const contentSubmission = Object.freeze({ ...submission, businessKey });
  const contentHash = `ch_v1_${sha256Base64Url(canonicalize(buildSensitiveContent(contentSubmission)))}`;
  const idempotencyKey = buildIdempotencyKey(submission.deviceId, submission.submissionId);
  return Object.freeze({
    submission,
    businessKey,
    contentHash,
    idempotencyKey,
    businessKeyRequiresExistingVerification: submission.operation === 'delete',
    protocolClass: submission.operation === 'delete' ? 'explicit_delete' : 'sensitive_rule_upsert',
  });
}

export function normalizeSensitiveSubmission(input) {
  const computed = computeSensitiveSubmissionHashes(input);
  if (computed.submission.businessKey !== computed.businessKey) {
    throw new SensitiveRulesValidationError('BUSINESS_KEY_MISMATCH', '客户端businessKey与服务端重算结果不一致');
  }
  if (computed.submission.contentHash !== computed.contentHash) {
    throw new SensitiveRulesValidationError('CONTENT_HASH_MISMATCH', '客户端contentHash与服务端重算结果不一致');
  }
  if (computed.submission.idempotencyKey !== computed.idempotencyKey) {
    throw new SensitiveRulesValidationError('IDEMPOTENCY_KEY_MISMATCH', '客户端idempotencyKey与服务端重算结果不一致');
  }
  return computed.submission;
}

function normalizeExistingRecord(value, submission) {
  if (value === null || value === undefined) return null;
  assertExactKeys(
    value,
    ['businessKey', 'contentHash', 'dataType', 'bossId', 'payload'],
    'INVALID_EXISTING_SENSITIVE_RECORD',
    '公共基线记录字段无效',
  );
  const dataType = String(value.dataType || '').trim().toLowerCase();
  if (dataType !== submission.dataType) {
    throw new SensitiveRulesValidationError('EXISTING_DATA_TYPE_MISMATCH', '公共基线类型与敏感候选不一致');
  }
  const businessKey = normalizeId(value.businessKey, BUSINESS_KEY_PATTERN, 'INVALID_EXISTING_SENSITIVE_RECORD', 'businessKey');
  const contentHash = normalizeId(value.contentHash, CONTENT_HASH_PATTERN, 'INVALID_EXISTING_SENSITIVE_RECORD', 'contentHash');
  if (businessKey !== submission.businessKey) {
    throw new SensitiveRulesValidationError('EXISTING_BUSINESS_KEY_MISMATCH', '公共基线业务键与敏感候选不一致');
  }
  let bossId = null;
  let payload;
  if (dataType === 'exact_price') {
    if (value.bossId !== null) throw new SensitiveRulesValidationError('INVALID_EXISTING_SENSITIVE_RECORD', '普通价格公共基线bossId必须为null');
    payload = normalizeExactPricePayload(value.payload);
  } else if (dataType === 'playable_name') {
    if (value.bossId !== null) throw new SensitiveRulesValidationError('INVALID_EXISTING_SENSITIVE_RECORD', '陪玩名字公共基线bossId必须为null');
    payload = normalizePlayableNamePayload(value.payload);
  } else if (dataType === 'boss_profile') {
    bossId = normalizeId(value.bossId, BOSS_ID_PATTERN, 'INVALID_EXISTING_SENSITIVE_RECORD', 'bossId');
    if (bossId !== submission.bossId) {
      throw new SensitiveRulesValidationError('EXISTING_BOSS_ID_MISMATCH', '公共老板身份与敏感候选不一致');
    }
    payload = normalizeBossProfilePayload(value.payload);
  } else {
    if (value.bossId !== null) throw new SensitiveRulesValidationError('INVALID_EXISTING_SENSITIVE_RECORD', '规则公共基线bossId必须为null');
    payload = normalizeRulePayload(dataType, value.payload);
  }
  return Object.freeze({ businessKey, contentHash, dataType, bossId, payload });
}

function pendingDecision(submission, reason, existing = null) {
  return Object.freeze({
    decision: 'pending_review',
    reason,
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    baselineContentHash: existing?.contentHash || null,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
    trustedDeviceBypassAllowed: false,
    twoDeviceBypassAllowed: false,
    tombstoneRequested: submission.operation === 'delete',
  });
}

function duplicateDecision(submission, existing) {
  return Object.freeze({
    decision: 'duplicate_noop',
    reason: 'same_as_public',
    businessKey: submission.businessKey,
    contentHash: submission.contentHash,
    baselineContentHash: existing.contentHash,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
    trustedDeviceBypassAllowed: false,
    twoDeviceBypassAllowed: false,
    tombstoneRequested: false,
  });
}

export function evaluateSensitiveCandidate({
  submission,
  existingRecord = null,
  matchingDistinctDeviceCount = 1,
  trustedDevice = false,
  conflictingCandidateCount = 0,
} = {}) {
  if (!Number.isInteger(matchingDistinctDeviceCount) || matchingDistinctDeviceCount < 1) {
    throw new SensitiveRulesValidationError('INVALID_MATCHING_DEVICE_COUNT', 'matchingDistinctDeviceCount必须是正整数');
  }
  if (!Number.isInteger(conflictingCandidateCount) || conflictingCandidateCount < 0) {
    throw new SensitiveRulesValidationError('INVALID_CONFLICT_COUNT', 'conflictingCandidateCount必须是非负整数');
  }
  const normalized = normalizeSensitiveSubmission(submission);
  const existing = normalizeExistingRecord(existingRecord, normalized);

  if (normalized.operation === 'delete') {
    if (!existing) {
      throw new SensitiveRulesValidationError('DELETE_TARGET_NOT_FOUND', '显式删除必须指向现有公共基线');
    }
    return pendingDecision(normalized, 'explicit_delete_manual_review', existing);
  }

  if (normalized.dataType === 'boss_profile') {
    if (!existing) {
      throw new SensitiveRulesValidationError('SENSITIVE_BOSS_BASELINE_REQUIRED', '老板敏感变化必须指向现有公共老板资料');
    }
    const ordinary = evaluateOrdinaryCandidate({
      submission: normalized,
      existingRecord: existing,
      matchingDistinctDeviceCount,
      trustedDevice,
      conflictingCandidateCount,
    });
    if (ordinary.decision === 'duplicate_noop') return duplicateDecision(normalized, existing);
    if (!BOSS_SENSITIVE_REASONS.has(ordinary.reason)) {
      throw new SensitiveRulesValidationError('NOT_SENSITIVE_BOSS_CHANGE', '该老板变化仍属于阶段5G普通候选，不应进入阶段6A敏感协议', {
        ordinaryDecision: ordinary.decision,
        ordinaryReason: ordinary.reason,
        maximumOrdinaryDrop: MAX_AUTOMATIC_DISCOUNT_DROP,
      });
    }
    return pendingDecision(normalized, ordinary.reason, existing);
  }

  if (existing?.contentHash === normalized.contentHash) return duplicateDecision(normalized, existing);
  const reasons = {
    rank_range_rule: 'rank_range_rule_manual_review',
    surcharge_rule: 'surcharge_rule_manual_review',
    gift_rule: 'gift_rule_manual_review',
  };
  return pendingDecision(normalized, reasons[normalized.dataType], existing);
}

export function readSensitiveRulesPreviewConfig(env = {}) {
  if (String(env.CLOUD_SENSITIVE_RULES_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new SensitiveRulesValidationError('SENSITIVE_RULES_PREVIEW_DISABLED', '敏感规则预览未开启');
  }
  const storeName = String(env.CLOUD_SENSITIVE_RULES_BLOB_STORE_NAME || '').trim();
  const groupId = String(env.CLOUD_SENSITIVE_RULES_ALLOWED_GROUP_ID || '').trim().toLowerCase();
  const libraryId = String(env.CLOUD_SENSITIVE_RULES_ALLOWED_LIBRARY_ID || '').trim().toLowerCase();
  if (storeName !== SENSITIVE_RULES_PREVIEW_STORE_NAME
      || groupId !== SENSITIVE_RULES_ALLOWED_GROUP_ID
      || libraryId !== SENSITIVE_RULES_ALLOWED_LIBRARY_ID) {
    throw new SensitiveRulesValidationError('SENSITIVE_RULES_SCOPE_INVALID', '敏感规则只允许合成预览价格库');
  }
  return Object.freeze({
    schemaVersion: SENSITIVE_RULES_SCHEMA_VERSION,
    enabled: true,
    storeName,
    groupId,
    libraryId,
  });
}

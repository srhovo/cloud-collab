import { createHash, createHmac } from 'node:crypto';

import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { canonicalize } from './submission_policy_v1.js';
import { buildUnifiedSensitivePublicSnapshot } from './sensitive_public_engine_v1.js';
import { createStoredZip } from './zip_store_v1.js';

export const PRODUCTION_EXPORT_SCHEMA_VERSION = 1;
export const PRODUCTION_EXPORT_PACKAGE_FORMAT_VERSION = 2;
export const PRODUCTION_EXPORT_MAX_BODY_BYTES = 512;
export const PRODUCTION_EXPORT_MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
export const PRODUCTION_EXPORT_CONFIRMATION = 'EXPORT_PRODUCTION_MIGRATION_PACKAGE';
export const PRODUCTION_EXPORT_FILENAME = '码单器公共数据库迁移包.zip';

const ROOT = '码单器公共数据库迁移包';
const REQUEST_ID_PATTERN = /^exrq_v1_[A-Za-z0-9_-]{22,64}$/;
const REQUEST_TOKEN_PATTERN = /^pextok_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^pexrh_v1_[A-Za-z0-9_-]{43}$/;
const EXPORT_ID_PATTERN = /^pex_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^pexau_v1_[A-Za-z0-9_-]{43}$/;
const PACKAGE_ID_PATTERN = /^pkg_v2_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;
const SUPPORTED_DATA_TYPES = Object.freeze([
  'exact_price',
  'playable_name',
  'boss_profile',
  'rank_range_rule',
  'surcharge_rule',
  'gift_rule',
]);
const SUPPORTED_DATA_TYPE_SET = new Set(SUPPORTED_DATA_TYPES);

export const PRODUCTION_EXPORT_CAPABILITIES = Object.freeze({
  exportSummaryRead: true,
  exportDownload: true,
  fullUnifiedSnapshot: true,
  tombstonesIncluded: true,
  portableWithoutEdgeOne: true,
  publicMutationAllowed: false,
  deviceMutation: false,
  reviewMutation: false,
  rollbackMutation: false,
  productionAdmin: true,
  syntheticFixtureOnly: false,
  stablePromotionAuthorized: false,
});

export class ProductionAdminExportError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '正式管理员迁移导出失败');
    this.name = 'ProductionAdminExportError';
    this.code = code || 'PRODUCTION_ADMIN_EXPORT_ERROR';
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
  if (!isPlainObject(value)) throw new ProductionAdminExportError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ProductionAdminExportError(code, message, status, { actual, expected: wanted });
  }
}

function assertSafeTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_TIME_INVALID', '正式迁移导出时间无效', 500);
  }
  return value;
}

function assertAuditSalt(value) {
  const text = String(value || '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 32 || bytes > 256) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_AUDIT_SALT_INVALID', '正式迁移导出审计盐值必须为32至256字节', 503);
  }
  return text;
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmacBase64Url(value, secret) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(String(value), 'utf8').digest('base64url');
}

function stableJson(value) {
  return Buffer.from(`${canonicalize(value)}\n`, 'utf8');
}

function validateConfig(config) {
  if (!config || config.mode !== 'production' || config.productionEnabled !== true
      || typeof config.storeName !== 'string' || !config.storeName
      || typeof config.groupId !== 'string' || !config.groupId
      || typeof config.libraryId !== 'string' || !config.libraryId) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_CONFIG_INVALID', '正式迁移导出配置无效', 503);
  }
  assertAuditSalt(config.auditSalt);
  return config;
}

function validateRecord(record) {
  if (!isPlainObject(record) || typeof record.businessKey !== 'string'
      || typeof record.contentHash !== 'string'
      || !SUPPORTED_DATA_TYPE_SET.has(record.dataType)
      || record.operation !== 'upsert'
      || !Number.isSafeInteger(record.approvedVersion) || record.approvedVersion < 1
      || !isPlainObject(record.payload)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_RECORD_INVALID', '统一公共快照包含无效记录', 503);
  }
  return Object.freeze(structuredClone(record));
}

function validateTombstone(item) {
  if (!isPlainObject(item) || typeof item.businessKey !== 'string'
      || typeof item.contentHash !== 'string'
      || !SUPPORTED_DATA_TYPE_SET.has(item.dataType)
      || item.operation !== 'delete'
      || !Number.isSafeInteger(item.approvedVersion) || item.approvedVersion < 1
      || !Number.isFinite(Date.parse(item.deletedAt))) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_TOMBSTONE_INVALID', '统一公共快照包含无效墓碑', 503);
  }
  return Object.freeze(structuredClone(item));
}

function validateSnapshot(snapshot, config, targetPublicVersion = null) {
  if (!isPlainObject(snapshot)
      || snapshot.groupId !== config.groupId
      || snapshot.libraryId !== config.libraryId
      || !Number.isSafeInteger(snapshot.publicVersion) || snapshot.publicVersion < 0
      || !Number.isSafeInteger(snapshot.baseOrdinaryVersion) || snapshot.baseOrdinaryVersion < 0
      || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.tombstones)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_SNAPSHOT_INVALID', '统一公共快照结构或作用域无效', 503);
  }
  if (targetPublicVersion !== null && snapshot.publicVersion !== targetPublicVersion) {
    throw new ProductionAdminExportError(
      'PRODUCTION_EXPORT_BASE_MOVED',
      '公共版本已变化，请使用新的requestId重新导出',
      409,
      { expected: targetPublicVersion, actual: snapshot.publicVersion },
    );
  }
  const records = Object.freeze(snapshot.records.map(validateRecord)
    .sort((left, right) => left.businessKey.localeCompare(right.businessKey)));
  const tombstones = Object.freeze(snapshot.tombstones.map(validateTombstone)
    .sort((left, right) => left.businessKey.localeCompare(right.businessKey)));
  if (new Set(records.map(item => item.businessKey)).size !== records.length
      || new Set(tombstones.map(item => item.businessKey)).size !== tombstones.length
      || records.some(item => tombstones.some(tombstone => tombstone.businessKey === item.businessKey))) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_SNAPSHOT_DUPLICATE', '统一公共快照存在重复或冲突业务键', 503);
  }
  return Object.freeze({ ...snapshot, records, tombstones });
}

function recordsOf(records, dataType) {
  return Object.freeze(records.filter(record => record.dataType === dataType));
}

function sectionCounts(snapshot) {
  const counts = Object.fromEntries(SUPPORTED_DATA_TYPES.map(type => [type, 0]));
  for (const record of snapshot.records) counts[record.dataType] += 1;
  return Object.freeze({
    ...counts,
    tombstones: snapshot.tombstones.length,
    totalRecords: snapshot.records.length,
  });
}

function buildContentFiles({ config, snapshot, generatedAt }) {
  const counts = sectionCounts(snapshot);
  const files = new Map([
    [`${ROOT}/schema.json`, stableJson(Object.freeze({
      schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
      packageFormatVersion: PRODUCTION_EXPORT_PACKAGE_FORMAT_VERSION,
      encoding: 'utf-8',
      portableWithoutEdgeOne: true,
      supportedDataTypes: SUPPORTED_DATA_TYPES,
      snapshotSchemaVersion: snapshot.schemaVersion,
      payloadSchemaVersion: snapshot.payloadSchemaVersion,
      restoreContractVersion: 1,
    }))],
    [`${ROOT}/groups.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      groups: Object.freeze([Object.freeze({
        groupId: config.groupId,
        externalClubId: config.externalScope.clubId,
        libraryIds: Object.freeze([config.libraryId]),
      })]),
    }))],
    [`${ROOT}/libraries/${config.libraryId}.json`, stableJson(Object.freeze({
      schemaVersion: snapshot.schemaVersion,
      payloadSchemaVersion: snapshot.payloadSchemaVersion,
      groupId: config.groupId,
      libraryId: config.libraryId,
      externalLibraryId: config.externalScope.libraryId,
      baseOrdinaryVersion: snapshot.baseOrdinaryVersion,
      publicVersion: snapshot.publicVersion,
      snapshotVersion: snapshot.snapshotVersion,
      cursor: snapshot.cursor,
      generatedAt: snapshot.generatedAt,
      records: snapshot.records,
      tombstones: snapshot.tombstones,
    }))],
    [`${ROOT}/prices/index.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      records: recordsOf(snapshot.records, 'exact_price'),
    }))],
    [`${ROOT}/playable-names/index.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      records: recordsOf(snapshot.records, 'playable_name'),
    }))],
    [`${ROOT}/bosses/index.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      records: recordsOf(snapshot.records, 'boss_profile'),
    }))],
    [`${ROOT}/rules/index.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      rankRangeRules: recordsOf(snapshot.records, 'rank_range_rule'),
      surchargeRules: recordsOf(snapshot.records, 'surcharge_rule'),
      giftRules: recordsOf(snapshot.records, 'gift_rule'),
    }))],
    [`${ROOT}/tombstones/index.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      records: snapshot.tombstones,
    }))],
    [`${ROOT}/audit/export-summary.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      generatedAt,
      groupId: config.groupId,
      libraryId: config.libraryId,
      publicVersion: snapshot.publicVersion,
      baseOrdinaryVersion: snapshot.baseOrdinaryVersion,
      counts,
      rawDeviceIdentifiersIncluded: false,
      credentialsIncluded: false,
      edgeOneInternalKeysIncluded: false,
    }))],
  ]);
  return Object.freeze({ files, counts });
}

function descriptors(files) {
  return Object.freeze([...files.entries()].map(([name, data]) => Object.freeze({
    name: name.slice(`${ROOT}/`.length),
    byteLength: data.length,
    sha256: sha256Hex(data),
  })).sort((left, right) => left.name.localeCompare(right.name)));
}

export async function buildProductionMigrationExportBundle({
  store,
  config,
  now = Date.now(),
  targetPublicVersion = null,
  buildSnapshot = buildUnifiedSensitivePublicSnapshot,
} = {}) {
  validateConfig(config);
  assertSafeTime(now);
  let rawSnapshot;
  try {
    rawSnapshot = await buildSnapshot({
      store,
      groupId: config.groupId,
      libraryId: config.libraryId,
      now,
    });
  } catch (error) {
    if (error instanceof ProductionAdminExportError) throw error;
    throw new ProductionAdminExportError(
      error?.code || 'PRODUCTION_EXPORT_SNAPSHOT_BUILD_FAILED',
      '无法构建正式统一公共快照',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  const snapshot = validateSnapshot(rawSnapshot, config, targetPublicVersion);
  const generatedAt = new Date(now).toISOString();
  const content = buildContentFiles({ config, snapshot, generatedAt });
  const files = descriptors(content.files);
  const packageId = `pkg_v2_${sha256Base64Url(canonicalize({
    schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
    packageFormatVersion: PRODUCTION_EXPORT_PACKAGE_FORMAT_VERSION,
    groupId: config.groupId,
    libraryId: config.libraryId,
    publicVersion: snapshot.publicVersion,
    files,
  }))}`;
  const manifest = Object.freeze({
    schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
    packageFormatVersion: PRODUCTION_EXPORT_PACKAGE_FORMAT_VERSION,
    packageId,
    generatedAt,
    groupId: config.groupId,
    libraryId: config.libraryId,
    externalScope: config.externalScope,
    publicVersion: snapshot.publicVersion,
    baseOrdinaryVersion: snapshot.baseOrdinaryVersion,
    recordCount: snapshot.records.length,
    tombstoneCount: snapshot.tombstones.length,
    sectionCounts: content.counts,
    files,
  });
  const entries = [...content.files.entries(), [`${ROOT}/manifest.json`, stableJson(manifest)]]
    .map(([name, data]) => ({ name, data }));
  const zip = createStoredZip(entries, {
    createdAt: now,
    maxBytes: PRODUCTION_EXPORT_MAX_PACKAGE_BYTES,
  });
  return Object.freeze({
    bytes: zip.bytes,
    byteLength: zip.byteLength,
    fileCount: zip.entryCount,
    packageId,
    generatedAt,
    publicVersion: snapshot.publicVersion,
    baseOrdinaryVersion: snapshot.baseOrdinaryVersion,
    recordCount: snapshot.records.length,
    tombstoneCount: snapshot.tombstones.length,
    sectionCounts: content.counts,
    manifest,
    filename: PRODUCTION_EXPORT_FILENAME,
    contentType: 'application/zip',
  });
}

function normalizeCommand(value) {
  assertExactKeys(
    value,
    ['schemaVersion', 'requestId', 'confirmation'],
    'PRODUCTION_EXPORT_INPUT_INVALID',
    '正式迁移导出请求字段无效',
    400,
  );
  if (value.schemaVersion !== PRODUCTION_EXPORT_SCHEMA_VERSION) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_SCHEMA_UNSUPPORTED', '正式迁移导出协议版本不受支持', 400);
  }
  const requestId = String(value.requestId || '').trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_REQUEST_ID_INVALID', '正式迁移导出requestId无效', 400);
  }
  if (value.confirmation !== PRODUCTION_EXPORT_CONFIRMATION) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_CONFIRMATION_REQUIRED', '正式迁移导出缺少固定确认词', 400);
  }
  return Object.freeze({
    schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
    requestId,
    confirmation: PRODUCTION_EXPORT_CONFIRMATION,
  });
}

function actorTagFor(identity, salt) {
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!username) throw new ProductionAdminExportError('PRODUCTION_EXPORT_ACTOR_INVALID', '管理员身份无效', 401);
  return `admin_${hmacBase64Url(username, salt).slice(0, 12)}`;
}

function requestTokenFor(requestId, salt) {
  return `pextok_v1_${hmacBase64Url(requestId, salt)}`;
}

function requestHashFor(command, actorTag, salt) {
  return `pexrh_v1_${hmacBase64Url(canonicalize({ ...command, actorTag }), salt)}`;
}

function exportIdFor(requestHash) {
  return `pex_v1_${sha256Base64Url(requestHash)}`;
}

function auditIdFor(exportId) {
  return `pexau_v1_${sha256Base64Url(exportId)}`;
}

function requestKey(config, token) {
  if (!REQUEST_TOKEN_PATTERN.test(token)) throw new ProductionAdminExportError('PRODUCTION_EXPORT_REQUEST_TOKEN_INVALID', '正式迁移导出请求索引无效', 500);
  return normalizeBlobKey(`exports/${config.libraryId}/production-requests/${token}.json`);
}

function decisionKey(config, exportId) {
  if (!EXPORT_ID_PATTERN.test(exportId)) throw new ProductionAdminExportError('PRODUCTION_EXPORT_ID_INVALID', '正式迁移导出决定ID无效', 500);
  return normalizeBlobKey(`exports/${config.libraryId}/production-decisions/${exportId}.json`);
}

function auditKey(auditId, occurredAt) {
  if (!AUDIT_ID_PATTERN.test(auditId)) throw new ProductionAdminExportError('PRODUCTION_EXPORT_AUDIT_ID_INVALID', '正式迁移导出审计ID无效', 500);
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) throw new ProductionAdminExportError('PRODUCTION_EXPORT_AUDIT_TIME_INVALID', '正式迁移导出审计时间无效', 500);
  return normalizeBlobKey(`audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`);
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
      throw new ProductionAdminExportError(code, message, 409, null, error);
    }
    return Object.freeze({ value: existing, created: false });
  }
}

function assertDecision(value, config, expected) {
  assertExactKeys(value, [
    'schemaVersion', 'exportId', 'requestHash', 'actorTag', 'createdAt',
    'groupId', 'libraryId', 'targetPublicVersion',
  ], 'PRODUCTION_EXPORT_DECISION_INVALID', '正式迁移导出决定无效');
  if (value.schemaVersion !== PRODUCTION_EXPORT_SCHEMA_VERSION
      || value.exportId !== expected.exportId || value.requestHash !== expected.requestHash
      || !EXPORT_ID_PATTERN.test(value.exportId) || !REQUEST_HASH_PATTERN.test(value.requestHash)
      || !ACTOR_TAG_PATTERN.test(String(value.actorTag || ''))
      || value.groupId !== config.groupId || value.libraryId !== config.libraryId
      || !Number.isSafeInteger(value.targetPublicVersion) || value.targetPublicVersion < 0
      || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_DECISION_INVALID', '正式迁移导出决定内容无效', 503);
  }
  return Object.freeze({ ...value });
}

export async function buildProductionMigrationExportSummary(options = {}) {
  const bundle = await buildProductionMigrationExportBundle(options);
  return Object.freeze({
    schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
    packageFormatVersion: PRODUCTION_EXPORT_PACKAGE_FORMAT_VERSION,
    packageId: bundle.packageId,
    publicVersion: bundle.publicVersion,
    baseOrdinaryVersion: bundle.baseOrdinaryVersion,
    recordCount: bundle.recordCount,
    tombstoneCount: bundle.tombstoneCount,
    fileCount: bundle.fileCount,
    packageByteLength: bundle.byteLength,
    generatedAt: bundle.generatedAt,
    sectionCounts: bundle.sectionCounts,
    portableWithoutEdgeOne: true,
    stablePromotionAuthorized: false,
  });
}

export async function createProductionMigrationExportDownload({
  store,
  config,
  identity,
  command,
  now = Date.now(),
  buildBundle = buildProductionMigrationExportBundle,
} = {}) {
  validateConfig(config);
  assertSafeTime(now);
  const input = normalizeCommand(command?.input || command);
  const actorTag = actorTagFor(identity, config.auditSalt);
  const requestToken = requestTokenFor(input.requestId, config.auditSalt);
  const requestHash = requestHashFor(input, actorTag, config.auditSalt);
  const exportId = exportIdFor(requestHash);
  const initialBundle = await buildBundle({ store, config, now });
  if (!PACKAGE_ID_PATTERN.test(String(initialBundle.packageId || ''))) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_PACKAGE_INVALID', '正式迁移导出包ID无效', 503);
  }
  const requestIndex = Object.freeze({
    schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
    requestToken,
    requestHash,
    exportId,
    createdAt: now,
  });
  await putImmutableExact(
    store,
    requestKey(config, requestToken),
    requestIndex,
    'PRODUCTION_EXPORT_REQUEST_CONFLICT',
    '相同requestId对应了不同正式迁移导出请求',
  );
  const proposedDecision = Object.freeze({
    schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
    exportId,
    requestHash,
    actorTag,
    createdAt: now,
    groupId: config.groupId,
    libraryId: config.libraryId,
    targetPublicVersion: initialBundle.publicVersion,
  });
  const writtenDecision = await putImmutableExact(
    store,
    decisionKey(config, exportId),
    proposedDecision,
    'PRODUCTION_EXPORT_DECISION_CONFLICT',
    '正式迁移导出决定冲突',
  );
  const decision = assertDecision(writtenDecision.value, config, { exportId, requestHash });
  const bundle = decision.createdAt === now && decision.targetPublicVersion === initialBundle.publicVersion
    ? initialBundle
    : await buildBundle({
        store,
        config,
        now: decision.createdAt,
        targetPublicVersion: decision.targetPublicVersion,
      });
  const auditId = auditIdFor(exportId);
  const audit = Object.freeze({
    schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
    auditId,
    exportId,
    action: 'production_migration_export',
    actorTag: decision.actorTag,
    occurredAt: decision.createdAt,
    groupId: decision.groupId,
    libraryId: decision.libraryId,
    packageId: bundle.packageId,
    publicVersion: bundle.publicVersion,
    recordCount: bundle.recordCount,
    tombstoneCount: bundle.tombstoneCount,
    fileCount: bundle.fileCount,
    byteLength: bundle.byteLength,
  });
  const writtenAudit = await putImmutableExact(
    store,
    auditKey(auditId, decision.createdAt),
    audit,
    'PRODUCTION_EXPORT_AUDIT_CONFLICT',
    '正式迁移导出审计冲突',
  );
  return Object.freeze({ ...bundle, duplicate: !writtenAudit.created });
}

export function isProductionExportProjectionSafe(value) {
  const forbiddenKeys = new Set([
    'deviceId', 'deviceIds', 'deviceToken', 'tokenHash', 'submissionId', 'submissionIds',
    'idempotencyKey', 'approvalId', 'eventKey', 'snapshotKey', 'blobKey', 'requestId',
    'requestToken', 'requestHash', 'exportId', 'auditId', 'actorTag', 'secret', 'salt',
  ]);
  const visit = (item, depth = 0) => {
    if (depth > 16) return false;
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
      if (typeof item === 'string' && (item.includes('exports/') || item.includes('audit/') || item.includes('public/'))) return false;
      return true;
    }
    if (Array.isArray(item)) return item.every(entry => visit(entry, depth + 1));
    if (!isPlainObject(item)) return false;
    return Object.entries(item).every(([key, entry]) => !forbiddenKeys.has(key) && visit(entry, depth + 1));
  };
  return visit(value);
}

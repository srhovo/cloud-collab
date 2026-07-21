import { createHash, createHmac } from 'node:crypto';

import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import {
  PRODUCTION_EXPORT_CONFIRMATION,
  PRODUCTION_EXPORT_SCHEMA_VERSION,
  ProductionAdminExportError,
  buildProductionMigrationExportBundle,
} from './production_admin_export_v1.js';
import { canonicalize } from './submission_policy_v1.js';

const REQUEST_ID_PATTERN = /^exrq_v1_[A-Za-z0-9_-]{22,64}$/;
const REQUEST_TOKEN_PATTERN = /^pextok_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^pexrh_v1_[A-Za-z0-9_-]{43}$/;
const EXPORT_ID_PATTERN = /^pex_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^pexau_v1_[A-Za-z0-9_-]{43}$/;
const PACKAGE_ID_PATTERN = /^pkg_v2_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;

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

function hmacBase64Url(value, secret) {
  return createHmac('sha256', Buffer.from(String(secret || ''), 'utf8'))
    .update(String(value), 'utf8')
    .digest('base64url');
}

function sha256Base64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
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
  if (!REQUEST_TOKEN_PATTERN.test(token)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_REQUEST_TOKEN_INVALID', '正式迁移导出请求索引无效', 500);
  }
  return normalizeBlobKey(`exports/${config.libraryId}/production-requests/${token}.json`);
}

function decisionKey(config, exportId) {
  if (!EXPORT_ID_PATTERN.test(exportId)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_ID_INVALID', '正式迁移导出决定ID无效', 500);
  }
  return normalizeBlobKey(`exports/${config.libraryId}/production-decisions/${exportId}.json`);
}

function auditKey(auditId, occurredAt) {
  if (!AUDIT_ID_PATTERN.test(auditId)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_AUDIT_ID_INVALID', '正式迁移导出审计ID无效', 500);
  }
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_AUDIT_TIME_INVALID', '正式迁移导出审计时间无效', 500);
  }
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

function assertRequestIndex(value, expected) {
  assertExactKeys(
    value,
    ['schemaVersion', 'requestToken', 'requestHash', 'exportId', 'createdAt'],
    'PRODUCTION_EXPORT_REQUEST_INDEX_INVALID',
    '正式迁移导出请求索引无效',
  );
  if (value.schemaVersion !== PRODUCTION_EXPORT_SCHEMA_VERSION
      || value.requestToken !== expected.requestToken
      || value.requestHash !== expected.requestHash
      || value.exportId !== expected.exportId
      || !REQUEST_TOKEN_PATTERN.test(value.requestToken)
      || !REQUEST_HASH_PATTERN.test(value.requestHash)
      || !EXPORT_ID_PATTERN.test(value.exportId)
      || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_REQUEST_INDEX_INVALID', '正式迁移导出请求索引内容无效', 503);
  }
  return Object.freeze({ ...value });
}

async function claimRequest(store, key, proposed) {
  try {
    await putJSONOnlyIfNew(store, key, proposed);
    return Object.freeze({ value: assertRequestIndex(proposed, proposed), created: true });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const existing = assertRequestIndex(await getJSONStrong(store, key), proposed);
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

function assertBundle(bundle, decision) {
  if (!bundle || !Buffer.isBuffer(bundle.bytes)
      || !PACKAGE_ID_PATTERN.test(String(bundle.packageId || ''))
      || bundle.publicVersion !== decision.targetPublicVersion
      || !Number.isSafeInteger(bundle.byteLength) || bundle.byteLength !== bundle.bytes.length
      || !Number.isSafeInteger(bundle.fileCount) || bundle.fileCount < 1) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_PACKAGE_INVALID', '正式迁移导出包无效', 503);
  }
  return bundle;
}

export async function createProductionMigrationExportDownloadV1({
  store,
  config,
  identity,
  command,
  now = Date.now(),
  buildBundle = buildProductionMigrationExportBundle,
} = {}) {
  assertSafeTime(now);
  const input = normalizeCommand(command?.input || command);
  const actorTag = actorTagFor(identity, config.auditSalt);
  const requestToken = requestTokenFor(input.requestId, config.auditSalt);
  const requestHash = requestHashFor(input, actorTag, config.auditSalt);
  const exportId = exportIdFor(requestHash);

  const requestClaim = await claimRequest(
    store,
    requestKey(config, requestToken),
    Object.freeze({
      schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
      requestToken,
      requestHash,
      exportId,
      createdAt: now,
    }),
  );
  const index = requestClaim.value;

  const storedDecisionKey = decisionKey(config, exportId);
  let decision = await getJSONStrong(store, storedDecisionKey);
  let firstBundle = null;
  if (decision) {
    decision = assertDecision(decision, config, { exportId, requestHash });
  } else {
    firstBundle = await buildBundle({ store, config, now: index.createdAt });
    const proposed = Object.freeze({
      schemaVersion: PRODUCTION_EXPORT_SCHEMA_VERSION,
      exportId,
      requestHash,
      actorTag,
      createdAt: index.createdAt,
      groupId: config.groupId,
      libraryId: config.libraryId,
      targetPublicVersion: firstBundle.publicVersion,
    });
    const written = await putImmutableExact(
      store,
      storedDecisionKey,
      proposed,
      'PRODUCTION_EXPORT_DECISION_CONFLICT',
      '正式迁移导出决定冲突',
    );
    decision = assertDecision(written.value, config, { exportId, requestHash });
  }

  const bundle = firstBundle
    && firstBundle.publicVersion === decision.targetPublicVersion
    && decision.createdAt === index.createdAt
    ? assertBundle(firstBundle, decision)
    : assertBundle(await buildBundle({
        store,
        config,
        now: decision.createdAt,
        targetPublicVersion: decision.targetPublicVersion,
      }), decision);

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

  return Object.freeze({
    ...bundle,
    duplicate: !writtenAudit.created,
    requestFirstCreatedAt: index.createdAt,
    stablePromotionAuthorized: false,
  });
}

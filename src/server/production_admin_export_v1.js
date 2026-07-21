import { createHash, createHmac } from 'node:crypto';

import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { canonicalize } from './submission_policy_v1.js';
import { buildProductionAdminExportBundle } from './production_admin_export_bundle_v1.js';

export const PRODUCTION_ADMIN_EXPORT_VERSION = 1;
export const PRODUCTION_ADMIN_EXPORT_CONFIRMATION = 'EXPORT_FULL_PUBLIC_DATABASE';
export const PRODUCTION_ADMIN_EXPORT_MAX_BODY_BYTES = 1024;

const REQUEST_ID_PATTERN = /^exrq_v1_[A-Za-z0-9_-]{22,64}$/;
const REQUEST_TOKEN_PATTERN = /^extok_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^exrh_v1_[A-Za-z0-9_-]{43}$/;
const EXPORT_ID_PATTERN = /^ex_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^exau_v1_[A-Za-z0-9_-]{43}$/;
const PACKAGE_ID_PATTERN = /^pkg_v2_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;

export class ProductionAdminExportError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '正式公共数据库导出失败');
    this.name = 'ProductionAdminExportError';
    this.code = code || 'PRODUCTION_ADMIN_EXPORT_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message, status = 400) {
  if (!isPlainObject(value)) throw new ProductionAdminExportError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ProductionAdminExportError(code, message, status, { actual, expected: wanted });
  }
}

function digestBase64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function hmacBase64Url(value, secret) {
  return createHmac('sha256', Buffer.from(String(secret), 'utf8'))
    .update(String(value), 'utf8')
    .digest('base64url');
}

function assertTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_TIME_INVALID', '正式导出时间无效', 500);
  }
}

function actorTagFor(identity) {
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!username) throw new ProductionAdminExportError('PRODUCTION_EXPORT_ACTOR_INVALID', '管理员身份无效', 401);
  return `admin_${digestBase64Url(username).slice(0, 12)}`;
}

function normalizeCommand(value) {
  assertExactKeys(
    value,
    ['schemaVersion', 'requestId', 'confirmation'],
    'PRODUCTION_EXPORT_INPUT_INVALID',
    '正式导出请求字段无效',
  );
  const requestId = String(value.requestId || '').trim();
  if (value.schemaVersion !== PRODUCTION_ADMIN_EXPORT_VERSION
      || !REQUEST_ID_PATTERN.test(requestId)
      || value.confirmation !== PRODUCTION_ADMIN_EXPORT_CONFIRMATION) {
    throw new ProductionAdminExportError(
      'PRODUCTION_EXPORT_INPUT_INVALID',
      '正式导出请求版本、请求ID或确认词无效',
      400,
    );
  }
  return Object.freeze({
    schemaVersion: PRODUCTION_ADMIN_EXPORT_VERSION,
    requestId,
    confirmation: PRODUCTION_ADMIN_EXPORT_CONFIRMATION,
  });
}

function requestTokenFor(requestId, auditSalt) {
  return `extok_v1_${hmacBase64Url(requestId, auditSalt)}`;
}

function requestHashFor(command, actorTag) {
  return `exrh_v1_${digestBase64Url(canonicalize({ command, actorTag }))}`;
}

function exportIdFor(requestHash) {
  return `ex_v1_${digestBase64Url(requestHash)}`;
}

function auditIdFor(exportId) {
  return `exau_v1_${digestBase64Url(exportId)}`;
}

function requestKey(config, token) {
  if (!REQUEST_TOKEN_PATTERN.test(token)) throw new ProductionAdminExportError('PRODUCTION_EXPORT_TOKEN_INVALID', '正式导出请求索引无效', 500);
  return normalizeBlobKey(`exports/${config.libraryId}/production/requests/${token}.json`);
}

function decisionKey(config, exportId) {
  if (!EXPORT_ID_PATTERN.test(exportId)) throw new ProductionAdminExportError('PRODUCTION_EXPORT_ID_INVALID', '正式导出决策ID无效', 500);
  return normalizeBlobKey(`exports/${config.libraryId}/production/decisions/${exportId}.json`);
}

function auditKey(auditId, occurredAt) {
  if (!AUDIT_ID_PATTERN.test(auditId)) throw new ProductionAdminExportError('PRODUCTION_EXPORT_AUDIT_ID_INVALID', '正式导出审计ID无效', 500);
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) throw new ProductionAdminExportError('PRODUCTION_EXPORT_AUDIT_TIME_INVALID', '正式导出审计时间无效', 500);
  return normalizeBlobKey(`audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`);
}

function isAlreadyExists(error) {
  return error instanceof BlobRepositoryError && error.code === 'BLOB_ALREADY_EXISTS';
}

async function putImmutableExact(store, key, value, code, message) {
  try {
    await putJSONOnlyIfNew(store, key, value);
    return Object.freeze({ value, created: true });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await getJSONStrong(store, key);
    if (!existing || canonicalize(existing) !== canonicalize(value)) {
      throw new ProductionAdminExportError(code, message, 409, null, error);
    }
    return Object.freeze({ value: existing, created: false });
  }
}

function assertRequestIndex(value, expectedToken) {
  assertExactKeys(
    value,
    ['schemaVersion', 'requestToken', 'requestHash', 'exportId', 'createdAt'],
    'PRODUCTION_EXPORT_REQUEST_INDEX_INVALID',
    '正式导出请求索引结构无效',
    503,
  );
  if (value.schemaVersion !== 1
      || value.requestToken !== expectedToken
      || !REQUEST_TOKEN_PATTERN.test(value.requestToken)
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || !EXPORT_ID_PATTERN.test(String(value.exportId || ''))
      || !Number.isSafeInteger(value.createdAt)
      || value.createdAt <= 0) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_REQUEST_INDEX_INVALID', '正式导出请求索引内容无效', 503);
  }
  return Object.freeze({ ...value });
}

function assertDecision(value, expected) {
  assertExactKeys(
    value,
    [
      'schemaVersion', 'exportId', 'requestHash', 'actorTag', 'createdAt',
      'groupId', 'libraryId', 'publicVersion', 'packageId', 'filename',
      'byteLength', 'fileCount', 'recordCount', 'tombstoneCount',
      'ordinaryEventCount', 'sensitiveEventCount', 'countsByType',
    ],
    'PRODUCTION_EXPORT_DECISION_INVALID',
    '正式导出决策结构无效',
    503,
  );
  if (value.schemaVersion !== 1
      || value.exportId !== expected.exportId
      || value.requestHash !== expected.requestHash
      || !ACTOR_TAG_PATTERN.test(String(value.actorTag || ''))
      || value.groupId !== expected.groupId
      || value.libraryId !== expected.libraryId
      || !Number.isSafeInteger(value.publicVersion)
      || value.publicVersion < 0
      || !PACKAGE_ID_PATTERN.test(String(value.packageId || ''))
      || typeof value.filename !== 'string'
      || !value.filename.endsWith('.zip')
      || !Number.isSafeInteger(value.byteLength)
      || value.byteLength < 1
      || !Number.isSafeInteger(value.fileCount)
      || value.fileCount < 1
      || !Number.isSafeInteger(value.recordCount)
      || value.recordCount < 0
      || !Number.isSafeInteger(value.tombstoneCount)
      || value.tombstoneCount < 0
      || !Number.isSafeInteger(value.ordinaryEventCount)
      || value.ordinaryEventCount < 0
      || !Number.isSafeInteger(value.sensitiveEventCount)
      || value.sensitiveEventCount < 0
      || !isPlainObject(value.countsByType)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_DECISION_INVALID', '正式导出决策内容无效', 503);
  }
  assertTime(value.createdAt);
  return Object.freeze({ ...value, countsByType: Object.freeze({ ...value.countsByType }) });
}

function buildDecision({ config, identity, requestHash, exportId, bundle, createdAt }) {
  return Object.freeze({
    schemaVersion: 1,
    exportId,
    requestHash,
    actorTag: actorTagFor(identity),
    createdAt,
    groupId: config.groupId,
    libraryId: config.libraryId,
    publicVersion: bundle.publicVersion,
    packageId: bundle.packageId,
    filename: bundle.filename,
    byteLength: bundle.byteLength,
    fileCount: bundle.fileCount,
    recordCount: bundle.recordCount,
    tombstoneCount: bundle.tombstoneCount,
    ordinaryEventCount: bundle.ordinaryEventCount,
    sensitiveEventCount: bundle.sensitiveEventCount,
    countsByType: bundle.countsByType,
  });
}

function assertBundleMatchesDecision(bundle, decision) {
  const same = bundle.publicVersion === decision.publicVersion
    && bundle.packageId === decision.packageId
    && bundle.filename === decision.filename
    && bundle.byteLength === decision.byteLength
    && bundle.fileCount === decision.fileCount
    && bundle.recordCount === decision.recordCount
    && bundle.tombstoneCount === decision.tombstoneCount
    && bundle.ordinaryEventCount === decision.ordinaryEventCount
    && bundle.sensitiveEventCount === decision.sensitiveEventCount
    && canonicalize(bundle.countsByType) === canonicalize(decision.countsByType);
  if (!same) {
    throw new ProductionAdminExportError(
      'PRODUCTION_EXPORT_REQUEST_STALE',
      '同一导出请求ID对应的公共版本已经变化，请使用新的请求ID重新导出',
      409,
    );
  }
}

function auditRecord(decision) {
  return Object.freeze({
    schemaVersion: 1,
    auditId: auditIdFor(decision.exportId),
    exportId: decision.exportId,
    action: 'production_public_database_export',
    actorTag: decision.actorTag,
    occurredAt: decision.createdAt,
    groupId: decision.groupId,
    libraryId: decision.libraryId,
    publicVersion: decision.publicVersion,
    packageId: decision.packageId,
    byteLength: decision.byteLength,
    fileCount: decision.fileCount,
    recordCount: decision.recordCount,
    tombstoneCount: decision.tombstoneCount,
  });
}

function summaryFromBundle(bundle) {
  return Object.freeze({
    schemaVersion: 1,
    publicVersion: bundle.publicVersion,
    packageId: bundle.packageId,
    filename: bundle.filename,
    byteLength: bundle.byteLength,
    fileCount: bundle.fileCount,
    recordCount: bundle.recordCount,
    tombstoneCount: bundle.tombstoneCount,
    ordinaryEventCount: bundle.ordinaryEventCount,
    sensitiveEventCount: bundle.sensitiveEventCount,
    countsByType: bundle.countsByType,
    generatedAt: bundle.generatedAt,
  });
}

export async function buildProductionAdminExportSummary({
  store,
  config,
  now = Date.now(),
  buildBundle = buildProductionAdminExportBundle,
} = {}) {
  const bundle = await buildBundle({ store, config, now });
  return summaryFromBundle(bundle);
}

export async function createProductionAdminExportDownload({
  store,
  config,
  identity,
  command,
  now = Date.now(),
  buildBundle = buildProductionAdminExportBundle,
} = {}) {
  assertTime(now);
  const input = normalizeCommand(command);
  const actorTag = actorTagFor(identity);
  const requestToken = requestTokenFor(input.requestId, config.auditSalt);
  const requestHash = requestHashFor(input, actorTag);
  const exportId = exportIdFor(requestHash);
  const proposedIndex = Object.freeze({
    schemaVersion: 1,
    requestToken,
    requestHash,
    exportId,
    createdAt: now,
  });
  let index;
  try {
    const claimed = await putImmutableExact(
      store,
      requestKey(config, requestToken),
      proposedIndex,
      'PRODUCTION_EXPORT_REQUEST_CONFLICT',
      '同一正式导出请求ID对应了不同正文',
    );
    index = assertRequestIndex(claimed.value, requestToken);
  } catch (error) {
    if (error instanceof ProductionAdminExportError) throw error;
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_REQUEST_CLAIM_FAILED', '无法登记正式导出请求', 503, null, error);
  }
  if (index.requestHash !== requestHash || index.exportId !== exportId) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_REQUEST_CONFLICT', '同一正式导出请求ID对应了不同正文', 409);
  }

  const bundle = await buildBundle({ store, config, now: index.createdAt });
  const key = decisionKey(config, exportId);
  const existing = await getJSONStrong(store, key);
  let decision;
  let duplicate = false;
  if (existing) {
    decision = assertDecision(existing, {
      exportId,
      requestHash,
      groupId: config.groupId,
      libraryId: config.libraryId,
    });
    assertBundleMatchesDecision(bundle, decision);
    duplicate = true;
  } else {
    decision = assertDecision(
      buildDecision({ config, identity, requestHash, exportId, bundle, createdAt: index.createdAt }),
      { exportId, requestHash, groupId: config.groupId, libraryId: config.libraryId },
    );
    const written = await putImmutableExact(
      store,
      key,
      decision,
      'PRODUCTION_EXPORT_DECISION_CONFLICT',
      '正式导出决策冲突',
    );
    decision = assertDecision(written.value, {
      exportId,
      requestHash,
      groupId: config.groupId,
      libraryId: config.libraryId,
    });
    duplicate = !written.created;
    assertBundleMatchesDecision(bundle, decision);
  }

  const audit = auditRecord(decision);
  await putImmutableExact(
    store,
    auditKey(audit.auditId, audit.occurredAt),
    audit,
    'PRODUCTION_EXPORT_AUDIT_CONFLICT',
    '正式导出审计记录冲突',
  );

  return Object.freeze({
    ...bundle,
    duplicate,
  });
}

export function isProductionAdminExportProjectionSafe(value) {
  const text = JSON.stringify(value);
  return !/dev_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/sub_[0-9A-HJKMNP-TV-Z]{26}/.test(text)
    && !/cloud_admin_session|authorization|password|secret|salt/i.test(text)
    && !/exports\/|audit\//.test(text);
}

import { createHash, createHmac } from 'node:crypto';
import {
  BlobRepositoryError,
  getJSONStrong,
  normalizeBlobKey,
  putJSONOnlyIfNew,
} from './blob_repository_v1.js';
import { listValidPublicEvents } from './auto_approval_engine_v1.js';
import { canonicalize } from './submission_policy_v1.js';
import {
  ADMIN_EXPORT_ALLOWED_GROUP_ID,
  ADMIN_EXPORT_ALLOWED_LIBRARY_ID,
  ADMIN_EXPORT_PREVIEW_STORE_NAME,
  ADMIN_EXPORT_SCHEMA_VERSION,
  AdminExportBundleError,
  buildAdminExportBundle,
} from './admin_export_bundle_v1.js';

export const ADMIN_EXPORT_MAX_BODY_BYTES = 512;
export const ADMIN_EXPORT_CONFIRMATION = 'EXPORT_SYNTHETIC_PUBLIC_DATABASE';

const REQUEST_ID_PATTERN = /^exrq_v1_[A-Za-z0-9_-]{22,64}$/;
const REQUEST_TOKEN_PATTERN = /^extok_v1_[A-Za-z0-9_-]{43}$/;
const REQUEST_HASH_PATTERN = /^exrh_v1_[A-Za-z0-9_-]{43}$/;
const EXPORT_ID_PATTERN = /^ex_v1_[A-Za-z0-9_-]{43}$/;
const AUDIT_ID_PATTERN = /^exau_v1_[A-Za-z0-9_-]{43}$/;
const PACKAGE_ID_PATTERN = /^pkg_v1_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;

export const ADMIN_EXPORT_CAPABILITIES = Object.freeze({
  exportSummaryRead: true,
  exportDownload: true,
  publicMutationAllowed: false,
  deviceMutation: false,
  reviewMutation: false,
  rollbackMutation: false,
  syntheticFixtureOnly: true,
});

export class AdminExportError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员公共数据库导出失败');
    this.name = 'AdminExportError';
    this.code = code || 'ADMIN_EXPORT_ERROR';
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
  if (!isPlainObject(value)) throw new AdminExportError(code, message, status);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AdminExportError(code, message, status, { actual, expected: wanted });
  }
}

function assertSafeTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new AdminExportError('ADMIN_EXPORT_TIME_INVALID', '管理员导出时间无效', 500);
  }
  return value;
}

function assertSalt(value) {
  const text = String(value || '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 32 || bytes > 256) {
    throw new AdminExportError('ADMIN_EXPORT_AUDIT_SALT_INVALID', '管理员导出审计盐值必须为32至256字节', 503);
  }
  return text;
}

function hashBase64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function hmacBase64Url(value, secret) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(String(value), 'utf8').digest('base64url');
}

function actorTagFor(identity, secret) {
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!username) throw new AdminExportError('ADMIN_EXPORT_ACTOR_INVALID', '管理员身份无效', 401);
  return `admin_${hmacBase64Url(username, secret).slice(0, 12)}`;
}

function normalizeCommand(value) {
  assertExactKeys(value, ['schemaVersion', 'requestId', 'confirmation'], 'ADMIN_EXPORT_INPUT_INVALID', '管理员导出请求字段无效', 400);
  if (value.schemaVersion !== ADMIN_EXPORT_SCHEMA_VERSION) {
    throw new AdminExportError('ADMIN_EXPORT_SCHEMA_UNSUPPORTED', '管理员导出协议版本不受支持', 400);
  }
  const requestId = String(value.requestId || '').trim();
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new AdminExportError('ADMIN_EXPORT_REQUEST_ID_INVALID', '管理员导出请求ID无效', 400);
  }
  if (value.confirmation !== ADMIN_EXPORT_CONFIRMATION) {
    throw new AdminExportError('ADMIN_EXPORT_CONFIRMATION_REQUIRED', '管理员导出缺少固定确认词', 400);
  }
  return Object.freeze({
    schemaVersion: ADMIN_EXPORT_SCHEMA_VERSION,
    requestId,
    confirmation: ADMIN_EXPORT_CONFIRMATION,
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
      throw new AdminExportError(conflictCode, conflictMessage, 409, null, error);
    }
    return Object.freeze({ value: existing, created: false });
  }
}

export function readAdminExportConfig(env = {}) {
  if (String(env.CLOUD_ADMIN_EXPORT_PREVIEW_ENABLED || '').trim() !== '1') {
    throw new AdminExportError('ADMIN_EXPORT_PREVIEW_DISABLED', '管理员导出预览未开启', 503);
  }
  const storeName = String(env.CLOUD_ADMIN_EXPORT_BLOB_STORE_NAME || '').trim();
  const groupId = String(env.CLOUD_ADMIN_EXPORT_ALLOWED_GROUP_ID || '').trim().toLowerCase();
  const libraryId = String(env.CLOUD_ADMIN_EXPORT_ALLOWED_LIBRARY_ID || '').trim().toLowerCase();
  if (storeName !== ADMIN_EXPORT_PREVIEW_STORE_NAME
      || groupId !== ADMIN_EXPORT_ALLOWED_GROUP_ID
      || libraryId !== ADMIN_EXPORT_ALLOWED_LIBRARY_ID) {
    throw new AdminExportError('ADMIN_EXPORT_SCOPE_INVALID', '管理员导出只允许合成预览公共库', 503);
  }
  return Object.freeze({
    schemaVersion: ADMIN_EXPORT_SCHEMA_VERSION,
    previewEnabled: true,
    storeName,
    groupId,
    libraryId,
    auditSalt: assertSalt(env.CLOUD_ADMIN_EXPORT_AUDIT_SALT),
  });
}

export async function buildAdminExportSummary({ store, config, now = Date.now() } = {}) {
  try {
    const bundle = await buildAdminExportBundle({ store, config, now });
    return Object.freeze({
      schemaVersion: ADMIN_EXPORT_SCHEMA_VERSION,
      packageId: bundle.packageId,
      groupId: config.groupId,
      libraryId: config.libraryId,
      publicVersion: bundle.publicVersion,
      eventCount: bundle.eventCount,
      recordCount: bundle.recordCount,
      rollbackCount: bundle.rollbackCount,
      fileCount: bundle.fileCount,
      packageByteLength: bundle.byteLength,
      generatedAt: bundle.generatedAt,
    });
  } catch (error) {
    if (error instanceof AdminExportBundleError) {
      throw new AdminExportError(error.code, error.message, error.status, error.details, error);
    }
    throw error;
  }
}

function requestTokenFor(requestId, secret) {
  return `extok_v1_${hmacBase64Url(requestId, secret)}`;
}

function requestHashFor(command, actorTag, secret) {
  return `exrh_v1_${hmacBase64Url(canonicalize({ ...command, actorTag }), secret)}`;
}

function exportIdFor(requestHash) {
  return `ex_v1_${hashBase64Url(requestHash)}`;
}

function auditIdFor(exportId) {
  return `exau_v1_${hashBase64Url(exportId)}`;
}

function requestKey(config, requestToken) {
  if (!REQUEST_TOKEN_PATTERN.test(requestToken)) throw new AdminExportError('ADMIN_EXPORT_REQUEST_TOKEN_INVALID', '管理员导出请求索引无效', 500);
  return normalizeBlobKey(`exports/${config.libraryId}/requests/${requestToken}.json`);
}

function decisionKey(config, exportId) {
  if (!EXPORT_ID_PATTERN.test(exportId)) throw new AdminExportError('ADMIN_EXPORT_ID_INVALID', '管理员导出决策ID无效', 500);
  return normalizeBlobKey(`exports/${config.libraryId}/decisions/${exportId}.json`);
}

function auditKey(auditId, occurredAt) {
  if (!AUDIT_ID_PATTERN.test(auditId)) throw new AdminExportError('ADMIN_EXPORT_AUDIT_ID_INVALID', '管理员导出审计ID无效', 500);
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) throw new AdminExportError('ADMIN_EXPORT_AUDIT_TIME_INVALID', '管理员导出审计时间无效', 500);
  return normalizeBlobKey(`audit/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${auditId}.json`);
}

function assertRequestIndex(value, expectedToken) {
  assertExactKeys(value, ['schemaVersion', 'requestToken', 'requestHash', 'exportId', 'createdAt'], 'ADMIN_EXPORT_REQUEST_INDEX_INVALID', '管理员导出请求索引结构无效');
  if (value.schemaVersion !== ADMIN_EXPORT_SCHEMA_VERSION
      || value.requestToken !== expectedToken || !REQUEST_TOKEN_PATTERN.test(value.requestToken)
      || !REQUEST_HASH_PATTERN.test(String(value.requestHash || ''))
      || !EXPORT_ID_PATTERN.test(String(value.exportId || ''))) {
    throw new AdminExportError('ADMIN_EXPORT_REQUEST_INDEX_INVALID', '管理员导出请求索引内容无效', 503);
  }
  assertSafeTime(value.createdAt);
  return Object.freeze({ ...value });
}

async function claimRequest(store, key, proposed) {
  try {
    await putJSONOnlyIfNew(store, key, proposed);
    return assertRequestIndex(proposed, proposed.requestToken);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = assertRequestIndex(await getJSONStrong(store, key), proposed.requestToken);
    if (existing.requestHash !== proposed.requestHash || existing.exportId !== proposed.exportId) {
      throw new AdminExportError('ADMIN_EXPORT_REQUEST_CONFLICT', '同一管理员导出请求ID对应了不同正文或管理员', 409, null, error);
    }
    return existing;
  }
}

function assertDecision(value, config, expected) {
  assertExactKeys(value, [
    'schemaVersion', 'exportId', 'requestHash', 'actorTag', 'createdAt',
    'groupId', 'libraryId', 'targetPublicVersion',
  ], 'ADMIN_EXPORT_DECISION_INVALID', '管理员导出决策结构无效');
  if (value.schemaVersion !== ADMIN_EXPORT_SCHEMA_VERSION
      || value.exportId !== expected.exportId || value.requestHash !== expected.requestHash
      || !EXPORT_ID_PATTERN.test(value.exportId) || !REQUEST_HASH_PATTERN.test(value.requestHash)
      || !ACTOR_TAG_PATTERN.test(String(value.actorTag || ''))
      || value.groupId !== config.groupId || value.libraryId !== config.libraryId
      || !Number.isSafeInteger(value.targetPublicVersion) || value.targetPublicVersion < 0) {
    throw new AdminExportError('ADMIN_EXPORT_DECISION_INVALID', '管理员导出决策内容无效', 503);
  }
  assertSafeTime(value.createdAt);
  return Object.freeze({ ...value });
}

function assertAudit(value, decision, bundle) {
  assertExactKeys(value, [
    'schemaVersion', 'auditId', 'exportId', 'action', 'actorTag', 'occurredAt',
    'groupId', 'libraryId', 'packageId', 'publicVersion', 'fileCount', 'byteLength',
  ], 'ADMIN_EXPORT_AUDIT_INVALID', '管理员导出审计结构无效');
  if (value.schemaVersion !== ADMIN_EXPORT_SCHEMA_VERSION
      || !AUDIT_ID_PATTERN.test(String(value.auditId || ''))
      || value.exportId !== decision.exportId || value.action !== 'admin_export'
      || value.actorTag !== decision.actorTag || value.occurredAt !== decision.createdAt
      || value.groupId !== decision.groupId || value.libraryId !== decision.libraryId
      || !PACKAGE_ID_PATTERN.test(String(value.packageId || ''))
      || value.packageId !== bundle.packageId || value.publicVersion !== bundle.publicVersion
      || value.fileCount !== bundle.fileCount || value.byteLength !== bundle.byteLength) {
    throw new AdminExportError('ADMIN_EXPORT_AUDIT_INVALID', '管理员导出审计内容无效', 503);
  }
  return value;
}

export async function createAdminExportDownload({ store, config, identity, command, now = Date.now() } = {}) {
  assertSafeTime(now);
  if (!config?.previewEnabled) throw new AdminExportError('ADMIN_EXPORT_PREVIEW_DISABLED', '管理员导出预览未开启', 503);
  const input = normalizeCommand(command?.input || command);
  const actorTag = actorTagFor(identity, config.auditSalt);
  const requestToken = requestTokenFor(input.requestId, config.auditSalt);
  const requestHash = requestHashFor(input, actorTag, config.auditSalt);
  const exportId = exportIdFor(requestHash);
  const index = await claimRequest(store, requestKey(config, requestToken), Object.freeze({
    schemaVersion: ADMIN_EXPORT_SCHEMA_VERSION,
    requestToken,
    requestHash,
    exportId,
    createdAt: now,
  }));

  const storedDecisionKey = decisionKey(config, exportId);
  let decision = await getJSONStrong(store, storedDecisionKey);
  if (decision) {
    decision = assertDecision(decision, config, { exportId, requestHash });
  } else {
    const events = await listValidPublicEvents({ store, libraryId: config.libraryId });
    const targetPublicVersion = events.length ? events[events.length - 1].version : 0;
    const proposed = Object.freeze({
      schemaVersion: ADMIN_EXPORT_SCHEMA_VERSION,
      exportId,
      requestHash,
      actorTag,
      createdAt: index.createdAt,
      groupId: config.groupId,
      libraryId: config.libraryId,
      targetPublicVersion,
    });
    const written = await putImmutableExact(store, storedDecisionKey, proposed, 'ADMIN_EXPORT_DECISION_CONFLICT', '管理员导出决策冲突');
    decision = assertDecision(written.value, config, { exportId, requestHash });
  }

  let bundle;
  try {
    bundle = await buildAdminExportBundle({
      store,
      config,
      now: decision.createdAt,
      targetPublicVersion: decision.targetPublicVersion,
    });
  } catch (error) {
    if (error instanceof AdminExportBundleError) {
      throw new AdminExportError(error.code, error.message, error.status, error.details, error);
    }
    throw error;
  }
  const auditId = auditIdFor(exportId);
  const audit = Object.freeze({
    schemaVersion: ADMIN_EXPORT_SCHEMA_VERSION,
    auditId,
    exportId,
    action: 'admin_export',
    actorTag: decision.actorTag,
    occurredAt: decision.createdAt,
    groupId: decision.groupId,
    libraryId: decision.libraryId,
    packageId: bundle.packageId,
    publicVersion: bundle.publicVersion,
    fileCount: bundle.fileCount,
    byteLength: bundle.byteLength,
  });
  const writtenAudit = await putImmutableExact(store, auditKey(auditId, decision.createdAt), audit, 'ADMIN_EXPORT_AUDIT_CONFLICT', '管理员导出审计冲突');
  assertAudit(writtenAudit.value, decision, bundle);
  return Object.freeze({ ...bundle, duplicate: !writtenAudit.created });
}

export function isAdminExportProjectionSafe(value) {
  const forbiddenKeys = new Set([
    'deviceId', 'deviceIds', 'deviceToken', 'tokenHash', 'submissionId', 'submissionIds',
    'idempotencyKey', 'approvalId', 'eventKey', 'snapshotKey', 'blobKey', 'requestId',
    'requestToken', 'requestHash', 'exportId', 'auditId', 'actorTag',
  ]);
  const visit = (item, depth = 0) => {
    if (depth > 12) return false;
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

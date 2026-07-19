import { createHash } from 'node:crypto';
import { getJSONStrong } from './blob_repository_v1.js';
import { listValidPublicEvents } from './auto_approval_engine_v1.js';
import { canonicalize } from './submission_policy_v1.js';
import { createStoredZip } from './zip_store_v1.js';

export const ADMIN_EXPORT_SCHEMA_VERSION = 1;
export const ADMIN_EXPORT_PACKAGE_FORMAT_VERSION = 1;
export const ADMIN_EXPORT_MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
export const ADMIN_EXPORT_MAX_EVENT_OBJECTS = 10_000;
export const ADMIN_EXPORT_MAX_AUDIT_OBJECTS = 10_000;
export const ADMIN_EXPORT_PREVIEW_STORE_NAME = 'cloud-collab-preview-v1';
export const ADMIN_EXPORT_ALLOWED_GROUP_ID = 'group_fixture';
export const ADMIN_EXPORT_ALLOWED_LIBRARY_ID = 'lib_receive_fixture';
export const ADMIN_EXPORT_FILENAME = '码单器公共数据库导出.zip';

const ROOT = '码单器公共数据库导出';
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const APPROVAL_ID_PATTERN = /^ap_v1_[A-Za-z0-9_-]{43}$/;
const ROLLBACK_ID_PATTERN = /^rb_v1_[A-Za-z0-9_-]{43}$/;
const ROLLBACK_AUDIT_ID_PATTERN = /^rbau_v1_[A-Za-z0-9_-]{43}$/;
const ACTOR_TAG_PATTERN = /^admin_[A-Za-z0-9_-]{12}$/;

export class AdminExportBundleError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '管理员导出包生成失败');
    this.name = 'AdminExportBundleError';
    this.code = code || 'ADMIN_EXPORT_BUNDLE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, expected, code, message) {
  if (!isPlainObject(value)) throw new AdminExportBundleError(code, message, 503);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AdminExportBundleError(code, message, 503, { actual, expected: wanted });
  }
}

function assertTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new AdminExportBundleError('ADMIN_EXPORT_TIME_INVALID', '导出时间无效', 500);
  }
  return value;
}

function digestBase64Url(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('base64url');
}

function digestHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return Buffer.from(`${canonicalize(value)}\n`, 'utf8');
}

async function listKeysStrong(store, prefix, maxObjects, code) {
  if (!store || typeof store.list !== 'function') {
    throw new AdminExportBundleError('ADMIN_EXPORT_LIST_UNAVAILABLE', '导出需要Blob列举能力', 503);
  }
  let result;
  try {
    result = await store.list({ prefix, consistency: 'strong' });
  } catch (error) {
    throw new AdminExportBundleError('ADMIN_EXPORT_LIST_FAILED', '导出强一致列举失败', 503, null, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > maxObjects) {
    throw new AdminExportBundleError(code, '导出对象数量超过安全上限', 409, {
      objectCount: blobs.length,
      maxObjects,
    });
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length) {
    throw new AdminExportBundleError('ADMIN_EXPORT_LIST_INVALID', '导出Blob列举结果无效', 503);
  }
  return keys.sort();
}

function validateConfig(config) {
  if (!config || config.storeName !== ADMIN_EXPORT_PREVIEW_STORE_NAME
      || config.groupId !== ADMIN_EXPORT_ALLOWED_GROUP_ID
      || config.libraryId !== ADMIN_EXPORT_ALLOWED_LIBRARY_ID) {
    throw new AdminExportBundleError('ADMIN_EXPORT_SCOPE_INVALID', '导出只允许合成预览公共库', 503);
  }
  return config;
}

function validateEventChain(events, config, targetPublicVersion = null) {
  const latest = events.length ? events[events.length - 1].version : 0;
  const target = targetPublicVersion === null ? latest : targetPublicVersion;
  if (!Number.isSafeInteger(target) || target < 0 || target > latest) {
    throw new AdminExportBundleError('ADMIN_EXPORT_TARGET_VERSION_INVALID', '导出目标公共版本无效', 409);
  }
  if (target > 0 && !events.some(event => event.version === target)) {
    throw new AdminExportBundleError('ADMIN_EXPORT_TARGET_VERSION_MISSING', '导出目标公共版本无法验证', 409);
  }
  const selected = events.filter(event => event.version <= target);
  const current = new Map();
  for (const event of selected) {
    if (event.groupId !== config.groupId || event.libraryId !== config.libraryId) {
      throw new AdminExportBundleError('ADMIN_EXPORT_EVENT_SCOPE_MISMATCH', '公共事件作用域不一致', 503);
    }
    const previous = current.get(event.businessKey) || null;
    if (event.baseline.approvedVersion !== (previous?.version ?? 0)
        || event.baseline.contentHash !== (previous?.contentHash ?? null)
        || event.baseline.unitPrice !== (previous?.payload?.unitPrice ?? null)) {
      throw new AdminExportBundleError('ADMIN_EXPORT_EVENT_CHAIN_INVALID', '公共事件基线链不连续', 503, {
        version: event.version,
      });
    }
    current.set(event.businessKey, event);
  }
  return Object.freeze({ targetPublicVersion: target, selected: Object.freeze(selected), current });
}

function assertRollbackAudit(value, config) {
  assertExactKeys(value, [
    'schemaVersion', 'auditId', 'rollbackId', 'action', 'actorTag', 'occurredAt',
    'groupId', 'libraryId', 'businessKey', 'sourceVersion', 'sourceContentHash',
    'restoreVersion', 'restoreContentHash', 'publicVersion', 'eventVersion', 'approvalId',
  ], 'ADMIN_EXPORT_ROLLBACK_AUDIT_INVALID', '回滚审计结构无效');
  if (value.schemaVersion !== 1
      || !ROLLBACK_AUDIT_ID_PATTERN.test(String(value.auditId || ''))
      || !ROLLBACK_ID_PATTERN.test(String(value.rollbackId || ''))
      || value.action !== 'admin_rollback'
      || !ACTOR_TAG_PATTERN.test(String(value.actorTag || ''))
      || !Number.isSafeInteger(value.occurredAt) || value.occurredAt <= 0
      || value.groupId !== config.groupId || value.libraryId !== config.libraryId
      || !BUSINESS_KEY_PATTERN.test(String(value.businessKey || ''))
      || !Number.isSafeInteger(value.sourceVersion) || value.sourceVersion < 1
      || !CONTENT_HASH_PATTERN.test(String(value.sourceContentHash || ''))
      || !Number.isSafeInteger(value.restoreVersion) || value.restoreVersion < 1
      || value.restoreVersion >= value.sourceVersion
      || !CONTENT_HASH_PATTERN.test(String(value.restoreContentHash || ''))
      || !Number.isSafeInteger(value.publicVersion) || value.publicVersion < 1
      || !Number.isSafeInteger(value.eventVersion) || value.eventVersion < 1
      || !APPROVAL_ID_PATTERN.test(String(value.approvalId || ''))) {
    throw new AdminExportBundleError('ADMIN_EXPORT_ROLLBACK_AUDIT_INVALID', '回滚审计内容无效', 503);
  }
  return value;
}

async function rollbackSummaries({ store, config, events, targetPublicVersion }) {
  const keys = await listKeysStrong(store, 'audit/', ADMIN_EXPORT_MAX_AUDIT_OBJECTS, 'ADMIN_EXPORT_AUDIT_LIMIT_EXCEEDED');
  const byVersion = new Map(events.map(event => [event.version, event]));
  const output = [];
  for (const key of keys) {
    const value = await getJSONStrong(store, key);
    if (!isPlainObject(value) || value.action !== 'admin_rollback') continue;
    const audit = assertRollbackAudit(value, config);
    if (audit.eventVersion > targetPublicVersion) continue;
    const event = byVersion.get(audit.eventVersion);
    if (!event || event.businessKey !== audit.businessKey
        || event.contentHash !== audit.restoreContentHash
        || event.baseline.approvedVersion !== audit.sourceVersion
        || event.baseline.contentHash !== audit.sourceContentHash
        || event.version !== audit.publicVersion) {
      throw new AdminExportBundleError('ADMIN_EXPORT_ROLLBACK_EVENT_MISMATCH', '回滚审计与公共事件不一致', 503);
    }
    output.push(Object.freeze({
      occurredAt: new Date(audit.occurredAt).toISOString(),
      sourceVersion: audit.sourceVersion,
      restoreVersion: audit.restoreVersion,
      publicVersion: audit.publicVersion,
      eventVersion: audit.eventVersion,
    }));
  }
  return Object.freeze(output.sort((left, right) => left.eventVersion - right.eventVersion));
}

function eventProjection(event) {
  return Object.freeze({
    version: event.version,
    approvedAt: event.approvedAt,
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    dataType: event.dataType,
    operation: event.operation,
    payload: event.payload,
    baseline: Object.freeze({
      approvedVersion: event.baseline.approvedVersion,
      contentHash: event.baseline.contentHash,
      unitPrice: event.baseline.unitPrice,
    }),
    approval: Object.freeze({
      mode: event.approval.mode,
      evidenceCount: event.approval.deviceIds.length,
    }),
  });
}

function currentRecords(chain) {
  return Object.freeze([...chain.current.values()].map(event => Object.freeze({
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    dataType: event.dataType,
    operation: event.operation,
    approvedVersion: event.version,
    approvedAt: event.approvedAt,
    payload: event.payload,
  })).sort((left, right) => left.businessKey.localeCompare(right.businessKey)));
}

function buildContentFiles({ config, chain, rollbacks, generatedAt }) {
  const records = currentRecords(chain);
  const events = Object.freeze(chain.selected.map(eventProjection));
  const files = new Map([
    [`${ROOT}/schema.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      packageFormatVersion: 1,
      encoding: 'utf-8',
      supportedDataTypes: Object.freeze(['exact_price']),
      publicEventSchemaVersion: 1,
      publicSnapshotSchemaVersion: 1,
      emptySections: Object.freeze(['bosses', 'playable-names', 'rules']),
    }))],
    [`${ROOT}/groups.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      groups: Object.freeze([Object.freeze({
        groupId: config.groupId,
        libraryIds: Object.freeze([config.libraryId]),
      })]),
    }))],
    [`${ROOT}/libraries/${config.libraryId}.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      payloadSchemaVersion: 1,
      groupId: config.groupId,
      libraryId: config.libraryId,
      publicVersion: chain.targetPublicVersion,
      generatedAt,
      records,
      tombstones: Object.freeze([]),
    }))],
    [`${ROOT}/bosses/index.json`, stableJson(Object.freeze({ schemaVersion: 1, records: Object.freeze([]) }))],
    [`${ROOT}/playable-names/index.json`, stableJson(Object.freeze({ schemaVersion: 1, records: Object.freeze([]) }))],
    [`${ROOT}/rules/index.json`, stableJson(Object.freeze({ schemaVersion: 1, records: Object.freeze([]) }))],
    [`${ROOT}/audit/public-events.json`, stableJson(Object.freeze({ schemaVersion: 1, publicVersion: chain.targetPublicVersion, events }))],
    [`${ROOT}/audit/rollbacks.json`, stableJson(Object.freeze({ schemaVersion: 1, rollbacks }))],
  ]);
  return Object.freeze({ files, records, events });
}

function descriptors(files) {
  return Object.freeze([...files.entries()].map(([name, data]) => Object.freeze({
    name: name.slice(`${ROOT}/`.length),
    byteLength: data.length,
    sha256: digestHex(data),
  })).sort((left, right) => left.name.localeCompare(right.name)));
}

export async function buildAdminExportBundle({
  store,
  config,
  now = Date.now(),
  targetPublicVersion = null,
} = {}) {
  validateConfig(config);
  assertTime(now);
  let allEvents;
  try {
    allEvents = await listValidPublicEvents({ store, libraryId: config.libraryId });
  } catch (error) {
    throw new AdminExportBundleError('ADMIN_EXPORT_PUBLIC_EVENT_VALIDATION_FAILED', '公共事件无法通过导出校验', 503, null, error);
  }
  if (allEvents.length > ADMIN_EXPORT_MAX_EVENT_OBJECTS) {
    throw new AdminExportBundleError('ADMIN_EXPORT_EVENT_LIMIT_EXCEEDED', '公共事件数量超过导出上限', 409);
  }
  const chain = validateEventChain(allEvents, config, targetPublicVersion);
  const generatedAt = new Date(now).toISOString();
  const rollbacks = await rollbackSummaries({
    store,
    config,
    events: chain.selected,
    targetPublicVersion: chain.targetPublicVersion,
  });
  const content = buildContentFiles({ config, chain, rollbacks, generatedAt });
  const files = descriptors(content.files);
  const packageId = `pkg_v1_${digestBase64Url(canonicalize({
    schemaVersion: 1,
    groupId: config.groupId,
    libraryId: config.libraryId,
    publicVersion: chain.targetPublicVersion,
    files,
  }))}`;
  const manifest = Object.freeze({
    schemaVersion: 1,
    packageFormatVersion: 1,
    packageId,
    generatedAt,
    groupId: config.groupId,
    libraryId: config.libraryId,
    publicVersion: chain.targetPublicVersion,
    eventCount: content.events.length,
    recordCount: content.records.length,
    rollbackCount: rollbacks.length,
    files,
  });
  const entries = [...content.files.entries(), [`${ROOT}/manifest.json`, stableJson(manifest)]]
    .map(([name, data]) => ({ name, data }));
  const zip = createStoredZip(entries, { createdAt: now, maxBytes: ADMIN_EXPORT_MAX_PACKAGE_BYTES });
  return Object.freeze({
    bytes: zip.bytes,
    byteLength: zip.byteLength,
    fileCount: zip.entryCount,
    packageId,
    generatedAt,
    publicVersion: chain.targetPublicVersion,
    eventCount: content.events.length,
    recordCount: content.records.length,
    rollbackCount: rollbacks.length,
    filename: ADMIN_EXPORT_FILENAME,
    contentType: 'application/zip',
  });
}

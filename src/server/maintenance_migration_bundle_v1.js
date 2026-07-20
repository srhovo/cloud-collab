import { createHash } from 'node:crypto';
import { canonicalize } from './submission_policy_v1.js';
import { createStoredZip } from './zip_store_v1.js';
import { buildMaintenanceIntegrityReport } from './maintenance_integrity_v1.js';
import {
  buildUnifiedSensitivePublicSnapshot,
  listValidSensitivePublicEvents,
} from './sensitive_public_engine_v1.js';
import { listValidOrdinaryPublicEvents } from './ordinary_public_engine_v1.js';

export const MAINTENANCE_MIGRATION_BUNDLE_VERSION = 1;
export const MAINTENANCE_MIGRATION_FORMAT_VERSION = 1;
export const MAINTENANCE_MIGRATION_MAX_BYTES = 20 * 1024 * 1024;

const ROOT = '码单器公共数据库迁移包';
const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;
const CONTENT_HASH_PATTERN = /^ch_v1_[A-Za-z0-9_-]{43}$/;
const MAX_VERSION = 999_999_999_999;
const SUPPORTED_DATA_TYPES = Object.freeze([
  'exact_price',
  'playable_name',
  'boss_profile',
  'rank_range_rule',
  'surcharge_rule',
  'gift_rule',
]);
const SUPPORTED_DATA_TYPE_SET = new Set(SUPPORTED_DATA_TYPES);
const PRIVATE_FIELD_KEYS = new Set([
  'deviceid',
  'submissionid',
  'idempotencykey',
  'requesthash',
  'token',
  'tokenhash',
  'authorization',
  'password',
  'secret',
  'cookie',
  'rawchat',
  'chat',
  'order',
  'history',
  'remark',
  'note',
  'customratio',
  'localid',
  'blobkey',
  'eventkey',
  'approvalid',
  'reviewid',
  'decisionid',
]);

export class MaintenanceMigrationBundleError extends Error {
  constructor(code, message, status = 500, details = null, cause = null) {
    super(message || code || '维护迁移包生成失败');
    this.name = 'MaintenanceMigrationBundleError';
    this.code = code || 'MAINTENANCE_MIGRATION_BUNDLE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_TIME_INVALID', '迁移包生成时间无效', 400);
  }
  return value;
}

function normalizeScope(groupId, libraryId) {
  const normalizedGroupId = String(groupId || '').trim().toLowerCase();
  const normalizedLibraryId = String(libraryId || '').trim().toLowerCase();
  if (!GROUP_ID_PATTERN.test(normalizedGroupId) || !LIBRARY_ID_PATTERN.test(normalizedLibraryId)) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_SCOPE_INVALID', '迁移包作用域无效', 400);
  }
  return Object.freeze({ groupId: normalizedGroupId, libraryId: normalizedLibraryId });
}

function assertVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VERSION) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_VERSION_INVALID', `${label}无效`, 500, { value });
  }
  return value;
}

function stableJson(value) {
  return Buffer.from(`${canonicalize(value)}\n`, 'utf8');
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function normalizedPrivateKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function assertNoPrivateFields(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateFields(item, `${path}[${index}]`));
    return value;
  }
  if (!isPlainObject(value)) return value;
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_FIELD_KEYS.has(normalizedPrivateKey(key))) {
      throw new MaintenanceMigrationBundleError(
        'MAINTENANCE_MIGRATION_PRIVATE_FIELD_BLOCKED',
        '迁移包检测到禁止导出的私有或内部字段',
        409,
        { path: `${path}.${key}` },
      );
    }
    assertNoPrivateFields(item, `${path}.${key}`);
  }
  return value;
}

function assertIntegrityReport(report, scope, now) {
  if (!isPlainObject(report) || report.schemaVersion !== 1
      || report.readOnly !== true || report.mutationsPerformed !== 0
      || !['healthy', 'attention_required'].includes(report.status)
      || !isPlainObject(report.scope) || !isPlainObject(report.public)
      || !isPlainObject(report.inventory) || !isPlainObject(report.checks)
      || Object.keys(report.checks).length === 0
      || Object.values(report.checks).some(value => value !== true)) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_INTEGRITY_REPORT_INVALID',
      '阶段7A完整性报告未全绿，禁止生成迁移包',
      409,
    );
  }
  if (report.scope.groupId !== scope.groupId || report.scope.libraryId !== scope.libraryId) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_INTEGRITY_SCOPE_MISMATCH',
      '完整性报告作用域与迁移包不一致',
      409,
    );
  }
  const checkedAt = Date.parse(String(report.checkedAt || ''));
  if (!Number.isFinite(checkedAt) || checkedAt <= 0 || checkedAt > now) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_INTEGRITY_TIME_INVALID',
      '完整性报告时间无效或来自未来',
      409,
    );
  }
  const ordinaryVersion = assertVersion(report.public.ordinaryVersion, '普通公共版本');
  const publicVersion = assertVersion(report.public.publicVersion, '统一公共版本');
  const snapshotVersion = assertVersion(report.public.snapshotVersion, '统一快照版本');
  if (ordinaryVersion > publicVersion || snapshotVersion !== publicVersion) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_INTEGRITY_VERSION_MISMATCH',
      '完整性报告中的公共版本不一致',
      409,
    );
  }
  return Object.freeze({ ordinaryVersion, publicVersion, snapshotVersion, checkedAt });
}

function assertSequentialEvents(events, startVersion, label) {
  if (!Array.isArray(events)) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_EVENT_CHAIN_INVALID', `${label}必须为数组`, 500);
  }
  for (let index = 0; index < events.length; index += 1) {
    const expected = startVersion + index;
    if (events[index]?.version !== expected) {
      throw new MaintenanceMigrationBundleError(
        'MAINTENANCE_MIGRATION_EVENT_CHAIN_INVALID',
        `${label}版本不连续`,
        409,
        { index, expected, actual: events[index]?.version },
      );
    }
  }
  return events;
}

function assertBusinessKey(value, label) {
  const text = String(value || '');
  if (!BUSINESS_KEY_PATTERN.test(text)) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_BUSINESS_KEY_INVALID', `${label}业务键无效`, 500);
  }
  return text;
}

function assertContentHash(value, label) {
  const text = String(value || '');
  if (!CONTENT_HASH_PATTERN.test(text)) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_CONTENT_HASH_INVALID', `${label}内容Hash无效`, 500);
  }
  return text;
}

function assertDataType(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!SUPPORTED_DATA_TYPE_SET.has(text)) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_DATA_TYPE_INVALID', `${label}数据类型不受支持`, 500);
  }
  return text;
}

function projectRecord(record) {
  if (!isPlainObject(record) || record.operation !== 'upsert') {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_RECORD_INVALID', '公共记录结构无效', 500);
  }
  const dataType = assertDataType(record.dataType, '公共记录');
  const bossId = dataType === 'boss_profile' ? String(record.bossId || '') : null;
  if (dataType === 'boss_profile' && !bossId.startsWith('boss_v1_')) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_RECORD_INVALID', '老板公共记录缺少稳定身份', 500);
  }
  const projected = Object.freeze({
    businessKey: assertBusinessKey(record.businessKey, '公共记录'),
    contentHash: assertContentHash(record.contentHash, '公共记录'),
    dataType,
    operation: 'upsert',
    approvedVersion: assertVersion(record.approvedVersion, '公共记录批准版本'),
    bossId,
    payload: record.payload,
  });
  assertNoPrivateFields(projected);
  return projected;
}

function projectTombstone(tombstone) {
  if (!isPlainObject(tombstone)) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_TOMBSTONE_INVALID', '公共墓碑结构无效', 500);
  }
  const projected = Object.freeze({
    businessKey: assertBusinessKey(tombstone.businessKey, '公共墓碑'),
    contentHash: assertContentHash(tombstone.contentHash, '公共墓碑'),
    dataType: assertDataType(tombstone.dataType, '公共墓碑'),
    operation: 'delete',
    approvedVersion: assertVersion(tombstone.approvedVersion, '公共墓碑批准版本'),
    bossId: tombstone.bossId ?? null,
  });
  assertNoPrivateFields(projected);
  return projected;
}

function projectSnapshot(snapshot, scope, versions, expectedCounts = null) {
  if (!isPlainObject(snapshot)
      || snapshot.groupId !== scope.groupId || snapshot.libraryId !== scope.libraryId
      || snapshot.baseOrdinaryVersion !== versions.ordinaryVersion
      || snapshot.publicVersion !== versions.publicVersion
      || snapshot.snapshotVersion !== versions.publicVersion
      || snapshot.cursor !== `pv_${versions.publicVersion}`
      || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.tombstones)) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_SNAPSHOT_INVALID',
      '统一公共快照作用域、版本或集合无效',
      409,
    );
  }
  const records = snapshot.records.map(projectRecord)
    .sort((left, right) => left.businessKey.localeCompare(right.businessKey));
  const tombstones = snapshot.tombstones.map(projectTombstone)
    .sort((left, right) => left.businessKey.localeCompare(right.businessKey));
  const activeKeys = new Set(records.map(item => item.businessKey));
  if (activeKeys.size !== records.length || new Set(tombstones.map(item => item.businessKey)).size !== tombstones.length
      || tombstones.some(item => activeKeys.has(item.businessKey))) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_SNAPSHOT_PARTITION_INVALID',
      '统一公共快照记录与墓碑分区无效',
      409,
    );
  }
  if (expectedCounts && (records.length !== expectedCounts.recordCount
      || tombstones.length !== expectedCounts.tombstoneCount)) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_SNAPSHOT_COUNT_MISMATCH',
      '统一公共快照数量与完整性报告不一致',
      409,
      {
        expectedRecords: expectedCounts.recordCount,
        actualRecords: records.length,
        expectedTombstones: expectedCounts.tombstoneCount,
        actualTombstones: tombstones.length,
      },
    );
  }
  const generatedAt = String(snapshot.generatedAt || '');
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_SNAPSHOT_TIME_INVALID', '统一公共快照时间无效', 500);
  }
  return Object.freeze({
    schemaVersion: 1,
    payloadSchemaVersion: Number.isSafeInteger(snapshot.payloadSchemaVersion) ? snapshot.payloadSchemaVersion : 1,
    groupId: scope.groupId,
    libraryId: scope.libraryId,
    baseOrdinaryVersion: versions.ordinaryVersion,
    publicVersion: versions.publicVersion,
    snapshotVersion: versions.publicVersion,
    cursor: `pv_${versions.publicVersion}`,
    generatedAt,
    records: Object.freeze(records),
    tombstones: Object.freeze(tombstones),
  });
}

function projectOrdinaryEvent(event) {
  const projected = Object.freeze({
    version: assertVersion(event?.version, '普通事件版本'),
    approvedAt: String(event?.approvedAt || ''),
    businessKey: assertBusinessKey(event?.businessKey, '普通事件'),
    contentHash: assertContentHash(event?.contentHash, '普通事件'),
    dataType: assertDataType(event?.dataType, '普通事件'),
    operation: String(event?.operation || ''),
    payload: event?.payload,
    baseline: Object.freeze({
      approvedVersion: assertVersion(event?.baseline?.approvedVersion, '普通事件基线版本'),
      contentHash: event?.baseline?.contentHash ?? null,
      unitPrice: event?.baseline?.unitPrice ?? null,
    }),
    approval: Object.freeze({
      mode: String(event?.approval?.mode || ''),
      evidenceCount: Array.isArray(event?.approval?.deviceIds) ? event.approval.deviceIds.length : 0,
    }),
  });
  if (projected.operation !== 'upsert' || !Number.isFinite(Date.parse(projected.approvedAt))) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_ORDINARY_EVENT_INVALID', '普通公共事件内容无效', 500);
  }
  assertNoPrivateFields(projected);
  return projected;
}

function projectSensitiveEvent(event) {
  const dataType = assertDataType(event?.dataType, '敏感事件');
  const operation = String(event?.operation || '');
  if (!['upsert', 'delete'].includes(operation)) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_SENSITIVE_EVENT_INVALID', '敏感公共事件操作无效', 500);
  }
  const projected = Object.freeze({
    version: assertVersion(event?.version, '敏感事件版本'),
    approvedAt: String(event?.approvedAt || ''),
    businessKey: assertBusinessKey(event?.businessKey, '敏感事件'),
    contentHash: assertContentHash(event?.contentHash, '敏感事件'),
    dataType,
    operation,
    bossId: dataType === 'boss_profile' ? String(event?.bossId || '') : null,
    payload: event?.payload ?? null,
    baseline: Object.freeze({
      approvedVersion: assertVersion(event?.baseline?.approvedVersion, '敏感事件基线版本'),
      contentHash: event?.baseline?.contentHash ?? null,
    }),
    approval: Object.freeze({ mode: String(event?.approval?.mode || '') }),
  });
  if (!Number.isFinite(Date.parse(projected.approvedAt))
      || (operation === 'delete') !== (projected.payload === null)) {
    throw new MaintenanceMigrationBundleError('MAINTENANCE_MIGRATION_SENSITIVE_EVENT_INVALID', '敏感公共事件内容无效', 500);
  }
  assertNoPrivateFields(projected);
  return projected;
}

function safeIntegrityProjection(report) {
  return Object.freeze({
    schemaVersion: 1,
    status: report.status,
    scope: Object.freeze({ ...report.scope }),
    checkedAt: report.checkedAt,
    readOnly: true,
    mutationsPerformed: 0,
    public: Object.freeze({
      ordinaryVersion: report.public.ordinaryVersion,
      sensitiveEventCount: report.public.sensitiveEventCount,
      publicVersion: report.public.publicVersion,
      snapshotVersion: report.public.snapshotVersion,
      recordCount: report.public.recordCount,
      tombstoneCount: report.public.tombstoneCount,
      latestChangeAt: report.public.latestChangeAt,
    }),
    checks: Object.freeze({ ...report.checks }),
  });
}

function fileDescriptors(files) {
  return Object.freeze([...files.entries()].map(([name, bytes]) => Object.freeze({
    name: name.slice(`${ROOT}/`.length),
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
  })).sort((left, right) => left.name.localeCompare(right.name)));
}

export function buildDailySnapshotArtifact({ integrityReport, snapshot, now = Date.now() } = {}) {
  const generatedAtMs = assertTime(now);
  const scope = normalizeScope(integrityReport?.scope?.groupId, integrityReport?.scope?.libraryId);
  const versions = assertIntegrityReport(integrityReport, scope, generatedAtMs);
  const projected = projectSnapshot(snapshot, scope, versions, {
    recordCount: integrityReport.public.recordCount,
    tombstoneCount: integrityReport.public.tombstoneCount,
  });
  const bytes = stableJson(projected);
  const sha256 = sha256Hex(bytes);
  return Object.freeze({
    schemaVersion: 1,
    scope,
    generatedAt: new Date(generatedAtMs).toISOString(),
    publicVersion: versions.publicVersion,
    snapshotVersion: versions.snapshotVersion,
    byteLength: bytes.length,
    sha256,
    bytes,
    marker: Object.freeze({
      publicVersion: versions.publicVersion,
      completedAt: new Date(generatedAtMs).toISOString(),
      artifactSha256: sha256,
    }),
    readOnly: true,
    mutationsPerformed: 0,
  });
}

export async function buildMaintenanceMigrationBundle({
  store,
  groupId,
  libraryId,
  now = Date.now(),
  dependencies = {},
} = {}) {
  const generatedAtMs = assertTime(now);
  const scope = normalizeScope(groupId, libraryId);
  const buildIntegrity = dependencies.buildIntegrityReport || buildMaintenanceIntegrityReport;
  const listOrdinary = dependencies.listOrdinaryEvents || listValidOrdinaryPublicEvents;
  const listSensitive = dependencies.listSensitiveEvents || listValidSensitivePublicEvents;
  const buildSnapshot = dependencies.buildSnapshot || buildUnifiedSensitivePublicSnapshot;

  let integrityReport;
  try {
    integrityReport = await buildIntegrity({ store, groupId: scope.groupId, libraryId: scope.libraryId, now: generatedAtMs });
  } catch (error) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_INTEGRITY_BUILD_FAILED',
      '生成迁移包前的完整性核查失败',
      error?.status || 503,
      null,
      error,
    );
  }
  const versions = assertIntegrityReport(integrityReport, scope, generatedAtMs);

  const ordinaryEvents = assertSequentialEvents(
    await listOrdinary({ store, groupId: scope.groupId, libraryId: scope.libraryId }),
    1,
    '普通公共事件链',
  );
  if ((ordinaryEvents.at(-1)?.version || 0) !== versions.ordinaryVersion) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_ORDINARY_VERSION_MISMATCH',
      '普通公共事件链与完整性报告版本不一致',
      409,
    );
  }

  const sensitiveEvents = assertSequentialEvents(
    await listSensitive({ store, libraryId: scope.libraryId, ordinaryVersion: versions.ordinaryVersion }),
    versions.ordinaryVersion + 1,
    '敏感公共事件链',
  );
  if ((sensitiveEvents.at(-1)?.version || versions.ordinaryVersion) !== versions.publicVersion) {
    throw new MaintenanceMigrationBundleError(
      'MAINTENANCE_MIGRATION_SENSITIVE_VERSION_MISMATCH',
      '敏感公共事件链与完整性报告版本不一致',
      409,
    );
  }

  const snapshot = await buildSnapshot({
    store,
    groupId: scope.groupId,
    libraryId: scope.libraryId,
    now: generatedAtMs,
  });
  const dailySnapshot = buildDailySnapshotArtifact({ integrityReport, snapshot, now: generatedAtMs });
  const ordinaryProjection = Object.freeze(ordinaryEvents.map(projectOrdinaryEvent));
  const sensitiveProjection = Object.freeze(sensitiveEvents.map(projectSensitiveEvent));
  const integrityProjection = safeIntegrityProjection(integrityReport);

  const contentFiles = new Map([
    [`${ROOT}/schema.json`, stableJson(Object.freeze({
      schemaVersion: MAINTENANCE_MIGRATION_BUNDLE_VERSION,
      packageFormatVersion: MAINTENANCE_MIGRATION_FORMAT_VERSION,
      encoding: 'utf-8',
      supportedDataTypes: SUPPORTED_DATA_TYPES,
      publicSnapshotSchemaVersion: 1,
      ordinaryEventProjectionVersion: 1,
      sensitiveEventProjectionVersion: 1,
      restoreMode: 'append_only_rebuild',
    }))],
    [`${ROOT}/public/snapshot.json`, dailySnapshot.bytes],
    [`${ROOT}/public/ordinary-events.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      groupId: scope.groupId,
      libraryId: scope.libraryId,
      publicVersion: versions.ordinaryVersion,
      events: ordinaryProjection,
    }))],
    [`${ROOT}/public/sensitive-events.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      groupId: scope.groupId,
      libraryId: scope.libraryId,
      baseOrdinaryVersion: versions.ordinaryVersion,
      publicVersion: versions.publicVersion,
      events: sensitiveProjection,
    }))],
    [`${ROOT}/maintenance/integrity.json`, stableJson(integrityProjection)],
    [`${ROOT}/restore/plan.json`, stableJson(Object.freeze({
      schemaVersion: 1,
      mode: 'append_only_rebuild',
      groupId: scope.groupId,
      libraryId: scope.libraryId,
      expectedOrdinaryVersion: versions.ordinaryVersion,
      expectedPublicVersion: versions.publicVersion,
      steps: Object.freeze([
        'verify_manifest_hashes',
        'validate_event_chains',
        'rebuild_unified_snapshot',
        'compare_snapshot_hash',
        'publish_only_after_manual_authorization',
      ]),
      automaticMutationAllowed: false,
    }))],
  ]);
  for (const [name, bytes] of contentFiles) assertNoPrivateFields(JSON.parse(bytes.toString('utf8')),
    `file:${name}`);

  const files = fileDescriptors(contentFiles);
  const packageId = `mpkg_v1_${sha256Base64Url(Buffer.from(canonicalize({
    schemaVersion: 1,
    scope,
    ordinaryVersion: versions.ordinaryVersion,
    publicVersion: versions.publicVersion,
    files,
  }), 'utf8'))}`;
  const generatedAt = new Date(generatedAtMs).toISOString();
  const manifest = Object.freeze({
    schemaVersion: 1,
    packageFormatVersion: 1,
    packageId,
    generatedAt,
    groupId: scope.groupId,
    libraryId: scope.libraryId,
    ordinaryVersion: versions.ordinaryVersion,
    publicVersion: versions.publicVersion,
    snapshotVersion: versions.snapshotVersion,
    recordCount: integrityReport.public.recordCount,
    tombstoneCount: integrityReport.public.tombstoneCount,
    ordinaryEventCount: ordinaryProjection.length,
    sensitiveEventCount: sensitiveProjection.length,
    files,
    readOnlySource: true,
    automaticMutationAllowed: false,
  });
  const entries = [...contentFiles.entries(), [`${ROOT}/manifest.json`, stableJson(manifest)]]
    .map(([name, data]) => ({ name, data }));
  const zip = createStoredZip(entries, {
    createdAt: generatedAtMs,
    maxBytes: MAINTENANCE_MIGRATION_MAX_BYTES,
  });
  const packageSha256 = sha256Hex(zip.bytes);

  return Object.freeze({
    schemaVersion: 1,
    scope,
    packageId,
    generatedAt,
    publicVersion: versions.publicVersion,
    ordinaryVersion: versions.ordinaryVersion,
    snapshotVersion: versions.snapshotVersion,
    recordCount: integrityReport.public.recordCount,
    tombstoneCount: integrityReport.public.tombstoneCount,
    ordinaryEventCount: ordinaryProjection.length,
    sensitiveEventCount: sensitiveProjection.length,
    filename: `码单器公共数据库迁移_v${versions.publicVersion}.zip`,
    contentType: 'application/zip',
    byteLength: zip.byteLength,
    fileCount: zip.entryCount,
    packageSha256,
    bytes: zip.bytes,
    dailySnapshot: Object.freeze({
      byteLength: dailySnapshot.byteLength,
      sha256: dailySnapshot.sha256,
      marker: dailySnapshot.marker,
    }),
    marker: Object.freeze({
      publicVersion: versions.publicVersion,
      completedAt: generatedAt,
      packageId,
      packageSha256,
    }),
    readOnly: true,
    mutationsPerformed: 0,
  });
}

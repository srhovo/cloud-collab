import { createHash } from 'node:crypto';

import { canonicalize } from './submission_policy_v1.js';
import { listValidOrdinaryPublicEvents } from './ordinary_public_engine_v1.js';
import {
  buildUnifiedSensitivePublicSnapshot,
  listValidSensitivePublicEvents,
} from './sensitive_public_engine_v1.js';
import { createStoredZip } from './zip_store_v1.js';

export const PRODUCTION_EXPORT_BUNDLE_VERSION = 1;
export const PRODUCTION_EXPORT_MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
export const PRODUCTION_EXPORT_FILENAME_PREFIX = '码单器公共数据库';

const ROOT = '码单器公共数据库导出';
const DATA_TYPES = Object.freeze([
  'exact_price',
  'playable_name',
  'boss_profile',
  'rank_range_rule',
  'surcharge_rule',
  'gift_rule',
]);

export class ProductionAdminExportBundleError extends Error {
  constructor(code, message, status = 500, details = null, cause = null) {
    super(message || code || '正式公共数据库导出包生成失败');
    this.name = 'ProductionAdminExportBundleError';
    this.code = code || 'PRODUCTION_ADMIN_EXPORT_BUNDLE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function stableJson(value) {
  return `${JSON.stringify(JSON.parse(canonicalize(value)), null, 2)}\n`;
}

function digestHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestBase64Url(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function assertTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_999_999_999_999) {
    throw new ProductionAdminExportBundleError('PRODUCTION_EXPORT_TIME_INVALID', '正式导出时间无效');
  }
}

function validateConfig(config) {
  if (config?.productionEnabled !== true
      || config?.storeName !== 'cloud-collab-production-v1'
      || config?.groupId !== 'group_see'
      || config?.libraryId !== 'lib_see_cz') {
    throw new ProductionAdminExportBundleError(
      'PRODUCTION_EXPORT_CONFIG_INVALID',
      '正式导出配置、Store或作用域无效',
      503,
    );
  }
}

function descriptorMap(files) {
  return Object.freeze([...files.entries()]
    .map(([name, data]) => Object.freeze({
      name,
      byteLength: Buffer.byteLength(data, 'utf8'),
      sha256: digestHex(data),
    }))
    .sort((left, right) => left.name.localeCompare(right.name)));
}

function recordsOfType(snapshot, dataType) {
  return Object.freeze(snapshot.records
    .filter(record => record.dataType === dataType)
    .map(record => Object.freeze({ ...record }))
    .sort((left, right) => left.businessKey.localeCompare(right.businessKey)));
}

function sanitizeOrdinaryEvent(event) {
  return Object.freeze({
    version: event.version,
    approvedAt: event.approvedAt,
    groupId: event.groupId,
    libraryId: event.libraryId,
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    dataType: event.dataType,
    operation: event.operation,
    payload: event.payload,
    baseline: event.baseline,
    approval: Object.freeze({
      mode: event.approval.mode,
      evidenceCount: event.approval.deviceIds.length,
    }),
  });
}

function sanitizeSensitiveEvent(event) {
  return Object.freeze({
    version: event.version,
    baseOrdinaryVersion: event.baseOrdinaryVersion,
    approvedAt: event.approvedAt,
    groupId: event.groupId,
    libraryId: event.libraryId,
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    dataType: event.dataType,
    operation: event.operation,
    bossId: event.bossId,
    payload: event.payload,
    baseline: event.baseline,
    approval: Object.freeze({ mode: event.approval.mode }),
  });
}

async function loadValidatedPublicState({ store, config, now }) {
  let ordinaryEvents;
  let sensitiveEvents;
  let snapshot;
  try {
    ordinaryEvents = await listValidOrdinaryPublicEvents({
      store,
      libraryId: config.libraryId,
    });
    const ordinaryVersion = ordinaryEvents.length
      ? ordinaryEvents[ordinaryEvents.length - 1].version
      : 0;
    sensitiveEvents = await listValidSensitivePublicEvents({
      store,
      libraryId: config.libraryId,
      ordinaryVersion,
    });
    snapshot = await buildUnifiedSensitivePublicSnapshot({
      store,
      groupId: config.groupId,
      libraryId: config.libraryId,
      now,
    });
    return { ordinaryEvents, sensitiveEvents, snapshot };
  } catch (error) {
    throw new ProductionAdminExportBundleError(
      'PRODUCTION_EXPORT_PUBLIC_STATE_INVALID',
      '公共事件或统一快照无法通过正式导出校验',
      503,
      null,
      error,
    );
  }
}

function buildFiles({ config, snapshot, ordinaryEvents, sensitiveEvents, generatedAt }) {
  const files = new Map();
  const ordinaryAudit = ordinaryEvents.map(sanitizeOrdinaryEvent);
  const sensitiveAudit = sensitiveEvents.map(sanitizeSensitiveEvent);
  const byType = Object.fromEntries(DATA_TYPES.map(type => [type, recordsOfType(snapshot, type)]));

  files.set(`${ROOT}/schema/schema.json`, stableJson({
    schemaVersion: 1,
    packageFormatVersion: 2,
    snapshotSchemaVersion: snapshot.schemaVersion,
    supportedDataTypes: DATA_TYPES,
    tombstonesIncluded: true,
    publicEventHistoryIncluded: true,
    privateCredentialsIncluded: false,
  }));
  files.set(`${ROOT}/groups/index.json`, stableJson({
    schemaVersion: 1,
    groups: [{ groupId: config.groupId, externalClubId: config.externalScope.clubId }],
  }));
  files.set(`${ROOT}/libraries/${config.libraryId}.json`, stableJson({
    schemaVersion: 1,
    groupId: config.groupId,
    libraryId: config.libraryId,
    externalClubId: config.externalScope.clubId,
    externalLibraryId: config.externalScope.libraryId,
    publicVersion: snapshot.publicVersion,
    generatedAt: snapshot.generatedAt,
    recordCount: snapshot.records.length,
    tombstoneCount: snapshot.tombstones.length,
  }));
  files.set(`${ROOT}/snapshot/all.json`, stableJson(snapshot));
  files.set(`${ROOT}/exact-prices/index.json`, stableJson({ schemaVersion: 1, records: byType.exact_price }));
  files.set(`${ROOT}/playable-names/index.json`, stableJson({ schemaVersion: 1, records: byType.playable_name }));
  files.set(`${ROOT}/bosses/index.json`, stableJson({ schemaVersion: 1, records: byType.boss_profile }));
  files.set(`${ROOT}/rules/rank-ranges.json`, stableJson({ schemaVersion: 1, records: byType.rank_range_rule }));
  files.set(`${ROOT}/rules/surcharges.json`, stableJson({ schemaVersion: 1, records: byType.surcharge_rule }));
  files.set(`${ROOT}/rules/gifts.json`, stableJson({ schemaVersion: 1, records: byType.gift_rule }));
  files.set(`${ROOT}/tombstones/index.json`, stableJson({
    schemaVersion: 1,
    tombstones: snapshot.tombstones,
  }));
  files.set(`${ROOT}/audit/ordinary-public-events.json`, stableJson({
    schemaVersion: 1,
    count: ordinaryAudit.length,
    events: ordinaryAudit,
  }));
  files.set(`${ROOT}/audit/sensitive-public-events.json`, stableJson({
    schemaVersion: 1,
    count: sensitiveAudit.length,
    events: sensitiveAudit,
  }));
  files.set(`${ROOT}/README.json`, stableJson({
    schemaVersion: 1,
    generatedAt,
    restoreOrder: [
      'schema/schema.json',
      'groups/index.json',
      `libraries/${config.libraryId}.json`,
      'snapshot/all.json',
      'audit/ordinary-public-events.json',
      'audit/sensitive-public-events.json',
    ],
    note: 'snapshot/all.json是恢复公共数据库的权威快照；audit目录用于历史审计。',
  }));
  return { files, byType, ordinaryAudit, sensitiveAudit };
}

export async function buildProductionAdminExportBundle({
  store,
  config,
  now = Date.now(),
} = {}) {
  validateConfig(config);
  assertTime(now);
  const generatedAt = new Date(now).toISOString();
  const { ordinaryEvents, sensitiveEvents, snapshot } = await loadValidatedPublicState({
    store,
    config,
    now,
  });
  const content = buildFiles({ config, snapshot, ordinaryEvents, sensitiveEvents, generatedAt });
  const files = descriptorMap(content.files);
  const packageId = `pkg_v2_${digestBase64Url(canonicalize({
    schemaVersion: 1,
    packageFormatVersion: 2,
    groupId: config.groupId,
    libraryId: config.libraryId,
    publicVersion: snapshot.publicVersion,
    files,
  }))}`;
  const countsByType = Object.freeze(Object.fromEntries(
    DATA_TYPES.map(type => [type, content.byType[type].length]),
  ));
  const manifest = Object.freeze({
    schemaVersion: 1,
    packageFormatVersion: 2,
    packageId,
    generatedAt,
    groupId: config.groupId,
    libraryId: config.libraryId,
    externalScope: config.externalScope,
    publicVersion: snapshot.publicVersion,
    recordCount: snapshot.records.length,
    tombstoneCount: snapshot.tombstones.length,
    ordinaryEventCount: content.ordinaryAudit.length,
    sensitiveEventCount: content.sensitiveAudit.length,
    countsByType,
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
    recordCount: snapshot.records.length,
    tombstoneCount: snapshot.tombstones.length,
    ordinaryEventCount: content.ordinaryAudit.length,
    sensitiveEventCount: content.sensitiveAudit.length,
    countsByType,
    filename: `${PRODUCTION_EXPORT_FILENAME_PREFIX}-${config.externalScope.clubId}-${config.externalScope.libraryId}-v${snapshot.publicVersion}.zip`,
    contentType: 'application/zip',
  });
}

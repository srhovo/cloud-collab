import { getJSONStrong, normalizeBlobKey } from './blob_repository_v1.js';
import {
  buildUnifiedSensitivePublicSnapshot,
  listValidSensitivePublicEvents,
} from './sensitive_public_engine_v1.js';
import {
  listValidOrdinaryPublicEvents,
} from './ordinary_public_engine_v1.js';

export const MAINTENANCE_INTEGRITY_VERSION = 1;
export const MAINTENANCE_INVENTORY_LIMIT = 20_000;

const GROUP_ID_PATTERN = /^group_[a-z0-9][a-z0-9_]{2,47}$/;
const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
const BUSINESS_KEY_PATTERN = /^bk_v1_[A-Za-z0-9_-]{43}$/;

export class MaintenanceIntegrityError extends Error {
  constructor(code, message, status = 500, details = null, cause = null) {
    super(message || code || '维护完整性核查失败');
    this.name = 'MaintenanceIntegrityError';
    this.code = code || 'MAINTENANCE_INTEGRITY_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function normalizeId(value, pattern, code, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!pattern.test(text)) throw new MaintenanceIntegrityError(code, `${label}格式无效`, 400);
  return text;
}

function normalizeScope(groupId, libraryId) {
  return Object.freeze({
    groupId: normalizeId(groupId, GROUP_ID_PATTERN, 'MAINTENANCE_GROUP_ID_INVALID', 'groupId'),
    libraryId: normalizeId(libraryId, LIBRARY_ID_PATTERN, 'MAINTENANCE_LIBRARY_ID_INVALID', 'libraryId'),
  });
}

function assertNow(now) {
  if (!Number.isSafeInteger(now) || now <= 0 || now > 9_999_999_999_999) {
    throw new MaintenanceIntegrityError('MAINTENANCE_TIME_INVALID', '维护核查时间无效', 400);
  }
  return now;
}

function assertVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999_999_999_999) {
    throw new MaintenanceIntegrityError('MAINTENANCE_VERSION_INVALID', `${label}无效`, 500, { value });
  }
  return value;
}

function assertSequentialVersions(events, startVersion, code, label) {
  if (!Array.isArray(events)) {
    throw new MaintenanceIntegrityError(code, `${label}必须为数组`, 500);
  }
  for (let index = 0; index < events.length; index += 1) {
    const expected = startVersion + index;
    const actual = events[index]?.version;
    if (actual !== expected) {
      throw new MaintenanceIntegrityError(code, `${label}版本不连续`, 500, {
        index,
        expected,
        actual,
      });
    }
  }
  return events;
}

function latestApprovedAt(events) {
  if (!events.length) return null;
  const value = String(events.at(-1)?.approvedAt || '');
  if (!Number.isFinite(Date.parse(value))) {
    throw new MaintenanceIntegrityError('MAINTENANCE_EVENT_TIME_INVALID', '公共事件批准时间无效', 500, { value });
  }
  return value;
}

function assertBusinessKey(value, label) {
  const text = String(value || '');
  if (!BUSINESS_KEY_PATTERN.test(text)) {
    throw new MaintenanceIntegrityError('MAINTENANCE_BUSINESS_KEY_INVALID', `${label}业务键无效`, 500);
  }
  return text;
}

function validateSnapshot(snapshot, scope, ordinaryVersion, publicVersion) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new MaintenanceIntegrityError('MAINTENANCE_SNAPSHOT_INVALID', '统一公共快照结构无效', 500);
  }
  if (snapshot.groupId !== scope.groupId || snapshot.libraryId !== scope.libraryId) {
    throw new MaintenanceIntegrityError('MAINTENANCE_SNAPSHOT_SCOPE_MISMATCH', '统一公共快照作用域不一致', 500);
  }
  if (snapshot.baseOrdinaryVersion !== ordinaryVersion) {
    throw new MaintenanceIntegrityError('MAINTENANCE_ORDINARY_BASE_MISMATCH', '统一公共快照普通基线版本不一致', 500, {
      expected: ordinaryVersion,
      actual: snapshot.baseOrdinaryVersion,
    });
  }
  if (snapshot.publicVersion !== publicVersion || snapshot.snapshotVersion !== publicVersion) {
    throw new MaintenanceIntegrityError('MAINTENANCE_SNAPSHOT_VERSION_MISMATCH', '统一公共快照版本不一致', 500, {
      expected: publicVersion,
      publicVersion: snapshot.publicVersion,
      snapshotVersion: snapshot.snapshotVersion,
    });
  }
  if (snapshot.cursor !== `pv_${publicVersion}`) {
    throw new MaintenanceIntegrityError('MAINTENANCE_SNAPSHOT_CURSOR_MISMATCH', '统一公共快照游标不一致', 500, {
      expected: `pv_${publicVersion}`,
      actual: snapshot.cursor,
    });
  }
  if (!Number.isFinite(Date.parse(String(snapshot.generatedAt || '')))) {
    throw new MaintenanceIntegrityError('MAINTENANCE_SNAPSHOT_TIME_INVALID', '统一公共快照生成时间无效', 500);
  }

  const records = Array.isArray(snapshot.records) ? snapshot.records : null;
  const tombstones = Array.isArray(snapshot.tombstones) ? snapshot.tombstones : null;
  if (!records || !tombstones) {
    throw new MaintenanceIntegrityError('MAINTENANCE_SNAPSHOT_COLLECTION_INVALID', '统一公共快照记录或墓碑不是数组', 500);
  }

  const activeKeys = new Set();
  for (const record of records) {
    const key = assertBusinessKey(record?.businessKey, '公共记录');
    if (activeKeys.has(key)) {
      throw new MaintenanceIntegrityError('MAINTENANCE_DUPLICATE_ACTIVE_RECORD', '统一公共快照包含重复生效记录', 500, { businessKey: key });
    }
    activeKeys.add(key);
  }

  const tombstoneKeys = new Set();
  for (const tombstone of tombstones) {
    const key = assertBusinessKey(tombstone?.businessKey, '删除墓碑');
    if (tombstoneKeys.has(key)) {
      throw new MaintenanceIntegrityError('MAINTENANCE_DUPLICATE_TOMBSTONE', '统一公共快照包含重复墓碑', 500, { businessKey: key });
    }
    if (activeKeys.has(key)) {
      throw new MaintenanceIntegrityError('MAINTENANCE_ACTIVE_TOMBSTONE_OVERLAP', '同一业务键同时存在生效记录和墓碑', 500, { businessKey: key });
    }
    tombstoneKeys.add(key);
  }

  return Object.freeze({ records, tombstones });
}

async function listInventoryKeys(store, prefix) {
  if (!store || typeof store.list !== 'function') {
    throw new MaintenanceIntegrityError('MAINTENANCE_BLOB_LIST_UNAVAILABLE', '维护核查需要Blob list能力', 500);
  }
  const normalizedPrefix = `${normalizeBlobKey(String(prefix || '').replace(/\/+$/, ''))}/`;
  let result;
  try {
    result = await store.list({ prefix: normalizedPrefix, consistency: 'strong' });
  } catch (error) {
    throw new MaintenanceIntegrityError('MAINTENANCE_BLOB_LIST_FAILED', '维护核查强一致列举Blob失败', 503, { prefix: normalizedPrefix }, error);
  }
  const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
  if (blobs.length > MAINTENANCE_INVENTORY_LIMIT) {
    throw new MaintenanceIntegrityError('MAINTENANCE_INVENTORY_LIMIT_EXCEEDED', '维护核查对象数超过安全上限', 409, {
      prefix: normalizedPrefix,
      objectCount: blobs.length,
      maxObjects: MAINTENANCE_INVENTORY_LIMIT,
    });
  }
  const keys = blobs.map(item => String(item?.key || '')).filter(Boolean);
  if (keys.length !== blobs.length || new Set(keys).size !== keys.length || keys.some(key => !key.startsWith(normalizedPrefix))) {
    throw new MaintenanceIntegrityError('MAINTENANCE_INVENTORY_INVALID', '维护核查列举结果包含空Key、重复Key或越界Key', 503, {
      prefix: normalizedPrefix,
    });
  }
  return keys.sort();
}

async function countStoredCandidates(store, libraryId) {
  const keys = await listInventoryKeys(store, `submissions/${libraryId}/pending`);
  let invalidReceivedAtCount = 0;
  let oldestReceivedAt = null;
  for (const key of keys) {
    const candidate = await getJSONStrong(store, key);
    const receivedAt = candidate?.receivedAt;
    if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) {
      invalidReceivedAtCount += 1;
      continue;
    }
    oldestReceivedAt = oldestReceivedAt === null ? receivedAt : Math.min(oldestReceivedAt, receivedAt);
  }
  return Object.freeze({
    objectCount: keys.length,
    invalidReceivedAtCount,
    oldestReceivedAt,
  });
}

export async function buildMaintenanceIntegrityReport({
  store,
  groupId,
  libraryId,
  now = Date.now(),
  dependencies = {},
} = {}) {
  const scope = normalizeScope(groupId, libraryId);
  const checkedAt = assertNow(now);
  const listOrdinaryEvents = dependencies.listOrdinaryEvents || listValidOrdinaryPublicEvents;
  const listSensitiveEvents = dependencies.listSensitiveEvents || listValidSensitivePublicEvents;
  const buildSnapshot = dependencies.buildSnapshot || buildUnifiedSensitivePublicSnapshot;
  const inventoryCounter = dependencies.countStoredCandidates || countStoredCandidates;

  const ordinaryEvents = await listOrdinaryEvents({ store, groupId: scope.groupId, libraryId: scope.libraryId });
  assertSequentialVersions(ordinaryEvents, 1, 'MAINTENANCE_ORDINARY_CHAIN_INVALID', '普通公共事件链');
  const ordinaryVersion = assertVersion(ordinaryEvents.at(-1)?.version || 0, '普通公共版本');

  const sensitiveEvents = await listSensitiveEvents({ store, libraryId: scope.libraryId, ordinaryVersion });
  assertSequentialVersions(sensitiveEvents, ordinaryVersion + 1, 'MAINTENANCE_SENSITIVE_CHAIN_INVALID', '敏感公共事件链');
  const publicVersion = assertVersion(sensitiveEvents.at(-1)?.version || ordinaryVersion, '统一公共版本');

  const snapshot = await buildSnapshot({
    store,
    groupId: scope.groupId,
    libraryId: scope.libraryId,
    now: checkedAt,
  });
  const collections = validateSnapshot(snapshot, scope, ordinaryVersion, publicVersion);
  const candidateInventory = await inventoryCounter(store, scope.libraryId);

  const allEvents = [...ordinaryEvents, ...sensitiveEvents];
  const latestChangeAt = latestApprovedAt(allEvents);
  const oldestStoredCandidateAgeMs = candidateInventory.oldestReceivedAt === null
    ? null
    : Math.max(0, checkedAt - candidateInventory.oldestReceivedAt);

  return Object.freeze({
    schemaVersion: MAINTENANCE_INTEGRITY_VERSION,
    scope,
    checkedAt: new Date(checkedAt).toISOString(),
    status: candidateInventory.invalidReceivedAtCount === 0 ? 'healthy' : 'attention_required',
    readOnly: true,
    mutationsPerformed: 0,
    public: Object.freeze({
      ordinaryVersion,
      sensitiveEventCount: sensitiveEvents.length,
      publicVersion,
      snapshotVersion: snapshot.snapshotVersion,
      recordCount: collections.records.length,
      tombstoneCount: collections.tombstones.length,
      latestChangeAt,
    }),
    inventory: Object.freeze({
      storedCandidateObjectCount: candidateInventory.objectCount,
      invalidCandidateTimeCount: candidateInventory.invalidReceivedAtCount,
      oldestStoredCandidateAgeMs,
    }),
    checks: Object.freeze({
      ordinaryEventChainValid: true,
      sensitiveEventChainValid: true,
      snapshotScopeValid: true,
      snapshotVersionValid: true,
      snapshotCursorValid: true,
      businessKeyPartitionValid: true,
      strongInventoryRead: true,
    }),
  });
}

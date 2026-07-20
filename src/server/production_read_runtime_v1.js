import {
  buildUnifiedSensitivePublicSnapshot,
  listUnifiedPublicEvents,
} from './sensitive_public_engine_v1.js';
import {
  ProductionRuntimeConfigError,
  readProductionRuntimeConfig,
} from './production_runtime_config_v1.js';

export const PRODUCTION_READ_RUNTIME_VERSION = 1;
export const MAX_PRODUCTION_CHANGE_LIMIT = 100;

export class ProductionReadRuntimeError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '生产只读同步失败');
    this.name = 'ProductionReadRuntimeError';
    this.code = code || 'PRODUCTION_READ_RUNTIME_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

export function readProductionReadConfig(env = {}) {
  let runtime;
  try { runtime = readProductionRuntimeConfig(env); }
  catch (error) {
    if (error instanceof ProductionRuntimeConfigError) {
      throw new ProductionReadRuntimeError(error.code, error.message, 503, error.details, error);
    }
    throw error;
  }
  if (runtime.mode !== 'production' || runtime.flags.production !== true || runtime.flags.readSync !== true) {
    throw new ProductionReadRuntimeError('PRODUCTION_READ_SYNC_DISABLED', '正式只读同步未开启', 503);
  }
  return Object.freeze({
    schemaVersion: PRODUCTION_READ_RUNTIME_VERSION,
    runtime,
    externalScope: runtime.scope.external,
    protocolScope: runtime.scope.protocol,
    storeName: runtime.publicStoreName,
    publicOrigin: runtime.publicOrigin,
  });
}

export function resolveProductionReadScope(groupId, libraryId, config) {
  const group = normalize(groupId);
  const library = normalize(libraryId);
  const external = config?.externalScope || {};
  const protocol = config?.protocolScope || {};
  const groupAccepted = group === external.clubId || group === protocol.groupId;
  const libraryAccepted = library === external.libraryId || library === protocol.libraryId;
  if (!groupAccepted || !libraryAccepted) {
    throw new ProductionReadRuntimeError(
      'PRODUCTION_READ_SCOPE_FORBIDDEN',
      '请求的club或价格库不属于正式只读作用域',
      403,
      {
        externalScope: external,
        protocolScope: protocol,
      },
    );
  }
  return Object.freeze({
    external: Object.freeze({ clubId: external.clubId, libraryId: external.libraryId }),
    protocol: Object.freeze({ groupId: protocol.groupId, libraryId: protocol.libraryId }),
  });
}

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.list !== 'function') {
    throw new ProductionReadRuntimeError('PRODUCTION_READ_STORE_INVALID', '生产只读Store必须提供get与list能力', 503);
  }
  return store;
}

function assertSnapshotScope(snapshot, scope) {
  if (!snapshot || snapshot.groupId !== scope.protocol.groupId || snapshot.libraryId !== scope.protocol.libraryId) {
    throw new ProductionReadRuntimeError('PRODUCTION_SNAPSHOT_SCOPE_MISMATCH', '公共快照作用域与正式配置不一致', 500);
  }
  return snapshot;
}

function assertEventScope(events, scope) {
  for (const event of events) {
    if (event.groupId !== scope.protocol.groupId || event.libraryId !== scope.protocol.libraryId) {
      throw new ProductionReadRuntimeError('PRODUCTION_EVENT_SCOPE_MISMATCH', '公共事件作用域与正式配置不一致', 500, {
        eventKey: event.eventKey || null,
      });
    }
  }
  return events;
}

export function projectProductionPublicEvent(event) {
  return Object.freeze({
    version: event.version,
    approvedAt: event.approvedAt,
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    dataType: event.dataType,
    operation: event.operation,
    payload: event.payload,
    ...(event.bossId ? { bossId: event.bossId } : {}),
  });
}

export function projectProductionSnapshot(snapshot, scope) {
  return Object.freeze({
    ...snapshot,
    groupId: scope.external.clubId,
    libraryId: scope.external.libraryId,
    protocolScope: scope.protocol,
  });
}

export async function readProductionPublicSnapshot({
  store,
  env,
  groupId,
  libraryId,
  now = Date.now(),
  buildSnapshot = buildUnifiedSensitivePublicSnapshot,
} = {}) {
  const config = readProductionReadConfig(env);
  const scope = resolveProductionReadScope(groupId, libraryId, config);
  const snapshot = await buildSnapshot({
    store: assertStore(store),
    groupId: scope.protocol.groupId,
    libraryId: scope.protocol.libraryId,
    now,
  });
  return projectProductionSnapshot(assertSnapshotScope(snapshot, scope), scope);
}

export async function readProductionPublicEvents({
  store,
  env,
  groupId,
  libraryId,
  listEvents = listUnifiedPublicEvents,
} = {}) {
  const config = readProductionReadConfig(env);
  const scope = resolveProductionReadScope(groupId, libraryId, config);
  const events = await listEvents({
    store: assertStore(store),
    groupId: scope.protocol.groupId,
    libraryId: scope.protocol.libraryId,
  });
  if (!Array.isArray(events)) {
    throw new ProductionReadRuntimeError('PRODUCTION_EVENTS_INVALID', '公共事件读取结果必须为数组', 500);
  }
  return Object.freeze({ config, scope, events: Object.freeze(assertEventScope(events, scope).map(projectProductionPublicEvent)) });
}

export function productionReadFlags(config) {
  const flags = config?.runtime?.flags || {};
  return Object.freeze({
    productionEnabled: flags.production === true,
    readSyncEnabled: flags.readSync === true,
    ordinarySubmissionEnabled: flags.ordinarySubmission === true,
    autoApprovalEnabled: flags.autoApproval === true,
    sensitiveSubmissionEnabled: flags.sensitiveSubmission === true,
    adminReviewEnabled: flags.adminReview === true,
    stablePromotionAuthorized: false,
  });
}

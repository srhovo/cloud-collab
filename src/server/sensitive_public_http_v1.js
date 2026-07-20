import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertPreviewRequestAccess,
  readPreviewWriteConfig,
} from './preview_write_runtime_v1.js';
import { readAdminSensitiveReviewConfig } from './admin_sensitive_review_v1.js';
import {
  buildUnifiedSensitivePublicSnapshot,
  listUnifiedPublicEvents,
} from './sensitive_public_engine_v1.js';

const SERVICE_ID = 'cloud-collab-sensitive-readonly';
const API_VERSION = '2026-07-20-stage6b';
const MAX_CHANGE_LIMIT = 100;

export class SensitivePublicHttpError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '敏感公共读取失败');
    this.name = 'SensitivePublicHttpError';
    this.code = code || 'SENSITIVE_PUBLIC_HTTP_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, X-Cloud-Collab-Preview-Key',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function jsonResponse(payload, { status = 200, headers = {}, head = false } = {}) {
  return new Response(head ? null : JSON.stringify(payload), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=UTF-8', ...headers }),
  });
}

function success(data, { status = 200, head = false } = {}) {
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data }, { status, head });
}

function failure(error, { head = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'SENSITIVE_PUBLIC_INTERNAL_ERROR';
  const message = status >= 500 ? '敏感公共读取暂时不可用' : (error?.message || '敏感公共读取请求失败');
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code, message, ...(status < 500 && error?.details ? { details: error.details } : {}) },
  }, { status, head });
}

function methodNotAllowed(method, allow, head = false) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `敏感公共读取接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow }, head });
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function parseUrl(request) {
  try {
    return new URL(request?.url || '');
  } catch (_) {
    throw new SensitivePublicHttpError('SENSITIVE_PUBLIC_REQUEST_INVALID', '敏感公共读取请求地址无效', 400);
  }
}

function parseScope(request) {
  const url = parseUrl(request);
  return Object.freeze({
    url,
    groupId: String(url.searchParams.get('groupId') || '').trim().toLowerCase(),
    libraryId: String(url.searchParams.get('libraryId') || '').trim().toLowerCase(),
  });
}

function parseInteger(raw, { code, message, fallback = null, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if ((raw === null || raw === '') && fallback === null) return null;
  const value = raw === null || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SensitivePublicHttpError(code, message, 400);
  }
  return value;
}

export function readSensitivePublicReadConfig(env = {}) {
  let preview;
  let sensitive;
  try {
    preview = readPreviewWriteConfig(env);
    sensitive = readAdminSensitiveReviewConfig(env);
  } catch (error) {
    throw new SensitivePublicHttpError(
      error?.code || 'SENSITIVE_PUBLIC_CONFIG_INVALID',
      error?.message || '敏感公共读取配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  if (preview.allowedGroupId !== sensitive.groupId || preview.allowedLibraryId !== sensitive.libraryId) {
    throw new SensitivePublicHttpError('SENSITIVE_PUBLIC_SCOPE_INVALID', '敏感公共读取必须与隔离写入使用同一合成作用域', 503);
  }
  return Object.freeze({
    schemaVersion: 1,
    storeName: sensitive.storeName,
    groupId: sensitive.groupId,
    libraryId: sensitive.libraryId,
    previewAccessKey: preview.previewAccessKey,
  });
}

function authenticateAndScope(context) {
  const env = context?.env || {};
  const config = readSensitivePublicReadConfig(env);
  assertPreviewRequestAccess(context?.request, config);
  const scope = parseScope(context?.request);
  if (scope.groupId !== config.groupId || scope.libraryId !== config.libraryId) {
    throw new SensitivePublicHttpError('SENSITIVE_PUBLIC_SCOPE_FORBIDDEN', '敏感公共读取只允许合成测试团和测试价格库', 403);
  }
  return Object.freeze({ env, config, scope });
}

function createStore(env, config, dependencies) {
  const factory = dependencies.createStore || createEdgeOneBlobStore;
  return factory({ ...env, CLOUD_BLOB_STORE_NAME: config.storeName });
}

function countSnapshot(snapshot) {
  const recordCounts = {
    exactPrice: 0,
    playableName: 0,
    bossProfile: 0,
    rankRangeRule: 0,
    surchargeRule: 0,
    giftRule: 0,
  };
  for (const record of snapshot.records) {
    if (record.dataType === 'exact_price') recordCounts.exactPrice += 1;
    else if (record.dataType === 'playable_name') recordCounts.playableName += 1;
    else if (record.dataType === 'boss_profile') recordCounts.bossProfile += 1;
    else if (record.dataType === 'rank_range_rule') recordCounts.rankRangeRule += 1;
    else if (record.dataType === 'surcharge_rule') recordCounts.surchargeRule += 1;
    else if (record.dataType === 'gift_rule') recordCounts.giftRule += 1;
  }
  const tombstoneCounts = {
    exactPrice: 0,
    playableName: 0,
    bossProfile: 0,
    rankRangeRule: 0,
    surchargeRule: 0,
    giftRule: 0,
  };
  for (const item of snapshot.tombstones) {
    if (item.dataType === 'exact_price') tombstoneCounts.exactPrice += 1;
    else if (item.dataType === 'playable_name') tombstoneCounts.playableName += 1;
    else if (item.dataType === 'boss_profile') tombstoneCounts.bossProfile += 1;
    else if (item.dataType === 'rank_range_rule') tombstoneCounts.rankRangeRule += 1;
    else if (item.dataType === 'surcharge_rule') tombstoneCounts.surchargeRule += 1;
    else if (item.dataType === 'gift_rule') tombstoneCounts.giftRule += 1;
  }
  return Object.freeze({
    recordCounts: Object.freeze(recordCounts),
    tombstoneCounts: Object.freeze(tombstoneCounts),
  });
}

function flags() {
  return Object.freeze({
    writeEnabled: false,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
    previewSensitiveReviewEnabled: true,
    sensitiveChangesRequireManualReview: true,
    tombstonesEnabled: true,
  });
}

function projectEvent(event) {
  return Object.freeze({
    version: event.version,
    approvedAt: event.approvedAt,
    businessKey: event.businessKey,
    contentHash: event.contentHash,
    dataType: event.dataType,
    operation: event.operation,
    payload: event.payload,
    ...(event.dataType === 'boss_profile' ? { bossId: event.bossId || null } : {}),
  });
}

export async function handleSensitivePublicVersionRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  const head = method === 'HEAD';
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'GET' && !head) return methodNotAllowed(method, 'GET, HEAD, OPTIONS', head);
  try {
    const { env, config, scope } = authenticateAndScope(context);
    if ([...scope.url.searchParams.keys()].some(key => !['groupId', 'libraryId'].includes(key))) {
      throw new SensitivePublicHttpError('SENSITIVE_PUBLIC_QUERY_INVALID', '敏感公共版本查询参数无效', 400);
    }
    const store = createStore(env, config, dependencies);
    const buildSnapshot = dependencies.buildSnapshot || buildUnifiedSensitivePublicSnapshot;
    const snapshot = await buildSnapshot({ store, groupId: scope.groupId, libraryId: scope.libraryId, now: dependencies.now?.() ?? Date.now() });
    return success({
      groupId: snapshot.groupId,
      libraryId: snapshot.libraryId,
      publicVersion: snapshot.publicVersion,
      snapshotVersion: snapshot.snapshotVersion,
      baseOrdinaryVersion: snapshot.baseOrdinaryVersion,
      updatedAt: snapshot.publicVersion > 0 ? snapshot.generatedAt : null,
      status: snapshot.publicVersion > 0 ? 'sensitive_preview_ready' : 'sensitive_preview_empty',
      snapshotAvailable: snapshot.publicVersion > 0,
      ...countSnapshot(snapshot),
      ...flags(),
    }, { head });
  } catch (error) {
    return failure(error, { head });
  }
}

export async function handleSensitivePublicSnapshotRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  const head = method === 'HEAD';
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'GET' && !head) return methodNotAllowed(method, 'GET, HEAD, OPTIONS', head);
  try {
    const { env, config, scope } = authenticateAndScope(context);
    if ([...scope.url.searchParams.keys()].some(key => !['groupId', 'libraryId', 'ifVersion'].includes(key))) {
      throw new SensitivePublicHttpError('SENSITIVE_PUBLIC_QUERY_INVALID', '敏感公共快照查询参数无效', 400);
    }
    const ifVersion = parseInteger(scope.url.searchParams.get('ifVersion'), {
      code: 'INVALID_PUBLIC_VERSION', message: 'ifVersion必须是非负整数', fallback: null,
    });
    const store = createStore(env, config, dependencies);
    const buildSnapshot = dependencies.buildSnapshot || buildUnifiedSensitivePublicSnapshot;
    const snapshot = await buildSnapshot({ store, groupId: scope.groupId, libraryId: scope.libraryId, now: dependencies.now?.() ?? Date.now() });
    let status = 'snapshot';
    let payloadSnapshot = snapshot;
    if (snapshot.publicVersion === 0) {
      status = 'snapshot_unavailable';
      payloadSnapshot = null;
    } else if (ifVersion !== null && ifVersion >= snapshot.publicVersion) {
      status = 'not_modified';
      payloadSnapshot = null;
    }
    return success({
      status,
      groupId: snapshot.groupId,
      libraryId: snapshot.libraryId,
      publicVersion: snapshot.publicVersion,
      snapshotVersion: snapshot.snapshotVersion,
      baseOrdinaryVersion: snapshot.baseOrdinaryVersion,
      snapshot: payloadSnapshot,
      ...flags(),
    }, { head });
  } catch (error) {
    return failure(error, { head });
  }
}

export async function handleSensitivePublicChangesRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  const head = method === 'HEAD';
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'GET' && !head) return methodNotAllowed(method, 'GET, HEAD, OPTIONS', head);
  try {
    const { env, config, scope } = authenticateAndScope(context);
    if ([...scope.url.searchParams.keys()].some(key => !['groupId', 'libraryId', 'sinceVersion', 'limit'].includes(key))) {
      throw new SensitivePublicHttpError('SENSITIVE_PUBLIC_QUERY_INVALID', '敏感公共增量查询参数无效', 400);
    }
    const sinceVersion = parseInteger(scope.url.searchParams.get('sinceVersion'), {
      code: 'INVALID_PUBLIC_VERSION', message: 'sinceVersion必须是非负整数', fallback: 0,
    });
    const limit = parseInteger(scope.url.searchParams.get('limit'), {
      code: 'INVALID_CHANGE_LIMIT', message: 'limit必须位于1至100', fallback: 100, min: 1, max: MAX_CHANGE_LIMIT,
    });
    const store = createStore(env, config, dependencies);
    const listEvents = dependencies.listEvents || listUnifiedPublicEvents;
    const events = await listEvents({ store, groupId: scope.groupId, libraryId: scope.libraryId });
    const publicVersion = events.length ? events[events.length - 1].version : 0;
    if (sinceVersion > publicVersion) {
      throw new SensitivePublicHttpError('PUBLIC_VERSION_AHEAD', '本地版本高于敏感预览服务器版本，需要重新读取快照', 409, { sinceVersion, publicVersion });
    }
    const selected = events.filter(event => event.version > sinceVersion).slice(0, limit);
    const nextVersion = selected.length ? selected[selected.length - 1].version : sinceVersion;
    return success({
      status: selected.length ? 'changes' : 'not_modified',
      groupId: scope.groupId,
      libraryId: scope.libraryId,
      sinceVersion,
      publicVersion,
      nextVersion,
      hasMore: nextVersion < publicVersion,
      changes: Object.freeze(selected.map(projectEvent)),
      ...flags(),
    }, { head });
  } catch (error) {
    return failure(error, { head });
  }
}

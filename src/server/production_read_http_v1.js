import { createEdgeOneNamedBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  MAX_PRODUCTION_CHANGE_LIMIT,
  ProductionReadRuntimeError,
  productionReadFlags,
  readProductionPublicEvents,
  readProductionPublicSnapshot,
  readProductionReadConfig,
  resolveProductionReadScope,
} from './production_read_runtime_v1.js';

const SERVICE_ID = 'cloud-collab-production-readonly';
const API_VERSION = '2026-07-21-stage7o';

function method(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function baseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=UTF-8',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function corsHeaders(request, config, extra = {}) {
  const requestOrigin = String(request?.headers?.get?.('origin') || '').trim();
  const allowedOrigin = config?.publicOrigin || '';
  const cors = requestOrigin && requestOrigin === allowedOrigin
    ? {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    }
    : {};
  return baseHeaders({ ...cors, ...extra });
}

function response(payload, { status = 200, headers = {}, head = false } = {}) {
  return new Response(head ? null : JSON.stringify(payload), { status, headers: baseHeaders(headers) });
}

function success(request, config, data, { status = 200, head = false } = {}) {
  return new Response(head ? null : JSON.stringify({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    data,
  }), {
    status,
    headers: corsHeaders(request, config),
  });
}

function failure(request, error, { config = null, head = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '正式只读同步暂时不可用' : (error?.message || '请求失败');
  const details = status < 500 && error?.details ? { details: error.details } : {};
  return new Response(head ? null : JSON.stringify({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code, message, ...details },
  }), {
    status,
    headers: corsHeaders(request, config, status === 429 ? { 'Retry-After': '60' } : {}),
  });
}

function methodNotAllowed(request, allow, head = false) {
  return response({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `接口不支持${method(request)}方法` },
  }, { status: 405, headers: { Allow: allow }, head });
}

function parseScope(request) {
  const url = new URL(request.url);
  return Object.freeze({
    groupId: String(url.searchParams.get('groupId') || url.searchParams.get('clubId') || '').trim(),
    libraryId: String(url.searchParams.get('libraryId') || '').trim(),
    url,
  });
}

function parseInteger(raw, { fallback, min, max, code, message }) {
  const value = raw === null || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProductionReadRuntimeError(code, message, 400, { min, max });
  }
  return value;
}

function createStoreForConfig(config, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
  return createStore(config.storeName);
}

function options(request, config) {
  return new Response(null, { status: 204, headers: corsHeaders(request, config) });
}

export async function handleProductionPublicVersionRequest(context, dependencies = {}) {
  const request = context?.request;
  const requestMethod = method(request);
  const head = requestMethod === 'HEAD';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(requestMethod)) return methodNotAllowed(request, 'GET, HEAD, OPTIONS', head);
  let config = null;
  try {
    config = readProductionReadConfig(context?.env || {});
    if (requestMethod === 'OPTIONS') return options(request, config);
    const requested = parseScope(request);
    const scope = resolveProductionReadScope(requested.groupId, requested.libraryId, config);
    const store = createStoreForConfig(config, dependencies);
    const result = await readProductionPublicEvents({
      store,
      env: context.env,
      groupId: requested.groupId,
      libraryId: requested.libraryId,
      ...(dependencies.listEvents ? { listEvents: dependencies.listEvents } : {}),
    });
    const publicVersion = result.events.length ? result.events[result.events.length - 1].version : 0;
    return success(request, config, {
      groupId: scope.external.clubId,
      libraryId: scope.external.libraryId,
      protocolScope: scope.protocol,
      publicVersion,
      snapshotVersion: publicVersion,
      snapshotAvailable: publicVersion > 0,
      status: publicVersion > 0 ? 'production_ready' : 'production_empty',
      recordCounts: null,
      ...productionReadFlags(config),
    }, { head });
  } catch (error) {
    return failure(request, error, { config, head });
  }
}

export async function handleProductionPublicSnapshotRequest(context, dependencies = {}) {
  const request = context?.request;
  const requestMethod = method(request);
  const head = requestMethod === 'HEAD';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(requestMethod)) return methodNotAllowed(request, 'GET, HEAD, OPTIONS', head);
  let config = null;
  try {
    config = readProductionReadConfig(context?.env || {});
    if (requestMethod === 'OPTIONS') return options(request, config);
    const requested = parseScope(request);
    const ifVersion = parseInteger(requested.url.searchParams.get('ifVersion'), {
      fallback: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      code: 'INVALID_PUBLIC_VERSION',
      message: 'ifVersion必须是非负整数',
    });
    const store = createStoreForConfig(config, dependencies);
    const snapshot = await readProductionPublicSnapshot({
      store,
      env: context.env,
      groupId: requested.groupId,
      libraryId: requested.libraryId,
      now: dependencies.now?.() || Date.now(),
      ...(dependencies.buildSnapshot ? { buildSnapshot: dependencies.buildSnapshot } : {}),
    });
    let status = 'snapshot';
    let payloadSnapshot = snapshot;
    if (snapshot.publicVersion === 0) {
      status = 'snapshot_unavailable';
      payloadSnapshot = null;
    } else if (ifVersion >= snapshot.publicVersion) {
      status = 'not_modified';
      payloadSnapshot = null;
    }
    return success(request, config, {
      status,
      groupId: config.externalScope.clubId,
      libraryId: config.externalScope.libraryId,
      protocolScope: config.protocolScope,
      publicVersion: snapshot.publicVersion,
      snapshotVersion: snapshot.snapshotVersion,
      snapshot: payloadSnapshot,
      ...productionReadFlags(config),
    }, { head });
  } catch (error) {
    return failure(request, error, { config, head });
  }
}

export async function handleProductionPublicChangesRequest(context, dependencies = {}) {
  const request = context?.request;
  const requestMethod = method(request);
  const head = requestMethod === 'HEAD';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(requestMethod)) return methodNotAllowed(request, 'GET, HEAD, OPTIONS', head);
  let config = null;
  try {
    config = readProductionReadConfig(context?.env || {});
    if (requestMethod === 'OPTIONS') return options(request, config);
    const requested = parseScope(request);
    const sinceVersion = parseInteger(requested.url.searchParams.get('sinceVersion'), {
      fallback: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      code: 'INVALID_PUBLIC_VERSION',
      message: 'sinceVersion必须是非负整数',
    });
    const limit = parseInteger(requested.url.searchParams.get('limit'), {
      fallback: MAX_PRODUCTION_CHANGE_LIMIT,
      min: 1,
      max: MAX_PRODUCTION_CHANGE_LIMIT,
      code: 'INVALID_CHANGE_LIMIT',
      message: `limit必须位于1至${MAX_PRODUCTION_CHANGE_LIMIT}`,
    });
    const store = createStoreForConfig(config, dependencies);
    const result = await readProductionPublicEvents({
      store,
      env: context.env,
      groupId: requested.groupId,
      libraryId: requested.libraryId,
      ...(dependencies.listEvents ? { listEvents: dependencies.listEvents } : {}),
    });
    const publicVersion = result.events.length ? result.events[result.events.length - 1].version : 0;
    if (sinceVersion > publicVersion) {
      throw new ProductionReadRuntimeError('PUBLIC_VERSION_AHEAD', '本地版本高于正式服务器版本，需要重新读取快照', 409, {
        sinceVersion,
        publicVersion,
      });
    }
    const selected = result.events.filter(event => event.version > sinceVersion).slice(0, limit);
    const nextVersion = selected.length ? selected[selected.length - 1].version : sinceVersion;
    return success(request, config, {
      status: selected.length ? 'changes' : 'not_modified',
      groupId: result.scope.external.clubId,
      libraryId: result.scope.external.libraryId,
      protocolScope: result.scope.protocol,
      sinceVersion,
      publicVersion,
      snapshotVersion: publicVersion,
      changes: selected,
      nextVersion,
      hasMore: result.events.some(event => event.version > nextVersion),
      ...productionReadFlags(config),
    }, { head });
  } catch (error) {
    return failure(request, error, { config, head });
  }
}

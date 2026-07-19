import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  readAdminAuthConfig,
  readAdminSessionCookie,
  verifyAdminSessionToken,
} from './admin_auth_v1.js';
import {
  ADMIN_ROLLBACK_CAPABILITIES,
  ADMIN_ROLLBACK_MAX_BODY_BYTES,
  AdminRollbackError,
  executeAdminRollback,
  isAdminRollbackProjectionSafe,
  listAdminRollbackCandidates,
  readAdminRollbackConfig,
} from './admin_rollback_v1.js';

const SERVICE_ID = 'cloud-collab-admin-rollback-preview';
const API_VERSION = '2026-07-20-stage5e';

function responseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Cookie, Origin',
    ...extra,
  };
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders({ 'Content-Type': 'application/json; charset=UTF-8', ...headers }),
  });
}

function viewer(identity) {
  return Object.freeze({
    authenticated: true,
    username: identity.username,
    sessionIdSuffix: identity.sessionIdSuffix,
    expiresAt: identity.expiresAt,
  });
}

function success(identity, result) {
  const data = {
    viewer: viewer(identity),
    result,
    capabilities: ADMIN_ROLLBACK_CAPABILITIES,
  };
  if (!isAdminRollbackProjectionSafe(data)) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_UNSAFE_RESPONSE', '管理员回滚响应包含禁止字段', 500);
  }
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data });
}

function failure(error, { clearSession = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : 'ADMIN_ROLLBACK_INTERNAL_ERROR';
  const message = status >= 500
    ? '管理员回滚暂时不可用'
    : (error?.message || '管理员回滚请求失败');
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code, message },
  }, {
    status,
    headers: clearSession ? { 'Set-Cookie': clearAdminSessionCookie() } : {},
  });
}

function methodNotAllowed(method, allow) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `管理员回滚接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function parseRequestUrl(request) {
  try {
    return new URL(request?.url || '');
  } catch (_) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_REQUEST_INVALID', '管理员回滚请求地址无效', 400);
  }
}

function assertNoQuery(request) {
  if ([...parseRequestUrl(request).searchParams.keys()].length !== 0) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_QUERY_INVALID', '管理员回滚接口不接受查询参数', 400);
  }
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_CONTENT_TYPE_INVALID', '管理员回滚只接受JSON', 415);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 2 || bytes > ADMIN_ROLLBACK_MAX_BODY_BYTES) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_BODY_SIZE_INVALID', '管理员回滚请求大小无效', 413);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new AdminRollbackError('ADMIN_ROLLBACK_JSON_INVALID', '管理员回滚JSON无效', 400);
  }
}

function authenticateAndConfigure(context, dependencies, { requireOrigin = false } = {}) {
  const env = context?.env || {};
  const authConfig = readAdminAuthConfig(env);
  assertAdminSameOriginRequest(context.request, {
    requireOrigin,
    publicOrigin: authConfig.publicOrigin,
  });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  const rollbackConfig = readAdminRollbackConfig(env);
  return { env, identity, rollbackConfig };
}

function createRollbackStore(env, rollbackConfig, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneBlobStore;
  return createStore({ ...env, CLOUD_BLOB_STORE_NAME: rollbackConfig.storeName });
}

export async function handleAdminRollbackListRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { env, identity, rollbackConfig } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const store = createRollbackStore(env, rollbackConfig, dependencies);
    const list = dependencies.listCandidates || listAdminRollbackCandidates;
    const result = await list({ store, config: rollbackConfig });
    return success(identity, result);
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

export async function handleAdminRollbackExecuteRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const { env, identity, rollbackConfig } = authenticateAndConfigure(
      context,
      dependencies,
      { requireOrigin: true },
    );
    assertNoQuery(context.request);
    const command = await readJsonBody(context.request);
    const store = createRollbackStore(env, rollbackConfig, dependencies);
    const execute = dependencies.executeRollback || executeAdminRollback;
    const result = await execute({
      store,
      config: rollbackConfig,
      identity,
      command,
      now: dependencies.now?.() ?? Date.now(),
    });
    return success(identity, result);
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

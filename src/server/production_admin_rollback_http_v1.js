import { createEdgeOneNamedBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  readAdminSessionCookie,
} from './admin_auth_v1.js';
import {
  readProductionAdminAuthConfig,
  verifyProductionAdminSessionToken,
} from './production_admin_auth_v1.js';
import { readProductionRuntimeConfig } from './production_runtime_config_v1.js';
import {
  ADMIN_ROLLBACK_CAPABILITIES,
  ADMIN_ROLLBACK_MAX_BODY_BYTES,
  AdminRollbackError,
  executeAdminRollback,
  isAdminRollbackProjectionSafe,
  listAdminRollbackCandidates,
} from './admin_rollback_v1.js';

const SERVICE_ID = 'cloud-collab-admin-rollback-production';
const API_VERSION = '2026-07-21-stage7aa';

export class ProductionAdminRollbackError extends Error {
  constructor(code, message, status = 503, details = null, cause = null) {
    super(message || code || '正式管理员回滚失败');
    this.name = 'ProductionAdminRollbackError';
    this.code = code || 'PRODUCTION_ADMIN_ROLLBACK_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function readProductionAdminRollbackConfig(env = {}) {
  let runtime;
  try {
    runtime = readProductionRuntimeConfig(env);
  } catch (error) {
    throw new ProductionAdminRollbackError(
      error?.code || 'PRODUCTION_ADMIN_ROLLBACK_CONFIG_INVALID',
      error?.message || '正式管理员回滚配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  if (runtime.mode !== 'production'
      || runtime.flags.readSync !== true
      || runtime.flags.admin !== true
      || runtime.flags.rollback !== true) {
    throw new ProductionAdminRollbackError(
      'PRODUCTION_ADMIN_ROLLBACK_DISABLED',
      '正式管理员回滚能力未开启',
      503,
    );
  }
  const rollbackRefSalt = String(runtime.secrets.CLOUD_ADMIN_ROLLBACK_REF_SALT || '');
  if (Buffer.byteLength(rollbackRefSalt, 'utf8') < 32) {
    throw new ProductionAdminRollbackError(
      'PRODUCTION_ADMIN_ROLLBACK_REF_SALT_INVALID',
      '正式回滚引用盐值无效',
      503,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    previewEnabled: false,
    productionEnabled: true,
    mode: 'production',
    storeName: runtime.publicStoreName,
    groupId: runtime.scope.protocol.groupId,
    libraryId: runtime.scope.protocol.libraryId,
    rollbackRefSalt,
    externalScope: runtime.scope.external,
    protocolScope: runtime.scope.protocol,
    publicOrigin: runtime.adminOrigin,
    syntheticFixtureOnly: false,
    stablePromotionAuthorized: false,
  });
}

const PRODUCTION_CAPABILITIES = Object.freeze({
  ...ADMIN_ROLLBACK_CAPABILITIES,
  productionAdmin: true,
  syntheticFixtureOnly: false,
  stablePromotionAuthorized: false,
});

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

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function methodNotAllowed(method, allow) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: { code: 'METHOD_NOT_ALLOWED', message: `正式管理员回滚接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: {
      code: error?.code || 'PRODUCTION_ADMIN_ROLLBACK_INTERNAL_ERROR',
      message: status >= 500 ? '正式管理员回滚暂时不可用' : (error?.message || '管理员回滚请求失败'),
    },
  }, {
    status,
    headers: error?.status === 401 ? { 'Set-Cookie': clearAdminSessionCookie() } : {},
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
    capabilities: PRODUCTION_CAPABILITIES,
    realSecretValuesExposed: false,
    stablePromotionAuthorized: false,
  };
  if (!isAdminRollbackProjectionSafe(data)) {
    throw new ProductionAdminRollbackError(
      'PRODUCTION_ADMIN_ROLLBACK_UNSAFE_RESPONSE',
      '正式管理员回滚响应包含禁止字段',
      500,
    );
  }
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, mode: 'production', data });
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
  const authConfig = readProductionAdminAuthConfig(env);
  const rollbackConfig = readProductionAdminRollbackConfig(env);
  if (authConfig.publicOrigin !== rollbackConfig.publicOrigin) {
    throw new ProductionAdminRollbackError(
      'PRODUCTION_ADMIN_ROLLBACK_ORIGIN_MISMATCH',
      '正式管理员身份与回滚来源不一致',
      503,
    );
  }
  assertAdminSameOriginRequest(context.request, { requireOrigin, publicOrigin: authConfig.publicOrigin });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyProductionAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  return { identity, rollbackConfig };
}

function createRollbackStore(config, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
  return createStore(config.storeName);
}

export async function handleProductionAdminRollbackListRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { identity, rollbackConfig } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const list = dependencies.listCandidates || listAdminRollbackCandidates;
    const result = await list({
      store: createRollbackStore(rollbackConfig, dependencies),
      config: rollbackConfig,
    });
    return success(identity, result);
  } catch (error) {
    return failure(error);
  }
}

export async function handleProductionAdminRollbackExecuteRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const { identity, rollbackConfig } = authenticateAndConfigure(
      context,
      dependencies,
      { requireOrigin: true },
    );
    assertNoQuery(context.request);
    const command = await readJsonBody(context.request);
    const execute = dependencies.executeRollback || executeAdminRollback;
    const result = await execute({
      store: createRollbackStore(rollbackConfig, dependencies),
      config: rollbackConfig,
      identity,
      command,
      now: dependencies.now?.() ?? Date.now(),
    });
    return success(identity, result);
  } catch (error) {
    return failure(error);
  }
}

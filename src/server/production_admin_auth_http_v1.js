import { createEdgeOneNamedBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  ADMIN_AUTH_CAPABILITIES,
  AdminAuthError,
  adminClientAddress,
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  createAdminSessionCookie,
  readAdminSessionCookie,
} from './admin_auth_v1.js';
import {
  consumeProductionAdminLoginRate,
  createProductionAdminSessionToken,
  readProductionAdminAuthConfig,
  verifyAdminCredentials,
  verifyProductionAdminSessionToken,
} from './production_admin_auth_v1.js';

const SERVICE_ID = 'cloud-collab-admin-auth-production';
const API_VERSION = '2026-07-21-stage7s';
const MAX_LOGIN_BYTES = 2 * 1024;

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

function success(data, { status = 200, headers = {} } = {}) {
  return jsonResponse({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    data,
  }, { status, headers });
}

function failure(error, { clearSession = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'ADMIN_INTERNAL_ERROR';
  const message = status >= 500 ? '正式管理员登录暂时不可用' : (error?.message || '管理员请求失败');
  const retryAfter = status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
    ? { 'Retry-After': String(error.details.retryAfterSeconds) }
    : {};
  const cookie = clearSession ? { 'Set-Cookie': clearAdminSessionCookie() } : {};
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: { code, message },
  }, { status, headers: { ...retryAfter, ...cookie } });
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
    error: { code: 'METHOD_NOT_ALLOWED', message: `管理员接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

async function readJsonBody(request, maxBytes) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new AdminAuthError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AdminAuthError('REQUEST_BODY_TOO_LARGE', `请求体不得超过${maxBytes}字节`, 413);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) throw new AdminAuthError('EMPTY_JSON_BODY', '请求体不能为空', 400);
  if (bytes > maxBytes) throw new AdminAuthError('REQUEST_BODY_TOO_LARGE', `请求体不得超过${maxBytes}字节`, 413);
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new AdminAuthError('INVALID_JSON_BODY', '请求体不是有效JSON', 400);
  }
}

function parseLoginInput(value) {
  const expected = ['password', 'schemaVersion', 'username'];
  const actual = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)
      || value.schemaVersion !== 1
      || typeof value.username !== 'string'
      || typeof value.password !== 'string'
      || Buffer.byteLength(value.username, 'utf8') > 128
      || Buffer.byteLength(value.password, 'utf8') > 512) {
    throw new AdminAuthError('INVALID_ADMIN_LOGIN_REQUEST', '管理员登录请求无效', 400);
  }
  return value;
}

function authData(identity, config) {
  return Object.freeze({
    authenticated: true,
    mode: 'production',
    username: identity.username,
    issuedAt: identity.issuedAt,
    expiresAt: identity.expiresAt,
    sessionIdSuffix: identity.sessionIdSuffix,
    externalScope: config.externalScope,
    protocolScope: config.protocolScope,
    capabilities: ADMIN_AUTH_CAPABILITIES,
    realSecretValuesExposed: false,
    stablePromotionAuthorized: false,
  });
}

export async function handleProductionAdminLoginRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const env = context?.env || {};
    const config = readProductionAdminAuthConfig(env);
    assertAdminSameOriginRequest(context.request, { requireOrigin: true, publicOrigin: config.publicOrigin });
    const input = parseLoginInput(await readJsonBody(context.request, MAX_LOGIN_BYTES));
    const now = dependencies.now?.() ?? Date.now();
    const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
    const consumeRate = dependencies.consumeRate || consumeProductionAdminLoginRate;
    const store = createStore(config.storeName);
    await consumeRate({
      store,
      username: input.username,
      clientAddress: adminClientAddress(context.request),
      salt: config.rateLimitSalt,
      now,
    });
    if (!verifyAdminCredentials(config, input)) {
      throw new AdminAuthError('ADMIN_CREDENTIALS_INVALID', '管理员用户名或密码错误', 401);
    }
    const session = createProductionAdminSessionToken({
      config,
      now,
      randomBytes: dependencies.randomBytes,
    });
    const identity = verifyProductionAdminSessionToken(session.token, config, { now });
    return success(authData(identity, config), {
      headers: { 'Set-Cookie': createAdminSessionCookie(session.token) },
    });
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

export async function handleProductionAdminSessionRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const env = context?.env || {};
    const config = readProductionAdminAuthConfig(env);
    assertAdminSameOriginRequest(context.request, { publicOrigin: config.publicOrigin });
    const token = readAdminSessionCookie(context.request);
    const identity = verifyProductionAdminSessionToken(token, config, {
      now: dependencies.now?.() ?? Date.now(),
    });
    return success(authData(identity, config));
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

export async function handleProductionAdminLogoutRequest(context) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const config = readProductionAdminAuthConfig(context?.env || {});
    assertAdminSameOriginRequest(context.request, { requireOrigin: true, publicOrigin: config.publicOrigin });
    return new Response(null, {
      status: 204,
      headers: responseHeaders({ 'Set-Cookie': clearAdminSessionCookie() }),
    });
  } catch (error) {
    return failure(error, { clearSession: false });
  }
}

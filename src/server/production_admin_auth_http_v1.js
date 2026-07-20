import { createEdgeOneNamedBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  ADMIN_AUTH_CAPABILITIES,
  AdminAuthError,
  adminClientAddress,
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  consumeAdminLoginRate,
  createAdminSessionCookie,
  createAdminSessionToken,
  readAdminSessionCookie,
  verifyAdminCredentials,
  verifyAdminSessionToken,
} from './admin_auth_v1.js';
import { readProductionRuntimeConfig } from './production_runtime_config_v1.js';

const SERVICE_ID = 'cloud-collab-admin-auth-production';
const API_VERSION = '2026-07-21-stage7s';
const MAX_LOGIN_BYTES = 2 * 1024;

export class ProductionAdminAuthError extends Error {
  constructor(code, message, status = 503, details = null, cause = null) {
    super(message || code || '正式管理员身份验证失败');
    this.name = 'ProductionAdminAuthError';
    this.code = code || 'PRODUCTION_ADMIN_AUTH_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function readProductionAdminAuthConfig(env = {}) {
  let runtime;
  try {
    runtime = readProductionRuntimeConfig(env);
  } catch (error) {
    throw new ProductionAdminAuthError(
      error?.code || 'PRODUCTION_ADMIN_CONFIG_INVALID',
      error?.message || '正式管理员配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  if (runtime.mode !== 'production' || runtime.flags.admin !== true) {
    throw new ProductionAdminAuthError('PRODUCTION_ADMIN_DISABLED', '正式管理员身份能力未开启', 503);
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: 'production',
    username: runtime.adminUsername,
    password: runtime.secrets.CLOUD_ADMIN_PASSWORD,
    sessionSecret: runtime.secrets.CLOUD_ADMIN_SESSION_SECRET,
    rateLimitSalt: runtime.secrets.CLOUD_ADMIN_RATE_LIMIT_SALT,
    storeName: runtime.adminStoreName,
    publicOrigin: runtime.adminOrigin,
    sessionTtlSeconds: 15 * 60,
    stablePromotionAuthorized: false,
  });
}

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
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data }, { status, headers });
}

function failure(error, { clearSession = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'PRODUCTION_ADMIN_INTERNAL_ERROR';
  const message = status >= 500 ? '正式管理员登录暂时不可用' : (error?.message || '管理员请求失败');
  const retryAfter = status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
    ? { 'Retry-After': String(error.details.retryAfterSeconds) }
    : {};
  const cookie = clearSession ? { 'Set-Cookie': clearAdminSessionCookie() } : {};
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
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
    error: { code: 'METHOD_NOT_ALLOWED', message: `正式管理员接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new ProductionAdminAuthError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGIN_BYTES) {
    throw new ProductionAdminAuthError('REQUEST_BODY_TOO_LARGE', `请求体不得超过${MAX_LOGIN_BYTES}字节`, 413);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) throw new ProductionAdminAuthError('EMPTY_JSON_BODY', '请求体不能为空', 400);
  if (bytes > MAX_LOGIN_BYTES) {
    throw new ProductionAdminAuthError('REQUEST_BODY_TOO_LARGE', `请求体不得超过${MAX_LOGIN_BYTES}字节`, 413);
  }
  try { return JSON.parse(text); }
  catch (_) { throw new ProductionAdminAuthError('INVALID_JSON_BODY', '请求体不是有效JSON', 400); }
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
    throw new ProductionAdminAuthError('INVALID_ADMIN_LOGIN_REQUEST', '管理员登录请求无效', 400);
  }
  return value;
}

function authData(identity) {
  return Object.freeze({
    authenticated: true,
    username: identity.username,
    issuedAt: identity.issuedAt,
    expiresAt: identity.expiresAt,
    sessionIdSuffix: identity.sessionIdSuffix,
    capabilities: Object.freeze({
      ...ADMIN_AUTH_CAPABILITIES,
      productionAdmin: true,
      stablePromotionAuthorized: false,
    }),
  });
}

export async function handleProductionAdminLoginRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const config = readProductionAdminAuthConfig(context?.env || {});
    assertAdminSameOriginRequest(context.request, { requireOrigin: true, publicOrigin: config.publicOrigin });
    const input = parseLoginInput(await readJsonBody(context.request));
    const now = dependencies.now?.() ?? Date.now();
    const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
    const consumeRate = dependencies.consumeRate || consumeAdminLoginRate;
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
    const session = createAdminSessionToken({ config, now, randomBytes: dependencies.randomBytes });
    const identity = verifyAdminSessionToken(session.token, config, { now });
    return success(authData(identity), {
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
    const config = readProductionAdminAuthConfig(context?.env || {});
    assertAdminSameOriginRequest(context.request, { publicOrigin: config.publicOrigin });
    const token = readAdminSessionCookie(context.request);
    const identity = verifyAdminSessionToken(token, config, { now: dependencies.now?.() ?? Date.now() });
    return success(authData(identity));
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
    return failure(error);
  }
}

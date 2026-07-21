import { createEdgeOneNamedBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  ProductionAdminAuthError,
  authenticateProductionAdminCredentials,
  consumeProductionAdminLoginRateLimit,
  consumeProductionAdminSessionRateLimit,
  createProductionAdminSessionToken,
  projectProductionAdminSession,
  readProductionAdminAuthConfig,
  verifyProductionAdminSessionToken,
} from './production_admin_auth_v1.js';
import {
  assertSameOrigin,
  buildAdminSessionCookie,
  clearAdminSessionCookie,
  extractAdminSessionCookie,
} from './admin_auth_v1.js';

const SERVICE_ID = 'cloud-collab-admin-production';
const API_VERSION = '2026-07-21-stage7t';
const MAX_LOGIN_BODY_BYTES = 4096;

function method(request) { return String(request?.method || 'GET').toUpperCase(); }
function headers(extra = {}) { return { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=UTF-8', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...extra }; }
function response(payload, { status = 200, extraHeaders = {} } = {}) { return new Response(JSON.stringify(payload), { status, headers: headers(extraHeaders) }); }
function success(data, options = {}) { return response({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data }, options); }
function failure(error, extraHeaders = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '正式管理员身份服务暂时不可用' : (error?.message || '管理员请求失败');
  const details = status < 500 && error?.details ? { details: error.details } : {};
  const retryAfter = status === 429 && Number.isInteger(error?.details?.retryAfterSeconds) ? { 'Retry-After': String(error.details.retryAfterSeconds) } : {};
  return response({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION, error: { code, message, ...details } }, { status, extraHeaders: { ...retryAfter, ...extraHeaders } });
}
function methodNotAllowed(request, allow) { return response({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION, error: { code: 'METHOD_NOT_ALLOWED', message: `管理员接口不支持${method(request)}方法` } }, { status: 405, extraHeaders: { Allow: allow } }); }
function storeFor(config, dependencies) { const createStore = dependencies.createStore || createEdgeOneNamedBlobStore; return createStore(config.storeName); }
async function readLoginBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new ProductionAdminAuthError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_LOGIN_BODY_BYTES) throw new ProductionAdminAuthError('REQUEST_BODY_TOO_LARGE', '管理员登录请求体过大', 413);
  const text = await request.text();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_LOGIN_BODY_BYTES) throw new ProductionAdminAuthError('INVALID_LOGIN_BODY', '管理员登录请求体无效', text ? 413 : 400);
  try { return JSON.parse(text); } catch (_) { throw new ProductionAdminAuthError('INVALID_JSON_BODY', '管理员登录请求体不是有效JSON', 400); }
}
function requestSubject(request, username) {
  return [String(username || '').trim().toLowerCase(), String(request?.headers?.get?.('cf-connecting-ip') || request?.headers?.get?.('x-forwarded-for') || 'unknown').split(',')[0].trim()].join('|');
}

export async function requireProductionAdminSession(context, dependencies = {}) {
  const request = context?.request;
  const env = context?.env || {};
  const config = readProductionAdminAuthConfig(env);
  assertSameOrigin(request, config.publicOrigin);
  const store = storeFor(config, dependencies);
  const token = extractAdminSessionCookie(request, config);
  const now = dependencies.now?.() || Date.now();
  const session = verifyProductionAdminSessionToken(token, config, now);
  await consumeProductionAdminSessionRateLimit({ store, config, sessionId: session.sessionId, now });
  return Object.freeze({ config, store, session });
}

export async function handleProductionAdminLoginRequest(context, dependencies = {}) {
  const request = context?.request;
  if (method(request) !== 'POST') return methodNotAllowed(request, 'POST');
  try {
    const config = readProductionAdminAuthConfig(context?.env || {});
    assertSameOrigin(request, config.publicOrigin);
    const input = await readLoginBody(request);
    const store = storeFor(config, dependencies);
    const now = dependencies.now?.() || Date.now();
    await consumeProductionAdminLoginRateLimit({ store, config, subject: requestSubject(request, input?.username), now });
    const identity = authenticateProductionAdminCredentials(input, config);
    const token = createProductionAdminSessionToken({ username: identity.username, now, randomBytes: dependencies.randomBytes }, config);
    const verified = verifyProductionAdminSessionToken(token, config, now);
    return success(projectProductionAdminSession(verified, config), { extraHeaders: { 'Set-Cookie': buildAdminSessionCookie(token, config) } });
  } catch (error) { return failure(error); }
}

export async function handleProductionAdminSessionRequest(context, dependencies = {}) {
  const request = context?.request;
  if (method(request) !== 'GET') return methodNotAllowed(request, 'GET');
  try { const { config, session } = await requireProductionAdminSession(context, dependencies); return success(projectProductionAdminSession(session, config)); }
  catch (error) { return failure(error); }
}

export async function handleProductionAdminLogoutRequest(context, dependencies = {}) {
  const request = context?.request;
  if (method(request) !== 'POST') return methodNotAllowed(request, 'POST');
  try {
    const config = readProductionAdminAuthConfig(context?.env || {});
    assertSameOrigin(request, config.publicOrigin);
    const token = extractAdminSessionCookie(request, config);
    if (token) verifyProductionAdminSessionToken(token, config, dependencies.now?.() || Date.now());
    return success({ loggedOut: true }, { extraHeaders: { 'Set-Cookie': clearAdminSessionCookie(config) } });
  } catch (error) {
    let config = null; try { config = readProductionAdminAuthConfig(context?.env || {}); } catch (_) {}
    return failure(error, config ? { 'Set-Cookie': clearAdminSessionCookie(config) } : {});
  }
}

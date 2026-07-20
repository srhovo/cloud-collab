import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  readAdminAuthConfig,
  readAdminSessionCookie,
  verifyAdminSessionToken,
} from './admin_auth_v1.js';
import {
  ADMIN_SENSITIVE_REVIEW_CAPABILITIES,
  ADMIN_SENSITIVE_REVIEW_MAX_BODY_BYTES,
  AdminSensitiveReviewError,
  getAdminSensitiveReviewDetail,
  isAdminSensitiveProjectionSafe,
  listAdminSensitiveReviewQueue,
  mutateAdminSensitiveReview,
  readAdminSensitiveReviewConfig,
} from './admin_sensitive_review_v1.js';

const SERVICE_ID = 'cloud-collab-admin-sensitive-review-preview';
const API_VERSION = '2026-07-20-stage6b';

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

function success(data, status = 200) {
  const payload = { ...data, capabilities: ADMIN_SENSITIVE_REVIEW_CAPABILITIES };
  if (!isAdminSensitiveProjectionSafe(payload)) {
    throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_UNSAFE_PROJECTION', '敏感审核响应包含禁止字段', 500);
  }
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data: payload }, { status });
}

function failure(error, { clearSession = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'ADMIN_SENSITIVE_INTERNAL_ERROR';
  const message = status >= 500 ? '管理员敏感审核暂时不可用' : (error?.message || '管理员敏感审核请求失败');
  return jsonResponse({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION, error: { code, message } }, {
    status,
    headers: clearSession ? { 'Set-Cookie': clearAdminSessionCookie() } : {},
  });
}

function method(request) { return String(request?.method || 'GET').toUpperCase(); }

function methodNotAllowed(requestMethod, allow) {
  return jsonResponse({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `管理员敏感审核接口不支持 ${requestMethod || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

function parseUrl(request) {
  try { return new URL(request?.url || ''); }
  catch (_) { throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_REQUEST_INVALID', '管理员敏感审核请求地址无效', 400); }
}

function assertNoQuery(request) {
  if ([...parseUrl(request).searchParams.keys()].length) throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_QUERY_INVALID', '敏感审核队列查询参数无效', 400);
}

function readDetailId(request) {
  const params = parseUrl(request).searchParams;
  const keys = [...params.keys()];
  const values = params.getAll('id');
  if (keys.length !== 1 || keys[0] !== 'id' || values.length !== 1) throw new AdminSensitiveReviewError('ADMIN_SENSITIVE_QUERY_INVALID', '敏感审核详情查询参数无效', 400);
  return values[0];
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new AdminSensitiveReviewError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ADMIN_SENSITIVE_REVIEW_MAX_BODY_BYTES) throw new AdminSensitiveReviewError('REQUEST_BODY_TOO_LARGE', '敏感审核请求体过大', 413);
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!bytes) throw new AdminSensitiveReviewError('EMPTY_JSON_BODY', '请求体不能为空', 400);
  if (bytes > ADMIN_SENSITIVE_REVIEW_MAX_BODY_BYTES) throw new AdminSensitiveReviewError('REQUEST_BODY_TOO_LARGE', '敏感审核请求体过大', 413);
  try { return JSON.parse(text); }
  catch (_) { throw new AdminSensitiveReviewError('INVALID_JSON_BODY', '请求体不是有效JSON', 400); }
}

function authenticateAndConfigure(context, dependencies) {
  const env = context?.env || {};
  const authConfig = readAdminAuthConfig(env);
  assertAdminSameOriginRequest(context.request, { publicOrigin: authConfig.publicOrigin });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyAdminSessionToken(token, authConfig, { now: dependencies.now?.() ?? Date.now() });
  const config = readAdminSensitiveReviewConfig(env);
  return { env, identity, config };
}

function createStore(env, config, dependencies) {
  const factory = dependencies.createStore || createEdgeOneBlobStore;
  return factory({ ...env, CLOUD_BLOB_STORE_NAME: config.storeName });
}

function viewer(identity) {
  return Object.freeze({ authenticated: true, username: identity.username, sessionIdSuffix: identity.sessionIdSuffix, expiresAt: identity.expiresAt });
}

export async function handleAdminSensitiveReviewQueueRequest(context, dependencies = {}) {
  const requestMethod = method(context?.request);
  if (requestMethod !== 'GET') return methodNotAllowed(requestMethod, 'GET');
  try {
    const { env, identity, config } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const store = createStore(env, config, dependencies);
    const listQueue = dependencies.listQueue || listAdminSensitiveReviewQueue;
    return success({ viewer: viewer(identity), ...(await listQueue({ store, config })) });
  } catch (error) { return failure(error, { clearSession: error?.status === 401 }); }
}

export async function handleAdminSensitiveReviewDetailRequest(context, dependencies = {}) {
  const requestMethod = method(context?.request);
  if (requestMethod !== 'GET') return methodNotAllowed(requestMethod, 'GET');
  try {
    const { env, identity, config } = authenticateAndConfigure(context, dependencies);
    const reviewId = readDetailId(context.request);
    const store = createStore(env, config, dependencies);
    const getDetail = dependencies.getDetail || getAdminSensitiveReviewDetail;
    return success({ viewer: viewer(identity), ...(await getDetail({ store, config, reviewId, now: dependencies.now?.() ?? Date.now() })) });
  } catch (error) { return failure(error, { clearSession: error?.status === 401 }); }
}

async function handleMutation(context, action, dependencies) {
  const requestMethod = method(context?.request);
  if (requestMethod !== 'POST') return methodNotAllowed(requestMethod, 'POST');
  try {
    const { env, identity, config } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const input = await readJsonBody(context.request);
    const store = createStore(env, config, dependencies);
    const mutate = dependencies.mutate || mutateAdminSensitiveReview;
    const result = await mutate({ store, config, identity, action, input, now: dependencies.now?.() ?? Date.now() });
    return success({ viewer: viewer(identity), ...result }, result.duplicate ? 200 : 201);
  } catch (error) { return failure(error, { clearSession: error?.status === 401 }); }
}

export function handleAdminSensitiveReviewApproveRequest(context, dependencies = {}) {
  return handleMutation(context, 'approve', dependencies);
}

export function handleAdminSensitiveReviewRejectRequest(context, dependencies = {}) {
  return handleMutation(context, 'reject', dependencies);
}

export function handleAdminSensitiveReviewEditAndApproveRequest(context, dependencies = {}) {
  return handleMutation(context, 'edit_and_approve', dependencies);
}

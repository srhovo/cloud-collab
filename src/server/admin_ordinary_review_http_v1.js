import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  readAdminAuthConfig,
  readAdminSessionCookie,
  verifyAdminSessionToken,
} from './admin_auth_v1.js';
import {
  ADMIN_ORDINARY_REVIEW_CAPABILITIES,
  AdminOrdinaryReviewError,
  getAdminOrdinaryReviewDetail,
  isAdminOrdinaryReviewProjectionSafe,
  listAdminOrdinaryReviewQueue,
  readAdminOrdinaryReviewConfig,
} from './admin_ordinary_review_projection_v1.js';

const SERVICE_ID = 'cloud-collab-admin-ordinary-review-preview';
const API_VERSION = '2026-07-20-stage5g';

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

function success(data) {
  if (!isAdminOrdinaryReviewProjectionSafe(data)) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_UNSAFE_PROJECTION', '普通共享审核投影包含禁止字段', 500);
  }
  return jsonResponse({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    data: { ...data, capabilities: ADMIN_ORDINARY_REVIEW_CAPABILITIES },
  });
}

function failure(error, { clearSession = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : 'ADMIN_ORDINARY_REVIEW_INTERNAL_ERROR';
  const message = status >= 500
    ? '管理员普通共享审核暂时不可用'
    : (error?.message || '管理员普通共享审核请求失败');
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
    error: { code: 'METHOD_NOT_ALLOWED', message: `管理员普通共享审核接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function parseRequestUrl(request) {
  try {
    return new URL(request?.url || '');
  } catch (_) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_REQUEST_INVALID', '管理员普通共享审核请求地址无效', 400);
  }
}

function assertNoQuery(request) {
  if ([...parseRequestUrl(request).searchParams.keys()].length !== 0) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_QUERY_INVALID', '普通共享审核队列查询参数无效', 400);
  }
}

function readDetailId(request) {
  const params = parseRequestUrl(request).searchParams;
  const keys = [...params.keys()];
  const values = params.getAll('id');
  if (keys.length !== 1 || keys[0] !== 'id' || values.length !== 1) {
    throw new AdminOrdinaryReviewError('ADMIN_ORDINARY_REVIEW_QUERY_INVALID', '普通共享审核详情查询参数无效', 400);
  }
  return values[0];
}

function authenticateAndConfigure(context, dependencies) {
  const env = context?.env || {};
  const authConfig = readAdminAuthConfig(env);
  assertAdminSameOriginRequest(context.request, { publicOrigin: authConfig.publicOrigin });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  const reviewConfig = readAdminOrdinaryReviewConfig(env);
  return { env, identity, reviewConfig };
}

function createReviewStore(env, reviewConfig, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneBlobStore;
  return createStore({ ...env, CLOUD_BLOB_STORE_NAME: reviewConfig.storeName });
}

function viewer(identity) {
  return Object.freeze({
    authenticated: true,
    username: identity.username,
    sessionIdSuffix: identity.sessionIdSuffix,
    expiresAt: identity.expiresAt,
  });
}

export async function handleAdminOrdinaryReviewQueueRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { env, identity, reviewConfig } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const store = createReviewStore(env, reviewConfig, dependencies);
    const listQueue = dependencies.listQueue || listAdminOrdinaryReviewQueue;
    const queue = await listQueue({ store, config: reviewConfig });
    return success({ viewer: viewer(identity), ...queue });
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

export async function handleAdminOrdinaryReviewDetailRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { env, identity, reviewConfig } = authenticateAndConfigure(context, dependencies);
    const reviewId = readDetailId(context.request);
    const store = createReviewStore(env, reviewConfig, dependencies);
    const getDetail = dependencies.getDetail || getAdminOrdinaryReviewDetail;
    const detail = await getDetail({ store, config: reviewConfig, reviewId });
    return success({ viewer: viewer(identity), ...detail });
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

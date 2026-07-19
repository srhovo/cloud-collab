import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  readAdminAuthConfig,
  readAdminSessionCookie,
  verifyAdminSessionToken,
} from './admin_auth_v1.js';
import {
  ADMIN_REVIEW_MUTATION_CAPABILITIES,
  ADMIN_REVIEW_MUTATION_MAX_BODY_BYTES,
  AdminReviewMutationError,
  isAdminReviewMutationProjectionSafe,
  mutateAdminReview,
  readAdminReviewMutationConfig,
} from './admin_review_mutation_v1.js';

const SERVICE_ID = 'cloud-collab-admin-review-mutation-preview';
const API_VERSION = '2026-07-19-stage5c';

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

function success(identity, result) {
  const data = {
    viewer: {
      authenticated: true,
      username: identity.username,
      sessionIdSuffix: identity.sessionIdSuffix,
      expiresAt: identity.expiresAt,
    },
    result,
    capabilities: ADMIN_REVIEW_MUTATION_CAPABILITIES,
  };
  if (!isAdminReviewMutationProjectionSafe(data)) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_MUTATION_UNSAFE_RESPONSE', '管理员审核响应包含禁止字段', 500);
  }
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data });
}

function failure(error, { clearSession = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : 'ADMIN_REVIEW_MUTATION_INTERNAL_ERROR';
  const message = status >= 500
    ? '管理员审核写入暂时不可用'
    : (error?.message || '管理员审核写入请求失败');
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

function methodNotAllowed(method) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `管理员审核写入接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: 'POST' } });
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function assertNoQuery(request) {
  let url;
  try {
    url = new URL(request?.url || '');
  } catch (_) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_REQUEST_INVALID', '管理员审核请求地址无效', 400);
  }
  if ([...url.searchParams.keys()].length !== 0) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_QUERY_INVALID', '管理员审核写入不接受查询参数', 400);
  }
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_CONTENT_TYPE_INVALID', '管理员审核写入只接受JSON', 415);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 2 || bytes > ADMIN_REVIEW_MUTATION_MAX_BODY_BYTES) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_BODY_SIZE_INVALID', '管理员审核请求大小无效', 413);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new AdminReviewMutationError('ADMIN_REVIEW_JSON_INVALID', '管理员审核JSON无效', 400);
  }
}

function authenticateAndConfigure(context, dependencies) {
  const env = context?.env || {};
  const authConfig = readAdminAuthConfig(env);
  assertAdminSameOriginRequest(context.request, {
    requireOrigin: true,
    publicOrigin: authConfig.publicOrigin,
  });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  const mutationConfig = readAdminReviewMutationConfig(env);
  return { env, identity, mutationConfig };
}

function createReviewStore(env, mutationConfig, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneBlobStore;
  return createStore({ ...env, CLOUD_BLOB_STORE_NAME: mutationConfig.storeName });
}

async function handleMutation(action, context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method);
  try {
    const { env, identity, mutationConfig } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const input = await readJsonBody(context.request);
    const store = createReviewStore(env, mutationConfig, dependencies);
    const mutate = dependencies.mutate || mutateAdminReview;
    const result = await mutate({
      store,
      config: mutationConfig,
      identity,
      command: { action, input },
      now: dependencies.now?.() ?? Date.now(),
    });
    return success(identity, result);
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

export function handleAdminReviewApproveRequest(context, dependencies = {}) {
  return handleMutation('approve', context, dependencies);
}

export function handleAdminReviewRejectRequest(context, dependencies = {}) {
  return handleMutation('reject', context, dependencies);
}

export function handleAdminReviewEditAndApproveRequest(context, dependencies = {}) {
  return handleMutation('edit_and_approve', context, dependencies);
}

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
  ADMIN_REVIEW_MAX_OBJECTS,
  AdminReviewError,
  getAdminReviewDetail,
  isAdminReviewProjectionSafe,
  listAdminReviewQueue,
} from './admin_review_projection_v1.js';
import {
  ADMIN_REVIEW_MUTATION_CAPABILITIES,
  ADMIN_REVIEW_MUTATION_MAX_BODY_BYTES,
  AdminReviewMutationError,
  isAdminReviewMutationProjectionSafe,
  mutateAdminReview,
} from './admin_review_mutation_v1.js';
import {
  ADMIN_ORDINARY_REVIEW_CAPABILITIES,
  AdminOrdinaryReviewError,
  getAdminOrdinaryReviewDetail,
  isAdminOrdinaryReviewProjectionSafe,
  listAdminOrdinaryReviewQueue,
} from './admin_ordinary_review_projection_v1.js';
import {
  ADMIN_ORDINARY_REVIEW_MUTATION_CAPABILITIES,
  ADMIN_ORDINARY_REVIEW_MUTATION_MAX_BODY_BYTES,
  AdminOrdinaryReviewMutationError,
  isAdminOrdinaryReviewMutationProjectionSafe,
  mutateAdminOrdinaryReview,
} from './admin_ordinary_review_mutation_v1.js';

const API_VERSION = '2026-07-21-stage7v';

export class ProductionAdminReviewError extends Error {
  constructor(code, message, status = 503, details = null, cause = null) {
    super(message || code || '正式管理员审核失败');
    this.name = 'ProductionAdminReviewError';
    this.code = code || 'PRODUCTION_ADMIN_REVIEW_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function readProductionAdminReviewConfig(env = {}) {
  let runtime;
  try {
    runtime = readProductionRuntimeConfig(env);
  } catch (error) {
    throw new ProductionAdminReviewError(
      error?.code || 'PRODUCTION_ADMIN_REVIEW_CONFIG_INVALID',
      error?.message || '正式管理员审核配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  if (runtime.mode !== 'production'
      || runtime.flags.admin !== true
      || runtime.flags.adminReview !== true) {
    throw new ProductionAdminReviewError('PRODUCTION_ADMIN_REVIEW_DISABLED', '正式管理员审核能力未开启', 503);
  }
  return Object.freeze({
    storeName: runtime.publicStoreName,
    groupId: runtime.scope.protocol.groupId,
    libraryId: runtime.scope.protocol.libraryId,
    maxObjects: ADMIN_REVIEW_MAX_OBJECTS,
    ordinaryTypesEnabled: true,
    mutationPreviewEnabled: true,
    mode: 'production',
    stablePromotionAuthorized: false,
  });
}

function headers(extra = {}) {
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

function jsonResponse(payload, { status = 200, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: headers({ 'Content-Type': 'application/json; charset=UTF-8', ...extraHeaders }),
  });
}

function method(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function methodNotAllowed(request, allow, serviceId) {
  return jsonResponse({
    ok: false,
    serviceId,
    apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `正式管理员审核接口不支持 ${method(request)} 方法` },
  }, { status: 405, extraHeaders: { Allow: allow } });
}

function failure(error, serviceId) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'PRODUCTION_ADMIN_REVIEW_INTERNAL_ERROR';
  const message = status >= 500 ? '正式管理员审核暂时不可用' : (error?.message || '管理员审核请求失败');
  return jsonResponse({ ok: false, serviceId, apiVersion: API_VERSION, error: { code, message } }, {
    status,
    extraHeaders: error?.status === 401 ? { 'Set-Cookie': clearAdminSessionCookie() } : {},
  });
}

function authenticate(context, dependencies) {
  const env = context?.env || {};
  const authConfig = readProductionAdminAuthConfig(env);
  assertAdminSameOriginRequest(context.request, {
    requireOrigin: method(context.request) === 'POST',
    publicOrigin: authConfig.publicOrigin,
  });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyProductionAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  const reviewConfig = readProductionAdminReviewConfig(env);
  return { identity, reviewConfig };
}

function storeFor(reviewConfig, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
  return createStore(reviewConfig.storeName);
}

function viewer(identity) {
  return Object.freeze({
    authenticated: true,
    username: identity.username,
    sessionIdSuffix: identity.sessionIdSuffix,
    expiresAt: identity.expiresAt,
  });
}

function parseUrl(request) {
  try { return new URL(request?.url || ''); }
  catch (_) { throw new ProductionAdminReviewError('PRODUCTION_ADMIN_REVIEW_URL_INVALID', '管理员审核请求地址无效', 400); }
}

function assertNoQuery(request) {
  if ([...parseUrl(request).searchParams.keys()].length !== 0) {
    throw new ProductionAdminReviewError('PRODUCTION_ADMIN_REVIEW_QUERY_INVALID', '审核队列不接受查询参数', 400);
  }
}

function readDetailId(request) {
  const params = parseUrl(request).searchParams;
  const keys = [...params.keys()];
  const values = params.getAll('id');
  if (keys.length !== 1 || keys[0] !== 'id' || values.length !== 1) {
    throw new ProductionAdminReviewError('PRODUCTION_ADMIN_REVIEW_QUERY_INVALID', '审核详情查询参数无效', 400);
  }
  return values[0];
}

async function readJson(request, maxBytes, ErrorType) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new ErrorType('ADMIN_REVIEW_CONTENT_TYPE_INVALID', '管理员审核写入只接受JSON', 415);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 2 || bytes > maxBytes) {
    throw new ErrorType('ADMIN_REVIEW_BODY_SIZE_INVALID', '管理员审核请求大小无效', 413);
  }
  try { return JSON.parse(text); }
  catch (_) { throw new ErrorType('ADMIN_REVIEW_JSON_INVALID', '管理员审核JSON无效', 400); }
}

function readSuccess(serviceId, identity, data, capabilities, safe) {
  const projected = {
    viewer: viewer(identity),
    ...data,
    capabilities: Object.freeze({ ...capabilities, productionAdmin: true, syntheticFixtureOnly: false }),
    stablePromotionAuthorized: false,
  };
  if (!safe(projected)) {
    throw new ProductionAdminReviewError('PRODUCTION_ADMIN_REVIEW_UNSAFE_PROJECTION', '管理员审核投影包含禁止字段', 500);
  }
  return jsonResponse({ ok: true, serviceId, apiVersion: API_VERSION, data: projected });
}

function mutationSuccess(serviceId, identity, result, capabilities, safe) {
  const projected = {
    viewer: viewer(identity),
    result,
    capabilities: Object.freeze({ ...capabilities, productionAdmin: true, syntheticFixtureOnly: false }),
    stablePromotionAuthorized: false,
  };
  if (!safe(projected)) {
    throw new ProductionAdminReviewError('PRODUCTION_ADMIN_REVIEW_UNSAFE_RESPONSE', '管理员审核响应包含禁止字段', 500);
  }
  return jsonResponse({ ok: true, serviceId, apiVersion: API_VERSION, data: projected });
}

async function handleQueue(kind, context, dependencies = {}) {
  const serviceId = `cloud-collab-admin-${kind}-review-production`;
  if (method(context?.request) !== 'GET') return methodNotAllowed(context?.request, 'GET', serviceId);
  try {
    const { identity, reviewConfig } = authenticate(context, dependencies);
    assertNoQuery(context.request);
    const store = storeFor(reviewConfig, dependencies);
    if (kind === 'exact') {
      const list = dependencies.listQueue || listAdminReviewQueue;
      const data = await list({ store, config: reviewConfig });
      return readSuccess(serviceId, identity, data, ADMIN_REVIEW_MUTATION_CAPABILITIES, isAdminReviewProjectionSafe);
    }
    const list = dependencies.listQueue || listAdminOrdinaryReviewQueue;
    const data = await list({ store, config: reviewConfig });
    return readSuccess(serviceId, identity, data, ADMIN_ORDINARY_REVIEW_CAPABILITIES, isAdminOrdinaryReviewProjectionSafe);
  } catch (error) {
    return failure(error, serviceId);
  }
}

async function handleDetail(kind, context, dependencies = {}) {
  const serviceId = `cloud-collab-admin-${kind}-review-production`;
  if (method(context?.request) !== 'GET') return methodNotAllowed(context?.request, 'GET', serviceId);
  try {
    const { identity, reviewConfig } = authenticate(context, dependencies);
    const reviewId = readDetailId(context.request);
    const store = storeFor(reviewConfig, dependencies);
    if (kind === 'exact') {
      const get = dependencies.getDetail || getAdminReviewDetail;
      const data = await get({ store, config: reviewConfig, reviewId });
      return readSuccess(serviceId, identity, data, ADMIN_REVIEW_MUTATION_CAPABILITIES, isAdminReviewProjectionSafe);
    }
    const get = dependencies.getDetail || getAdminOrdinaryReviewDetail;
    const data = await get({ store, config: reviewConfig, reviewId });
    return readSuccess(serviceId, identity, data, ADMIN_ORDINARY_REVIEW_CAPABILITIES, isAdminOrdinaryReviewProjectionSafe);
  } catch (error) {
    return failure(error, serviceId);
  }
}

async function handleMutation(kind, action, context, dependencies = {}) {
  const serviceId = `cloud-collab-admin-${kind}-review-mutation-production`;
  if (method(context?.request) !== 'POST') return methodNotAllowed(context?.request, 'POST', serviceId);
  try {
    const { identity, reviewConfig } = authenticate(context, dependencies);
    assertNoQuery(context.request);
    const store = storeFor(reviewConfig, dependencies);
    if (kind === 'exact') {
      const input = await readJson(context.request, ADMIN_REVIEW_MUTATION_MAX_BODY_BYTES, AdminReviewMutationError);
      const mutate = dependencies.mutate || mutateAdminReview;
      const result = await mutate({
        store,
        config: reviewConfig,
        identity,
        command: { action, input },
        now: dependencies.now?.() ?? Date.now(),
      });
      return mutationSuccess(serviceId, identity, result, ADMIN_REVIEW_MUTATION_CAPABILITIES, isAdminReviewMutationProjectionSafe);
    }
    const input = await readJson(context.request, ADMIN_ORDINARY_REVIEW_MUTATION_MAX_BODY_BYTES, AdminOrdinaryReviewMutationError);
    const mutate = dependencies.mutate || mutateAdminOrdinaryReview;
    const result = await mutate({
      store,
      config: reviewConfig,
      identity,
      command: { action, input },
      now: dependencies.now?.() ?? Date.now(),
    });
    return mutationSuccess(serviceId, identity, result, ADMIN_ORDINARY_REVIEW_MUTATION_CAPABILITIES, isAdminOrdinaryReviewMutationProjectionSafe);
  } catch (error) {
    return failure(error, serviceId);
  }
}

export const handleProductionAdminExactReviewQueueRequest = (context, dependencies) => handleQueue('exact', context, dependencies);
export const handleProductionAdminExactReviewDetailRequest = (context, dependencies) => handleDetail('exact', context, dependencies);
export const handleProductionAdminExactReviewApproveRequest = (context, dependencies) => handleMutation('exact', 'approve', context, dependencies);
export const handleProductionAdminExactReviewRejectRequest = (context, dependencies) => handleMutation('exact', 'reject', context, dependencies);
export const handleProductionAdminExactReviewEditAndApproveRequest = (context, dependencies) => handleMutation('exact', 'edit_and_approve', context, dependencies);

export const handleProductionAdminOrdinaryReviewQueueRequest = (context, dependencies) => handleQueue('ordinary', context, dependencies);
export const handleProductionAdminOrdinaryReviewDetailRequest = (context, dependencies) => handleDetail('ordinary', context, dependencies);
export const handleProductionAdminOrdinaryReviewApproveRequest = (context, dependencies) => handleMutation('ordinary', 'approve', context, dependencies);
export const handleProductionAdminOrdinaryReviewRejectRequest = (context, dependencies) => handleMutation('ordinary', 'reject', context, dependencies);
export const handleProductionAdminOrdinaryReviewEditAndApproveRequest = (context, dependencies) => handleMutation('ordinary', 'edit_and_approve', context, dependencies);

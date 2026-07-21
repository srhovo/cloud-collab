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
import {
  getAdminSensitiveReviewDetail,
  isAdminSensitiveProjectionSafe,
  listAdminSensitiveReviewQueue,
} from './admin_sensitive_review_v1.js';
import {
  PRODUCTION_ORDINARY_REVIEW_READ_CAPABILITIES,
  ProductionAdminReviewReadError,
  getProductionOrdinaryReviewDetail,
  isProductionAdminReviewProjectionSafe,
  listProductionOrdinaryReviewQueue,
  readProductionAdminReviewConfig,
} from './production_admin_review_read_v1.js';

const API_VERSION = '2026-07-21-stage7u';
const SERVICES = Object.freeze({
  exact: 'cloud-collab-admin-review-production',
  ordinary: 'cloud-collab-admin-ordinary-review-production',
  sensitive: 'cloud-collab-admin-sensitive-review-production',
});
const EXACT_CAPABILITIES = Object.freeze({
  reviewQueueRead: true,
  reviewDetailRead: true,
  reviewMutation: false,
  dataTypes: Object.freeze(['exact_price']),
  publicMutationAllowed: false,
  stablePromotionAuthorized: false,
});
const SENSITIVE_CAPABILITIES = Object.freeze({
  queueRead: true,
  detailRead: true,
  approve: false,
  reject: false,
  editAndApprove: false,
  tombstonePublish: false,
  publicMutationAllowed: false,
  stablePromotionAuthorized: false,
});

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

function json(serviceId, payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: headers({ 'Content-Type': 'application/json; charset=UTF-8', ...extra }),
  });
}

function fail(serviceId, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status : 500;
  return json(serviceId, {
    ok: false,
    serviceId,
    apiVersion: API_VERSION,
    mode: 'production',
    error: {
      code: error?.code || 'PRODUCTION_ADMIN_REVIEW_INTERNAL_ERROR',
      message: status >= 500 ? '正式管理员只读审核暂时不可用' : (error?.message || '请求失败'),
    },
  }, status, error?.status === 401 ? { 'Set-Cookie': clearAdminSessionCookie() } : {});
}

function method(request) { return String(request?.method || 'GET').toUpperCase(); }
function url(request) {
  try { return new URL(request?.url || ''); }
  catch (_) { throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_REQUEST_INVALID', '审核请求地址无效', 400); }
}
function noQuery(request) {
  if ([...url(request).searchParams.keys()].length) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_QUERY_INVALID', '审核队列查询参数无效', 400);
  }
}
function detailId(request) {
  const params = url(request).searchParams;
  const keys = [...params.keys()];
  const values = params.getAll('id');
  if (keys.length !== 1 || keys[0] !== 'id' || values.length !== 1 || !values[0]) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_QUERY_INVALID', '审核详情查询参数无效', 400);
  }
  return values[0];
}

function authenticate(context, dependencies) {
  const env = context?.env || {};
  const authConfig = readProductionAdminAuthConfig(env);
  const config = readProductionAdminReviewConfig(env);
  if (authConfig.publicOrigin !== config.publicOrigin) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_ORIGIN_MISMATCH', '身份与审核来源不一致', 503);
  }
  assertAdminSameOriginRequest(context.request, { publicOrigin: config.publicOrigin });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyProductionAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  return { config, identity };
}

function storeFor(config, dependencies) {
  const factory = dependencies.createStore || createEdgeOneNamedBlobStore;
  return factory(config.storeName);
}

function viewer(identity) {
  return Object.freeze({
    authenticated: true,
    username: identity.username,
    sessionIdSuffix: identity.sessionIdSuffix,
    expiresAt: identity.expiresAt,
  });
}

function safe(kind, value) {
  return isProductionAdminReviewProjectionSafe(value)
    && (kind !== 'sensitive' || isAdminSensitiveProjectionSafe(value));
}

function ok(kind, data, capabilities) {
  const serviceId = SERVICES[kind];
  const projection = Object.freeze({
    ...data,
    capabilities,
    readOnly: true,
    realSecretValuesExposed: false,
    stablePromotionAuthorized: false,
  });
  if (!safe(kind, projection)) {
    throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_REVIEW_UNSAFE_PROJECTION', '审核响应包含禁止字段', 500);
  }
  return json(serviceId, {
    ok: true,
    serviceId,
    apiVersion: API_VERSION,
    mode: 'production',
    data: projection,
  });
}

async function ordinaryQueue(context, dependencies) {
  const state = authenticate(context, dependencies);
  noQuery(context.request);
  const store = storeFor(state.config, dependencies);
  const list = dependencies.listOrdinaryQueue || listProductionOrdinaryReviewQueue;
  return { ...state, queue: await list({ store, config: state.config }) };
}

async function ordinaryDetail(context, dependencies) {
  const state = authenticate(context, dependencies);
  const reviewId = detailId(context.request);
  const store = storeFor(state.config, dependencies);
  const get = dependencies.getOrdinaryDetail || getProductionOrdinaryReviewDetail;
  return { ...state, detail: await get({ store, config: state.config, reviewId }) };
}

async function handle(kind, view, context, dependencies = {}) {
  const serviceId = SERVICES[kind];
  if (method(context?.request) !== 'GET') {
    return json(serviceId, {
      ok: false,
      serviceId,
      apiVersion: API_VERSION,
      mode: 'production',
      error: { code: 'METHOD_NOT_ALLOWED', message: '只允许GET' },
    }, 405, { Allow: 'GET' });
  }
  try {
    if (kind === 'sensitive') {
      const state = authenticate(context, dependencies);
      let result;
      if (view === 'queue') {
        noQuery(context.request);
        const store = storeFor(state.config, dependencies);
        const list = dependencies.listSensitiveQueue || listAdminSensitiveReviewQueue;
        result = await list({ store, config: state.config });
      } else {
        const reviewId = detailId(context.request);
        const store = storeFor(state.config, dependencies);
        const get = dependencies.getSensitiveDetail || getAdminSensitiveReviewDetail;
        result = await get({
          store,
          config: state.config,
          reviewId,
          now: dependencies.now?.() ?? Date.now(),
        });
      }
      const { capabilities: ignored, ...clean } = result;
      return ok(kind, { viewer: viewer(state.identity), ...clean }, SENSITIVE_CAPABILITIES);
    }
    const state = view === 'queue'
      ? await ordinaryQueue(context, dependencies)
      : await ordinaryDetail(context, dependencies);
    if (kind === 'ordinary') {
      return ok(kind, {
        viewer: viewer(state.identity),
        ...(view === 'queue' ? state.queue : state.detail),
      }, PRODUCTION_ORDINARY_REVIEW_READ_CAPABILITIES);
    }
    if (view === 'queue') {
      const items = state.queue.items.filter(item => item.dataType === 'exact_price');
      return ok(kind, {
        viewer: viewer(state.identity),
        scope: state.queue.scope,
        total: items.length,
        items: Object.freeze(items),
        compatibilityView: 'exact_price_only',
      }, EXACT_CAPABILITIES);
    }
    if (state.detail.review?.dataType !== 'exact_price') {
      throw new ProductionAdminReviewReadError('PRODUCTION_ADMIN_EXACT_REVIEW_NOT_FOUND', '精确价格审核详情不存在', 404);
    }
    return ok(kind, {
      viewer: viewer(state.identity),
      ...state.detail,
      compatibilityView: 'exact_price_only',
    }, EXACT_CAPABILITIES);
  } catch (error) {
    return fail(serviceId, error);
  }
}

export const handleProductionAdminExactReviewQueueRequest = (c, d) => handle('exact', 'queue', c, d);
export const handleProductionAdminExactReviewDetailRequest = (c, d) => handle('exact', 'detail', c, d);
export const handleProductionAdminOrdinaryReviewQueueRequest = (c, d) => handle('ordinary', 'queue', c, d);
export const handleProductionAdminOrdinaryReviewDetailRequest = (c, d) => handle('ordinary', 'detail', c, d);
export const handleProductionAdminSensitiveReviewQueueRequest = (c, d) => handle('sensitive', 'queue', c, d);
export const handleProductionAdminSensitiveReviewDetailRequest = (c, d) => handle('sensitive', 'detail', c, d);

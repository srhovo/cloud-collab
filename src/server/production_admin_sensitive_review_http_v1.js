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
  ADMIN_SENSITIVE_REVIEW_CAPABILITIES,
  ADMIN_SENSITIVE_REVIEW_MAX_BODY_BYTES,
  AdminSensitiveReviewError,
  getAdminSensitiveReviewDetail,
  isAdminSensitiveProjectionSafe,
  listAdminSensitiveReviewQueue,
  mutateAdminSensitiveReview,
} from './admin_sensitive_review_v1.js';

const SERVICE_ID = 'cloud-collab-admin-sensitive-review-production';
const API_VERSION = '2026-07-21-stage7v';

export class ProductionAdminSensitiveReviewError extends Error {
  constructor(code, message, status = 503, details = null, cause = null) {
    super(message || code || '正式管理员敏感审核失败');
    this.name = 'ProductionAdminSensitiveReviewError';
    this.code = code || 'PRODUCTION_ADMIN_SENSITIVE_REVIEW_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function readProductionAdminSensitiveReviewConfig(env = {}) {
  let runtime;
  try { runtime = readProductionRuntimeConfig(env); }
  catch (error) {
    throw new ProductionAdminSensitiveReviewError(
      error?.code || 'PRODUCTION_ADMIN_SENSITIVE_REVIEW_CONFIG_INVALID',
      error?.message || '正式敏感审核配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  if (runtime.mode !== 'production'
      || runtime.flags.admin !== true
      || runtime.flags.adminReview !== true) {
    throw new ProductionAdminSensitiveReviewError(
      'PRODUCTION_ADMIN_SENSITIVE_REVIEW_DISABLED',
      '正式敏感审核能力未开启',
      503,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    enabled: true,
    mode: 'production',
    storeName: runtime.publicStoreName,
    groupId: runtime.scope.protocol.groupId,
    libraryId: runtime.scope.protocol.libraryId,
    publicOrigin: runtime.adminOrigin,
    externalScope: runtime.scope.external,
    protocolScope: runtime.scope.protocol,
    sensitiveSubmissionIntakeEnabled: runtime.flags.sensitiveSubmission,
    syntheticFixtureOnly: false,
    stablePromotionAuthorized: false,
  });
}

const PRODUCTION_CAPABILITIES = Object.freeze({
  ...ADMIN_SENSITIVE_REVIEW_CAPABILITIES,
  productionAdmin: true,
  syntheticFixtureOnly: false,
  manualReviewRequired: true,
  automaticApproval: false,
  publicMutationAllowed: true,
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

function jsonResponse(payload, { status = 200, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: headers({ 'Content-Type': 'application/json; charset=UTF-8', ...extraHeaders }),
  });
}

function success(data, status = 200) {
  const projected = Object.freeze({
    ...data,
    capabilities: PRODUCTION_CAPABILITIES,
    realSecretValuesExposed: false,
    stablePromotionAuthorized: false,
  });
  if (!isAdminSensitiveProjectionSafe(projected)) {
    throw new ProductionAdminSensitiveReviewError(
      'PRODUCTION_ADMIN_SENSITIVE_UNSAFE_PROJECTION',
      '正式敏感审核响应包含禁止字段',
      500,
    );
  }
  return jsonResponse({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    data: projected,
  }, { status });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status : 500;
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: {
      code: error?.code || 'PRODUCTION_ADMIN_SENSITIVE_INTERNAL_ERROR',
      message: status >= 500 ? '正式管理员敏感审核暂时不可用' : (error?.message || '请求失败'),
    },
  }, {
    status,
    extraHeaders: error?.status === 401 ? { 'Set-Cookie': clearAdminSessionCookie() } : {},
  });
}

function method(request) { return String(request?.method || 'GET').toUpperCase(); }
function methodNotAllowed(requestMethod, allow) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: { code: 'METHOD_NOT_ALLOWED', message: `正式敏感审核接口不支持 ${requestMethod || 'UNKNOWN'} 方法` },
  }, { status: 405, extraHeaders: { Allow: allow } });
}
function parseUrl(request) {
  try { return new URL(request?.url || ''); }
  catch (_) { throw new ProductionAdminSensitiveReviewError('PRODUCTION_ADMIN_SENSITIVE_REQUEST_INVALID', '正式敏感审核请求地址无效', 400); }
}
function assertNoQuery(request) {
  if ([...parseUrl(request).searchParams.keys()].length) {
    throw new ProductionAdminSensitiveReviewError('PRODUCTION_ADMIN_SENSITIVE_QUERY_INVALID', '敏感审核队列查询参数无效', 400);
  }
}
function readDetailId(request) {
  const params = parseUrl(request).searchParams;
  const keys = [...params.keys()];
  const values = params.getAll('id');
  if (keys.length !== 1 || keys[0] !== 'id' || values.length !== 1 || !values[0]) {
    throw new ProductionAdminSensitiveReviewError('PRODUCTION_ADMIN_SENSITIVE_QUERY_INVALID', '敏感审核详情查询参数无效', 400);
  }
  return values[0];
}
async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new AdminSensitiveReviewError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ADMIN_SENSITIVE_REVIEW_MAX_BODY_BYTES) {
    throw new AdminSensitiveReviewError('REQUEST_BODY_TOO_LARGE', '敏感审核请求体过大', 413);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!bytes) throw new AdminSensitiveReviewError('EMPTY_JSON_BODY', '请求体不能为空', 400);
  if (bytes > ADMIN_SENSITIVE_REVIEW_MAX_BODY_BYTES) {
    throw new AdminSensitiveReviewError('REQUEST_BODY_TOO_LARGE', '敏感审核请求体过大', 413);
  }
  try { return JSON.parse(text); }
  catch (_) { throw new AdminSensitiveReviewError('INVALID_JSON_BODY', '请求体不是有效JSON', 400); }
}

function authenticate(context, dependencies) {
  const env = context?.env || {};
  const authConfig = readProductionAdminAuthConfig(env);
  const config = readProductionAdminSensitiveReviewConfig(env);
  if (authConfig.publicOrigin !== config.publicOrigin) {
    throw new ProductionAdminSensitiveReviewError(
      'PRODUCTION_ADMIN_SENSITIVE_ORIGIN_MISMATCH',
      '正式管理员身份与敏感审核来源不一致',
      503,
    );
  }
  assertAdminSameOriginRequest(context.request, {
    requireOrigin: method(context.request) === 'POST',
    publicOrigin: authConfig.publicOrigin,
  });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyProductionAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  return { config, identity };
}

function storeFor(config, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
  return createStore(config.storeName);
}
function viewer(identity) {
  return Object.freeze({
    authenticated: true,
    username: identity.username,
    sessionIdSuffix: identity.sessionIdSuffix,
    expiresAt: identity.expiresAt,
  });
}

export async function handleProductionAdminSensitiveReviewQueueRequest(context, dependencies = {}) {
  const requestMethod = method(context?.request);
  if (requestMethod !== 'GET') return methodNotAllowed(requestMethod, 'GET');
  try {
    const state = authenticate(context, dependencies);
    assertNoQuery(context.request);
    const list = dependencies.listQueue || listAdminSensitiveReviewQueue;
    const raw = await list({ store: storeFor(state.config, dependencies), config: state.config });
    const { capabilities: ignored, ...data } = raw;
    return success({
      viewer: viewer(state.identity),
      sensitiveSubmissionIntakeEnabled: state.config.sensitiveSubmissionIntakeEnabled,
      ...data,
    });
  } catch (error) { return failure(error); }
}

export async function handleProductionAdminSensitiveReviewDetailRequest(context, dependencies = {}) {
  const requestMethod = method(context?.request);
  if (requestMethod !== 'GET') return methodNotAllowed(requestMethod, 'GET');
  try {
    const state = authenticate(context, dependencies);
    const reviewId = readDetailId(context.request);
    const get = dependencies.getDetail || getAdminSensitiveReviewDetail;
    const raw = await get({
      store: storeFor(state.config, dependencies),
      config: state.config,
      reviewId,
      now: dependencies.now?.() ?? Date.now(),
    });
    const { capabilities: ignored, ...data } = raw;
    return success({
      viewer: viewer(state.identity),
      sensitiveSubmissionIntakeEnabled: state.config.sensitiveSubmissionIntakeEnabled,
      ...data,
    });
  } catch (error) { return failure(error); }
}

async function handleMutation(context, action, dependencies) {
  const requestMethod = method(context?.request);
  if (requestMethod !== 'POST') return methodNotAllowed(requestMethod, 'POST');
  try {
    const state = authenticate(context, dependencies);
    assertNoQuery(context.request);
    const input = await readJsonBody(context.request);
    const mutate = dependencies.mutate || mutateAdminSensitiveReview;
    const result = await mutate({
      store: storeFor(state.config, dependencies),
      config: state.config,
      identity: state.identity,
      action,
      input,
      now: dependencies.now?.() ?? Date.now(),
    });
    return success({
      viewer: viewer(state.identity),
      sensitiveSubmissionIntakeEnabled: state.config.sensitiveSubmissionIntakeEnabled,
      result,
    }, result.duplicate ? 200 : 201);
  } catch (error) { return failure(error); }
}

export const handleProductionAdminSensitiveReviewApproveRequest = (c, d = {}) => handleMutation(c, 'approve', d);
export const handleProductionAdminSensitiveReviewRejectRequest = (c, d = {}) => handleMutation(c, 'reject', d);
export const handleProductionAdminSensitiveReviewEditAndApproveRequest = (c, d = {}) => handleMutation(c, 'edit_and_approve', d);

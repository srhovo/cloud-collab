import { createEdgeOneNamedBlobStore } from './edgeone_blob_runtime_v1.js';
import { requireProductionAdminSession } from './production_admin_auth_http_v1.js';
import {
  ProductionAdminSensitiveReviewError,
  approveProductionSensitiveCandidate,
  editAndApproveProductionSensitiveCandidate,
  getProductionAdminSensitiveReviewDetail,
  listProductionAdminSensitiveReviews,
  rejectProductionSensitiveCandidate,
} from './production_admin_sensitive_review_v1.js';

const SERVICE_ID = 'cloud-collab-admin-sensitive-production';
const API_VERSION = '2026-07-21-stage7t';
const MAX_BODY_BYTES = 32 * 1024;

function method(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function headers(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=UTF-8',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function response(payload, { status = 200, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: headers(extraHeaders) });
}

function success(data, status = 200) {
  return response({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    reviewMode: 'manual_only',
    data,
  }, { status });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '正式敏感审核服务暂时不可用' : (error?.message || '审核请求失败');
  const details = status < 500 && error?.details ? { details: error.details } : {};
  return response({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    reviewMode: 'manual_only',
    error: { code, message, ...details },
  }, { status });
}

function methodNotAllowed(request, allow) {
  return response({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    reviewMode: 'manual_only',
    error: { code: 'METHOD_NOT_ALLOWED', message: `审核接口不支持${method(request)}方法` },
  }, { status: 405, extraHeaders: { Allow: allow } });
}

function parseLimit(raw) {
  const value = raw === null || raw === '' ? 20 : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new ProductionAdminSensitiveReviewError('INVALID_LIMIT', 'limit必须是1至50的整数', 400);
  }
  return value;
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new ProductionAdminSensitiveReviewError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ProductionAdminSensitiveReviewError('REQUEST_BODY_TOO_LARGE', '审核请求体过大', 413);
  }
  const text = await request.text();
  if (!text) throw new ProductionAdminSensitiveReviewError('EMPTY_JSON_BODY', '审核请求体不能为空', 400);
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new ProductionAdminSensitiveReviewError('REQUEST_BODY_TOO_LARGE', '审核请求体过大', 413);
  }
  try { return JSON.parse(text); }
  catch (_) { throw new ProductionAdminSensitiveReviewError('INVALID_JSON_BODY', '审核请求体不是有效JSON', 400); }
}

function publicStoreFor(auth, dependencies) {
  const createStore = dependencies.createPublicStore || dependencies.createStore || createEdgeOneNamedBlobStore;
  return createStore(auth.config.publicStoreName);
}

async function authAndPublicStore(context, dependencies) {
  const auth = await requireProductionAdminSession(context, {
    createStore: dependencies.createAdminStore || dependencies.createStore,
    now: dependencies.now,
  });
  return Object.freeze({ auth, publicStore: publicStoreFor(auth, dependencies) });
}

export async function handleProductionSensitiveReviewListRequest(context, dependencies = {}) {
  const request = context?.request;
  if (method(request) !== 'GET') return methodNotAllowed(request, 'GET');
  try {
    const { auth, publicStore } = await authAndPublicStore(context, dependencies);
    const url = new URL(request.url);
    const data = await listProductionAdminSensitiveReviews({
      store: publicStore,
      env: context.env,
      limit: parseLimit(url.searchParams.get('limit')),
      cursor: url.searchParams.get('cursor') || '',
      now: dependencies.now?.() || Date.now(),
    });
    return success({
      ...data,
      administrator: auth.session.username,
      capabilities: auth.config.capabilities,
    });
  } catch (error) { return failure(error); }
}

export async function handleProductionSensitiveReviewDetailRequest(context, dependencies = {}) {
  const request = context?.request;
  if (method(request) !== 'GET') return methodNotAllowed(request, 'GET');
  try {
    const { auth, publicStore } = await authAndPublicStore(context, dependencies);
    const reviewId = new URL(request.url).searchParams.get('id') || '';
    const data = await getProductionAdminSensitiveReviewDetail({
      store: publicStore,
      env: context.env,
      reviewId,
      now: dependencies.now?.() || Date.now(),
    });
    return success({ ...data, administrator: auth.session.username });
  } catch (error) { return failure(error); }
}

async function action(context, dependencies, executor) {
  const request = context?.request;
  if (method(request) !== 'POST') return methodNotAllowed(request, 'POST');
  try {
    const { auth, publicStore } = await authAndPublicStore(context, dependencies);
    const body = await readJsonBody(request);
    const data = await executor({
      store: publicStore,
      env: context.env,
      administrator: auth.session.username,
      request: body,
      now: dependencies.now?.() || Date.now(),
    });
    return success({
      ...data,
      administrator: auth.session.username,
      manualReview: true,
      stablePromotionAuthorized: false,
    });
  } catch (error) { return failure(error); }
}

export function handleProductionSensitiveReviewApproveRequest(context, dependencies = {}) {
  return action(context, dependencies, approveProductionSensitiveCandidate);
}

export function handleProductionSensitiveReviewRejectRequest(context, dependencies = {}) {
  return action(context, dependencies, rejectProductionSensitiveCandidate);
}

export function handleProductionSensitiveReviewEditAndApproveRequest(context, dependencies = {}) {
  return action(context, dependencies, editAndApproveProductionSensitiveCandidate);
}

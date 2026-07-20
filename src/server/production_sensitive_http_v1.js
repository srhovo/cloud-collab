import { createEdgeOneNamedBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  ProductionSensitiveRuntimeError,
  acceptProductionSensitiveCandidate,
  assertProductionSensitiveEnvelope,
  readProductionSensitiveConfig,
} from './production_sensitive_runtime_v1.js';
import { assertProductionRequestAccess } from './production_write_runtime_v1.js';

const SERVICE_ID = 'cloud-collab-production-sensitive';
const API_VERSION = '2026-07-21-stage7s';
const SENSITIVE_SUBMISSION_MAX_BYTES = 24 * 1024;

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function headers(request, config, extra = {}) {
  const origin = String(request?.headers?.get?.('origin') || '').trim();
  const allowed = config?.publicOrigin || '';
  const cors = origin && origin === allowed
    ? {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization, X-Cloud-Collab-Access-Key',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    }
    : {};
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=UTF-8',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...cors,
    ...extra,
  };
}

function jsonResponse(request, config, payload, { status = 200, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: headers(request, config, extraHeaders) });
}

function success(request, config, data, status) {
  return jsonResponse(request, config, {
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    reviewMode: 'manual_only',
    data,
  }, { status });
}

function failure(request, config, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '正式敏感候选服务暂时不可用' : (error?.message || '请求失败');
  const details = status < 500 && error?.details ? { details: error.details } : {};
  const retryAfter = status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
    ? { 'Retry-After': String(error.details.retryAfterSeconds) }
    : {};
  return jsonResponse(request, config, {
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    reviewMode: 'manual_only',
    error: { code, message, ...details },
  }, { status, extraHeaders: retryAfter });
}

function methodNotAllowed(request) {
  return jsonResponse(request, null, {
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    reviewMode: 'manual_only',
    error: { code: 'METHOD_NOT_ALLOWED', message: `敏感提交接口不支持${requestMethod(request)}方法` },
  }, { status: 405, extraHeaders: { Allow: 'POST, OPTIONS' } });
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new ProductionSensitiveRuntimeError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > SENSITIVE_SUBMISSION_MAX_BYTES) {
    throw new ProductionSensitiveRuntimeError('REQUEST_BODY_TOO_LARGE', `请求体不得超过${SENSITIVE_SUBMISSION_MAX_BYTES}字节`, 413);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) throw new ProductionSensitiveRuntimeError('EMPTY_JSON_BODY', '请求体不能为空', 400);
  if (bytes > SENSITIVE_SUBMISSION_MAX_BYTES) {
    throw new ProductionSensitiveRuntimeError('REQUEST_BODY_TOO_LARGE', `请求体不得超过${SENSITIVE_SUBMISSION_MAX_BYTES}字节`, 413);
  }
  try { return JSON.parse(text); }
  catch (_) { throw new ProductionSensitiveRuntimeError('INVALID_JSON_BODY', '请求体不是有效JSON', 400); }
}

function storeFor(config, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
  return createStore(config.storeName);
}

export async function handleProductionSensitiveSubmissionRequest(context, dependencies = {}) {
  const request = context?.request;
  const method = requestMethod(request);
  if (!['POST', 'OPTIONS'].includes(method)) return methodNotAllowed(request);
  let config = null;
  try {
    const env = context?.env || {};
    config = readProductionSensitiveConfig(env);
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(request, config) });
    assertProductionRequestAccess(request, config);
    const rawSubmission = await readJsonBody(request);
    assertProductionSensitiveEnvelope(rawSubmission);
    const accept = dependencies.acceptProduction || acceptProductionSensitiveCandidate;
    const result = await accept({
      store: storeFor(config, dependencies),
      authorization: request.headers.get('authorization') || '',
      rawSubmission,
      env,
      now: dependencies.now?.() || Date.now(),
      ...(dependencies.resolveExistingRecord ? { resolveExistingRecord: dependencies.resolveExistingRecord } : {}),
      ...(dependencies.buildSnapshot ? { buildSnapshot: dependencies.buildSnapshot } : {}),
    });
    return success(request, config, {
      ...result,
      manualReviewRequired: true,
      publicMutationAllowed: false,
      publicMutationApplied: false,
      autoApprovalEnabled: false,
      stablePromotionAuthorized: false,
    }, result?.duplicate ? 200 : 202);
  } catch (error) {
    return failure(request, config, error);
  }
}

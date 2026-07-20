import { MAX_SUBMISSION_BYTES } from './submission_policy_v1.js';
import { createEdgeOneNamedBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  ProductionWriteRuntimeError,
  acceptProductionExactSubmission,
  assertProductionRequestAccess,
  readProductionWriteConfig,
  registerProductionDevice,
} from './production_write_runtime_v1.js';

const SERVICE_ID = 'cloud-collab-production-write';
const API_VERSION = '2026-07-21-stage7q';
const MAX_REGISTRATION_BYTES = 4 * 1024;

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
    writeScope: 'production_protocol_scope',
    data,
  }, { status });
}

function failure(request, config, error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '正式普通提交服务暂时不可用' : (error?.message || '请求失败');
  const details = status < 500 && error?.details ? { details: error.details } : {};
  const retryAfter = status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
    ? { 'Retry-After': String(error.details.retryAfterSeconds) }
    : {};
  return jsonResponse(request, config, {
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    writeScope: 'production_protocol_scope',
    error: { code, message, ...details },
  }, { status, extraHeaders: retryAfter });
}

function methodNotAllowed(request) {
  return jsonResponse(request, null, {
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    writeScope: 'production_protocol_scope',
    error: { code: 'METHOD_NOT_ALLOWED', message: `写入接口不支持${requestMethod(request)}方法` },
  }, { status: 405, extraHeaders: { Allow: 'POST, OPTIONS' } });
}

async function readJsonBody(request, maxBytes) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new ProductionWriteRuntimeError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ProductionWriteRuntimeError('REQUEST_BODY_TOO_LARGE', `请求体不得超过${maxBytes}字节`, 413);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) throw new ProductionWriteRuntimeError('EMPTY_JSON_BODY', '请求体不能为空', 400);
  if (bytes > maxBytes) throw new ProductionWriteRuntimeError('REQUEST_BODY_TOO_LARGE', `请求体不得超过${maxBytes}字节`, 413);
  try { return JSON.parse(text); }
  catch (_) { throw new ProductionWriteRuntimeError('INVALID_JSON_BODY', '请求体不是有效JSON', 400); }
}

function optionsResponse(request, config) {
  return new Response(null, { status: 204, headers: headers(request, config) });
}

function storeFor(config, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
  return createStore(config.storeName);
}

export async function handleProductionDeviceRegisterRequest(context, dependencies = {}) {
  const request = context?.request;
  const method = requestMethod(request);
  if (!['POST', 'OPTIONS'].includes(method)) return methodNotAllowed(request);
  let config = null;
  try {
    const env = context?.env || {};
    config = readProductionWriteConfig(env);
    if (method === 'OPTIONS') return optionsResponse(request, config);
    assertProductionRequestAccess(request, config);
    const input = await readJsonBody(request, MAX_REGISTRATION_BYTES);
    const register = dependencies.registerProduction || registerProductionDevice;
    const result = await register({
      store: storeFor(config, dependencies),
      input,
      env,
      now: dependencies.now?.() || Date.now(),
    });
    return success(request, config, {
      ...result,
      externalScope: config.externalScope,
      protocolScope: { groupId: config.allowedGroupId, libraryId: config.allowedLibraryId },
      submissionEnabled: true,
      publicMutationAllowed: false,
      autoApprovalEnabled: config.runtime.flags.autoApproval === true,
      stablePromotionAuthorized: false,
    }, 201);
  } catch (error) {
    return failure(request, config, error);
  }
}

export async function handleProductionSubmissionCreateRequest(context, dependencies = {}) {
  const request = context?.request;
  const method = requestMethod(request);
  if (!['POST', 'OPTIONS'].includes(method)) return methodNotAllowed(request);
  let config = null;
  try {
    const env = context?.env || {};
    config = readProductionWriteConfig(env);
    if (method === 'OPTIONS') return optionsResponse(request, config);
    assertProductionRequestAccess(request, config);
    const rawSubmission = await readJsonBody(request, MAX_SUBMISSION_BYTES);
    const accept = dependencies.acceptProduction || acceptProductionExactSubmission;
    const result = await accept({
      store: storeFor(config, dependencies),
      authorization: request.headers.get('authorization') || '',
      rawSubmission,
      env,
      now: dependencies.now?.() || Date.now(),
    });
    const autoApproved = result?.autoApprovalResult?.status === 'auto_approved';
    return success(request, config, {
      ...result,
      publicMutationAllowed: result?.publicMutationAllowed === true,
      publicMutationApplied: result?.publicMutationApplied === true,
      autoApprovalEnabled: result?.autoApprovalEnabled === true,
      stablePromotionAuthorized: false,
    }, result?.duplicate || autoApproved ? 200 : 202);
  } catch (error) {
    return failure(request, config, error);
  }
}

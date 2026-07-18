import { MAX_SUBMISSION_BYTES } from './submission_policy_v1.js';
import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  acceptPreviewSubmission,
  assertPreviewRequestAccess,
  readPreviewWriteConfig,
  registerPreviewDevice,
} from './preview_write_runtime_v1.js';

const SERVICE_ID = 'cloud-collab-preview-write';
const API_VERSION = '2026-07-18-stage4b2';
const MAX_REGISTRATION_BYTES = 4 * 1024;

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization, X-Cloud-Collab-Preview-Key',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=UTF-8',
      ...headers,
    }),
  });
}

function success(data, status = 200) {
  return jsonResponse({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    writeScope: 'fixture_only',
    data,
  }, { status });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '预览写入服务暂时不可用' : (error?.message || '请求失败');
  const details = status < 500 && error?.details ? { details: error.details } : {};
  const retryAfter = status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
    ? { 'Retry-After': String(error.details.retryAfterSeconds) }
    : {};
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    writeScope: 'fixture_only',
    error: { code, message, ...details },
  }, { status, headers: retryAfter });
}

function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function methodNotAllowed(method) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    writeScope: 'fixture_only',
    error: { code: 'METHOD_NOT_ALLOWED', message: `写入接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}

async function readJsonBody(request, maxBytes) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    const error = new Error('Content-Type必须为application/json');
    error.code = 'JSON_CONTENT_TYPE_REQUIRED';
    error.status = 415;
    throw error;
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error(`请求体不得超过${maxBytes}字节`);
    error.code = 'REQUEST_BODY_TOO_LARGE';
    error.status = 413;
    throw error;
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) {
    const error = new Error('请求体不能为空');
    error.code = 'EMPTY_JSON_BODY';
    error.status = 400;
    throw error;
  }
  if (bytes > maxBytes) {
    const error = new Error(`请求体不得超过${maxBytes}字节`);
    error.code = 'REQUEST_BODY_TOO_LARGE';
    error.status = 413;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    const error = new Error('请求体不是有效JSON');
    error.code = 'INVALID_JSON_BODY';
    error.status = 400;
    throw error;
  }
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

export async function handleDeviceRegisterRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'POST') return methodNotAllowed(method);

  try {
    const env = context?.env || {};
    const config = readPreviewWriteConfig(env);
    assertPreviewRequestAccess(context.request, config);
    const input = await readJsonBody(context.request, MAX_REGISTRATION_BYTES);
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const register = dependencies.registerPreview || registerPreviewDevice;
    const store = createStore(env);
    const result = await register({ store, input, env, now: dependencies.now?.() || Date.now() });
    return success({
      ...result,
      submissionEnabled: false,
      publicMutationAllowed: false,
      autoApprovalEnabled: false,
    }, 201);
  } catch (error) {
    return failure(error);
  }
}

export async function handleSubmissionCreateRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'POST') return methodNotAllowed(method);

  try {
    const env = context?.env || {};
    const config = readPreviewWriteConfig(env);
    assertPreviewRequestAccess(context.request, config);
    const rawSubmission = await readJsonBody(context.request, MAX_SUBMISSION_BYTES);
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const accept = dependencies.acceptPreview || acceptPreviewSubmission;
    const store = createStore(env);
    const result = await accept({
      store,
      authorization: context.request.headers.get('authorization') || '',
      rawSubmission,
      env,
      now: dependencies.now?.() || Date.now(),
    });
    return success({
      ...result,
      publicMutationAllowed: false,
      autoApprovalEnabled: false,
    }, result?.duplicate ? 200 : 202);
  } catch (error) {
    return failure(error);
  }
}

import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  AdminAcceptanceCleanupError,
  assertAdminAcceptanceCleanupAccess,
  assertAdminAcceptanceCleanupConfirmation,
  cleanupAdminAcceptanceObjects,
  inspectAdminAcceptanceObjects,
  readAdminAcceptanceCleanupConfig,
} from './admin_acceptance_cleanup_v1.js';

const SERVICE_ID = 'cloud-collab-admin-acceptance-cleanup';
const API_VERSION = '2026-07-19-stage5a-acceptance';
const MAX_BODY_BYTES = 1024;

function responseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
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
  return jsonResponse({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    data: {
      ...data,
      publicMutationAllowed: false,
      reviewMutationAllowed: false,
      acceptanceCleanupOnly: true,
    },
  });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : 'ADMIN_ACCEPTANCE_INTERNAL_ERROR';
  const message = status >= 500
    ? '阶段5A验收清理暂时不可用'
    : (error?.message || '阶段5A验收清理请求失败');
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code, message },
  }, { status });
}

function methodNotAllowed(method, allow) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `验收清理接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new AdminAcceptanceCleanupError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new AdminAcceptanceCleanupError('REQUEST_BODY_TOO_LARGE', '验收清理请求体不得超过1KB', 413);
  }
  const text = await request.text();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new AdminAcceptanceCleanupError(
      text ? 'REQUEST_BODY_TOO_LARGE' : 'EMPTY_JSON_BODY',
      text ? '验收清理请求体不得超过1KB' : '验收清理请求体不能为空',
      text ? 413 : 400,
    );
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new AdminAcceptanceCleanupError('INVALID_JSON_BODY', '验收清理请求体不是有效JSON', 400);
  }
}

function createAcceptanceStore(env, config, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneBlobStore;
  return createStore({ ...env, CLOUD_BLOB_STORE_NAME: config.storeName });
}

export async function handleAdminAcceptanceStatusRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const env = context?.env || {};
    const config = readAdminAcceptanceCleanupConfig(env);
    assertAdminAcceptanceCleanupAccess(context.request, config);
    const store = createAcceptanceStore(env, config, dependencies);
    const inspect = dependencies.inspect || inspectAdminAcceptanceObjects;
    return success(await inspect({ store }));
  } catch (error) {
    return failure(error);
  }
}

export async function handleAdminAcceptanceCleanupRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const env = context?.env || {};
    const config = readAdminAcceptanceCleanupConfig(env);
    assertAdminAcceptanceCleanupAccess(context.request, config, { requireOrigin: true });
    assertAdminAcceptanceCleanupConfirmation(await readJsonBody(context.request));
    const store = createAcceptanceStore(env, config, dependencies);
    const cleanup = dependencies.cleanup || cleanupAdminAcceptanceObjects;
    return success(await cleanup({ store }));
  } catch (error) {
    return failure(error);
  }
}

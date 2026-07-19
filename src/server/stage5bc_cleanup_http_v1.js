import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  STAGE5BC_CLEANUP_CONFIRMATION,
  Stage5bcCleanupError,
  assertStage5bcCleanupAccess,
  cleanupStage5bcObjects,
  inspectStage5bcObjects,
  readStage5bcCleanupConfig,
} from './stage5bc_cleanup_v1.js';

const SERVICE_ID = 'cloud-collab-stage5bc-cleanup';
const API_VERSION = '2026-07-19-stage5bc-cleanup-v1';
const MAX_BODY_BYTES = 2048;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function headers(extra = {}) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function json(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: headers({ 'Content-Type': 'application/json; charset=UTF-8', ...extra }),
  });
}

function success(action, data) {
  return json({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    action,
    data: {
      ...data,
      acceptanceEnabled: false,
      publicMutationAllowed: false,
      reviewMutationAllowed: false,
      cleanupOnly: true,
    },
  });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  return json({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'STAGE5BC_CLEANUP_INTERNAL_ERROR',
      message: status >= 500 ? '阶段5B/5C联合验收清理暂时不可用' : String(error?.message || '清理请求失败'),
      ...(status < 500 && error?.details ? { details: error.details } : {}),
    },
  }, status);
}

async function readBody(request) {
  const type = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new Stage5bcCleanupError('JSON_CONTENT_TYPE_REQUIRED', 'Content-Type必须为application/json', 415);
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Stage5bcCleanupError('REQUEST_BODY_TOO_LARGE', '清理请求体不得超过2KB', 413);
  }
  const text = await request.text();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new Stage5bcCleanupError(
      text ? 'REQUEST_BODY_TOO_LARGE' : 'EMPTY_JSON_BODY',
      text ? '清理请求体不得超过2KB' : '清理请求体不能为空',
      text ? 413 : 400,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (_) {
    throw new Stage5bcCleanupError('INVALID_JSON_BODY', '清理请求体不是有效JSON', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1 || value.confirmation !== STAGE5BC_CLEANUP_CONFIRMATION) {
    throw new Stage5bcCleanupError('INVALID_CLEANUP_REQUEST', '清理请求确认字段无效', 400);
  }
  if (value.action === 'inspect') {
    if (Object.keys(value).sort().join(',') !== 'action,confirmation,schemaVersion') {
      throw new Stage5bcCleanupError('INVALID_CLEANUP_REQUEST', '清理检查请求字段无效', 400);
    }
    return Object.freeze({ action: 'inspect' });
  }
  if (value.action === 'execute') {
    if (Object.keys(value).sort().join(',') !== 'action,confirmation,expectedAdminKeySetDigest,expectedPublicKeySetDigest,schemaVersion'
        || !DIGEST_PATTERN.test(String(value.expectedPublicKeySetDigest || ''))
        || !DIGEST_PATTERN.test(String(value.expectedAdminKeySetDigest || ''))) {
      throw new Stage5bcCleanupError('INVALID_CLEANUP_REQUEST', '执行清理必须携带两套检查摘要', 400);
    }
    return Object.freeze({
      action: 'execute',
      expectedPublicKeySetDigest: String(value.expectedPublicKeySetDigest),
      expectedAdminKeySetDigest: String(value.expectedAdminKeySetDigest),
    });
  }
  throw new Stage5bcCleanupError('INVALID_CLEANUP_ACTION', '清理动作必须为inspect或execute', 400);
}

export async function handleStage5bcCleanupRequest(context, dependencies = {}) {
  const method = String(context?.request?.method || 'GET').toUpperCase();
  if (method !== 'POST') {
    return json({
      ok: false,
      serviceId: SERVICE_ID,
      apiVersion: API_VERSION,
      error: { code: 'METHOD_NOT_ALLOWED', message: `清理接口不支持 ${method} 方法` },
    }, 405, { Allow: 'POST' });
  }
  try {
    const env = context?.env || {};
    const config = readStage5bcCleanupConfig(env);
    assertStage5bcCleanupAccess(context.request, config);
    const body = await readBody(context.request);
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const publicStore = createStore({ ...env, CLOUD_BLOB_STORE_NAME: config.publicStoreName });
    const adminStore = createStore({ ...env, CLOUD_BLOB_STORE_NAME: config.adminStoreName });
    const inspect = dependencies.inspect || inspectStage5bcObjects;
    const cleanup = dependencies.cleanup || cleanupStage5bcObjects;
    const result = body.action === 'inspect'
      ? await inspect({ publicStore, adminStore })
      : await cleanup({ publicStore, adminStore, ...body });
    return success(body.action, result);
  } catch (error) {
    return failure(error);
  }
}

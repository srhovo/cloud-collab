import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  STAGE5DEF_CLEANUP_CONFIRMATION,
  Stage5defCleanupError,
  assertStage5defCleanupAccess,
  cleanupStage5defObjects,
  inspectStage5defObjects,
  readStage5defCleanupConfig,
} from './stage5def_cleanup_v1.js';

const SERVICE_ID = 'cloud-collab-stage5def-cleanup';
const API_VERSION = '2026-07-20-stage5def-cleanup-v1';
const MAX_BODY_BYTES = 2_048;
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
    Vary: 'Origin',
    ...extra,
  };
}

function json(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: headers({ 'Content-Type': 'application/json; charset=UTF-8', ...extra }),
  });
}

function success(action, result) {
  return json({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    action,
    data: {
      result,
      acceptanceEnabled: false,
      adminCapabilitiesEnabled: false,
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
      code: typeof error?.code === 'string' && error.code
        ? error.code
        : 'STAGE5DEF_CLEANUP_INTERNAL_ERROR',
      message: status >= 500
        ? '阶段5D/5E/5F联合验收清理暂时不可用'
        : String(error?.message || '联合验收清理请求失败'),
      ...(status < 500 && error?.details ? { details: error.details } : {}),
    },
  }, status);
}

async function readBody(request) {
  const type = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(type)) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_CONTENT_TYPE_INVALID', '清理请求只接受JSON', 415);
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_BODY_SIZE_INVALID', '清理请求体不得超过2KB', 413);
  }
  const text = await request.text();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new Stage5defCleanupError(
      text ? 'STAGE5DEF_CLEANUP_BODY_SIZE_INVALID' : 'STAGE5DEF_CLEANUP_BODY_EMPTY',
      text ? '清理请求体不得超过2KB' : '清理请求体不能为空',
      text ? 413 : 400,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (_) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_JSON_INVALID', '清理请求体不是有效JSON', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1
      || value.confirmation !== STAGE5DEF_CLEANUP_CONFIRMATION) {
    throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_REQUEST_INVALID', '清理请求确认字段无效', 400);
  }
  if (value.action === 'inspect') {
    if (Object.keys(value).sort().join(',') !== 'action,confirmation,schemaVersion') {
      throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_REQUEST_INVALID', '清理检查请求字段无效', 400);
    }
    return Object.freeze({ action: 'inspect' });
  }
  if (value.action === 'execute') {
    if (Object.keys(value).sort().join(',') !== 'action,confirmation,expectedAdminKeySetDigest,expectedPublicKeySetDigest,schemaVersion'
        || !DIGEST_PATTERN.test(String(value.expectedPublicKeySetDigest || ''))
        || !DIGEST_PATTERN.test(String(value.expectedAdminKeySetDigest || ''))) {
      throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_REQUEST_INVALID', '执行清理必须携带两套检查摘要', 400);
    }
    return Object.freeze({
      action: 'execute',
      expectedPublicKeySetDigest: String(value.expectedPublicKeySetDigest),
      expectedAdminKeySetDigest: String(value.expectedAdminKeySetDigest),
    });
  }
  throw new Stage5defCleanupError('STAGE5DEF_CLEANUP_ACTION_INVALID', '清理动作必须为inspect或execute', 400);
}

export async function handleStage5defCleanupRequest(context, dependencies = {}) {
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
    const config = readStage5defCleanupConfig(env);
    assertStage5defCleanupAccess(context.request, config);
    const body = await readBody(context.request);
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const publicStore = createStore({ ...env, CLOUD_BLOB_STORE_NAME: config.publicStoreName });
    const adminStore = createStore({ ...env, CLOUD_BLOB_STORE_NAME: config.adminStoreName });
    const inspect = dependencies.inspect || inspectStage5defObjects;
    const cleanup = dependencies.cleanup || cleanupStage5defObjects;
    const result = body.action === 'inspect'
      ? await inspect({ publicStore, adminStore })
      : await cleanup({ publicStore, adminStore, ...body });
    return success(body.action, result);
  } catch (error) {
    return failure(error);
  }
}

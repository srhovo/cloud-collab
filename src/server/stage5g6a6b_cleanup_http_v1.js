import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertStage5g6a6bCleanupAccess,
  cleanupStage5g6a6bObjects,
  inspectStage5g6a6bObjects,
  readStage5g6a6bCleanupConfig,
} from './stage5g6a6b_cleanup_exact_v1.js';

const SERVICE_ID = 'stage5g6a6b-joint-cleanup';
const API_VERSION = '2026-07-20-stage5g6a6b';
const MAX_BODY_BYTES = 2048;

function responseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Content-Type': 'application/json; charset=UTF-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function json(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders(extra) });
}

function success(data) {
  return json({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'STAGE5G6A6B_CLEANUP_INTERNAL_ERROR';
  const message = status >= 500 ? '联合验收清理服务暂时不可用' : (error?.message || '联合验收清理失败');
  return json({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code, message, ...(status < 500 && error?.details ? { details: error.details } : {}) },
  }, status);
}

async function readBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    const error = new Error('Content-Type必须为application/json');
    error.code = 'JSON_CONTENT_TYPE_REQUIRED';
    error.status = 415;
    throw error;
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!bytes || bytes > MAX_BODY_BYTES) {
    const error = new Error(bytes ? `请求体不得超过${MAX_BODY_BYTES}字节` : '请求体不能为空');
    error.code = bytes ? 'REQUEST_BODY_TOO_LARGE' : 'EMPTY_JSON_BODY';
    error.status = bytes ? 413 : 400;
    throw error;
  }
  try { return JSON.parse(text); }
  catch (_) {
    const error = new Error('请求体不是有效JSON');
    error.code = 'INVALID_JSON_BODY';
    error.status = 400;
    throw error;
  }
}

function createStores(env, config, dependencies) {
  const factory = dependencies.createStore || createEdgeOneBlobStore;
  return {
    publicStore: factory({ ...env, CLOUD_BLOB_STORE_NAME: config.publicStoreName }),
    adminStore: factory({ ...env, CLOUD_BLOB_STORE_NAME: config.adminStoreName }),
  };
}

export async function handleStage5g6a6bCleanupRequest(context, dependencies = {}) {
  if (String(context?.request?.method || 'GET').toUpperCase() !== 'POST') {
    return json({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION,
      error: { code: 'METHOD_NOT_ALLOWED', message: '联合验收清理接口只允许POST' } }, 405, { Allow: 'POST' });
  }
  try {
    const env = context?.env || {};
    const config = readStage5g6a6bCleanupConfig(env);
    assertStage5g6a6bCleanupAccess(context?.request, config);
    const body = await readBody(context.request);
    const { publicStore, adminStore } = createStores(env, config, dependencies);
    if (body?.action === 'inspect' && Object.keys(body).length === 1) {
      return success(await inspectStage5g6a6bObjects({ publicStore, adminStore }));
    }
    if (body?.action === 'execute'
        && Object.keys(body).sort().join(',') === 'action,expectedAdminKeySetDigest,expectedPublicKeySetDigest') {
      return success(await cleanupStage5g6a6bObjects({
        publicStore,
        adminStore,
        expectedPublicKeySetDigest: body.expectedPublicKeySetDigest,
        expectedAdminKeySetDigest: body.expectedAdminKeySetDigest,
      }));
    }
    const error = new Error('清理请求字段无效');
    error.code = 'STAGE5G6A6B_CLEANUP_BODY_INVALID';
    error.status = 400;
    throw error;
  } catch (error) {
    return failure(error);
  }
}

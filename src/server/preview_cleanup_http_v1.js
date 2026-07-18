import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  PREVIEW_CLEANUP_CONFIRMATION,
  assertPreviewCleanupAccess,
  cleanupSyntheticPreviewObjects,
  readPreviewCleanupConfig,
} from './preview_cleanup_v1.js';

const SERVICE_ID = 'cloud-collab-preview-cleanup';
const API_VERSION = '2026-07-18-stage4c-cleanup';
const MAX_BODY_BYTES = 1024;

function headers(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, X-Cloud-Collab-Preview-Key',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: headers({ 'Content-Type': 'application/json; charset=UTF-8', ...extraHeaders }),
  });
}

function fail(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '一次性预览清理服务暂时不可用' : (error?.message || '清理请求失败');
  return json({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    writeScope: 'fixture_cleanup_only',
    error: { code, message, ...(status < 500 && error?.details ? { details: error.details } : {}) },
  }, status);
}

async function readBody(request) {
  const type = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    const error = new Error('Content-Type必须为application/json');
    error.code = 'JSON_CONTENT_TYPE_REQUIRED';
    error.status = 415;
    throw error;
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    const error = new Error('清理请求体过大');
    error.code = 'REQUEST_BODY_TOO_LARGE';
    error.status = 413;
    throw error;
  }
  let value;
  try { value = JSON.parse(text); }
  catch (_) {
    const error = new Error('请求体不是有效JSON');
    error.code = 'INVALID_JSON_BODY';
    error.status = 400;
    throw error;
  }
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.join(',') !== 'confirmation,schemaVersion' || value.schemaVersion !== 1 || value.confirmation !== PREVIEW_CLEANUP_CONFIRMATION) {
    const error = new Error('清理请求确认字段无效');
    error.code = 'INVALID_CLEANUP_REQUEST';
    error.status = 400;
    throw error;
  }
  return value;
}

export async function handlePreviewCleanupRequest(context, dependencies = {}) {
  const method = String(context?.request?.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: headers() });
  if (method !== 'POST') return json({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    writeScope: 'fixture_cleanup_only',
    error: { code: 'METHOD_NOT_ALLOWED', message: `清理接口不支持 ${method} 方法` },
  }, 405, { Allow: 'POST, OPTIONS' });

  try {
    const env = context?.env || {};
    const config = readPreviewCleanupConfig(env);
    assertPreviewCleanupAccess(context.request, config);
    await readBody(context.request);
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const cleanup = dependencies.cleanup || cleanupSyntheticPreviewObjects;
    const store = createStore(env);
    const result = await cleanup({ store });
    return json({
      ok: true,
      serviceId: SERVICE_ID,
      apiVersion: API_VERSION,
      writeScope: 'fixture_cleanup_only',
      data: result,
    }, 200);
  } catch (error) {
    return fail(error);
  }
}

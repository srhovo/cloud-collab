import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  STAGE4F_CLEANUP_CONFIRMATION,
  assertStage4fPreviewCleanupAccess,
  cleanupStage4fSyntheticPreviewObjects,
  inspectStage4fSyntheticPreviewObjects,
  readStage4fPreviewCleanupConfig,
} from './stage4f_preview_cleanup_v1.js';

const SERVICE_ID = 'cloud-collab-stage4f-preview-cleanup';
const API_VERSION = '2026-07-19-stage4f-cleanup-v1';
const MAX_BODY_BYTES = 2048;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function responseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders({ 'Content-Type': 'application/json; charset=UTF-8', ...extraHeaders }),
  });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '阶段4F一次性清理服务暂时不可用' : (error?.message || '清理请求失败');
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
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    const error = new Error('清理请求体过大');
    error.code = 'REQUEST_BODY_TOO_LARGE';
    error.status = 413;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1 || value.confirmation !== STAGE4F_CLEANUP_CONFIRMATION) {
    const error = new Error('清理请求确认字段无效');
    error.code = 'INVALID_CLEANUP_REQUEST';
    error.status = 400;
    throw error;
  }
  if (value.action === 'inspect') {
    if (Object.keys(value).sort().join(',') !== 'action,confirmation,schemaVersion') {
      const error = new Error('检查请求字段无效');
      error.code = 'INVALID_CLEANUP_REQUEST';
      error.status = 400;
      throw error;
    }
    return Object.freeze({ action: 'inspect' });
  }
  if (value.action === 'execute') {
    if (Object.keys(value).sort().join(',') !== 'action,confirmation,expectedKeySetDigest,schemaVersion'
        || !DIGEST_PATTERN.test(String(value.expectedKeySetDigest || ''))) {
      const error = new Error('执行请求必须携带检查阶段返回的对象集合摘要');
      error.code = 'INVALID_CLEANUP_REQUEST';
      error.status = 400;
      throw error;
    }
    return Object.freeze({ action: 'execute', expectedKeySetDigest: String(value.expectedKeySetDigest) });
  }
  const error = new Error('清理动作必须为inspect或execute');
  error.code = 'INVALID_CLEANUP_ACTION';
  error.status = 400;
  throw error;
}

export async function handleStage4fPreviewCleanupRequest(context, dependencies = {}) {
  const method = String(context?.request?.method || 'GET').toUpperCase();
  if (method !== 'POST') {
    return json({
      ok: false,
      serviceId: SERVICE_ID,
      apiVersion: API_VERSION,
      writeScope: 'fixture_cleanup_only',
      error: { code: 'METHOD_NOT_ALLOWED', message: `清理接口不支持 ${method} 方法` },
    }, 405, { Allow: 'POST' });
  }

  try {
    const env = context?.env || {};
    const config = readStage4fPreviewCleanupConfig(env);
    assertStage4fPreviewCleanupAccess(context.request, config);
    const body = await readBody(context.request);
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const inspect = dependencies.inspect || inspectStage4fSyntheticPreviewObjects;
    const cleanup = dependencies.cleanup || cleanupStage4fSyntheticPreviewObjects;
    const store = createStore(env);
    const result = body.action === 'inspect'
      ? await inspect({ store })
      : await cleanup({ store, expectedKeySetDigest: body.expectedKeySetDigest });
    return json({
      ok: true,
      serviceId: SERVICE_ID,
      apiVersion: API_VERSION,
      writeScope: 'fixture_cleanup_only',
      action: body.action,
      data: result,
    });
  } catch (error) {
    return failure(error);
  }
}

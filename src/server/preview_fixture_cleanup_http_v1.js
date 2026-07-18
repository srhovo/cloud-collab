import {
  assertPreviewFixtureCleanupAccess,
  inspectPreviewFixtureObjects,
  readPreviewFixtureCleanupConfig,
  runPreviewFixtureCleanup,
} from './preview_fixture_cleanup_once_v1.js';
import { createPreviewFixtureCleanupStore } from './preview_fixture_cleanup_runtime_v1.js';

const SERVICE_ID = 'cloud-collab-preview-fixture-cleanup-once';
const API_VERSION = '2026-07-18-stage4c-cleanup-once';
const MAX_BODY_BYTES = 2048;

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: securityHeaders({ 'Content-Type': 'application/json; charset=UTF-8', ...headers }),
  });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500 ? '一次性预览清理服务暂时不可用' : (error?.message || '请求失败');
  const details = status < 500 && error?.details ? { details: error.details } : {};
  return json({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION, error: { code, message, ...details } }, status);
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
    const error = new Error('请求体过大');
    error.code = 'REQUEST_BODY_TOO_LARGE';
    error.status = 413;
    throw error;
  }
  try { return JSON.parse(text || '{}'); }
  catch (_) {
    const error = new Error('请求体不是有效JSON');
    error.code = 'INVALID_JSON_BODY';
    error.status = 400;
    throw error;
  }
}

export async function handlePreviewFixtureCleanupRequest(context, dependencies = {}) {
  const method = String(context?.request?.method || 'GET').toUpperCase();
  if (method !== 'POST') return json({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION, error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持POST' } }, 405, { Allow: 'POST' });
  try {
    const env = context?.env || {};
    const config = readPreviewFixtureCleanupConfig(env);
    assertPreviewFixtureCleanupAccess(context.request, config);
    const body = await readBody(context.request);
    const store = (dependencies.createStore || createPreviewFixtureCleanupStore)(env);
    if (body.action === 'inspect') {
      const inspected = await inspectPreviewFixtureObjects(store);
      return json({
        ok: true,
        serviceId: SERVICE_ID,
        apiVersion: API_VERSION,
        data: {
          schemaVersion: inspected.schemaVersion,
          storeName: inspected.storeName,
          objectCount: inspected.objectCount,
          counts: inspected.counts,
          manifestDigest: inspected.manifestDigest,
          deletionPerformed: false,
        },
      });
    }
    if (body.action === 'execute') {
      const result = await runPreviewFixtureCleanup({
        store,
        expectedDigest: String(body.manifestDigest || ''),
        confirmation: String(body.confirmation || ''),
      });
      return json({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data: result });
    }
    const error = new Error('action只能是inspect或execute');
    error.code = 'INVALID_CLEANUP_ACTION';
    error.status = 400;
    throw error;
  } catch (error) {
    return failure(error);
  }
}

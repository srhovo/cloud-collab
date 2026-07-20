import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertStage5g6a6bAcceptanceAccess,
  inspectStage5g6a6bAcceptance,
  readStage5g6a6bAcceptanceConfig,
  seedStage5g6a6bAcceptance,
} from './stage5g6a6b_acceptance_v1.js';

const SERVICE_ID = 'stage5g6a6b-joint-acceptance';
const API_VERSION = '2026-07-20-stage5g6a6b';
const MAX_BODY_BYTES = 1024;

function headers(extra = {}) {
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
  return new Response(JSON.stringify(payload), { status, headers: headers(extra) });
}

function success(data, status = 200) {
  return json({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data }, status);
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'STAGE5G6A6B_ACCEPTANCE_INTERNAL_ERROR';
  const message = status >= 500 ? '联合验收服务暂时不可用' : (error?.message || '联合验收请求失败');
  return json({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code, message, ...(status < 500 && error?.details ? { details: error.details } : {}) },
  }, status);
}

function method(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function readAcceptanceRuntimeConfig(env = {}) {
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '0').trim() !== '0'
      || String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '0').trim() !== '0') {
    const error = new Error('联合验收部署必须保持正式公共写入与自动批准门禁关闭');
    error.code = 'STAGE5G6A6B_FORMAL_PUBLIC_MUTATION_MUST_BE_CLOSED';
    error.status = 503;
    throw error;
  }
  return readStage5g6a6bAcceptanceConfig({
    ...env,
    // 核心配置校验复用既有fixture写入约束；真实环境中的正式开关仍保持0。
    CLOUD_WRITE_PREVIEW_ENABLED: '1',
  });
}

async function readJson(request) {
  const type = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!type.startsWith('application/json')) {
    const error = new Error('Content-Type必须为application/json');
    error.code = 'JSON_CONTENT_TYPE_REQUIRED';
    error.status = 415;
    throw error;
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new Error(`请求体不得超过${MAX_BODY_BYTES}字节`);
    error.code = 'REQUEST_BODY_TOO_LARGE';
    error.status = 413;
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
  let value;
  try { value = JSON.parse(text); }
  catch (_) {
    const error = new Error('请求体不是有效JSON');
    error.code = 'INVALID_JSON_BODY';
    error.status = 400;
    throw error;
  }
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.length !== 1 || keys[0] !== 'confirmation') {
    const error = new Error('种子请求字段必须严格为confirmation');
    error.code = 'STAGE5G6A6B_SEED_BODY_INVALID';
    error.status = 400;
    throw error;
  }
  return value;
}

function createStore(env, config, dependencies) {
  const factory = dependencies.createStore || createEdgeOneBlobStore;
  return factory({ ...env, CLOUD_BLOB_STORE_NAME: config.publicStoreName });
}

export async function handleStage5g6a6bSeedRequest(context, dependencies = {}) {
  if (method(context?.request) !== 'POST') {
    return json({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION,
      error: { code: 'METHOD_NOT_ALLOWED', message: '联合验收种子接口只允许POST' } }, 405, { Allow: 'POST' });
  }
  try {
    const env = context?.env || {};
    const config = readAcceptanceRuntimeConfig(env);
    assertStage5g6a6bAcceptanceAccess(context?.request, config);
    const body = await readJson(context.request);
    const store = createStore(env, config, dependencies);
    const result = await seedStage5g6a6bAcceptance({
      store,
      confirmation: body.confirmation,
      now: dependencies.now?.() ?? Date.now(),
    });
    return success(result, result.duplicate ? 200 : 201);
  } catch (error) {
    return failure(error);
  }
}

export async function handleStage5g6a6bStatusRequest(context, dependencies = {}) {
  const requestMethod = method(context?.request);
  const head = requestMethod === 'HEAD';
  if (requestMethod !== 'GET' && !head) {
    return json({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION,
      error: { code: 'METHOD_NOT_ALLOWED', message: '联合验收状态接口只允许GET或HEAD' } }, 405, { Allow: 'GET, HEAD' });
  }
  try {
    const env = context?.env || {};
    const config = readAcceptanceRuntimeConfig(env);
    assertStage5g6a6bAcceptanceAccess(context?.request, config);
    const store = createStore(env, config, dependencies);
    const result = await inspectStage5g6a6bAcceptance({ store, now: dependencies.now?.() ?? Date.now() });
    if (head) return new Response(null, { status: 200, headers: headers() });
    return success(result);
  } catch (error) {
    return failure(error);
  }
}

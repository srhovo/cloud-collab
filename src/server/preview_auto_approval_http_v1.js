import { MAX_SUBMISSION_BYTES } from './submission_policy_v1.js';
import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertPreviewRequestAccess,
} from './preview_write_runtime_v1.js';
import {
  acceptAndReviewPreviewSubmission,
  projectPreviewPublicEvent,
  readPreviewAutoApprovalConfig,
  readPreviewPublicEvents,
  readPreviewPublicSnapshot,
} from './preview_auto_approval_runtime_v1.js';

const WRITE_SERVICE_ID = 'cloud-collab-preview-write';
const READ_SERVICE_ID = 'cloud-collab-readonly';
const API_VERSION = '2026-07-19-stage4e';
const MAX_CHANGE_LIMIT = 100;

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization, X-Cloud-Collab-Preview-Key',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function jsonResponse(payload, { status = 200, headers = {}, head = false } = {}) {
  return new Response(head ? null : JSON.stringify(payload), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=UTF-8',
      ...headers,
    }),
  });
}

function success(serviceId, data, { status = 200, head = false } = {}) {
  return jsonResponse({
    ok: true,
    serviceId,
    apiVersion: API_VERSION,
    data,
  }, { status, head });
}

function failure(serviceId, error, { head = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR';
  const message = status >= 500
    ? '隔离预览服务暂时不可用'
    : (error?.message || '请求失败');
  const details = status < 500 && error?.details ? { details: error.details } : {};
  const retryAfter = status === 429 && Number.isInteger(error?.details?.retryAfterSeconds)
    ? { 'Retry-After': String(error.details.retryAfterSeconds) }
    : {};
  return jsonResponse({
    ok: false,
    serviceId,
    apiVersion: API_VERSION,
    error: { code, message, ...details },
  }, { status, headers: retryAfter, head });
}

function methodNotAllowed(serviceId, method, allow, head = false) {
  return jsonResponse({
    ok: false,
    serviceId,
    apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow }, head });
}

function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function assertPreviewAccessBeforeStore(context) {
  const env = context?.env || {};
  const config = readPreviewAutoApprovalConfig(env);
  assertPreviewRequestAccess(context?.request, config);
  return { env, config };
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

function parseScope(request) {
  const url = new URL(request.url);
  return {
    groupId: String(url.searchParams.get('groupId') || '').trim().toLowerCase(),
    libraryId: String(url.searchParams.get('libraryId') || '').trim().toLowerCase(),
    url,
  };
}

function parseNonNegativeInteger(raw, code, message, fallback = null) {
  if ((raw === null || raw === '') && fallback === null) return null;
  const value = raw === null || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    const error = new Error(message);
    error.code = code;
    error.status = 400;
    throw error;
  }
  return value;
}

function readFlags(config = {}) {
  return Object.freeze({
    writeEnabled: false,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
    previewWriteEnabled: true,
    previewAutoApprovalEnabled: true,
    ...(config.ordinaryTypesEnabled === true ? { previewOrdinaryTypesEnabled: true } : {}),
  });
}

function recordCounts(snapshot, config = {}) {
  if (config.ordinaryTypesEnabled !== true) {
    return Object.freeze({ exactPrice: snapshot.records.length });
  }
  const counts = { exactPrice: 0, playableName: 0, bossProfile: 0 };
  for (const record of snapshot.records) {
    if (record.dataType === 'exact_price') counts.exactPrice += 1;
    else if (record.dataType === 'playable_name') counts.playableName += 1;
    else if (record.dataType === 'boss_profile') counts.bossProfile += 1;
  }
  return Object.freeze(counts);
}

export async function handlePreviewAutoApprovalSubmissionRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'POST') return methodNotAllowed(WRITE_SERVICE_ID, method, 'POST, OPTIONS');

  try {
    const { env, config } = assertPreviewAccessBeforeStore(context);
    const rawSubmission = await readJsonBody(context.request, MAX_SUBMISSION_BYTES);
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const acceptAndReview = dependencies.acceptAndReview || acceptAndReviewPreviewSubmission;
    const store = createStore(env);
    const result = await acceptAndReview({
      store,
      authorization: context.request.headers.get('authorization') || '',
      rawSubmission,
      env,
      now: dependencies.now?.() || Date.now(),
    });
    return success(WRITE_SERVICE_ID, {
      ...result,
      ...readFlags(config),
    }, { status: result?.duplicate ? 200 : 202 });
  } catch (error) {
    return failure(WRITE_SERVICE_ID, error);
  }
}

export async function handlePreviewPublicVersionRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  const head = method === 'HEAD';
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'GET' && !head) return methodNotAllowed(READ_SERVICE_ID, method, 'GET, HEAD, OPTIONS', head);

  try {
    const { env, config } = assertPreviewAccessBeforeStore(context);
    const { groupId, libraryId } = parseScope(context.request);
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const readSnapshot = dependencies.readSnapshot || readPreviewPublicSnapshot;
    const store = createStore(env);
    const snapshot = await readSnapshot({
      store,
      env,
      groupId,
      libraryId,
      now: dependencies.now?.() || Date.now(),
    });
    return success(READ_SERVICE_ID, {
      groupId: snapshot.groupId,
      libraryId: snapshot.libraryId,
      publicVersion: snapshot.publicVersion,
      snapshotVersion: snapshot.snapshotVersion,
      updatedAt: snapshot.publicVersion > 0 ? snapshot.generatedAt : null,
      status: snapshot.publicVersion > 0 ? 'preview_dynamic_ready' : 'preview_dynamic_empty',
      snapshotAvailable: snapshot.publicVersion > 0,
      recordCounts: recordCounts(snapshot, config),
      ...readFlags(config),
    }, { head });
  } catch (error) {
    return failure(READ_SERVICE_ID, error, { head });
  }
}

export async function handlePreviewPublicSnapshotRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  const head = method === 'HEAD';
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'GET' && !head) return methodNotAllowed(READ_SERVICE_ID, method, 'GET, HEAD, OPTIONS', head);

  try {
    const { env, config } = assertPreviewAccessBeforeStore(context);
    const { groupId, libraryId, url } = parseScope(context.request);
    const ifVersion = parseNonNegativeInteger(url.searchParams.get('ifVersion'), 'INVALID_PUBLIC_VERSION', 'ifVersion必须是非负整数', null);
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const readSnapshot = dependencies.readSnapshot || readPreviewPublicSnapshot;
    const store = createStore(env);
    const snapshot = await readSnapshot({
      store,
      env,
      groupId,
      libraryId,
      now: dependencies.now?.() || Date.now(),
    });
    let status = 'snapshot';
    let payloadSnapshot = snapshot;
    if (snapshot.publicVersion === 0) {
      status = 'snapshot_unavailable';
      payloadSnapshot = null;
    } else if (ifVersion !== null && ifVersion >= snapshot.publicVersion) {
      status = 'not_modified';
      payloadSnapshot = null;
    }
    return success(READ_SERVICE_ID, {
      status,
      groupId: snapshot.groupId,
      libraryId: snapshot.libraryId,
      publicVersion: snapshot.publicVersion,
      snapshotVersion: snapshot.snapshotVersion,
      snapshot: payloadSnapshot,
      ...readFlags(config),
    }, { head });
  } catch (error) {
    return failure(READ_SERVICE_ID, error, { head });
  }
}

export async function handlePreviewPublicChangesRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  const head = method === 'HEAD';
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'GET' && !head) return methodNotAllowed(READ_SERVICE_ID, method, 'GET, HEAD, OPTIONS', head);

  try {
    const { env, config } = assertPreviewAccessBeforeStore(context);
    const { groupId, libraryId, url } = parseScope(context.request);
    const sinceVersion = parseNonNegativeInteger(url.searchParams.get('sinceVersion'), 'INVALID_PUBLIC_VERSION', 'sinceVersion必须是非负整数', 0);
    const limit = parseNonNegativeInteger(url.searchParams.get('limit'), 'INVALID_CHANGE_LIMIT', 'limit必须位于1至100', 100);
    if (limit < 1 || limit > MAX_CHANGE_LIMIT) {
      const error = new Error('limit必须位于1至100');
      error.code = 'INVALID_CHANGE_LIMIT';
      error.status = 400;
      throw error;
    }
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const readEvents = dependencies.readEvents || readPreviewPublicEvents;
    const store = createStore(env);
    const events = await readEvents({ store, env, groupId, libraryId });
    const publicVersion = events.length ? events[events.length - 1].version : 0;
    if (sinceVersion > publicVersion) {
      const error = new Error('本地版本高于预览服务器版本，需要重新读取快照');
      error.code = 'PUBLIC_VERSION_AHEAD';
      error.status = 409;
      error.details = { sinceVersion, publicVersion };
      throw error;
    }
    const selected = events.filter(event => event.version > sinceVersion).slice(0, limit);
    const nextVersion = selected.length ? selected[selected.length - 1].version : sinceVersion;
    return success(READ_SERVICE_ID, {
      status: selected.length ? 'changes' : 'not_modified',
      groupId,
      libraryId,
      sinceVersion,
      publicVersion,
      snapshotVersion: publicVersion,
      changes: selected.map(projectPreviewPublicEvent),
      nextVersion,
      hasMore: events.some(event => event.version > nextVersion),
      ...readFlags(config),
    }, { head });
  } catch (error) {
    return failure(READ_SERVICE_ID, error, { head });
  }
}

import { MAX_SUBMISSION_BYTES } from './submission_policy_v1.js';
import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertPreviewRequestAccess,
  readPreviewWriteConfig,
} from './preview_write_runtime_v1.js';
import {
  readSensitiveRulesPreviewConfig,
} from './sensitive_rules_policy_v1.js';
import {
  acceptSensitiveSubmission,
} from './sensitive_submission_acceptance_v1.js';
import {
  buildUnifiedSensitivePublicSnapshot,
} from './sensitive_public_engine_v1.js';

const SERVICE_ID = 'cloud-collab-sensitive-submission-preview';
const API_VERSION = '2026-07-20-stage6b';

function headers(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization, X-Cloud-Collab-Preview-Key',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store, max-age=0',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function jsonResponse(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: headers({ 'Content-Type': 'application/json; charset=UTF-8', ...extra }),
  });
}

function success(data, status = 202) {
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data: {
    ...data,
    previewSensitiveRulesEnabled: true,
    sensitiveManualReviewRequired: true,
    publicMutationAllowed: false,
    autoApprovalEnabled: false,
  } }, status);
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'SENSITIVE_SUBMISSION_INTERNAL_ERROR';
  const message = status >= 500 ? '敏感候选预览服务暂时不可用' : (error?.message || '敏感候选提交失败');
  return jsonResponse({ ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION, error: {
    code,
    message,
    ...(status < 500 && error?.details ? { details: error.details } : {}),
  } }, status, status === 429 && error?.details?.retryAfterSeconds ? { 'Retry-After': String(error.details.retryAfterSeconds) } : {});
}

function method(request) { return String(request?.method || 'GET').toUpperCase(); }

async function readJson(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    const error = new Error('Content-Type必须为application/json');
    error.code = 'JSON_CONTENT_TYPE_REQUIRED'; error.status = 415; throw error;
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SUBMISSION_BYTES) {
    const error = new Error(`请求体不得超过${MAX_SUBMISSION_BYTES}字节`);
    error.code = 'REQUEST_BODY_TOO_LARGE'; error.status = 413; throw error;
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!bytes || bytes > MAX_SUBMISSION_BYTES) {
    const error = new Error(bytes ? `请求体不得超过${MAX_SUBMISSION_BYTES}字节` : '请求体不能为空');
    error.code = bytes ? 'REQUEST_BODY_TOO_LARGE' : 'EMPTY_JSON_BODY'; error.status = bytes ? 413 : 400; throw error;
  }
  try { return JSON.parse(text); }
  catch (_) { const error = new Error('请求体不是有效JSON'); error.code = 'INVALID_JSON_BODY'; error.status = 400; throw error; }
}

function readConfig(env) {
  const write = readPreviewWriteConfig(env);
  const sensitive = readSensitiveRulesPreviewConfig(env);
  const writeStoreName = String(env.CLOUD_BLOB_STORE_NAME || '').trim();
  if (writeStoreName !== sensitive.storeName
      || write.allowedGroupId !== sensitive.groupId
      || write.allowedLibraryId !== sensitive.libraryId) {
    const error = new Error('敏感候选必须与隔离写入使用同一合成作用域');
    error.code = 'SENSITIVE_SUBMISSION_SCOPE_INVALID'; error.status = 503; throw error;
  }
  return Object.freeze({ write: Object.freeze({ ...write, storeName: writeStoreName }), sensitive });
}

function projectSensitiveBaselineRecord(record) {
  if (!record) return null;
  return Object.freeze({
    businessKey: record.businessKey,
    contentHash: record.contentHash,
    dataType: record.dataType,
    bossId: record.bossId ?? null,
    payload: record.payload,
  });
}

export async function handleSensitiveSubmissionRequest(context, dependencies = {}) {
  const requestMethod = method(context?.request);
  if (requestMethod === 'OPTIONS') return new Response(null, { status: 204, headers: headers() });
  if (requestMethod !== 'POST') return jsonResponse({
    ok: false, serviceId: SERVICE_ID, apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `敏感候选接口不支持 ${requestMethod} 方法` },
  }, 405, { Allow: 'POST, OPTIONS' });

  try {
    const env = context?.env || {};
    const config = readConfig(env);
    assertPreviewRequestAccess(context.request, config.write);
    const rawSubmission = await readJson(context.request);
    if (String(rawSubmission?.groupId || '').trim().toLowerCase() !== config.sensitive.groupId
        || String(rawSubmission?.libraryId || '').trim().toLowerCase() !== config.sensitive.libraryId) {
      const error = new Error('敏感候选只允许合成测试团和测试价格库');
      error.code = 'PREVIEW_SCOPE_FORBIDDEN'; error.status = 403; throw error;
    }
    const createStore = dependencies.createStore || createEdgeOneBlobStore;
    const store = createStore({ ...env, CLOUD_BLOB_STORE_NAME: config.sensitive.storeName });
    const now = dependencies.now?.() ?? Date.now();
    const snapshotBuilder = dependencies.buildSnapshot || buildUnifiedSensitivePublicSnapshot;
    const snapshot = await snapshotBuilder({ store, groupId: config.sensitive.groupId, libraryId: config.sensitive.libraryId, now });
    const resolveExistingRecord = async ({ businessKey }) => projectSensitiveBaselineRecord(
      snapshot.records.find(item => item.businessKey === businessKey) || null,
    );
    const accept = dependencies.accept || acceptSensitiveSubmission;
    const result = await accept({
      store,
      authorization: context.request.headers.get('authorization') || '',
      rawSubmission,
      resolveExistingRecord,
      now,
      ...(dependencies.authenticate ? { authenticate: dependencies.authenticate } : {}),
    });
    return success(result, result?.duplicate ? 200 : 202);
  } catch (error) {
    return failure(error);
  }
}

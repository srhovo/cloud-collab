import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  readAdminAuthConfig,
  readAdminSessionCookie,
  verifyAdminSessionToken,
} from './admin_auth_v1.js';
import {
  ADMIN_EXPORT_CAPABILITIES,
  ADMIN_EXPORT_MAX_BODY_BYTES,
  AdminExportError,
  buildAdminExportSummary,
  createAdminExportDownload,
  isAdminExportProjectionSafe,
  readAdminExportConfig,
} from './admin_export_v1.js';

const SERVICE_ID = 'cloud-collab-admin-export-preview';
const API_VERSION = '2026-07-20-stage5f';

function baseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Cookie, Origin',
    ...extra,
  };
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: baseHeaders({ 'Content-Type': 'application/json; charset=UTF-8', ...headers }),
  });
}

function viewer(identity) {
  return Object.freeze({
    authenticated: true,
    username: identity.username,
    sessionIdSuffix: identity.sessionIdSuffix,
    expiresAt: identity.expiresAt,
  });
}

function summarySuccess(identity, result) {
  const data = { viewer: viewer(identity), result, capabilities: ADMIN_EXPORT_CAPABILITIES };
  if (!isAdminExportProjectionSafe(data)) {
    throw new AdminExportError('ADMIN_EXPORT_UNSAFE_RESPONSE', '管理员导出摘要包含禁止字段', 500);
  }
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data });
}

function failure(error, { clearSession = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : 'ADMIN_EXPORT_INTERNAL_ERROR';
  const message = status >= 500
    ? '管理员导出暂时不可用'
    : (error?.message || '管理员导出请求失败');
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code, message },
  }, {
    status,
    headers: clearSession ? { 'Set-Cookie': clearAdminSessionCookie() } : {},
  });
}

function methodNotAllowed(method, allow) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code: 'METHOD_NOT_ALLOWED', message: `管理员导出接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function parseRequestUrl(request) {
  try {
    return new URL(request?.url || '');
  } catch (_) {
    throw new AdminExportError('ADMIN_EXPORT_REQUEST_INVALID', '管理员导出请求地址无效', 400);
  }
}

function assertNoQuery(request) {
  if ([...parseRequestUrl(request).searchParams.keys()].length !== 0) {
    throw new AdminExportError('ADMIN_EXPORT_QUERY_INVALID', '管理员导出接口不接受查询参数', 400);
  }
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new AdminExportError('ADMIN_EXPORT_CONTENT_TYPE_INVALID', '管理员导出只接受JSON', 415);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 2 || bytes > ADMIN_EXPORT_MAX_BODY_BYTES) {
    throw new AdminExportError('ADMIN_EXPORT_BODY_SIZE_INVALID', '管理员导出请求大小无效', 413);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new AdminExportError('ADMIN_EXPORT_JSON_INVALID', '管理员导出JSON无效', 400);
  }
}

function authenticateAndConfigure(context, dependencies, { requireOrigin = false } = {}) {
  const env = context?.env || {};
  const authConfig = readAdminAuthConfig(env);
  assertAdminSameOriginRequest(context.request, {
    requireOrigin,
    publicOrigin: authConfig.publicOrigin,
  });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  const exportConfig = readAdminExportConfig(env);
  return { env, identity, exportConfig };
}

function createExportStore(env, exportConfig, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneBlobStore;
  return createStore({ ...env, CLOUD_BLOB_STORE_NAME: exportConfig.storeName });
}

export async function handleAdminExportSummaryRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { env, identity, exportConfig } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const store = createExportStore(env, exportConfig, dependencies);
    const build = dependencies.buildSummary || buildAdminExportSummary;
    const result = await build({
      store,
      config: exportConfig,
      now: dependencies.now?.() ?? Date.now(),
    });
    return summarySuccess(identity, result);
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

export async function handleAdminExportDownloadRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const { env, identity, exportConfig } = authenticateAndConfigure(
      context,
      dependencies,
      { requireOrigin: true },
    );
    assertNoQuery(context.request);
    const command = await readJsonBody(context.request);
    const store = createExportStore(env, exportConfig, dependencies);
    const createDownload = dependencies.createDownload || createAdminExportDownload;
    const bundle = await createDownload({
      store,
      config: exportConfig,
      identity,
      command,
      now: dependencies.now?.() ?? Date.now(),
    });
    return new Response(bundle.bytes, {
      status: 200,
      headers: baseHeaders({
        'Content-Type': bundle.contentType,
        'Content-Length': String(bundle.byteLength),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(bundle.filename)}`,
        'X-Mdq-Package-Id': bundle.packageId,
        'X-Mdq-Public-Version': String(bundle.publicVersion),
        'X-Mdq-File-Count': String(bundle.fileCount),
        'X-Mdq-Duplicate': bundle.duplicate ? '1' : '0',
      }),
    });
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

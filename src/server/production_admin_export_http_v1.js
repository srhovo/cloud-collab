import { createEdgeOneNamedBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  readAdminSessionCookie,
} from './admin_auth_v1.js';
import {
  readProductionAdminAuthConfig,
  verifyProductionAdminSessionToken,
} from './production_admin_auth_v1.js';
import { readProductionRuntimeConfig } from './production_runtime_config_v1.js';
import {
  PRODUCTION_ADMIN_EXPORT_MAX_BODY_BYTES,
  ProductionAdminExportError,
  buildProductionAdminExportSummary,
  createProductionAdminExportDownload,
  isProductionAdminExportProjectionSafe,
} from './production_admin_export_v1.js';

const SERVICE_ID = 'cloud-collab-admin-export-production';
const API_VERSION = '2026-07-21-stage8a';

export class ProductionAdminExportHttpError extends Error {
  constructor(code, message, status = 503, details = null, cause = null) {
    super(message || code || '正式公共数据库导出失败');
    this.name = 'ProductionAdminExportHttpError';
    this.code = code || 'PRODUCTION_ADMIN_EXPORT_HTTP_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function readProductionAdminExportConfig(env = {}) {
  let runtime;
  try {
    runtime = readProductionRuntimeConfig(env);
  } catch (error) {
    throw new ProductionAdminExportHttpError(
      error?.code || 'PRODUCTION_ADMIN_EXPORT_CONFIG_INVALID',
      error?.message || '正式导出配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  if (runtime.mode !== 'production'
      || runtime.flags.readSync !== true
      || runtime.flags.admin !== true
      || runtime.flags.export !== true) {
    throw new ProductionAdminExportHttpError(
      'PRODUCTION_ADMIN_EXPORT_DISABLED',
      '正式公共数据库导出能力未开启',
      503,
    );
  }
  const auditSalt = String(runtime.secrets.CLOUD_ADMIN_EXPORT_AUDIT_SALT || '');
  if (Buffer.byteLength(auditSalt, 'utf8') < 32) {
    throw new ProductionAdminExportHttpError(
      'PRODUCTION_ADMIN_EXPORT_AUDIT_SALT_INVALID',
      '正式导出审计盐值无效',
      503,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: 'production',
    productionEnabled: true,
    storeName: runtime.publicStoreName,
    groupId: runtime.scope.protocol.groupId,
    libraryId: runtime.scope.protocol.libraryId,
    externalScope: runtime.scope.external,
    publicOrigin: runtime.adminOrigin,
    auditSalt,
    syntheticFixtureOnly: false,
    stablePromotionAuthorized: false,
  });
}

function responseHeaders(extra = {}) {
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
    headers: responseHeaders({ 'Content-Type': 'application/json; charset=UTF-8', ...headers }),
  });
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function methodNotAllowed(method, allow) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: { code: 'METHOD_NOT_ALLOWED', message: `正式导出接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: {
      code: error?.code || 'PRODUCTION_ADMIN_EXPORT_INTERNAL_ERROR',
      message: status >= 500 ? '正式公共数据库导出暂时不可用' : (error?.message || '管理员导出请求失败'),
    },
  }, {
    status,
    headers: error?.status === 401 ? { 'Set-Cookie': clearAdminSessionCookie() } : {},
  });
}

function parseUrl(request) {
  try { return new URL(request?.url || ''); }
  catch (_) { throw new ProductionAdminExportError('PRODUCTION_EXPORT_URL_INVALID', '正式导出请求地址无效', 400); }
}

function assertNoQuery(request) {
  if ([...parseUrl(request).searchParams.keys()].length !== 0) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_QUERY_INVALID', '正式导出接口不接受查询参数', 400);
  }
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_CONTENT_TYPE_INVALID', '正式导出下载只接受JSON', 415);
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > PRODUCTION_ADMIN_EXPORT_MAX_BODY_BYTES) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_BODY_SIZE_INVALID', '正式导出请求体过大', 413);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 2 || bytes > PRODUCTION_ADMIN_EXPORT_MAX_BODY_BYTES) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_BODY_SIZE_INVALID', '正式导出请求大小无效', 413);
  }
  try { return JSON.parse(text); }
  catch (_) { throw new ProductionAdminExportError('PRODUCTION_EXPORT_JSON_INVALID', '正式导出JSON无效', 400); }
}

function authenticateAndConfigure(context, dependencies, { requireOrigin = false } = {}) {
  const env = context?.env || {};
  const authConfig = readProductionAdminAuthConfig(env);
  const exportConfig = readProductionAdminExportConfig(env);
  if (authConfig.publicOrigin !== exportConfig.publicOrigin) {
    throw new ProductionAdminExportHttpError(
      'PRODUCTION_ADMIN_EXPORT_ORIGIN_MISMATCH',
      '正式管理员身份与导出来源不一致',
      503,
    );
  }
  assertAdminSameOriginRequest(context.request, { requireOrigin, publicOrigin: authConfig.publicOrigin });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyProductionAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  return { identity, exportConfig };
}

function createExportStore(config, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
  return createStore(config.storeName);
}

function viewer(identity) {
  return Object.freeze({
    authenticated: true,
    username: identity.username,
    sessionIdSuffix: identity.sessionIdSuffix,
    expiresAt: identity.expiresAt,
  });
}

export async function handleProductionAdminExportSummaryRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { identity, exportConfig } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const buildSummary = dependencies.buildSummary || buildProductionAdminExportSummary;
    const summary = await buildSummary({
      store: createExportStore(exportConfig, dependencies),
      config: exportConfig,
      now: dependencies.now?.() ?? Date.now(),
      ...(dependencies.buildBundle ? { buildBundle: dependencies.buildBundle } : {}),
    });
    const data = Object.freeze({
      viewer: viewer(identity),
      summary,
      capabilities: Object.freeze({
        exportSummary: true,
        exportDownload: true,
        productionAdmin: true,
        syntheticFixtureOnly: false,
        privateCredentialsIncluded: false,
        stablePromotionAuthorized: false,
      }),
      realSecretValuesExposed: false,
      stablePromotionAuthorized: false,
    });
    if (!isProductionAdminExportProjectionSafe(data)) {
      throw new ProductionAdminExportHttpError('PRODUCTION_ADMIN_EXPORT_UNSAFE_RESPONSE', '正式导出摘要包含禁止字段', 500);
    }
    return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, mode: 'production', data });
  } catch (error) {
    return failure(error);
  }
}

export async function handleProductionAdminExportDownloadRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const { identity, exportConfig } = authenticateAndConfigure(context, dependencies, { requireOrigin: true });
    assertNoQuery(context.request);
    const command = await readJsonBody(context.request);
    const createDownload = dependencies.createDownload || createProductionAdminExportDownload;
    const result = await createDownload({
      store: createExportStore(exportConfig, dependencies),
      config: exportConfig,
      identity,
      command,
      now: dependencies.now?.() ?? Date.now(),
      ...(dependencies.buildBundle ? { buildBundle: dependencies.buildBundle } : {}),
    });
    return new Response(result.bytes, {
      status: 200,
      headers: responseHeaders({
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        'Content-Length': String(result.byteLength),
        'X-Cloud-Collab-Package-Id': result.packageId,
        'X-Cloud-Collab-Public-Version': String(result.publicVersion),
        'X-Cloud-Collab-Export-Duplicate': result.duplicate ? '1' : '0',
      }),
    });
  } catch (error) {
    return failure(error);
  }
}

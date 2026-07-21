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
import {
  PRODUCTION_EXPORT_CAPABILITIES,
  PRODUCTION_EXPORT_MAX_BODY_BYTES,
  ProductionAdminExportError,
  buildProductionMigrationExportSummary,
  isProductionExportProjectionSafe,
} from './production_admin_export_v1.js';
import { createProductionMigrationExportDownloadV1 } from './production_admin_export_download_v1.js';
import { readProductionRuntimeConfig } from './production_runtime_config_v1.js';

const SERVICE_ID = 'cloud-collab-admin-migration-export-production';
const API_VERSION = '2026-07-21-stage8a';

export function readProductionAdminExportConfig(env = {}) {
  let runtime;
  try {
    runtime = readProductionRuntimeConfig(env);
  } catch (error) {
    throw new ProductionAdminExportError(
      error?.code || 'PRODUCTION_EXPORT_CONFIG_INVALID',
      error?.message || '正式迁移导出配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  if (runtime.mode !== 'production'
      || runtime.flags.production !== true
      || runtime.flags.readSync !== true
      || runtime.flags.admin !== true
      || runtime.flags.migrationExport !== true) {
    throw new ProductionAdminExportError(
      'PRODUCTION_EXPORT_DISABLED',
      '正式迁移导出能力未开启',
      503,
    );
  }
  const auditSalt = String(runtime.secrets.CLOUD_ADMIN_EXPORT_AUDIT_SALT || '');
  if (Buffer.byteLength(auditSalt, 'utf8') < 32) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_AUDIT_SALT_INVALID', '正式迁移导出审计盐值无效', 503);
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: 'production',
    productionEnabled: true,
    storeName: runtime.publicStoreName,
    groupId: runtime.scope.protocol.groupId,
    libraryId: runtime.scope.protocol.libraryId,
    externalScope: runtime.scope.external,
    protocolScope: runtime.scope.protocol,
    auditSalt,
    publicOrigin: runtime.adminOrigin,
    stablePromotionAuthorized: false,
  });
}

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

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function methodNotAllowed(method, allow) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: { code: 'METHOD_NOT_ALLOWED', message: `正式管理员迁移导出接口不支持 ${method || 'UNKNOWN'} 方法` },
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
      code: error?.code || 'PRODUCTION_EXPORT_INTERNAL_ERROR',
      message: status >= 500 ? '正式管理员迁移导出暂时不可用' : (error?.message || '正式管理员迁移导出请求失败'),
    },
  }, {
    status,
    headers: error?.status === 401 ? { 'Set-Cookie': clearAdminSessionCookie() } : {},
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

function summarySuccess(identity, config, result) {
  const data = {
    viewer: viewer(identity),
    result,
    externalScope: config.externalScope,
    protocolScope: config.protocolScope,
    capabilities: PRODUCTION_EXPORT_CAPABILITIES,
    realSecretValuesExposed: false,
    stablePromotionAuthorized: false,
  };
  if (!isProductionExportProjectionSafe(data)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_UNSAFE_RESPONSE', '正式迁移导出摘要包含禁止字段', 500);
  }
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, mode: 'production', data });
}

function parseRequestUrl(request) {
  try {
    return new URL(request?.url || '');
  } catch (_) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_REQUEST_INVALID', '正式迁移导出请求地址无效', 400);
  }
}

function assertNoQuery(request) {
  if ([...parseRequestUrl(request).searchParams.keys()].length !== 0) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_QUERY_INVALID', '正式迁移导出接口不接受查询参数', 400);
  }
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_CONTENT_TYPE_INVALID', '正式迁移导出只接受JSON', 415);
  }
  const declared = Number(request?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > PRODUCTION_EXPORT_MAX_BODY_BYTES) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_BODY_SIZE_INVALID', '正式迁移导出请求大小无效', 413);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 2 || bytes > PRODUCTION_EXPORT_MAX_BODY_BYTES) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_BODY_SIZE_INVALID', '正式迁移导出请求大小无效', 413);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_JSON_INVALID', '正式迁移导出JSON无效', 400);
  }
}

function authenticateAndConfigure(context, dependencies, { requireOrigin = false } = {}) {
  const env = context?.env || {};
  const authConfig = readProductionAdminAuthConfig(env);
  const exportConfig = readProductionAdminExportConfig(env);
  if (authConfig.publicOrigin !== exportConfig.publicOrigin) {
    throw new ProductionAdminExportError('PRODUCTION_EXPORT_ORIGIN_MISMATCH', '正式管理员身份与迁移导出来源不一致', 503);
  }
  assertAdminSameOriginRequest(context.request, {
    requireOrigin,
    publicOrigin: authConfig.publicOrigin,
  });
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

export async function handleProductionAdminExportSummaryRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { identity, exportConfig } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const build = dependencies.buildSummary || buildProductionMigrationExportSummary;
    const result = await build({
      store: createExportStore(exportConfig, dependencies),
      config: exportConfig,
      now: dependencies.now?.() ?? Date.now(),
      buildSnapshot: dependencies.buildSnapshot,
    });
    return summarySuccess(identity, exportConfig, result);
  } catch (error) {
    return failure(error);
  }
}

export async function handleProductionAdminExportDownloadRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const { identity, exportConfig } = authenticateAndConfigure(
      context,
      dependencies,
      { requireOrigin: true },
    );
    assertNoQuery(context.request);
    const command = await readJsonBody(context.request);
    const createDownload = dependencies.createDownload || createProductionMigrationExportDownloadV1;
    const bundle = await createDownload({
      store: createExportStore(exportConfig, dependencies),
      config: exportConfig,
      identity,
      command,
      now: dependencies.now?.() ?? Date.now(),
      buildBundle: dependencies.buildBundle,
    });
    return new Response(bundle.bytes, {
      status: 200,
      headers: baseHeaders({
        'Content-Type': bundle.contentType,
        'Content-Length': String(bundle.byteLength),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(bundle.filename)}`,
        'X-Mdq-Package-Id': bundle.packageId,
        'X-Mdq-Package-Format': '2',
        'X-Mdq-Public-Version': String(bundle.publicVersion),
        'X-Mdq-Record-Count': String(bundle.recordCount),
        'X-Mdq-Tombstone-Count': String(bundle.tombstoneCount),
        'X-Mdq-File-Count': String(bundle.fileCount),
        'X-Mdq-Duplicate': bundle.duplicate ? '1' : '0',
        'X-Mdq-Stable-Promotion-Authorized': '0',
      }),
    });
  } catch (error) {
    return failure(error);
  }
}

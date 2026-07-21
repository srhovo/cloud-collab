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
  ADMIN_DEVICE_GOVERNANCE_CAPABILITIES,
  DEVICE_GOVERNANCE_MAX_BODY_BYTES,
  DeviceGovernanceError,
  getAdminDeviceDetail,
  isAdminDeviceGovernanceProjectionSafe,
  listAdminDevices,
  mutateDeviceGovernance,
} from './device_governance_v1.js';

const SERVICE_ID = 'cloud-collab-admin-device-governance-production';
const API_VERSION = '2026-07-21-stage7w';

export class ProductionDeviceGovernanceError extends Error {
  constructor(code, message, status = 503, details = null, cause = null) {
    super(message || code || '正式管理员设备治理失败');
    this.name = 'ProductionDeviceGovernanceError';
    this.code = code || 'PRODUCTION_DEVICE_GOVERNANCE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

export function readProductionDeviceGovernanceConfig(env = {}) {
  let runtime;
  try { runtime = readProductionRuntimeConfig(env); }
  catch (error) {
    throw new ProductionDeviceGovernanceError(
      error?.code || 'PRODUCTION_DEVICE_GOVERNANCE_CONFIG_INVALID',
      error?.message || '正式设备治理配置无效',
      error?.status || 503,
      error?.details || null,
      error,
    );
  }
  if (runtime.mode !== 'production'
      || runtime.flags.admin !== true
      || runtime.flags.deviceGovernance !== true) {
    throw new ProductionDeviceGovernanceError(
      'PRODUCTION_DEVICE_GOVERNANCE_DISABLED',
      '正式设备治理能力未开启',
      503,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: 'production',
    storeName: runtime.publicStoreName,
    deviceRefSalt: runtime.secrets.CLOUD_ADMIN_DEVICE_REF_SALT,
    publicOrigin: runtime.adminOrigin,
    externalScope: runtime.scope.external,
    protocolScope: runtime.scope.protocol,
    syntheticFixtureOnly: false,
    stablePromotionAuthorized: false,
  });
}

const CAPABILITIES = Object.freeze({
  ...ADMIN_DEVICE_GOVERNANCE_CAPABILITIES,
  productionAdmin: true,
  syntheticFixtureOnly: false,
  publicMutationAllowed: false,
  stablePromotionAuthorized: false,
});

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

function jsonResponse(payload, { status = 200, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders({ 'Content-Type': 'application/json; charset=UTF-8', ...extraHeaders }),
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

function success(identity, config, result) {
  const data = Object.freeze({
    viewer: viewer(identity),
    scope: Object.freeze({
      external: config.externalScope,
      protocol: config.protocolScope,
      syntheticFixtureOnly: false,
    }),
    result,
    capabilities: CAPABILITIES,
    realSecretValuesExposed: false,
    stablePromotionAuthorized: false,
  });
  if (!isAdminDeviceGovernanceProjectionSafe(data)) {
    throw new ProductionDeviceGovernanceError(
      'PRODUCTION_DEVICE_GOVERNANCE_UNSAFE_RESPONSE',
      '正式设备治理响应包含禁止字段',
      500,
    );
  }
  return jsonResponse({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    data,
  });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status : 500;
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: {
      code: error?.code || 'PRODUCTION_DEVICE_GOVERNANCE_INTERNAL_ERROR',
      message: status >= 500 ? '正式管理员设备治理暂时不可用' : (error?.message || '请求失败'),
    },
  }, {
    status,
    extraHeaders: error?.status === 401 ? { 'Set-Cookie': clearAdminSessionCookie() } : {},
  });
}

function method(request) { return String(request?.method || 'GET').toUpperCase(); }
function methodNotAllowed(requestMethod, allow) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    mode: 'production',
    error: { code: 'METHOD_NOT_ALLOWED', message: `正式设备治理接口不支持 ${requestMethod || 'UNKNOWN'} 方法` },
  }, { status: 405, extraHeaders: { Allow: allow } });
}
function parseUrl(request) {
  try { return new URL(request?.url || ''); }
  catch (_) { throw new ProductionDeviceGovernanceError('PRODUCTION_DEVICE_GOVERNANCE_URL_INVALID', '设备治理请求地址无效', 400); }
}
function assertNoQuery(request) {
  if ([...parseUrl(request).searchParams.keys()].length) {
    throw new ProductionDeviceGovernanceError('PRODUCTION_DEVICE_GOVERNANCE_QUERY_INVALID', '设备列表不接受查询参数', 400);
  }
}
function readDetailRef(request) {
  const params = parseUrl(request).searchParams;
  const keys = [...params.keys()];
  const values = params.getAll('id');
  if (keys.length !== 1 || keys[0] !== 'id' || values.length !== 1 || !values[0]) {
    throw new ProductionDeviceGovernanceError('PRODUCTION_DEVICE_GOVERNANCE_QUERY_INVALID', '设备详情查询参数无效', 400);
  }
  return values[0];
}
async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_CONTENT_TYPE_INVALID', '设备治理写入只接受JSON', 415);
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > DEVICE_GOVERNANCE_MAX_BODY_BYTES) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_BODY_SIZE_INVALID', '设备治理请求大小无效', 413);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 2 || bytes > DEVICE_GOVERNANCE_MAX_BODY_BYTES) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_BODY_SIZE_INVALID', '设备治理请求大小无效', 413);
  }
  try { return JSON.parse(text); }
  catch (_) { throw new DeviceGovernanceError('DEVICE_GOVERNANCE_JSON_INVALID', '设备治理JSON无效', 400); }
}

function authenticate(context, dependencies) {
  const env = context?.env || {};
  const authConfig = readProductionAdminAuthConfig(env);
  const config = readProductionDeviceGovernanceConfig(env);
  if (authConfig.publicOrigin !== config.publicOrigin) {
    throw new ProductionDeviceGovernanceError(
      'PRODUCTION_DEVICE_GOVERNANCE_ORIGIN_MISMATCH',
      '正式管理员身份与设备治理来源不一致',
      503,
    );
  }
  assertAdminSameOriginRequest(context.request, {
    requireOrigin: method(context.request) === 'POST',
    publicOrigin: config.publicOrigin,
  });
  const token = readAdminSessionCookie(context.request);
  const identity = verifyProductionAdminSessionToken(token, authConfig, {
    now: dependencies.now?.() ?? Date.now(),
  });
  return { config, identity };
}

function storeFor(config, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneNamedBlobStore;
  return createStore(config.storeName);
}

export async function handleProductionAdminDeviceListRequest(context, dependencies = {}) {
  const requestMethod = method(context?.request);
  if (requestMethod !== 'GET') return methodNotAllowed(requestMethod, 'GET');
  try {
    const state = authenticate(context, dependencies);
    assertNoQuery(context.request);
    const list = dependencies.listDevices || listAdminDevices;
    const result = await list({ store: storeFor(state.config, dependencies), config: state.config });
    return success(state.identity, state.config, result);
  } catch (error) { return failure(error); }
}

export async function handleProductionAdminDeviceDetailRequest(context, dependencies = {}) {
  const requestMethod = method(context?.request);
  if (requestMethod !== 'GET') return methodNotAllowed(requestMethod, 'GET');
  try {
    const state = authenticate(context, dependencies);
    const deviceRef = readDetailRef(context.request);
    const get = dependencies.getDeviceDetail || getAdminDeviceDetail;
    const result = await get({
      store: storeFor(state.config, dependencies),
      config: state.config,
      deviceRef,
    });
    return success(state.identity, state.config, result);
  } catch (error) { return failure(error); }
}

async function handleMutation(action, context, dependencies = {}) {
  const requestMethod = method(context?.request);
  if (requestMethod !== 'POST') return methodNotAllowed(requestMethod, 'POST');
  try {
    const state = authenticate(context, dependencies);
    assertNoQuery(context.request);
    const input = await readJsonBody(context.request);
    const mutate = dependencies.mutateDevice || mutateDeviceGovernance;
    const result = await mutate({
      store: storeFor(state.config, dependencies),
      config: state.config,
      identity: state.identity,
      command: { action, input },
      now: dependencies.now?.() ?? Date.now(),
    });
    return success(state.identity, state.config, result);
  } catch (error) { return failure(error); }
}

export const handleProductionAdminDeviceTrustRequest = (c, d = {}) => handleMutation('trust', c, d);
export const handleProductionAdminDeviceRevokeTrustRequest = (c, d = {}) => handleMutation('revoke_trust', c, d);
export const handleProductionAdminDeviceBlockRequest = (c, d = {}) => handleMutation('block', c, d);
export const handleProductionAdminDeviceUnblockRequest = (c, d = {}) => handleMutation('unblock', c, d);

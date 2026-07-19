import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  assertAdminSameOriginRequest,
  clearAdminSessionCookie,
  readAdminAuthConfig,
  readAdminSessionCookie,
  verifyAdminSessionToken,
} from './admin_auth_v1.js';
import {
  ADMIN_DEVICE_GOVERNANCE_CAPABILITIES,
  DEVICE_GOVERNANCE_MAX_BODY_BYTES,
  DeviceGovernanceError,
  getAdminDeviceDetail,
  isAdminDeviceGovernanceProjectionSafe,
  listAdminDevices,
  mutateDeviceGovernance,
  readDeviceGovernanceConfig,
} from './device_governance_v1.js';

const SERVICE_ID = 'cloud-collab-admin-device-governance-preview';
const API_VERSION = '2026-07-20-stage5d';

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

function viewer(identity) {
  return Object.freeze({
    authenticated: true,
    username: identity.username,
    sessionIdSuffix: identity.sessionIdSuffix,
    expiresAt: identity.expiresAt,
  });
}

function success(identity, result) {
  const data = {
    viewer: viewer(identity),
    result,
    capabilities: ADMIN_DEVICE_GOVERNANCE_CAPABILITIES,
  };
  if (!isAdminDeviceGovernanceProjectionSafe(data)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_UNSAFE_RESPONSE', '设备治理响应包含禁止字段', 500);
  }
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data });
}

function failure(error, { clearSession = false } = {}) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : 'DEVICE_GOVERNANCE_INTERNAL_ERROR';
  const message = status >= 500
    ? '管理员设备治理暂时不可用'
    : (error?.message || '管理员设备治理请求失败');
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
    error: { code: 'METHOD_NOT_ALLOWED', message: `管理员设备治理接口不支持 ${method || 'UNKNOWN'} 方法` },
  }, { status: 405, headers: { Allow: allow } });
}

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function parseRequestUrl(request) {
  try {
    return new URL(request?.url || '');
  } catch (_) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_REQUEST_INVALID', '管理员设备治理请求地址无效', 400);
  }
}

function assertNoQuery(request) {
  if ([...parseRequestUrl(request).searchParams.keys()].length !== 0) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_QUERY_INVALID', '设备列表不接受查询参数', 400);
  }
}

function readDetailRef(request) {
  const params = parseRequestUrl(request).searchParams;
  const keys = [...params.keys()];
  const values = params.getAll('id');
  if (keys.length !== 1 || keys[0] !== 'id' || values.length !== 1) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_QUERY_INVALID', '设备详情查询参数无效', 400);
  }
  return values[0];
}

async function readJsonBody(request) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_CONTENT_TYPE_INVALID', '设备治理写入只接受JSON', 415);
  }
  const text = await request.text();
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 2 || bytes > DEVICE_GOVERNANCE_MAX_BODY_BYTES) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_BODY_SIZE_INVALID', '设备治理请求大小无效', 413);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new DeviceGovernanceError('DEVICE_GOVERNANCE_JSON_INVALID', '设备治理JSON无效', 400);
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
  const governanceConfig = readDeviceGovernanceConfig(env);
  return { env, identity, governanceConfig };
}

function createGovernanceStore(env, governanceConfig, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneBlobStore;
  return createStore({ ...env, CLOUD_BLOB_STORE_NAME: governanceConfig.storeName });
}

export async function handleAdminDeviceListRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { env, identity, governanceConfig } = authenticateAndConfigure(context, dependencies);
    assertNoQuery(context.request);
    const store = createGovernanceStore(env, governanceConfig, dependencies);
    const list = dependencies.listDevices || listAdminDevices;
    const result = await list({ store, config: governanceConfig });
    return success(identity, result);
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

export async function handleAdminDeviceDetailRequest(context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { env, identity, governanceConfig } = authenticateAndConfigure(context, dependencies);
    const deviceRef = readDetailRef(context.request);
    const store = createGovernanceStore(env, governanceConfig, dependencies);
    const getDetail = dependencies.getDeviceDetail || getAdminDeviceDetail;
    const result = await getDetail({ store, config: governanceConfig, deviceRef });
    return success(identity, result);
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

async function handleMutation(action, context, dependencies = {}) {
  const method = requestMethod(context?.request);
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const { env, identity, governanceConfig } = authenticateAndConfigure(
      context,
      dependencies,
      { requireOrigin: true },
    );
    assertNoQuery(context.request);
    const input = await readJsonBody(context.request);
    const store = createGovernanceStore(env, governanceConfig, dependencies);
    const mutate = dependencies.mutateDevice || mutateDeviceGovernance;
    const result = await mutate({
      store,
      config: governanceConfig,
      identity,
      command: { action, input },
      now: dependencies.now?.() ?? Date.now(),
    });
    return success(identity, result);
  } catch (error) {
    return failure(error, { clearSession: error?.status === 401 });
  }
}

export function handleAdminDeviceTrustRequest(context, dependencies = {}) {
  return handleMutation('trust', context, dependencies);
}

export function handleAdminDeviceRevokeTrustRequest(context, dependencies = {}) {
  return handleMutation('revoke_trust', context, dependencies);
}

export function handleAdminDeviceBlockRequest(context, dependencies = {}) {
  return handleMutation('block', context, dependencies);
}

export function handleAdminDeviceUnblockRequest(context, dependencies = {}) {
  return handleMutation('unblock', context, dependencies);
}

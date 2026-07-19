import { createEdgeOneBlobStore } from './edgeone_blob_runtime_v1.js';
import {
  STAGE5DEF_ACCEPTANCE_SCHEMA_VERSION,
  STAGE5DEF_SEED_CONFIRMATION,
  Stage5defAcceptanceError,
  assertStage5defAcceptanceAccess,
  checkStage5defDeviceAuthentication,
  inspectStage5defAcceptance,
  isStage5defAcceptanceProjectionSafe,
  readStage5defAcceptanceConfig,
  seedStage5defAcceptance,
} from './stage5def_acceptance_v1.js';

const SERVICE_ID = 'cloud-collab-stage5def-acceptance';
const API_VERSION = '2026-07-20-stage5def-acceptance-v1';
const MAX_BODY_BYTES = 512;

function headers(extra = {}) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
    ...extra,
  };
}

function json(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: headers({ 'Content-Type': 'application/json; charset=UTF-8', ...extra }),
  });
}

function success(action, result) {
  const data = Object.freeze({
    result,
    capabilities: Object.freeze({
      syntheticSeed: true,
      statusRead: true,
      blockedAuthenticationCheck: true,
      publicMutationAllowed: true,
      formalDataAllowed: false,
      cleanupAllowed: false,
    }),
  });
  if (!isStage5defAcceptanceProjectionSafe(data)) {
    throw new Stage5defAcceptanceError(
      'STAGE5DEF_ACCEPTANCE_UNSAFE_RESPONSE',
      '联合验收响应包含禁止字段',
      500,
    );
  }
  return json({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    action,
    data,
  });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  return json({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: {
      code: typeof error?.code === 'string' && error.code
        ? error.code
        : 'STAGE5DEF_ACCEPTANCE_INTERNAL_ERROR',
      message: status >= 500
        ? '阶段5D/5E/5F联合验收暂时不可用'
        : String(error?.message || '联合验收请求失败'),
    },
  }, status);
}

function methodNotAllowed(method, allow) {
  return json({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: `联合验收接口不支持 ${method || 'UNKNOWN'} 方法`,
    },
  }, 405, { Allow: allow });
}

function assertNoQuery(request) {
  let url;
  try {
    url = new URL(request?.url || '');
  } catch (_) {
    throw new Stage5defAcceptanceError('STAGE5DEF_REQUEST_INVALID', '联合验收请求地址无效', 400);
  }
  if ([...url.searchParams.keys()].length) {
    throw new Stage5defAcceptanceError('STAGE5DEF_QUERY_INVALID', '联合验收接口不接受查询参数', 400);
  }
}

async function readJsonBody(request) {
  const type = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(type)) {
    throw new Stage5defAcceptanceError('STAGE5DEF_CONTENT_TYPE_INVALID', '联合验收写入只接受JSON', 415);
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Stage5defAcceptanceError('STAGE5DEF_BODY_SIZE_INVALID', '联合验收请求体过大', 413);
  }
  const text = await request.text();
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new Stage5defAcceptanceError(
      text ? 'STAGE5DEF_BODY_SIZE_INVALID' : 'STAGE5DEF_BODY_EMPTY',
      text ? '联合验收请求体过大' : '联合验收请求体不能为空',
      text ? 413 : 400,
    );
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Stage5defAcceptanceError('STAGE5DEF_JSON_INVALID', '联合验收JSON无效', 400);
  }
}

function createPublicStore(env, config, dependencies) {
  const createStore = dependencies.createStore || createEdgeOneBlobStore;
  return createStore({ ...env, CLOUD_BLOB_STORE_NAME: config.publicStoreName });
}

function configure(context, dependencies, { requireOrigin }) {
  const env = context?.env || {};
  const config = readStage5defAcceptanceConfig(env);
  assertStage5defAcceptanceAccess(context.request, config, { requireOrigin });
  assertNoQuery(context.request);
  return {
    env,
    config,
    store: createPublicStore(env, config, dependencies),
  };
}

export async function handleStage5defSeedRequest(context, dependencies = {}) {
  const method = String(context?.request?.method || 'GET').toUpperCase();
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const { config, store } = configure(context, dependencies, { requireOrigin: true });
    const body = await readJsonBody(context.request);
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== 'confirmation,schemaVersion'
        || body.schemaVersion !== STAGE5DEF_ACCEPTANCE_SCHEMA_VERSION
        || body.confirmation !== STAGE5DEF_SEED_CONFIRMATION) {
      throw new Stage5defAcceptanceError('STAGE5DEF_SEED_REQUEST_INVALID', '联合验收种子确认字段无效', 400);
    }
    const seed = dependencies.seed || seedStage5defAcceptance;
    return success('seed', await seed({ store, config }));
  } catch (error) {
    return failure(error);
  }
}

export async function handleStage5defStatusRequest(context, dependencies = {}) {
  const method = String(context?.request?.method || 'GET').toUpperCase();
  if (method !== 'GET') return methodNotAllowed(method, 'GET');
  try {
    const { config, store } = configure(context, dependencies, { requireOrigin: false });
    const inspect = dependencies.inspect || inspectStage5defAcceptance;
    return success('status', await inspect({
      store,
      config,
      now: dependencies.now?.() ?? Date.now(),
    }));
  } catch (error) {
    return failure(error);
  }
}

export async function handleStage5defDeviceAuthRequest(context, dependencies = {}) {
  const method = String(context?.request?.method || 'GET').toUpperCase();
  if (method !== 'POST') return methodNotAllowed(method, 'POST');
  try {
    const { config, store } = configure(context, dependencies, { requireOrigin: true });
    const body = await readJsonBody(context.request);
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== 'schemaVersion,slot'
        || body.schemaVersion !== STAGE5DEF_ACCEPTANCE_SCHEMA_VERSION
        || !['A', 'B'].includes(String(body.slot || '').toUpperCase())) {
      throw new Stage5defAcceptanceError('STAGE5DEF_DEVICE_AUTH_REQUEST_INVALID', '联合验收设备认证请求无效', 400);
    }
    const check = dependencies.checkDeviceAuthentication || checkStage5defDeviceAuthentication;
    return success('device-auth', await check({
      store,
      config,
      slot: String(body.slot).toUpperCase(),
      now: dependencies.now?.() ?? Date.now(),
    }));
  } catch (error) {
    return failure(error);
  }
}

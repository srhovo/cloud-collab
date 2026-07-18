import {
  DEVICE_REGISTRATION_LIMITS,
  DeviceRegistrationError,
  assertRegisterRequestBytes,
  registerDevice,
} from '../_shared/device-registration.js';

const SERVICE_ID = 'cloud-collab-device-registration';
const API_VERSION = '2026-07-18';

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
    }),
  });
}

function success(data, status = 200) {
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data }, status);
}

function failure(code, message, status, details = null) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: { code, message, ...(details === null ? {} : { details }) },
  }, status);
}

function enabledFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function resolveRuntime(context) {
  const env = context?.env || {};
  return {
    enabled: enabledFlag(env.CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED
      ?? globalThis.CLOUD_COLLAB_DEVICE_REGISTRATION_ENABLED),
    kv: env.CLOUD_COLLAB_KV
      ?? env.cloud_collab_kv
      ?? globalThis.CLOUD_COLLAB_KV
      ?? globalThis.cloud_collab_kv
      ?? null,
    secret: env.CLOUD_COLLAB_DEVICE_TOKEN_SECRET
      ?? globalThis.CLOUD_COLLAB_DEVICE_TOKEN_SECRET
      ?? '',
  };
}

function errorStatus(error) {
  switch (error?.code) {
    case 'REGISTER_REQUEST_TOO_LARGE': return 413;
    case 'UNSUPPORTED_MEDIA_TYPE': return 415;
    case 'DEVICE_ALREADY_REGISTERED': return 409;
    case 'DEVICE_BANNED': return 403;
    case 'DEVICE_REGISTRATION_DISABLED':
    case 'DEVICE_REGISTRY_NOT_CONFIGURED':
    case 'DEVICE_REGISTRY_READ_FAILED':
    case 'DEVICE_REGISTRY_WRITE_FAILED':
    case 'DEVICE_TOKEN_SECRET_TOO_SHORT':
    case 'WEB_CRYPTO_UNAVAILABLE':
    case 'TEXT_ENCODER_UNAVAILABLE':
    case 'TEXT_DECODER_UNAVAILABLE':
    case 'BASE64_UNAVAILABLE':
    case 'INVALID_TOKEN_TTL':
      return 503;
    default:
      return error instanceof DeviceRegistrationError ? 400 : 500;
  }
}

export default async function onRequest(context) {
  const request = context?.request;
  const method = String(request?.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (method !== 'POST') return failure('METHOD_NOT_ALLOWED', `设备注册接口不支持 ${method} 方法`, 405);

  const runtime = resolveRuntime(context);
  if (!runtime.enabled) return failure('DEVICE_REGISTRATION_DISABLED', '设备注册功能尚未启用', 503);
  if (!runtime.kv || typeof runtime.kv.get !== 'function' || typeof runtime.kv.put !== 'function') {
    return failure('DEVICE_REGISTRY_NOT_CONFIGURED', '设备注册存储尚未配置', 503);
  }

  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return failure('UNSUPPORTED_MEDIA_TYPE', '设备注册只接受 application/json', 415);
  }

  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > DEVICE_REGISTRATION_LIMITS.maxRegisterBodyBytes) {
      throw new DeviceRegistrationError('REGISTER_REQUEST_TOO_LARGE', '设备注册请求体过大', {
        bytes: contentLength,
        maxBytes: DEVICE_REGISTRATION_LIMITS.maxRegisterBodyBytes,
      });
    }
    const rawBody = await request.text();
    assertRegisterRequestBytes(rawBody);
    let body;
    try { body = JSON.parse(rawBody); }
    catch (_) { throw new DeviceRegistrationError('INVALID_JSON', '设备注册请求不是有效JSON'); }

    const result = await registerDevice({
      request: body,
      kv: runtime.kv,
      secret: runtime.secret,
    });
    return success({
      status: 'registered',
      device: result.device,
      credential: result.credential,
      publicMutationAllowed: false,
      submissionEnabled: false,
      autoApprovalEnabled: false,
    }, 201);
  } catch (error) {
    const status = errorStatus(error);
    const code = error instanceof DeviceRegistrationError ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof DeviceRegistrationError ? error.message : '设备注册服务暂时不可用';
    return failure(code, message, status, error instanceof DeviceRegistrationError ? error.details : null);
  }
}

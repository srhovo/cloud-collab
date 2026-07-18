const SERVICE_ID = 'cloud-collab-write-foundation';
const API_VERSION = '2026-07-18';

export class WriteFoundationError extends Error {
  constructor(code, message, { status = 400, details = null, retryable = false } = {}) {
    super(message || code || '写入基础链路错误');
    this.name = 'WriteFoundationError';
    this.code = code || 'WRITE_FOUNDATION_ERROR';
    this.status = status;
    this.details = details;
    this.retryable = Boolean(retryable);
  }
}

export function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

export function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store',
    }),
  });
}

export function success(data, { status = 200 } = {}) {
  return jsonResponse({ ok: true, serviceId: SERVICE_ID, apiVersion: API_VERSION, data }, { status });
}

export function failure(error) {
  const status = Number(error?.status);
  const normalized = error instanceof WriteFoundationError
    ? error
    : (error && typeof error.code === 'string' && Number.isInteger(status)
      ? new WriteFoundationError(error.code, error.message || error.code, {
        status,
        details: error.details ?? null,
        retryable: Boolean(error.retryable) || status === 408 || status === 429 || status >= 500,
      })
      : new WriteFoundationError('INTERNAL_ERROR', '写入基础链路暂时不可用', { status: 500, retryable: true }));
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.details === null ? {} : { details: normalized.details }),
    },
  }, { status: normalized.status });
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function parseEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

export function requireEnabled(env, name, code = 'WRITE_FOUNDATION_DISABLED') {
  if (!parseEnabled(env?.[name])) {
    throw new WriteFoundationError(code, '该写入能力尚未启用', { status: 503, retryable: true });
  }
}

export async function readJsonBody(request, { maxBytes = 16 * 1024 } = {}) {
  const contentType = String(request?.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new WriteFoundationError('UNSUPPORTED_CONTENT_TYPE', '请求必须使用application/json', { status: 415 });
  }
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WriteFoundationError('REQUEST_TOO_LARGE', `请求体不得超过${maxBytes}字节`, { status: 413 });
  }
  const text = await request.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBytes) {
    throw new WriteFoundationError('REQUEST_TOO_LARGE', `请求体不得超过${maxBytes}字节`, { status: 413 });
  }
  try {
    return { value: JSON.parse(text), rawText: text, bytes };
  } catch (_) {
    throw new WriteFoundationError('INVALID_JSON', '请求体不是有效JSON', { status: 400 });
  }
}

export function requirePost(request) {
  const method = String(request?.method || '').toUpperCase();
  if (method !== 'POST') {
    throw new WriteFoundationError('METHOD_NOT_ALLOWED', `接口不支持${method || 'UNKNOWN'}方法`, { status: 405 });
  }
}

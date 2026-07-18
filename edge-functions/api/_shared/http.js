const SERVICE_ID = 'cloud-collab-readonly';
const API_VERSION = '2026-07-18';
const MAX_AGE_SECONDS = 300;

export function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

export function jsonResponse(payload, { status = 200, cacheSeconds = 0, head = false } = {}) {
  const cacheControl = cacheSeconds > 0
    ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=30`
    : 'no-store';
  return new Response(head ? null : JSON.stringify(payload), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': cacheControl,
    }),
  });
}

export function success(data, options = {}) {
  return jsonResponse({
    ok: true,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    data,
  }, options);
}

export function failure(code, message, { status = 400, details = null, head = false } = {}) {
  return jsonResponse({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: {
      code,
      message,
      ...(details === null ? {} : { details }),
    },
  }, { status, head });
}

export function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function methodNotAllowed(method) {
  return failure('METHOD_NOT_ALLOWED', `只读接口不支持 ${method || 'UNKNOWN'} 方法`, { status: 405 });
}

export function parseReadonlyMethod(request) {
  const method = String(request?.method || 'GET').toUpperCase();
  return {
    method,
    isGet: method === 'GET',
    isHead: method === 'HEAD',
    isOptions: method === 'OPTIONS',
  };
}

export function cacheSeconds() {
  return MAX_AGE_SECONDS;
}

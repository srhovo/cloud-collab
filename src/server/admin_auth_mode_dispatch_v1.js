import {
  handleAdminLoginRequest,
  handleAdminLogoutRequest,
  handleAdminSessionRequest,
} from './admin_auth_http_v1.js';
import {
  handleProductionAdminLoginRequest,
  handleProductionAdminLogoutRequest,
  handleProductionAdminSessionRequest,
} from './production_admin_auth_http_v1.js';

export class AdminAuthModeDispatchError extends Error {
  constructor(code, message, status = 503) {
    super(message || code || '管理员运行模式无效');
    this.name = 'AdminAuthModeDispatchError';
    this.code = code || 'ADMIN_AUTH_MODE_INVALID';
    this.status = status;
  }
}

export function resolveAdminAuthMode(env = {}) {
  const raw = String(env.CLOUD_ADMIN_PRODUCTION_ENABLED ?? '0').trim();
  if (raw === '1') return 'production';
  if (raw === '0' || raw === '') return 'preview';
  throw new AdminAuthModeDispatchError(
    'ADMIN_AUTH_MODE_INVALID',
    'CLOUD_ADMIN_PRODUCTION_ENABLED必须明确为0或1',
    503,
  );
}

function dispatch(context, dependencies, handlers) {
  try {
    return resolveAdminAuthMode(context?.env || {}) === 'production'
      ? handlers.production(context, dependencies)
      : handlers.preview(context, dependencies);
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      serviceId: 'cloud-collab-admin-auth-dispatch',
      apiVersion: '2026-07-21-stage7s',
      error: {
        code: error?.code || 'ADMIN_AUTH_MODE_INVALID',
        message: '管理员运行模式配置无效',
      },
    }), {
      status: Number.isInteger(error?.status) ? error.status : 503,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=UTF-8',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}

export function handleAdminLoginByMode(context, dependencies = {}) {
  return dispatch(context, dependencies, {
    production: handleProductionAdminLoginRequest,
    preview: handleAdminLoginRequest,
  });
}

export function handleAdminSessionByMode(context, dependencies = {}) {
  return dispatch(context, dependencies, {
    production: handleProductionAdminSessionRequest,
    preview: handleAdminSessionRequest,
  });
}

export function handleAdminLogoutByMode(context, dependencies = {}) {
  return dispatch(context, dependencies, {
    production: handleProductionAdminLogoutRequest,
    preview: handleAdminLogoutRequest,
  });
}

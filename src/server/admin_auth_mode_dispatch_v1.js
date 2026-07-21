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

const SERVICE_ID = 'cloud-collab-admin-auth-dispatch';
const API_VERSION = '2026-07-21-stage7t';

function invalidFlagResponse() {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: SERVICE_ID,
    apiVersion: API_VERSION,
    error: {
      code: 'PRODUCTION_FLAG_INVALID',
      message: 'CLOUD_PRODUCTION_ENABLED必须明确为0或1',
    },
  }), {
    status: 503,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=UTF-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function productionMode(env = {}) {
  const raw = String(env.CLOUD_PRODUCTION_ENABLED ?? '0').trim();
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function select(context, productionHandler, previewHandler, dependencies) {
  const mode = productionMode(context?.env || {});
  if (mode === null) return invalidFlagResponse();
  if (mode) return productionHandler(context, dependencies.production || {});
  return previewHandler(context, dependencies.preview || {});
}

export function dispatchAdminLoginRequest(context, dependencies = {}) {
  return select(
    context,
    handleProductionAdminLoginRequest,
    handleAdminLoginRequest,
    dependencies,
  );
}

export function dispatchAdminSessionRequest(context, dependencies = {}) {
  return select(
    context,
    handleProductionAdminSessionRequest,
    handleAdminSessionRequest,
    dependencies,
  );
}

export function dispatchAdminLogoutRequest(context, dependencies = {}) {
  return select(
    context,
    handleProductionAdminLogoutRequest,
    handleAdminLogoutRequest,
    dependencies,
  );
}

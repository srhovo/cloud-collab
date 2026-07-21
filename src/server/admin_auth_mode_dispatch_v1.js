import {
  handleAdminLoginRequest as handlePreviewAdminLoginRequest,
  handleAdminLogoutRequest as handlePreviewAdminLogoutRequest,
  handleAdminSessionRequest as handlePreviewAdminSessionRequest,
} from './admin_auth_http_v1.js';
import {
  handleProductionAdminLoginRequest,
  handleProductionAdminLogoutRequest,
  handleProductionAdminSessionRequest,
} from './production_admin_auth_http_v1.js';

function productionFlag(env = {}) {
  const raw = String(env.CLOUD_PRODUCTION_ENABLED ?? '').trim();
  if (raw === '1') return true;
  if (raw === '' || raw === '0') return false;
  return null;
}
function invalidFlagResponse() {
  return new Response(JSON.stringify({ ok: false, serviceId: 'cloud-collab-admin-auth-dispatch', apiVersion: '2026-07-21-stage7t', error: { code: 'PRODUCTION_FLAG_INVALID', message: '管理员服务配置无效' } }), {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=UTF-8', 'X-Content-Type-Options': 'nosniff' },
  });
}
function dispatch(context, dependencies, productionHandler, previewHandler) {
  const production = productionFlag(context?.env || {});
  if (production === null) return invalidFlagResponse();
  return production ? productionHandler(context, dependencies.production || dependencies) : previewHandler(context, dependencies.preview || dependencies);
}
export function dispatchAdminLoginRequest(context, dependencies = {}) { return dispatch(context, dependencies, handleProductionAdminLoginRequest, handlePreviewAdminLoginRequest); }
export function dispatchAdminSessionRequest(context, dependencies = {}) { return dispatch(context, dependencies, handleProductionAdminSessionRequest, handlePreviewAdminSessionRequest); }
export function dispatchAdminLogoutRequest(context, dependencies = {}) { return dispatch(context, dependencies, handleProductionAdminLogoutRequest, handlePreviewAdminLogoutRequest); }

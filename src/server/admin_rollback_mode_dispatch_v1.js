import { resolveAdminAuthMode } from './admin_auth_mode_dispatch_v1.js';
import {
  handleAdminRollbackExecuteRequest,
  handleAdminRollbackListRequest,
} from './admin_rollback_http_v1.js';
import {
  handleProductionAdminRollbackExecuteRequest,
  handleProductionAdminRollbackListRequest,
} from './production_admin_rollback_http_v1.js';

function invalid(error) {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'cloud-collab-admin-rollback-dispatch',
    apiVersion: '2026-07-21-stage7x',
    error: {
      code: error?.code || 'ADMIN_ROLLBACK_MODE_INVALID',
      message: '管理员回滚运行模式配置无效',
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

function dispatch(context, dependencies, preview, production) {
  try {
    return resolveAdminAuthMode(context?.env || {}) === 'production'
      ? production(context, dependencies)
      : preview(context, dependencies);
  } catch (error) {
    return invalid(error);
  }
}

export const handleAdminRollbackListByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminRollbackListRequest,
  handleProductionAdminRollbackListRequest,
);

export const handleAdminRollbackExecuteByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminRollbackExecuteRequest,
  handleProductionAdminRollbackExecuteRequest,
);

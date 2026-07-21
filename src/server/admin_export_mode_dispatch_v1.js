import { resolveAdminAuthMode } from './admin_auth_mode_dispatch_v1.js';
import {
  handleAdminExportDownloadRequest,
  handleAdminExportSummaryRequest,
} from './admin_export_http_v1.js';
import {
  handleProductionAdminExportDownloadRequest,
  handleProductionAdminExportSummaryRequest,
} from './production_admin_export_http_v1.js';

function invalidModeResponse(error) {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'cloud-collab-admin-export-dispatch',
    apiVersion: '2026-07-21-stage8a',
    error: {
      code: error?.code || 'ADMIN_EXPORT_MODE_INVALID',
      message: '管理员迁移导出运行模式配置无效',
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

function dispatch(context, dependencies, productionHandler, previewHandler) {
  try {
    return resolveAdminAuthMode(context?.env || {}) === 'production'
      ? productionHandler(context, dependencies.production || dependencies)
      : previewHandler(context, dependencies.preview || dependencies);
  } catch (error) {
    return invalidModeResponse(error);
  }
}

export function handleAdminExportSummaryByMode(context, dependencies = {}) {
  return dispatch(
    context,
    dependencies,
    handleProductionAdminExportSummaryRequest,
    handleAdminExportSummaryRequest,
  );
}

export function handleAdminExportDownloadByMode(context, dependencies = {}) {
  return dispatch(
    context,
    dependencies,
    handleProductionAdminExportDownloadRequest,
    handleAdminExportDownloadRequest,
  );
}

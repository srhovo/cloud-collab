import { resolveAdminAuthMode } from './admin_auth_mode_dispatch_v1.js';
import {
  handleAdminExportDownloadRequest,
  handleAdminExportSummaryRequest,
} from './admin_export_http_v1.js';
import {
  handleProductionAdminExportDownloadRequest,
  handleProductionAdminExportSummaryRequest,
} from './production_admin_export_http_v1.js';

function invalid(error) {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'cloud-collab-admin-export-dispatch',
    apiVersion: '2026-07-21-stage8a',
    error: {
      code: error?.code || 'ADMIN_EXPORT_MODE_INVALID',
      message: '管理员导出运行模式配置无效',
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

export const handleAdminExportSummaryByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminExportSummaryRequest,
  handleProductionAdminExportSummaryRequest,
);

export const handleAdminExportDownloadByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminExportDownloadRequest,
  handleProductionAdminExportDownloadRequest,
);

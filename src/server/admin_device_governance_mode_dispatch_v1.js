import { resolveAdminAuthMode } from './admin_auth_mode_dispatch_v1.js';
import {
  handleAdminDeviceBlockRequest,
  handleAdminDeviceDetailRequest,
  handleAdminDeviceListRequest,
  handleAdminDeviceRevokeTrustRequest,
  handleAdminDeviceTrustRequest,
  handleAdminDeviceUnblockRequest,
} from './device_governance_http_v1.js';
import {
  handleProductionAdminDeviceBlockRequest,
  handleProductionAdminDeviceDetailRequest,
  handleProductionAdminDeviceListRequest,
  handleProductionAdminDeviceRevokeTrustRequest,
  handleProductionAdminDeviceTrustRequest,
  handleProductionAdminDeviceUnblockRequest,
} from './production_device_governance_http_v1.js';

function invalid(error) {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'cloud-collab-admin-device-governance-dispatch',
    apiVersion: '2026-07-21-stage7w',
    error: {
      code: error?.code || 'DEVICE_GOVERNANCE_MODE_INVALID',
      message: '管理员设备治理运行模式配置无效',
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

export const handleAdminDeviceListByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminDeviceListRequest,
  handleProductionAdminDeviceListRequest,
);

export const handleAdminDeviceDetailByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminDeviceDetailRequest,
  handleProductionAdminDeviceDetailRequest,
);

export const handleAdminDeviceTrustByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminDeviceTrustRequest,
  handleProductionAdminDeviceTrustRequest,
);

export const handleAdminDeviceRevokeTrustByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminDeviceRevokeTrustRequest,
  handleProductionAdminDeviceRevokeTrustRequest,
);

export const handleAdminDeviceBlockByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminDeviceBlockRequest,
  handleProductionAdminDeviceBlockRequest,
);

export const handleAdminDeviceUnblockByMode = (context, dependencies = {}) => dispatch(
  context,
  dependencies,
  handleAdminDeviceUnblockRequest,
  handleProductionAdminDeviceUnblockRequest,
);

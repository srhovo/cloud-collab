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

function invalidModeResponse(error) {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'cloud-collab-admin-device-governance-dispatch',
    apiVersion: '2026-07-21-stage7w',
    error: {
      code: error?.code || 'ADMIN_DEVICE_GOVERNANCE_MODE_INVALID',
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

function dispatch(context, dependencies, productionHandler, previewHandler) {
  try {
    return resolveAdminAuthMode(context?.env || {}) === 'production'
      ? productionHandler(context, dependencies.production || dependencies)
      : previewHandler(context, dependencies.preview || dependencies);
  } catch (error) {
    return invalidModeResponse(error);
  }
}

export function handleAdminDeviceListByMode(context, dependencies = {}) {
  return dispatch(context, dependencies, handleProductionAdminDeviceListRequest, handleAdminDeviceListRequest);
}

export function handleAdminDeviceDetailByMode(context, dependencies = {}) {
  return dispatch(context, dependencies, handleProductionAdminDeviceDetailRequest, handleAdminDeviceDetailRequest);
}

export function handleAdminDeviceTrustByMode(context, dependencies = {}) {
  return dispatch(context, dependencies, handleProductionAdminDeviceTrustRequest, handleAdminDeviceTrustRequest);
}

export function handleAdminDeviceRevokeTrustByMode(context, dependencies = {}) {
  return dispatch(context, dependencies, handleProductionAdminDeviceRevokeTrustRequest, handleAdminDeviceRevokeTrustRequest);
}

export function handleAdminDeviceBlockByMode(context, dependencies = {}) {
  return dispatch(context, dependencies, handleProductionAdminDeviceBlockRequest, handleAdminDeviceBlockRequest);
}

export function handleAdminDeviceUnblockByMode(context, dependencies = {}) {
  return dispatch(context, dependencies, handleProductionAdminDeviceUnblockRequest, handleAdminDeviceUnblockRequest);
}

import {
  handleDeviceRegisterRequest as handlePreviewDeviceRegisterRequest,
  handleSubmissionCreateRequest as handlePreviewSubmissionCreateRequest,
} from './preview_write_http_v1.js';
import {
  handleProductionDeviceRegisterRequest,
  handleProductionSubmissionCreateRequest,
} from './production_write_http_v1.js';

function productionFlag(env = {}) {
  const raw = String(env.CLOUD_PRODUCTION_ENABLED ?? '').trim();
  if (raw === '1') return true;
  if (raw === '' || raw === '0') return false;
  return null;
}

function invalidFlagResponse() {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'cloud-collab-write-dispatch',
    apiVersion: '2026-07-21-stage7p',
    error: { code: 'PRODUCTION_FLAG_INVALID', message: '写入服务配置无效' },
  }), {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function dispatchDeviceRegisterRequest(context, dependencies = {}) {
  const production = productionFlag(context?.env || {});
  if (production === null) return invalidFlagResponse();
  return production
    ? handleProductionDeviceRegisterRequest(context, dependencies.production || dependencies)
    : handlePreviewDeviceRegisterRequest(context, dependencies.preview || dependencies);
}

export async function dispatchSubmissionCreateRequest(context, dependencies = {}) {
  const production = productionFlag(context?.env || {});
  if (production === null) return invalidFlagResponse();
  return production
    ? handleProductionSubmissionCreateRequest(context, dependencies.production || dependencies)
    : handlePreviewSubmissionCreateRequest(context, dependencies.preview || dependencies);
}

import { handleDeviceRegisterRequest } from './preview_write_http_v1.js';
import { handlePreviewAutoApprovalSubmissionRequest } from './preview_auto_approval_http_v1.js';
import { handleSensitiveSubmissionRequest } from './sensitive_submission_http_v1.js';
import {
  handleSensitivePublicChangesRequest,
  handleSensitivePublicSnapshotRequest,
  handleSensitivePublicVersionRequest,
} from './sensitive_public_http_v1.js';
import {
  assertStage5g6a6bAcceptanceAccess,
  readStage5g6a6bAcceptanceConfig,
} from './stage5g6a6b_acceptance_v1.js';

function requestMethod(request) {
  return String(request?.method || 'GET').toUpperCase();
}

function authorize(context) {
  const env = context?.env || {};
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '0').trim() !== '0'
      || String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '0').trim() !== '0') {
    const error = new Error('一次性验收代理要求正式公共写入与自动批准门禁保持关闭');
    error.code = 'STAGE5G6A6B_FORMAL_PUBLIC_MUTATION_MUST_BE_CLOSED';
    error.status = 503;
    throw error;
  }
  const config = readStage5g6a6bAcceptanceConfig({ ...env, CLOUD_WRITE_PREVIEW_ENABLED: '1' });
  const method = requestMethod(context?.request);
  assertStage5g6a6bAcceptanceAccess(context?.request, config, {
    requireOrigin: !['GET', 'HEAD'].includes(method),
  });
  return { env, config };
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'STAGE5G6A6B_PROXY_INTERNAL_ERROR';
  const message = status >= 500 ? '联合验收代理暂时不可用' : (error?.message || '联合验收代理请求失败');
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'stage5g6a6b-acceptance-proxy',
    apiVersion: '2026-07-20-stage5g6a6b',
    error: { code, message, ...(status < 500 && error?.details ? { details: error.details } : {}) },
  }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function delegate(context, dependencies, handler, overrides = {}) {
  try {
    const { env } = authorize(context);
    return await handler({
      ...context,
      env: {
        ...env,
        CLOUD_WRITE_PREVIEW_ENABLED: '1',
        ...overrides,
      },
    }, dependencies);
  } catch (error) {
    return failure(error);
  }
}

export function handleStage5g6a6bDeviceRegisterRequest(context, dependencies = {}) {
  return delegate(context, dependencies, handleDeviceRegisterRequest);
}

export function handleStage5g6a6bOrdinarySubmissionRequest(context, dependencies = {}) {
  return delegate(context, dependencies, handlePreviewAutoApprovalSubmissionRequest, {
    CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '1',
    CLOUD_SENSITIVE_REVIEW_PREVIEW_ENABLED: '0',
  });
}

export function handleStage5g6a6bSensitiveSubmissionRequest(context, dependencies = {}) {
  return delegate(context, dependencies, handleSensitiveSubmissionRequest);
}

export function handleStage5g6a6bPublicVersionRequest(context, dependencies = {}) {
  return delegate(context, dependencies, handleSensitivePublicVersionRequest);
}

export function handleStage5g6a6bPublicSnapshotRequest(context, dependencies = {}) {
  return delegate(context, dependencies, handleSensitivePublicSnapshotRequest);
}

export function handleStage5g6a6bPublicChangesRequest(context, dependencies = {}) {
  return delegate(context, dependencies, handleSensitivePublicChangesRequest);
}

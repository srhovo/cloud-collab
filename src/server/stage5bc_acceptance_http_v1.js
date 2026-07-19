import { readAdminAuthConfig } from './admin_auth_v1.js';
import { readAdminReviewMutationConfig } from './admin_review_mutation_v1.js';
import {
  handleDeviceRegisterRequest,
} from './preview_write_http_v1.js';
import {
  handlePreviewAutoApprovalSubmissionRequest,
  handlePreviewPublicChangesRequest,
  handlePreviewPublicSnapshotRequest,
  handlePreviewPublicVersionRequest,
} from './preview_auto_approval_http_v1.js';
import { readPreviewAutoApprovalConfig } from './preview_auto_approval_runtime_v1.js';

export const STAGE5BC_ACCEPTANCE_SCHEMA_VERSION = 1;
export const STAGE5BC_ACCEPTANCE_PUBLIC_STORE = 'cloud-collab-preview-v1';
export const STAGE5BC_ACCEPTANCE_ADMIN_STORE = 'cloud-collab-admin-preview-v1';
export const STAGE5BC_ACCEPTANCE_GROUP_ID = 'group_fixture';
export const STAGE5BC_ACCEPTANCE_LIBRARY_ID = 'lib_receive_fixture';

export class Stage5bcAcceptanceError extends Error {
  constructor(code, message, status = 503, details = null, cause = null) {
    super(message || code || '阶段5B/5C联合验收路由不可用');
    this.name = 'Stage5bcAcceptanceError';
    this.code = code || 'STAGE5BC_ACCEPTANCE_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function json(payload, status = 503) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'Content-Type': 'application/json; charset=UTF-8',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function failure(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 503;
  return json({
    ok: false,
    serviceId: 'cloud-collab-stage5bc-acceptance',
    apiVersion: '2026-07-19-stage5bc-acceptance-v1',
    error: {
      code: typeof error?.code === 'string' ? error.code : 'STAGE5BC_ACCEPTANCE_INTERNAL_ERROR',
      message: status >= 500 ? '阶段5B/5C联合验收路由暂时不可用' : String(error?.message || '联合验收请求失败'),
    },
  }, status);
}

function assertDistinctSecrets(values) {
  const configured = values.map(value => String(value || '')).filter(Boolean);
  if (configured.length !== new Set(configured).size) {
    throw new Stage5bcAcceptanceError(
      'STAGE5BC_ACCEPTANCE_SECRETS_REUSED',
      '联合验收的预览密钥、管理员凭据与盐值必须全部不同',
    );
  }
}

export function readStage5bcAcceptanceConfig(env = {}) {
  if (String(env.CLOUD_STAGE5BC_ACCEPTANCE_ENABLED || '').trim() !== '1') {
    throw new Stage5bcAcceptanceError('STAGE5BC_ACCEPTANCE_DISABLED', '阶段5B/5C联合验收未开启');
  }
  if (String(env.CLOUD_STAGE5BC_CLEANUP_ENABLED || '0').trim() === '1') {
    throw new Stage5bcAcceptanceError(
      'STAGE5BC_ACCEPTANCE_CLEANUP_CONFLICT',
      '联合验收与联合清理不能同时开启',
    );
  }
  if (String(env.CLOUD_WRITE_PREVIEW_ENABLED || '').trim() !== '0'
      || String(env.CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED || '').trim() !== '0') {
    throw new Stage5bcAcceptanceError(
      'STAGE5BC_FORMAL_PREVIEW_ROUTES_MUST_STAY_CLOSED',
      '联合验收期间标准公共预览路由必须保持关闭',
    );
  }

  let adminConfig;
  let reviewConfig;
  let previewConfig;
  const previewEnv = {
    ...env,
    CLOUD_WRITE_PREVIEW_ENABLED: '1',
    CLOUD_AUTO_APPROVAL_PREVIEW_ENABLED: '1',
  };
  try {
    adminConfig = readAdminAuthConfig(env);
    reviewConfig = readAdminReviewMutationConfig(env);
    previewConfig = readPreviewAutoApprovalConfig(previewEnv);
  } catch (error) {
    throw new Stage5bcAcceptanceError(
      'STAGE5BC_ACCEPTANCE_CONFIG_INVALID',
      '联合验收底层能力配置无效',
      503,
      null,
      error,
    );
  }

  if (String(env.CLOUD_BLOB_STORE_NAME || '').trim() !== STAGE5BC_ACCEPTANCE_PUBLIC_STORE
      || previewConfig.allowedGroupId !== STAGE5BC_ACCEPTANCE_GROUP_ID
      || previewConfig.allowedLibraryId !== STAGE5BC_ACCEPTANCE_LIBRARY_ID
      || reviewConfig.storeName !== STAGE5BC_ACCEPTANCE_PUBLIC_STORE
      || reviewConfig.groupId !== STAGE5BC_ACCEPTANCE_GROUP_ID
      || reviewConfig.libraryId !== STAGE5BC_ACCEPTANCE_LIBRARY_ID
      || adminConfig.storeName !== STAGE5BC_ACCEPTANCE_ADMIN_STORE) {
    throw new Stage5bcAcceptanceError(
      'STAGE5BC_ACCEPTANCE_SCOPE_INVALID',
      '联合验收必须硬锁两套合成Blob与fixture作用域',
    );
  }

  assertDistinctSecrets([
    previewConfig.previewAccessKey,
    previewConfig.rateLimitSalt,
    adminConfig.password,
    adminConfig.sessionSecret,
    adminConfig.rateLimitSalt,
  ]);

  return Object.freeze({
    schemaVersion: STAGE5BC_ACCEPTANCE_SCHEMA_VERSION,
    publicStoreName: STAGE5BC_ACCEPTANCE_PUBLIC_STORE,
    adminStoreName: STAGE5BC_ACCEPTANCE_ADMIN_STORE,
    groupId: STAGE5BC_ACCEPTANCE_GROUP_ID,
    libraryId: STAGE5BC_ACCEPTANCE_LIBRARY_ID,
    previewEnv: Object.freeze(previewEnv),
  });
}

async function forward(context, dependencies, handler) {
  try {
    const config = readStage5bcAcceptanceConfig(context?.env || {});
    return handler({ ...context, env: config.previewEnv }, dependencies);
  } catch (error) {
    return failure(error);
  }
}

export function handleStage5bcDeviceRegisterRequest(context, dependencies = {}) {
  return forward(context, dependencies, handleDeviceRegisterRequest);
}

export function handleStage5bcSubmissionCreateRequest(context, dependencies = {}) {
  return forward(context, dependencies, handlePreviewAutoApprovalSubmissionRequest);
}

export function handleStage5bcPublicVersionRequest(context, dependencies = {}) {
  return forward(context, dependencies, handlePreviewPublicVersionRequest);
}

export function handleStage5bcPublicSnapshotRequest(context, dependencies = {}) {
  return forward(context, dependencies, handlePreviewPublicSnapshotRequest);
}

export function handleStage5bcPublicChangesRequest(context, dependencies = {}) {
  return forward(context, dependencies, handlePreviewPublicChangesRequest);
}

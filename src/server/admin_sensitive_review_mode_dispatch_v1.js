import { resolveAdminAuthMode } from './admin_auth_mode_dispatch_v1.js';
import {
  handleAdminSensitiveReviewApproveRequest,
  handleAdminSensitiveReviewDetailRequest,
  handleAdminSensitiveReviewEditAndApproveRequest,
  handleAdminSensitiveReviewQueueRequest,
  handleAdminSensitiveReviewRejectRequest,
} from './admin_sensitive_review_http_v1.js';
import {
  handleProductionAdminSensitiveReviewApproveRequest,
  handleProductionAdminSensitiveReviewDetailRequest,
  handleProductionAdminSensitiveReviewEditAndApproveRequest,
  handleProductionAdminSensitiveReviewQueueRequest,
  handleProductionAdminSensitiveReviewRejectRequest,
} from './production_admin_sensitive_review_http_v1.js';

function invalid(error) {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'cloud-collab-admin-sensitive-review-dispatch',
    apiVersion: '2026-07-21-stage7v',
    error: {
      code: error?.code || 'ADMIN_SENSITIVE_REVIEW_MODE_INVALID',
      message: '管理员敏感审核运行模式配置无效',
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

export const handleAdminSensitiveReviewQueueByMode = (c, d = {}) => dispatch(
  c, d, handleAdminSensitiveReviewQueueRequest, handleProductionAdminSensitiveReviewQueueRequest,
);
export const handleAdminSensitiveReviewDetailByMode = (c, d = {}) => dispatch(
  c, d, handleAdminSensitiveReviewDetailRequest, handleProductionAdminSensitiveReviewDetailRequest,
);
export const handleAdminSensitiveReviewApproveByMode = (c, d = {}) => dispatch(
  c, d, handleAdminSensitiveReviewApproveRequest, handleProductionAdminSensitiveReviewApproveRequest,
);
export const handleAdminSensitiveReviewRejectByMode = (c, d = {}) => dispatch(
  c, d, handleAdminSensitiveReviewRejectRequest, handleProductionAdminSensitiveReviewRejectRequest,
);
export const handleAdminSensitiveReviewEditAndApproveByMode = (c, d = {}) => dispatch(
  c, d, handleAdminSensitiveReviewEditAndApproveRequest, handleProductionAdminSensitiveReviewEditAndApproveRequest,
);

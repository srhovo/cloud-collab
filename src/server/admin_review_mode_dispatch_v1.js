import { resolveAdminAuthMode } from './admin_auth_mode_dispatch_v1.js';
import {
  handleAdminReviewDetailRequest,
  handleAdminReviewQueueRequest,
} from './admin_review_http_v1.js';
import {
  handleAdminOrdinaryReviewDetailRequest,
  handleAdminOrdinaryReviewQueueRequest,
} from './admin_ordinary_review_http_v1.js';
import {
  handleAdminSensitiveReviewDetailRequest,
  handleAdminSensitiveReviewQueueRequest,
} from './admin_sensitive_review_http_v1.js';
import {
  handleProductionAdminExactReviewDetailRequest,
  handleProductionAdminExactReviewQueueRequest,
  handleProductionAdminOrdinaryReviewDetailRequest,
  handleProductionAdminOrdinaryReviewQueueRequest,
  handleProductionAdminSensitiveReviewDetailRequest,
  handleProductionAdminSensitiveReviewQueueRequest,
} from './production_admin_review_http_v1.js';

function invalid(error) {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'cloud-collab-admin-review-dispatch',
    apiVersion: '2026-07-21-stage7u',
    error: {
      code: error?.code || 'PRODUCTION_FLAG_INVALID',
      message: '管理员审核运行模式配置无效',
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

function dispatch(context, dependencies, production, preview) {
  try {
    return resolveAdminAuthMode(context?.env || {}) === 'production'
      ? production(context, dependencies)
      : preview(context, dependencies);
  } catch (error) {
    return invalid(error);
  }
}

export const handleAdminExactReviewQueueByMode = (c, d = {}) => dispatch(
  c, d, handleProductionAdminExactReviewQueueRequest, handleAdminReviewQueueRequest,
);
export const handleAdminExactReviewDetailByMode = (c, d = {}) => dispatch(
  c, d, handleProductionAdminExactReviewDetailRequest, handleAdminReviewDetailRequest,
);
export const handleAdminOrdinaryReviewQueueByMode = (c, d = {}) => dispatch(
  c, d, handleProductionAdminOrdinaryReviewQueueRequest, handleAdminOrdinaryReviewQueueRequest,
);
export const handleAdminOrdinaryReviewDetailByMode = (c, d = {}) => dispatch(
  c, d, handleProductionAdminOrdinaryReviewDetailRequest, handleAdminOrdinaryReviewDetailRequest,
);
export const handleAdminSensitiveReviewQueueByMode = (c, d = {}) => dispatch(
  c, d, handleProductionAdminSensitiveReviewQueueRequest, handleAdminSensitiveReviewQueueRequest,
);
export const handleAdminSensitiveReviewDetailByMode = (c, d = {}) => dispatch(
  c, d, handleProductionAdminSensitiveReviewDetailRequest, handleAdminSensitiveReviewDetailRequest,
);

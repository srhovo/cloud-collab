import {
  handleAdminReviewQueueRequest,
  handleAdminReviewDetailRequest,
} from './admin_review_http_v1.js';
import {
  handleAdminReviewApproveRequest,
  handleAdminReviewRejectRequest,
  handleAdminReviewEditAndApproveRequest,
} from './admin_review_mutation_http_v1.js';
import {
  handleAdminOrdinaryReviewQueueRequest,
  handleAdminOrdinaryReviewDetailRequest,
} from './admin_ordinary_review_http_v1.js';
import {
  handleAdminOrdinaryReviewApproveRequest,
  handleAdminOrdinaryReviewRejectRequest,
  handleAdminOrdinaryReviewEditAndApproveRequest,
} from './admin_ordinary_review_mutation_http_v1.js';
import {
  handleProductionAdminExactReviewQueueRequest,
  handleProductionAdminExactReviewDetailRequest,
  handleProductionAdminExactReviewApproveRequest,
  handleProductionAdminExactReviewRejectRequest,
  handleProductionAdminExactReviewEditAndApproveRequest,
  handleProductionAdminOrdinaryReviewQueueRequest,
  handleProductionAdminOrdinaryReviewDetailRequest,
  handleProductionAdminOrdinaryReviewApproveRequest,
  handleProductionAdminOrdinaryReviewRejectRequest,
  handleProductionAdminOrdinaryReviewEditAndApproveRequest,
} from './production_admin_review_http_v1.js';

function mode(context) {
  const raw = String(context?.env?.CLOUD_ADMIN_PRODUCTION_ENABLED ?? '0').trim();
  if (raw === '1') return 'production';
  if (raw === '0' || raw === '') return 'preview';
  return 'invalid';
}

function invalid() {
  return new Response(JSON.stringify({
    ok: false,
    serviceId: 'cloud-collab-admin-review-dispatch',
    apiVersion: '2026-07-21-stage7t',
    error: { code: 'ADMIN_REVIEW_MODE_INVALID', message: '管理员运行模式配置无效' },
  }), {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=UTF-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function dispatch(context, dependencies, preview, production) {
  const selected = mode(context);
  if (selected === 'production') return production(context, dependencies);
  if (selected === 'preview') return preview(context, dependencies);
  return invalid();
}

export const handleAdminExactReviewQueueByMode = (c, d) => dispatch(c, d, handleAdminReviewQueueRequest, handleProductionAdminExactReviewQueueRequest);
export const handleAdminExactReviewDetailByMode = (c, d) => dispatch(c, d, handleAdminReviewDetailRequest, handleProductionAdminExactReviewDetailRequest);
export const handleAdminExactReviewApproveByMode = (c, d) => dispatch(c, d, handleAdminReviewApproveRequest, handleProductionAdminExactReviewApproveRequest);
export const handleAdminExactReviewRejectByMode = (c, d) => dispatch(c, d, handleAdminReviewRejectRequest, handleProductionAdminExactReviewRejectRequest);
export const handleAdminExactReviewEditAndApproveByMode = (c, d) => dispatch(c, d, handleAdminReviewEditAndApproveRequest, handleProductionAdminExactReviewEditAndApproveRequest);

export const handleAdminOrdinaryReviewQueueByMode = (c, d) => dispatch(c, d, handleAdminOrdinaryReviewQueueRequest, handleProductionAdminOrdinaryReviewQueueRequest);
export const handleAdminOrdinaryReviewDetailByMode = (c, d) => dispatch(c, d, handleAdminOrdinaryReviewDetailRequest, handleProductionAdminOrdinaryReviewDetailRequest);
export const handleAdminOrdinaryReviewApproveByMode = (c, d) => dispatch(c, d, handleAdminOrdinaryReviewApproveRequest, handleProductionAdminOrdinaryReviewApproveRequest);
export const handleAdminOrdinaryReviewRejectByMode = (c, d) => dispatch(c, d, handleAdminOrdinaryReviewRejectRequest, handleProductionAdminOrdinaryReviewRejectRequest);
export const handleAdminOrdinaryReviewEditAndApproveByMode = (c, d) => dispatch(c, d, handleAdminOrdinaryReviewEditAndApproveRequest, handleProductionAdminOrdinaryReviewEditAndApproveRequest);

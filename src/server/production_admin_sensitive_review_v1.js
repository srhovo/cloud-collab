import {
  AdminSensitiveReviewError,
  approveSensitiveCandidate,
  editAndApproveSensitiveCandidate,
  getAdminSensitiveReviewDetail,
  listAdminSensitiveReviewQueue,
  rejectSensitiveCandidate,
} from './admin_sensitive_review_v1.js';
import {
  ProductionRuntimeConfigError,
  readProductionRuntimeConfig,
} from './production_runtime_config_v1.js';

export const PRODUCTION_ADMIN_SENSITIVE_REVIEW_VERSION = 1;

export class ProductionAdminSensitiveReviewError extends Error {
  constructor(code, message, status = 400, details = null, cause = null) {
    super(message || code || '正式敏感审核失败');
    this.name = 'ProductionAdminSensitiveReviewError';
    this.code = code || 'PRODUCTION_ADMIN_SENSITIVE_REVIEW_ERROR';
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }
}

function mapError(error) {
  if (error instanceof ProductionAdminSensitiveReviewError) return error;
  if (error instanceof ProductionRuntimeConfigError) {
    return new ProductionAdminSensitiveReviewError(error.code, error.message, 503, error.details, error);
  }
  if (error instanceof AdminSensitiveReviewError) {
    return new ProductionAdminSensitiveReviewError(error.code, error.message, error.status, error.details, error);
  }
  return error;
}

export function readProductionAdminSensitiveReviewConfig(env = {}) {
  let runtime;
  try { runtime = readProductionRuntimeConfig(env); }
  catch (error) { throw mapError(error); }
  const flags = runtime.flags;
  if (runtime.mode !== 'production' || flags.production !== true || flags.readSync !== true
      || flags.admin !== true || flags.adminReview !== true || flags.sensitiveSubmission !== true) {
    throw new ProductionAdminSensitiveReviewError(
      'PRODUCTION_ADMIN_SENSITIVE_REVIEW_DISABLED',
      '正式敏感人工审核尚未开启',
      503,
    );
  }
  return Object.freeze({
    schemaVersion: PRODUCTION_ADMIN_SENSITIVE_REVIEW_VERSION,
    enabled: true,
    storeName: runtime.publicStoreName,
    groupId: runtime.scope.protocol.groupId,
    libraryId: runtime.scope.protocol.libraryId,
    externalScope: runtime.scope.external,
    adminOrigin: runtime.adminOrigin,
  });
}

function reviewConfig(config) {
  return Object.freeze({
    enabled: true,
    storeName: config.storeName,
    groupId: config.groupId,
    libraryId: config.libraryId,
  });
}

function project(result, config) {
  return Object.freeze({
    ...result,
    externalScope: config.externalScope,
    protocolScope: Object.freeze({ groupId: config.groupId, libraryId: config.libraryId }),
    manualReview: true,
    stablePromotionAuthorized: false,
  });
}

export async function listProductionAdminSensitiveReviews(input = {}) {
  const config = readProductionAdminSensitiveReviewConfig(input.env || {});
  try {
    const result = await listAdminSensitiveReviewQueue({
      store: input.store,
      config: reviewConfig(config),
      limit: input.limit,
      cursor: input.cursor,
      now: input.now,
    });
    return project(result, config);
  } catch (error) { throw mapError(error); }
}

export async function getProductionAdminSensitiveReviewDetail(input = {}) {
  const config = readProductionAdminSensitiveReviewConfig(input.env || {});
  try {
    const result = await getAdminSensitiveReviewDetail({
      store: input.store,
      config: reviewConfig(config),
      reviewId: input.reviewId,
      now: input.now,
    });
    return project(result, config);
  } catch (error) { throw mapError(error); }
}

export async function approveProductionSensitiveCandidate(input = {}) {
  const config = readProductionAdminSensitiveReviewConfig(input.env || {});
  try {
    const result = await approveSensitiveCandidate({
      store: input.store,
      config: reviewConfig(config),
      administrator: input.administrator,
      request: input.request,
      now: input.now,
    });
    return project(result, config);
  } catch (error) { throw mapError(error); }
}

export async function rejectProductionSensitiveCandidate(input = {}) {
  const config = readProductionAdminSensitiveReviewConfig(input.env || {});
  try {
    const result = await rejectSensitiveCandidate({
      store: input.store,
      config: reviewConfig(config),
      administrator: input.administrator,
      request: input.request,
      now: input.now,
    });
    return project(result, config);
  } catch (error) { throw mapError(error); }
}

export async function editAndApproveProductionSensitiveCandidate(input = {}) {
  const config = readProductionAdminSensitiveReviewConfig(input.env || {});
  try {
    const result = await editAndApproveSensitiveCandidate({
      store: input.store,
      config: reviewConfig(config),
      administrator: input.administrator,
      request: input.request,
      now: input.now,
    });
    return project(result, config);
  } catch (error) { throw mapError(error); }
}

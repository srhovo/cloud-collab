import { normalizeBlobKey } from './blob_repository_v1.js';

const LIBRARY_ID_PATTERN = /^lib_[a-z0-9][a-z0-9_]{2,55}$/;
const REVIEW_ID_PATTERN = /^rv_v1_[A-Za-z0-9_-]{43}$/;

export class AdminReviewKeyError extends Error {
  constructor(code, message, status = 503) {
    super(message || code || '管理员审核Key无效');
    this.name = 'AdminReviewKeyError';
    this.code = code || 'ADMIN_REVIEW_KEY_INVALID';
    this.status = status;
  }
}

export function adminReviewResolutionKey(libraryId, reviewId) {
  const library = String(libraryId || '').trim();
  const id = String(reviewId || '').trim();
  if (!LIBRARY_ID_PATTERN.test(library) || !REVIEW_ID_PATTERN.test(id)) {
    throw new AdminReviewKeyError('ADMIN_REVIEW_RESOLUTION_KEY_INVALID', '审核归档Key无效', 503);
  }
  return normalizeBlobKey(`reviews/${library}/resolved/${id}.json`);
}

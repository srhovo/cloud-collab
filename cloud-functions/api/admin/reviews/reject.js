import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminExactReviewRejectByMode as handleAdminReviewRejectRequest } from '../../../../src/server/admin_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminReviewRejectRequest(resolveCloudFunctionContext(context));
}

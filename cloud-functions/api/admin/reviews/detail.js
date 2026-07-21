import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminExactReviewDetailByMode as handleAdminReviewDetailRequest } from '../../../../src/server/admin_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminReviewDetailRequest(resolveCloudFunctionContext(context));
}

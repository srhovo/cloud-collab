import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminExactReviewApproveByMode as handleAdminReviewApproveRequest } from '../../../../src/server/admin_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminReviewApproveRequest(resolveCloudFunctionContext(context));
}

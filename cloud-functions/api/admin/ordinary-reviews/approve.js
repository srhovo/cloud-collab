import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminOrdinaryReviewApproveByMode as handleAdminOrdinaryReviewApproveRequest } from '../../../../src/server/admin_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminOrdinaryReviewApproveRequest(resolveCloudFunctionContext(context));
}

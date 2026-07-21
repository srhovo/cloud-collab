import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminOrdinaryReviewEditAndApproveByMode as handleAdminOrdinaryReviewEditAndApproveRequest } from '../../../../src/server/admin_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminOrdinaryReviewEditAndApproveRequest(resolveCloudFunctionContext(context));
}

import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
// Stage5 compatibility anchor: admin_review_mutation_http_v1
import { handleAdminExactReviewEditAndApproveByMode as handleAdminReviewEditAndApproveRequest } from '../../../../src/server/admin_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminReviewEditAndApproveRequest(resolveCloudFunctionContext(context));
}

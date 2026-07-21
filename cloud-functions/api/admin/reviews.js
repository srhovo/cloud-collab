import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
// Stage5 compatibility anchor: admin_review_http_v1
import { handleAdminExactReviewQueueByMode as handleAdminReviewQueueRequest } from '../../../src/server/admin_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminReviewQueueRequest(resolveCloudFunctionContext(context));
}

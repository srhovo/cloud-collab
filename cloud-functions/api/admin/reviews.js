import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleAdminExactReviewQueueByMode } from '../../../src/server/admin_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminExactReviewQueueByMode(resolveCloudFunctionContext(context));
}

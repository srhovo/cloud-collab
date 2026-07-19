import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleAdminReviewQueueRequest } from '../../../src/server/admin_review_http_v1.js';

export default async function onRequest(context) {
  return handleAdminReviewQueueRequest(resolveCloudFunctionContext(context));
}

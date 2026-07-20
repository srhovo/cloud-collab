import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleAdminOrdinaryReviewQueueRequest } from '../../../src/server/admin_ordinary_review_http_v1.js';

export default async function onRequest(context) {
  return handleAdminOrdinaryReviewQueueRequest(resolveCloudFunctionContext(context));
}

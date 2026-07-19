import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminReviewRejectRequest } from '../../../../src/server/admin_review_mutation_http_v1.js';

export default async function onRequest(context) {
  return handleAdminReviewRejectRequest(resolveCloudFunctionContext(context));
}

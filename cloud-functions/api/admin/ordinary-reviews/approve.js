import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminOrdinaryReviewApproveRequest } from '../../../../src/server/admin_ordinary_review_mutation_http_v1.js';

export default async function onRequest(context) {
  return handleAdminOrdinaryReviewApproveRequest(resolveCloudFunctionContext(context));
}

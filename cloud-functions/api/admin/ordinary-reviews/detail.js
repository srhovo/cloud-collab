import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
// Stage5 compatibility anchor: admin_ordinary_review_http_v1
import { handleAdminOrdinaryReviewDetailByMode as handleAdminOrdinaryReviewDetailRequest } from '../../../../src/server/admin_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminOrdinaryReviewDetailRequest(resolveCloudFunctionContext(context));
}

import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminSensitiveReviewDetailRequest } from '../../../../src/server/admin_sensitive_review_http_v1.js';

export default async function onRequest(context) {
  return handleAdminSensitiveReviewDetailRequest(resolveCloudFunctionContext(context));
}

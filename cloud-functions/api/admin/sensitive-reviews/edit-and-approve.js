import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminSensitiveReviewEditAndApproveRequest } from '../../../../src/server/admin_sensitive_review_http_v1.js';

export default async function onRequest(context) {
  return handleAdminSensitiveReviewEditAndApproveRequest(resolveCloudFunctionContext(context));
}

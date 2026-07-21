import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminSensitiveReviewRejectByMode } from '../../../../src/server/admin_sensitive_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminSensitiveReviewRejectByMode(resolveCloudFunctionContext(context));
}

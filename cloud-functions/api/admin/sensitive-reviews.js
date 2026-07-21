import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleAdminSensitiveReviewQueueByMode } from '../../../src/server/admin_sensitive_review_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminSensitiveReviewQueueByMode(resolveCloudFunctionContext(context));
}

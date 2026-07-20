import { resolveCloudFunctionContext } from '../../../../_shared/runtime_env.js';
import { handleSensitiveSubmissionRequest } from '../../../../../src/server/sensitive_submission_http_v1.js';

export default async function onRequest(context) {
  return handleSensitiveSubmissionRequest(resolveCloudFunctionContext(context));
}

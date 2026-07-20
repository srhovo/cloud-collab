import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleProductionSensitiveSubmissionRequest } from '../../../src/server/production_sensitive_http_v1.js';

export default async function onRequest(context) {
  return handleProductionSensitiveSubmissionRequest(resolveCloudFunctionContext(context));
}

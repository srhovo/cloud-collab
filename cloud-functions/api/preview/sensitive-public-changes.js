import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleSensitivePublicChangesRequest } from '../../../src/server/sensitive_public_http_v1.js';

export default async function onRequest(context) {
  return handleSensitivePublicChangesRequest(resolveCloudFunctionContext(context));
}

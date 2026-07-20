import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleSensitivePublicVersionRequest } from '../../../src/server/sensitive_public_http_v1.js';

export default async function onRequest(context) {
  return handleSensitivePublicVersionRequest(resolveCloudFunctionContext(context));
}

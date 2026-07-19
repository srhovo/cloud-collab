import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminLoginRequest } from '../../../../src/server/admin_auth_http_v1.js';

export default async function onRequest(context) {
  return handleAdminLoginRequest(resolveCloudFunctionContext(context));
}

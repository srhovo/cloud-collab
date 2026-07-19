import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminLogoutRequest } from '../../../../src/server/admin_auth_http_v1.js';

export default async function onRequest(context) {
  return handleAdminLogoutRequest(resolveCloudFunctionContext(context));
}

import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminSessionByMode as handleAdminSessionRequest } from '../../../../src/server/admin_auth_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminSessionRequest(resolveCloudFunctionContext(context));
}

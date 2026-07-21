import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { dispatchAdminLoginRequest } from '../../../../src/server/admin_auth_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return dispatchAdminLoginRequest(resolveCloudFunctionContext(context));
}

import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminSessionByMode } from '../../../../src/server/admin_auth_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminSessionByMode(resolveCloudFunctionContext(context));
}

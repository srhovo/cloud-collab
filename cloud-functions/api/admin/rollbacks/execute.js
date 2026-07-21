import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
// Stage5E compatibility anchor: admin_rollback_http_v1
import { handleAdminRollbackExecuteByMode as handleAdminRollbackExecuteRequest } from '../../../../src/server/admin_rollback_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminRollbackExecuteRequest(resolveCloudFunctionContext(context));
}

import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminRollbackExecuteRequest } from '../../../../src/server/admin_rollback_http_v1.js';

export default async function onRequest(context) {
  return handleAdminRollbackExecuteRequest(resolveCloudFunctionContext(context));
}

import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminAcceptanceStatusRequest } from '../../../../src/server/admin_acceptance_cleanup_http_v1.js';

export default async function onRequest(context) {
  return handleAdminAcceptanceStatusRequest(resolveCloudFunctionContext(context));
}

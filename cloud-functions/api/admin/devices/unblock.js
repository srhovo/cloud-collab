import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
// Stage5D compatibility anchor: device_governance_http_v1
import { handleAdminDeviceUnblockByMode as handleAdminDeviceUnblockRequest } from '../../../../src/server/admin_device_governance_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceUnblockRequest(resolveCloudFunctionContext(context));
}

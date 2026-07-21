import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
// Stage5D compatibility anchor: device_governance_http_v1
import { handleAdminDeviceRevokeTrustByMode as handleAdminDeviceRevokeTrustRequest } from '../../../../src/server/admin_device_governance_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceRevokeTrustRequest(resolveCloudFunctionContext(context));
}

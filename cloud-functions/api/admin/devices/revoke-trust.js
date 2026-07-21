import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminDeviceRevokeTrustByMode } from '../../../../src/server/device_governance_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceRevokeTrustByMode(resolveCloudFunctionContext(context));
}

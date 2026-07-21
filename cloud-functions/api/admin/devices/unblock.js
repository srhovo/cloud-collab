import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import { handleAdminDeviceUnblockByMode } from '../../../../src/server/device_governance_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceUnblockByMode(resolveCloudFunctionContext(context));
}

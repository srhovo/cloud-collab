import { resolveCloudFunctionContext } from '../../_shared/runtime_env.js';
import { handleAdminDeviceListByMode } from '../../../src/server/device_governance_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceListByMode(resolveCloudFunctionContext(context));
}

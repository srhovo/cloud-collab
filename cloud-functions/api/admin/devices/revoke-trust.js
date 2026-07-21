import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import {
  handleAdminDeviceRevokeTrustByMode as handleAdminDeviceRevokeTrustRequest,
} from '../../../../src/server/admin_device_governance_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceRevokeTrustRequest(resolveCloudFunctionContext(context));
}

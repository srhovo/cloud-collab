import { resolveCloudFunctionContext } from '../../../_shared/runtime_env.js';
import {
  handleAdminDeviceDetailByMode as handleAdminDeviceDetailRequest,
} from '../../../../src/server/admin_device_governance_mode_dispatch_v1.js';

export default async function onRequest(context) {
  return handleAdminDeviceDetailRequest(resolveCloudFunctionContext(context));
}
